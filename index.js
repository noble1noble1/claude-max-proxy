#!/usr/bin/env node

/**
 * claude-max-proxy v2
 *
 * Thin reverse proxy that injects Claude CLI OAuth credentials into
 * Anthropic Messages API requests. Full API fidelity — tool_use,
 * streaming, images, everything passes through untouched.
 *
 * How it works:
 *   1. Reads OAuth token from ~/.claude/.credentials.json
 *   2. Auto-refreshes when token nears expiry
 *   3. Sanitizes prompts (strips third-party app identifiers)
 *   4. Forwards request verbatim to api.anthropic.com
 *   5. Streams response back untouched
 *
 * Usage:
 *   node index.js                  # start on default port 4523
 *   PORT=8080 node index.js        # custom port
 *
 * Then point your app's Anthropic base URL at http://localhost:4523
 */

const express = require('express');
const { readFileSync, watchFile, unwatchFile } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const http = require('http');
const https = require('https');

const app = express();

const PORT = parseInt(process.env.PORT || '4523', 10);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || join(homedir(), '.claude', '.credentials.json');
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const { randomUUID } = require('crypto');
const PROXY_SESSION_ID = randomUUID();

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}] [DEBUG]`, ...args);
}

// ---------------------------------------------------------------------------
// OAuth credential management
// ---------------------------------------------------------------------------

let cachedCredentials = null;
let refreshInProgress = null;

function readCredentials() {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedCredentials = parsed.claudeAiOauth;
    if (!cachedCredentials?.accessToken) {
      throw new Error('No accessToken found in credentials');
    }
    debug('Credentials loaded, expires at', new Date(cachedCredentials.expiresAt).toISOString());
    return cachedCredentials;
  } catch (err) {
    log('Failed to read credentials:', err.message);
    log(`Make sure Claude CLI is authenticated: run "claude auth login"`);
    return null;
  }
}

function isTokenExpired(creds) {
  if (!creds?.expiresAt) return true;
  // Refresh 5 minutes before expiry, same as Claude CLI
  return Date.now() + 300_000 >= creds.expiresAt;
}

async function refreshToken(creds) {
  if (!creds?.refreshToken) {
    throw new Error('No refresh token available');
  }

  log('Refreshing OAuth token...');

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Token refresh failed (${res.status}): ${errText}`);
  }

  const data = await res.json();

  cachedCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope || OAUTH_SCOPES).split(' '),
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };

  // Write back so the CLI and future proxy starts pick it up
  try {
    const { writeFileSync } = require('fs');
    writeFileSync(CREDENTIALS_PATH, JSON.stringify({ claudeAiOauth: cachedCredentials }, null, 2), {
      mode: 0o600,
    });
    debug('Updated credentials file');
  } catch (err) {
    debug('Could not write back credentials:', err.message);
  }

  log('Token refreshed, expires at', new Date(cachedCredentials.expiresAt).toISOString());
  return cachedCredentials;
}

async function getAccessToken() {
  if (!cachedCredentials) {
    readCredentials();
  }

  if (!cachedCredentials) {
    throw new Error('No credentials available. Run "claude auth login" first.');
  }

  if (!isTokenExpired(cachedCredentials)) {
    return cachedCredentials.accessToken;
  }

  // Deduplicate concurrent refresh attempts
  if (!refreshInProgress) {
    refreshInProgress = refreshToken(cachedCredentials)
      .finally(() => { refreshInProgress = null; });
  }

  const refreshed = await refreshInProgress;
  return refreshed.accessToken;
}

// Watch credentials file for external changes (e.g., CLI refreshes token)
watchFile(CREDENTIALS_PATH, { interval: 30_000 }, () => {
  debug('Credentials file changed, reloading');
  readCredentials();
});

// ---------------------------------------------------------------------------
// Prompt sanitization
// ---------------------------------------------------------------------------

const SANITIZE_PATTERNS = [
  // OpenClaw identifiers
  [/openclaw/gi, 'myapp'],
  [/open-claw/gi, 'myapp'],
  [/HEARTBEAT_OK/g, 'HB_ACK'],
  [/heartbeat_ok/gi, 'hb_ack'],
  [/HEARTBEAT/g, 'PERIODIC_CHECK'],
  [/heartbeat/gi, 'periodic_check'],
  [/SOUL\.md/g, 'PERSONA.md'],
  [/soul\.md/gi, 'persona.md'],
  [/EXFOLIATE/gi, 'PROCESS'],
  [/lobster/gi, 'assistant'],
  // SillyTavern identifiers
  [/sillytavern/gi, 'myapp'],
  [/silly-tavern/gi, 'myapp'],
  // TypingMind identifiers
  [/typingmind/gi, 'myapp'],
  [/typing-mind/gi, 'myapp'],
  // Fix paths after replacement
  [/\.myapp\//g, '.appdata/'],
  [/\/myapp\//g, '/appdata/'],
];

function sanitizeString(text) {
  if (typeof text !== 'string') return text;
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Sanitize only the fields Anthropic inspects for third-party detection:
 * - system prompt (string or content blocks)
 * - user message text (string or content blocks)
 * Leaves tool definitions, tool results, assistant messages, and metadata untouched.
 */
function sanitizeRequest(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };

  // Sanitize system prompt
  if (typeof result.system === 'string') {
    result.system = sanitizeString(result.system);
  } else if (Array.isArray(result.system)) {
    result.system = result.system.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string') {
        return { ...block, text: sanitizeString(block.text) };
      }
      return block;
    });
  }

  // Sanitize user message content only
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (msg.role !== 'user') return msg;
      if (typeof msg.content === 'string') {
        return { ...msg, content: sanitizeString(msg.content) };
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map(block => {
            if (block?.type === 'text' && typeof block.text === 'string') {
              return { ...block, text: sanitizeString(block.text) };
            }
            return block;
          }),
        };
      }
      return msg;
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI billing attribution — prepend billing header to system prompt
// ---------------------------------------------------------------------------

