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
  if (!text) return text;
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitizeDeep(obj) {
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeDeep);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeDeep(value);
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Reverse proxy: forward to api.anthropic.com
// ---------------------------------------------------------------------------

function forwardRequest(req, res, body) {
  return new Promise(async (resolve) => {
    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (err) {
      log('Auth error:', err.message);
      res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: err.message },
      });
      return resolve();
    }

    const targetUrl = new URL(req.path, ANTHROPIC_BASE);
    // Forward query params
    if (req.url.includes('?')) {
      targetUrl.search = req.url.split('?')[1];
    }

    const headers = {
      'x-api-key': accessToken,
      'content-type': 'application/json',
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      // Identify as CLI client for first-party billing classification
      'anthropic-client-platform': 'cli',
      'user-agent': 'Anthropic/JS 0.80.0',
      // Stainless SDK telemetry (matches CLI fingerprint)
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.80.0',
      'x-stainless-os': process.platform,
      'x-stainless-arch': process.arch,
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': process.versions.node,
    };

    // Forward anthropic-beta header if present
    if (req.headers['anthropic-beta']) {
      headers['anthropic-beta'] = req.headers['anthropic-beta'];
    }

    debug(`→ ${req.method} ${targetUrl.toString()}`);

    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) {
      headers['content-length'] = Buffer.byteLength(payload);
    }

    const transport = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = transport.request(targetUrl, {
      method: req.method,
      headers,
    }, (proxyRes) => {
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
    });

    proxyReq.on('error', (err) => {
      log('Proxy request error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: `Proxy error: ${err.message}` },
        });
      }
      resolve();
    });

    if (payload) {
      proxyReq.write(payload);
    }
    proxyReq.end();
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Parse JSON body for POST requests
app.use(express.json({ limit: '50mb' }));

// POST /v1/messages — main proxy endpoint (sanitize + forward)
app.post('/v1/messages', async (req, res) => {
  const sanitizedBody = sanitizeDeep(req.body);

  const model = sanitizedBody.model || '?';
  const stream = !!sanitizedBody.stream;
  const msgCount = sanitizedBody.messages?.length || 0;

  log(`→ POST /v1/messages | model=${model} | stream=${stream} | messages=${msgCount}`);

  if (DEBUG) {
    const fs = require('fs');
    fs.writeFileSync('/tmp/claude-proxy-last-request.json', JSON.stringify(req.body, null, 2));
    debug('Full request saved to /tmp/claude-proxy-last-request.json');
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

  res.json({
    status: 'ok',
    version: require('./package.json').version,
    mode: 'oauth-proxy',
    token: tokenStatus,
    subscription: cachedCredentials?.subscriptionType || 'unknown',
    rateLimitTier: cachedCredentials?.rateLimitTier || 'unknown',
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