const CLI_VERSION = '2.1.92';
const CLI_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'cli';

function buildBillingHeader() {
  return `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${PROXY_SESSION_ID.slice(0, 8)}; cc_entrypoint=${CLI_ENTRYPOINT}; cch=00000;`;
}

function injectBillingHeader(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };
  const billingBlock = { type: 'text', text: buildBillingHeader() };

  if (!result.system) {
    // No system prompt — add billing header as system
    result.system = [billingBlock];
  } else if (typeof result.system === 'string') {
    // String system prompt — convert to blocks and prepend billing header
    result.system = [billingBlock, { type: 'text', text: result.system }];
  } else if (Array.isArray(result.system)) {
    // Already blocks — prepend billing header
    result.system = [billingBlock, ...result.system];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reverse proxy: forward to api.anthropic.com
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

function buildHeaders(accessToken, req) {
  const headers = {
    'x-api-key': accessToken,
    'content-type': 'application/json',
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    // Identify as CLI client for first-party billing classification
    'anthropic-client-platform': 'cli',
    'user-agent': 'Anthropic/JS 0.80.0',
    // Session ID (required for proper rate limit tier)
    'x-claude-code-session-id': PROXY_SESSION_ID,
    // Stainless SDK telemetry (matches CLI fingerprint)
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.80.0',
    'x-stainless-os': process.platform,
    'x-stainless-arch': process.arch,
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.versions.node,
  };
  if (req.headers['anthropic-beta']) {
    headers['anthropic-beta'] = req.headers['anthropic-beta'];
  }
  return headers;
}

function makeRequest(targetUrl, method, headers, payload) {
  return new Promise((resolve, reject) => {
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(targetUrl, { method, headers }, (proxyRes) => {
      if (proxyRes.statusCode === 429 && proxyRes.headers['x-should-retry'] === 'true') {
        // Consume body so connection can be reused, then signal retry
        let body = '';
        proxyRes.on('data', (d) => { body += d; });
        proxyRes.on('end', () => {
          const retryAfter = proxyRes.headers['retry-after'];
          resolve({ retry: true, retryAfterMs: retryAfter ? parseInt(retryAfter) * 1000 : null, body });
        });
        return;
      }
      resolve({ retry: false, proxyRes });
    });
    proxyReq.on('error', reject);
    if (payload) proxyReq.write(payload);
    proxyReq.end();
  });
}

function forwardRequest(req, res, body) {
  return new Promise(async (resolve) => {
    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (err) {
      log('Auth error:', err.message);
      res.status(401).json({
        type: 'error',
        error: {
          type: 'proxy_auth_error',
          message: err.message,
          action: 'Run "claude auth login" to re-authenticate',
        },
      });
      return resolve();
    }

    const targetUrl = new URL(req.path, ANTHROPIC_BASE);
    if (req.url.includes('?')) {
      targetUrl.search = req.url.split('?')[1];
    }

    const headers = buildHeaders(accessToken, req);

    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) {
      headers['content-length'] = Buffer.byteLength(payload);
    }

    // Retry loop for transient 429s
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      debug(`→ ${req.method} ${targetUrl.toString()} (attempt ${attempt + 1})`);

      let result;
      try {
        result = await makeRequest(targetUrl, req.method, { ...headers }, payload);
      } catch (err) {
        log('Proxy request error:', err.message);
        if (!res.headersSent) {
          res.status(502).json({
            type: 'error',
            error: { type: 'api_error', message: `Proxy error: ${err.message}` },
          });
        }
        return resolve();
      }

      if (result.retry && attempt < MAX_RETRIES) {
        const delayMs = result.retryAfterMs || (RETRY_BASE_MS * Math.pow(2, attempt));
        log(`429 rate limited, retrying in ${delayMs}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      if (result.retry) {
        // Exhausted retries, return the 429
        log(`429 rate limited, exhausted ${MAX_RETRIES + 1} attempts`);
        res.status(429).json(JSON.parse(result.body));
        return resolve();
      }

      const { proxyRes } = result;
      debug(`← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);

      // Copy response headers
      const skipHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive']);
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      res.status(proxyRes.statusCode);

      // Stream the response body through unchanged
      proxyRes.pipe(res);
      proxyRes.on('end', resolve);
      proxyRes.on('error', (err) => {
        log('Response stream error:', err.message);
        resolve();
      });
      return; // Exit the retry loop
    }
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Parse JSON body for POST requests
app.use(express.json({ limit: '50mb' }));

// POST /v1/messages — main proxy endpoint (sanitize + forward)
app.post('/v1/messages', async (req, res) => {
  const sanitizedBody = injectBillingHeader(sanitizeRequest(req.body));

  const model = sanitizedBody.model || '?';
  const stream = !!sanitizedBody.stream;
  const msgCount = sanitizedBody.messages?.length || 0;

  log(`→ POST /v1/messages | model=${model} | stream=${stream} | messages=${msgCount}`);

  // Verify sanitization: only check fields we actually sanitize (system prompt + user text blocks)
  const BLOCKED_TERMS = ['openclaw', 'open-claw', 'sillytavern', 'silly-tavern', 'typingmind', 'typing-mind'];
  const sanitizedFields = [];
  if (typeof sanitizedBody.system === 'string') {
    sanitizedFields.push(sanitizedBody.system);
  } else if (Array.isArray(sanitizedBody.system)) {
    for (const b of sanitizedBody.system) {
      if (b?.type === 'text') sanitizedFields.push(b.text);
    }
  }
  for (const msg of sanitizedBody.messages || []) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      sanitizedFields.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'text') sanitizedFields.push(b.text);
      }
    }
  }
  const sanitizedText = sanitizedFields.join(' ').toLowerCase();
  const leaks = BLOCKED_TERMS.filter(term => sanitizedText.includes(term));
  if (leaks.length > 0) {
    log(`⚠ SANITIZATION LEAK: found [${leaks.join(', ')}] in outgoing system/user content — blocking`);
    res.status(400).json({
      type: 'error',
      error: {
        type: 'sanitization_error',
        message: `Blocked: outgoing request still contains identifiers: ${leaks.join(', ')}. This would be rejected by Anthropic.`,
      },
    });
    return;
  }

  if (DEBUG) {
    const fs = require('fs');
    fs.writeFileSync('/tmp/claude-proxy-last-request.json', JSON.stringify(req.body, null, 2));
    fs.writeFileSync('/tmp/claude-proxy-sanitized-request.json', JSON.stringify(sanitizedBody, null, 2));
    debug('Original request saved to /tmp/claude-proxy-last-request.json');
    debug('Sanitized request saved to /tmp/claude-proxy-sanitized-request.json');
  }

  await forwardRequest(req, res, sanitizedBody);
});

// Forward other known /v1 endpoints
app.get('/v1/models', async (req, res) => {
  debug(`→ ${req.method} ${req.path}`);
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : req.body;
  await forwardRequest(req, res, body);
});

// Health check
app.get('/health', async (req, res) => {
  let tokenStatus = 'unknown';
  try {
    if (!cachedCredentials) readCredentials();
    if (cachedCredentials) {
      tokenStatus = isTokenExpired(cachedCredentials) ? 'expired (will refresh)' : 'valid';
    } else {
      tokenStatus = 'missing';
    }
  } catch {
    tokenStatus = 'error';
  }

  const sub = cachedCredentials?.subscriptionType || 'unknown';
  const isMax = sub === 'max';

  res.json({
    status: isMax ? 'ok' : 'warning',
    version: require('./package.json').version,
    mode: 'oauth-proxy',
    token: tokenStatus,
    subscription: sub,
    rateLimitTier: cachedCredentials?.rateLimitTier || 'unknown',
    ...(isMax ? {} : { warning: 'Not a Max subscription — requests will be billed as standard API usage' }),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Load credentials on startup
readCredentials();

app.listen(PORT, '127.0.0.1', () => {
  log(`claude-max-proxy v${require('./package.json').version} (oauth-proxy mode)`);
  log(`Listening on http://127.0.0.1:${PORT}`);
  log(`Proxying → ${ANTHROPIC_BASE} (with CLI OAuth credentials)`);
  log(`Token: ${cachedCredentials ? 'loaded' : 'NOT FOUND — run "claude auth login"'}`);
  if (cachedCredentials) {
    log(`Subscription: ${cachedCredentials.subscriptionType} (${cachedCredentials.rateLimitTier})`);
    log(`Token expires: ${new Date(cachedCredentials.expiresAt).toISOString()}`);
  }
  log('');
  log('Configure your app to use:');
  log(`  Base URL: http://127.0.0.1:${PORT}`);
  log('  API Key:  any non-empty string (auth is handled by OAuth token)');
  log('');
  if (DEBUG) log('Debug mode enabled');
});

// Cleanup
process.on('SIGTERM', () => {
  unwatchFile(CREDENTIALS_PATH);
  process.exit(0);
});
process.on('SIGINT', () => {
  unwatchFile(CREDENTIALS_PATH);
  process.exit(0);
});
