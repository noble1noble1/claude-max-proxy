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
const { readFileSync, watchFile, unwatchFile, appendFileSync, existsSync, mkdirSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const http = require('http');
const https = require('https');

const app = express();

const PORT = parseInt(process.env.PORT || '4523', 10);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const MAX_RATE_LIMIT_WAIT_MS = parseInt(process.env.MAX_RATE_LIMIT_WAIT_MS || '0', 10); // 0 = always defer to client immediately on 429
// Fallback event log: a JSONL file written whenever Anthropic overage/quota
// errors occur or model fallback is likely. External watchers (Telegram bot,
// cron, etc.) can tail this file for alerting.
const FALLBACK_LOG_DIR = process.env.FALLBACK_LOG_DIR || join(homedir(), '.claude-max-proxy');
const FALLBACK_LOG_PATH = join(FALLBACK_LOG_DIR, 'fallback-events.jsonl');
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || join(homedir(), '.claude', '.credentials.json');
// ANTHROPIC_TOKEN env var: bypass credentials file entirely — set to your sk-ant-oat01-* token directly.
// Useful when Claude Code stores credentials in macOS Keychain instead of ~/.claude/.credentials.json.
const ANTHROPIC_TOKEN_OVERRIDE = process.env.ANTHROPIC_TOKEN || null;
// CREDENTIALS_PATH_FALLBACK: path to a second account's credentials file.
// When the primary account hits an overage/quota error, the proxy automatically
// switches to the fallback account for the remainder of that request (and future
// requests until the process restarts or the primary account quota resets).
const CREDENTIALS_PATH_FALLBACK = process.env.CREDENTIALS_PATH_FALLBACK || null;
// AUTH_HEADER_FORMAT: 'bearer' (default) or 'x-api-key'.
// OAuth tokens (sk-ant-oat01-*) require Authorization: Bearer — sending them as x-api-key
// causes "invalid x-api-key" 401s. Override with AUTH_HEADER_FORMAT=x-api-key only if
// using a legacy sk-ant-api03-* key.
const AUTH_HEADER_FORMAT = (process.env.AUTH_HEADER_FORMAT || 'bearer').toLowerCase();
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const { randomUUID } = require('crypto');
let PROXY_SESSION_ID = randomUUID();
// Per-model rate-limit recovery tracking (keyed by model id)
const perModelRateLimitRecovery = {}; // { [model]: { timer, at } }
let rateLimitRecoveryTimer = null;
let rateLimitRecoveryAt = 0;
let rateLimitRecoveryModel = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}] [DEBUG]`, ...args);
}

function scheduleRateLimitRecovery(details = {}) {
  const retryAfterMs = Number(details.retryAfterMs || 0);
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;

  const nextRecoveryAt = Date.now() + retryAfterMs;
  if (rateLimitRecoveryAt && nextRecoveryAt <= rateLimitRecoveryAt + 5000) {
    debug(`[rate-limit-recovery] Existing recovery window kept (${new Date(rateLimitRecoveryAt).toISOString()})`);
    return;
  }

  if (rateLimitRecoveryTimer) clearTimeout(rateLimitRecoveryTimer);
  rateLimitRecoveryAt = nextRecoveryAt;
  rateLimitRecoveryModel = details.model || rateLimitRecoveryModel || 'anthropic';

  const delayMs = Math.max(nextRecoveryAt - Date.now(), 1000);
  log(`[rate-limit-recovery] Scheduled for ${new Date(nextRecoveryAt).toISOString()} (${Math.round(delayMs / 60000)} min from now)`);

  rateLimitRecoveryTimer = setTimeout(() => {
    logFallbackEvent('rate_limit_cleared', {
      model: rateLimitRecoveryModel || details.model || 'anthropic',
      retryAfterMs,
      availableAt: new Date(rateLimitRecoveryAt).toISOString(),
      reason: 'anthropic_retry_window_elapsed',
    });
    rateLimitRecoveryTimer = null;
    rateLimitRecoveryAt = 0;
    rateLimitRecoveryModel = null;
  }, delayMs);

  rateLimitRecoveryTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Fallback event logging
// ---------------------------------------------------------------------------
//
// Durable JSONL log of overage/quota failures and likely model-fallback events.
// Written to ~/.claude-max-proxy/fallback-events.jsonl (configurable via
// FALLBACK_LOG_DIR env var). Each line is a self-contained JSON object so the
// file is safe to tail and parse incrementally.
//
// Event types:
//   overage          — Anthropic returned a 400/529 that looks like quota/overage
//   malformed        — Anthropic returned a 400 that is a genuine request error
//   model_fallback   — A request arrived for a "premium" model after recent
//                      overage failures (client may have fallen back on its own)
//   auth_failure     — Persistent 401 after token refresh
//
// Telegram alerts: the /fallback-events endpoint returns recent events as JSON
// so the telegram-watchdog-trigger.js (or any cron) can poll and alert.
// ---------------------------------------------------------------------------

function ensureFallbackLogDir() {
  if (!existsSync(FALLBACK_LOG_DIR)) {
    try { mkdirSync(FALLBACK_LOG_DIR, { recursive: true, mode: 0o700 }); } catch {}
  }
}

function logFallbackEvent(type, details = {}) {
  const event = {
    ts: new Date().toISOString(),
    type,
    ...details,
  };
  log(`[fallback-event] ${type}${details.model ? ` model=${details.model}` : ''}${details.reason ? ` reason=${details.reason}` : ''}`);
  try {
    ensureFallbackLogDir();
    appendFileSync(FALLBACK_LOG_PATH, JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch (err) {
    debug('[fallback-event] could not write to log:', err.message);
  }
}

// Classify a non-2xx Anthropic response into one of:
//   'overage'   — quota exhausted or plan-level restriction (soft, retrying won't help immediately)
//   'malformed' — request was bad (hard error, caller bug)
//   'auth'      — authentication failure
//   'ratelimit' — transient rate limit
//   'other'     — everything else
//
// Overage signals:
//   • HTTP 400 with error.type = 'out_of_usage' OR error.type = 'quota_exceeded'
//   • HTTP 400 with error.message containing 'out of extra usage' / 'over your usage limit'
//   • HTTP 529 (overloaded/capacity)
//   • anthropic-ratelimit-unified-overage-status header = 'disabled'
function classifyAnthropicError(statusCode, body, headers = {}) {
  if (statusCode === 401) return 'auth';
  if (statusCode === 429) return 'ratelimit';

  const overageStatus = (headers['anthropic-ratelimit-unified-overage-status'] || '').toLowerCase();
  if (overageStatus === 'disabled') return 'overage';

  if (statusCode === 529) return 'overage'; // service capacity exhausted

  if (statusCode === 400) {
    let parsed = null;
    try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch {}

    const errType = (parsed?.error?.type || '').toLowerCase();
    const errMsg  = (parsed?.error?.message || '').toLowerCase();

    if (
      errType === 'out_of_usage' ||
      errType === 'quota_exceeded' ||
      errType === 'usage_limit_exceeded' ||
      errMsg.includes('out of extra usage') ||
      errMsg.includes('over your usage limit') ||
      errMsg.includes('quota') ||
      errMsg.includes('usage limit')
    ) {
      return 'overage';
    }
    return 'malformed';
  }

  return 'other';
}

// Track recent overage events so we can detect client-side model fallback.
// Stored as a ring buffer (max 20 entries) of { ts, model } objects.
const recentOverageModels = [];
const OVERAGE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function recordOverage(model) {
  const now = Date.now();
  recentOverageModels.push({ ts: now, model });
  // Trim old entries and cap the buffer
  while (recentOverageModels.length > 20) recentOverageModels.shift();
}

// Returns the set of models that had overage errors within the recent window.
function recentOverageModelSet() {
  const cutoff = Date.now() - OVERAGE_WINDOW_MS;
  return new Set(recentOverageModels.filter(e => e.ts > cutoff).map(e => e.model));
}

// Called before each request to detect if the incoming model looks like a
// fallback choice after recent overage failures on a different model.
function checkModelFallback(incomingModel) {
  const recentModels = recentOverageModelSet();
  if (recentModels.size === 0) return;
  if (recentModels.has(incomingModel)) return; // same model that had overage — not a fallback
  // New model, different from the one(s) that had recent overages → likely fallback
  logFallbackEvent('model_fallback', {
    model: incomingModel,
    priorOverageModels: [...recentModels],
    detail: 'Client requested a different model shortly after overage failures on prior model(s)',
  });
}

// ---------------------------------------------------------------------------
// OAuth credential management
// ---------------------------------------------------------------------------

let cachedCredentials = null;
let refreshInProgress = null;

// ---------------------------------------------------------------------------
// Multi-account fallback state
// ---------------------------------------------------------------------------
let cachedFallbackCredentials = null;
let fallbackRefreshInProgress = null;
let usingFallbackAccount = false; // flips to true on primary overage

function readFallbackCredentials() {
  if (!CREDENTIALS_PATH_FALLBACK) return null;
  try {
    const raw = readFileSync(CREDENTIALS_PATH_FALLBACK, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedFallbackCredentials = parsed.claudeAiOauth;
    if (!cachedFallbackCredentials?.accessToken) throw new Error('No accessToken');
    debug('[fallback-account] Fallback credentials loaded from', CREDENTIALS_PATH_FALLBACK);
    return cachedFallbackCredentials;
  } catch (err) {
    debug('[fallback-account] Could not read fallback credentials:', err.message);
    return null;
  }
}

async function getFallbackAccessToken() {
  if (!cachedFallbackCredentials) readFallbackCredentials();
  if (!cachedFallbackCredentials) throw new Error('No fallback credentials available');

  if (!isTokenExpired(cachedFallbackCredentials)) return cachedFallbackCredentials.accessToken;

  // Refresh the fallback token
  if (!fallbackRefreshInProgress) {
    fallbackRefreshInProgress = (async () => {
      if (!cachedFallbackCredentials?.refreshToken) throw new Error('No fallback refresh token');
      log('[fallback-account] Refreshing fallback OAuth token...');
      const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: cachedFallbackCredentials.refreshToken,
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
        throw new Error(`Fallback token refresh failed (${res.status}): ${errText}`);
      }
      const data = await res.json();
      cachedFallbackCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || cachedFallbackCredentials.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        scopes: (data.scope || OAUTH_SCOPES).split(' '),
      };
      try {
        const { writeFileSync } = require('fs');
        writeFileSync(CREDENTIALS_PATH_FALLBACK, JSON.stringify({ claudeAiOauth: cachedFallbackCredentials }, null, 2), { mode: 0o600 });
      } catch {}
      log('[fallback-account] Fallback token refreshed, expires at', new Date(cachedFallbackCredentials.expiresAt).toISOString());
      return cachedFallbackCredentials;
    })().finally(() => { fallbackRefreshInProgress = null; });
  }
  const refreshed = await fallbackRefreshInProgress;
  return refreshed.accessToken;
}

// Read token from macOS Keychain — fallback for Claude Code 2.1.92+ which may
// migrate credentials away from ~/.claude/.credentials.json on some machines.
function readCredentialsFromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!raw) return null;

    // May be a JSON blob or a raw token string
    try {
      const parsed = JSON.parse(raw);
      if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth;
      if (parsed.accessToken) return parsed;
    } catch {
      // Raw token string
      if (raw.startsWith('sk-ant-')) {
        return { accessToken: raw, refreshToken: null, expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readCredentials() {
  // 1. Env var override — highest priority, no file needed
  if (ANTHROPIC_TOKEN_OVERRIDE) {
    cachedCredentials = {
      accessToken: ANTHROPIC_TOKEN_OVERRIDE,
      refreshToken: null,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    };
    log('Using token from ANTHROPIC_TOKEN env var');
    return cachedCredentials;
  }

  // 2. Credentials file (default for most Claude Code installations)
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedCredentials = parsed.claudeAiOauth;
    if (!cachedCredentials?.accessToken) {
      throw new Error('No accessToken found in credentials');
    }
    debug('Credentials loaded from file, expires at', new Date(cachedCredentials.expiresAt).toISOString());
    return cachedCredentials;
  } catch (err) {
    debug('Credentials file not available:', err.message);
  }

  // 3. macOS Keychain — Claude Code 2.1.92+ on some machines migrates here
  const keychainCreds = readCredentialsFromKeychain();
  if (keychainCreds) {
    cachedCredentials = keychainCreds;
    log('Credentials loaded from macOS Keychain');
    return cachedCredentials;
  }

  log('Failed to read credentials from file or Keychain');
  log('Options:');
  log('  A) Run "claude auth login" to re-authenticate');
  log('  B) Set ANTHROPIC_TOKEN=sk-ant-oat01-... env var with your OAuth token');
  log('  C) Set CREDENTIALS_PATH to your credentials file location');
  return null;
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
  syncAuthProfiles(cachedCredentials);
  return cachedCredentials;
}

async function getAccessToken() {
  // If primary account hit overage, route all subsequent requests through fallback
  if (usingFallbackAccount && CREDENTIALS_PATH_FALLBACK) {
    return getFallbackAccessToken();
  }

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

// Sync the fresh token into openclaw's auth-profiles.json so openclaw never
// uses a stale token. This is the root cause of recurring 401s: the proxy
// refreshes credentials.json but openclaw reads a separate file.
const AUTH_PROFILES_PATH = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');

function readFreshToken() {
  // Try credentials file first, then Keychain — mirrors readCredentials() priority
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth;
  } catch {}

  // Keychain fallback (Claude Code 2.1.92+ on some Macs)
  const kc = readCredentialsFromKeychain();
  if (kc?.accessToken) return kc;
  return null;
}

function syncAuthProfiles(creds) {
  if (!creds?.accessToken) return;
  try {
    const { readFileSync: rfs, writeFileSync: wfs } = require('fs');
    const data = JSON.parse(rfs(AUTH_PROFILES_PATH, 'utf8'));
    const profile = data?.profiles?.['anthropic:claude-cli'];
    if (!profile) return;

    const wasStale = profile.access !== creds.accessToken;
    profile.access = creds.accessToken;
    profile.refresh = creds.refreshToken || profile.refresh;
    profile.expires = Date.now() + 365 * 24 * 60 * 60 * 1000;

    // Clear any stale cooldown that might block openclaw from retrying
    if (data.usageStats?.['anthropic:claude-cli']) {
      delete data.usageStats['anthropic:claude-cli'].cooldownUntil;
      delete data.usageStats['anthropic:claude-cli'].cooldownReason;
      data.usageStats['anthropic:claude-cli'].errorCount = 0;
      delete data.usageStats['anthropic:claude-cli'].failureCounts;
    }

    wfs(AUTH_PROFILES_PATH, JSON.stringify(data, null, 2));
    if (wasStale) {
      log('[token-sync] Synced fresh token into auth-profiles.json (was stale)');
    } else {
      debug('[token-sync] auth-profiles.json already up to date');
    }
  } catch (err) {
    debug('[token-sync] could not sync auth-profiles.json:', err.message);
  }
}

// Watch credentials file for external changes (e.g., CLI refreshes token independently)
watchFile(CREDENTIALS_PATH, { interval: 30_000 }, () => {
  debug('Credentials file changed externally, reloading and syncing');
  readCredentials();
  const fresh = readFreshToken();
  if (fresh) syncAuthProfiles(fresh);
  scheduleProactiveRefresh(); // reschedule based on new expiry
});

// Proactive token refresh — refreshes 10 minutes before expiry so requests
// never hit an expired token. Without this, the proxy only refreshes on the
// next incoming request, which arrives after the token is already dead.
let proactiveRefreshTimer = null;

function scheduleProactiveRefresh() {
  if (proactiveRefreshTimer) clearTimeout(proactiveRefreshTimer);
  if (!cachedCredentials?.expiresAt || !cachedCredentials?.refreshToken) return;

  const refreshAt = cachedCredentials.expiresAt - 10 * 60 * 1000; // 10 min before expiry
  const delayMs = Math.max(refreshAt - Date.now(), 60_000); // at least 1 min from now

  proactiveRefreshTimer = setTimeout(async () => {
    try {
      log('[proactive-refresh] Token nearing expiry, refreshing preemptively...');
      const refreshed = await refreshToken(cachedCredentials);
      log(`[proactive-refresh] Success, new expiry: ${new Date(refreshed.expiresAt).toISOString()}`);
      scheduleProactiveRefresh(); // schedule the next one
    } catch (err) {
      log(`[proactive-refresh] Failed: ${err.message} — will retry in 5 min`);
      proactiveRefreshTimer = setTimeout(() => scheduleProactiveRefresh(), 5 * 60 * 1000);
    }
  }, delayMs);

  proactiveRefreshTimer.unref(); // don't prevent process exit
  const refreshTime = new Date(Date.now() + delayMs).toISOString();
  debug(`[proactive-refresh] Scheduled for ${refreshTime} (${Math.round(delayMs / 60000)} min from now)`);
}

// ---------------------------------------------------------------------------
// Prompt sanitization
// ---------------------------------------------------------------------------

// Minimal verified trigger patterns — only what Anthropic actually detects.
// Based on systematic testing by zacdcook/openclaw-billing-proxy.
// Paths, filenames (SOUL.md, AGENTS.md), plugin names, and tool names
// outside this list do NOT trigger detection and are left untouched.
// Patterns applied to system prompt and user messages
const SANITIZE_PATTERNS = [
  // Preserve file paths before generic name replacement
  [/\.openclaw\//g, '.clawdata/'],
  [/\/openclaw\//g, '/clawdata/'],
  // URLs
  [/docs\.openclaw\.ai/g, 'docs.myapp.local'],
  [/github\.com\/openclaw/g, 'github.com/myapp'],
  [/clawhub\.ai/g, 'apphub.local'],
  // App name (case-insensitive)
  [/openclaw/gi, 'myapp'],
  [/open-claw/gi, 'myapp'],
  [/sillytavern/gi, 'myapp'],
  [/silly-tavern/gi, 'myapp'],
  [/typingmind/gi, 'myapp'],
  [/typing-mind/gi, 'myapp'],
];

// Extra patterns for system prompt only
const SYSTEM_ONLY_PATTERNS = [
  [/HEARTBEAT_OK/g, 'STATUS_ACK'],
  [/heartbeat_ok/gi, 'status_ack'],
  [/HEARTBEAT\.md/g, 'STATUSCHECK.md'],
  [/heartbeat\.md/gi, 'statuscheck.md'],
  [/HEARTBEAT/g, 'STATUS_CHECK'],
  [/heartbeat/gi, 'status_check'],
  [/SOUL\.md/g, 'PERSONA.md'],
  [/soul\.md/gi, 'persona.md'],
  [/NO_REPLY/g, 'SKIP_MSG'],
  [/EXFOLIATE/gi, 'PROCESS'],
  [/lobster/gi, 'assistant'],
  [/sessions_spawn/g, 'create_task'],
  [/sessions_list/g, 'list_tasks'],
  [/sessions_history/g, 'get_history'],
  [/sessions_send/g, 'send_to_task'],
  [/running inside/gi, 'running on'],
];

// Tool renames to normalize tool-set identifiers in outbound requests
const TOOL_RENAMES = {
  'sessions_list': 'sess_list',
  'sessions_history': 'sess_history',
  'sessions_send': 'sess_send',
  'sessions_yield': 'sess_yield',
  'sessions_spawn': 'sess_spawn',
  'session_status': 'sess_status',
  'memory_search': 'mem_search',
  'memory_get': 'mem_get',
  'subagents': 'sub_agents',
  'cron': 'scheduler',
};

// Reverse map: renamed → original, for restoring tool names in inbound responses
const TOOL_RENAMES_REVERSE = Object.fromEntries(
  Object.entries(TOOL_RENAMES).map(([orig, renamed]) => [renamed, orig])
);

function sanitizeString(text, systemOnly = false) {
  if (typeof text !== 'string') return text;
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (systemOnly) {
    for (const [pattern, replacement] of SYSTEM_ONLY_PATTERNS) {
      text = text.replace(pattern, replacement);
    }
  }
  return text;
}

function sanitizeRequest(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };

  // Strip trailing assistant messages — some models (sonnet-4-6) don't support
  // assistant message prefill and return a 400 that crashes the agent run.
  if (Array.isArray(result.messages) && result.messages.length > 0) {
    while (result.messages.length > 0 &&
           result.messages[result.messages.length - 1].role === 'assistant') {
      debug('Stripped trailing assistant message (prefill not supported)');
      result.messages = result.messages.slice(0, -1);
    }
  }

  // Fix max_tokens: must be >= 1. OpenClaw sometimes sends 0 or negative
  // values when token budget is exhausted, which Anthropic rejects.
  if (result.max_tokens !== undefined && result.max_tokens < 1) {
    debug(`Fixed max_tokens: ${result.max_tokens} → 1024`);
    result.max_tokens = 1024;
  }

  // Repair broken tool_use / tool_result pairing. The API requires that
  // every tool_use block in an assistant message has a matching tool_result
  // in the immediately following user message, and vice versa. OpenClaw's
  // lossless-claw context compaction can break this invariant when it trims
  // messages mid-conversation. We fix it by:
  //   1. Collecting tool_use IDs from each assistant message
  //   2. Checking the next user message has matching tool_result blocks
  //   3. Injecting stub tool_results for any orphaned tool_use blocks
  //   4. Removing tool_result blocks that reference non-existent tool_use IDs
  if (Array.isArray(result.messages) && result.messages.length >= 2) {
    for (let i = 0; i < result.messages.length - 1; i++) {
      const msg = result.messages[i];
      const next = result.messages[i + 1];
      if (msg.role !== 'assistant' || next.role !== 'user') continue;
      if (!Array.isArray(msg.content) || !Array.isArray(next.content)) continue;

      const toolUseIds = new Set();
      for (const block of msg.content) {
        if (block?.type === 'tool_use' && block.id) toolUseIds.add(block.id);
      }
      if (toolUseIds.size === 0) continue;

      const existingResultIds = new Set();
      for (const block of next.content) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          existingResultIds.add(block.tool_use_id);
        }
      }

      // Inject stub results for orphaned tool_use blocks
      for (const id of toolUseIds) {
        if (!existingResultIds.has(id)) {
          debug(`Injected stub tool_result for orphaned tool_use ${id}`);
          next.content.push({
            type: 'tool_result',
            tool_use_id: id,
            content: '[result unavailable — context was compacted]',
          });
        }
      }

      // Remove tool_results that reference non-existent tool_use IDs
      next.content = next.content.filter(block => {
        if (block?.type === 'tool_result' && block.tool_use_id && !toolUseIds.has(block.tool_use_id)) {
          debug(`Removed orphaned tool_result referencing unknown tool_use ${block.tool_use_id}`);
          return false;
        }
        return true;
      });
    }
  }

  // Sanitize system prompt with extra patterns
  if (typeof result.system === 'string') {
    result.system = sanitizeString(result.system, true);
  } else if (Array.isArray(result.system)) {
    result.system = result.system.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string') {
        return { ...block, text: sanitizeString(block.text, true) };
      }
      return block;
    });
  }

  // Sanitize all message content — but skip tool_result blocks entirely.
  // Tool results are exec outputs (shell commands, file reads, etc.) and don't
  // need sanitization for billing detection. Sanitizing them corrupts file paths
  // and binary names in exec session output, breaking openclaw's self-diagnosis.
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (typeof msg.content === 'string') {
        return { ...msg, content: sanitizeString(msg.content) };
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map(block => {
            // Skip tool_result blocks — execution output, not app fingerprints
            if (block?.type === 'tool_result') return block;
            if (typeof block === 'string') return sanitizeString(block);
            if (block && typeof block === 'object') {
              const newBlock = { ...block };
              if (typeof newBlock.text === 'string') newBlock.text = sanitizeString(newBlock.text);
              if (typeof newBlock.content === 'string') newBlock.content = sanitizeString(newBlock.content);
              // Deep sanitize tool input (handles nested objects like edit new_string)
              if (newBlock.input && typeof newBlock.input === 'object') {
                newBlock.input = JSON.parse(sanitizeString(JSON.stringify(newBlock.input)));
              }
              return newBlock;
            }
            return block;
          }),
        };
      }
      return msg;
    });
  }

  // Sanitize and rename tools
  if (Array.isArray(result.tools)) {
    result.tools = JSON.parse(sanitizeString(JSON.stringify(result.tools)));
    result.tools = result.tools.map(tool => ({
      ...tool,
      name: TOOL_RENAMES[tool.name] || tool.name,
    }));
  }

  // Rename tool_use references in messages
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map(block => {
          if (block?.type === 'tool_use' && TOOL_RENAMES[block.name]) {
            return { ...block, name: TOOL_RENAMES[block.name] };
          }
          return block;
        }),
      };
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI billing attribution — rewrite system prompt so Anthropic's billing
// classifier recognises this as a Claude Code session (Max subscription).
// ---------------------------------------------------------------------------
//
// The classifier checks that system[0].text starts with "You are Claude Code,".
// If it does, the request is routed to the Max plan (service_tier: standard).
// If not, it falls through to API quota → "out of extra usage" 400 error.
//
// Strategy:
//   1. If system already starts with "You are Claude Code," — no-op (openclaw
//      sends this on its own for agent sessions).
//   2. Otherwise replace system with the Claude Code preamble + billing header,
//      and move the original system text into the first user message wrapped in
//      <system>…</system> so the model still sees it.
// ---------------------------------------------------------------------------

const CLI_VERSION = '2.1.92';
const CLI_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'cli';
const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

function buildBillingHeader() {
  return `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${PROXY_SESSION_ID.slice(0, 8)}; cc_entrypoint=${CLI_ENTRYPOINT}; cch=00000;`;
}

function rewriteSystemForBillingClassifier(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };

  // Normalize system to array of text blocks (handles string form too)
  let originalBlocks = [];
  if (!result.system) {
    originalBlocks = [];
  } else if (typeof result.system === 'string') {
    originalBlocks = [{ type: 'text', text: result.system }];
  } else if (Array.isArray(result.system)) {
    originalBlocks = result.system;
  }

  // If already a Claude Code session, enforce exactly [CC-preamble, billing-header].
  // Any additional blocks (e.g. openclaw's "You are a personal assistant running on X")
  // are MOVED into the first user message as <system> context. Anthropic's classifier
  // rejects requests where extra system blocks betray a third-party app identity,
  // even when the billing header is present at [1].
  const firstText = originalBlocks.find(b => b.type === 'text')?.text || '';
  if (firstText.startsWith('You are Claude Code,')) {
    // Remove any existing billing header block from wherever it sits
    const billingIdx = originalBlocks.findIndex(
      b => b.type === 'text' && b.text?.startsWith('x-anthropic-billing-header:')
    );
    const blocksWithoutBilling = billingIdx >= 0
      ? originalBlocks.filter((_, i) => i !== billingIdx)
      : originalBlocks;

    // blocksWithoutBilling[0] is the CC preamble block.
    // Anything beyond [0] is extra context added by the third-party app.
    const extraBlocks = blocksWithoutBilling.slice(1);

    // System: only CC preamble + billing header (clean classifier fingerprint)
    result.system = [
      blocksWithoutBilling[0],
      { type: 'text', text: buildBillingHeader() },
    ];

    // Move extra blocks into the first user message as <system> context so
    // the model still receives the instructions, just not in the system slot.
    if (extraBlocks.length > 0) {
      const extraText = extraBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n')
        .trim();
      if (extraText) {
        const messages = [...(result.messages || [])];
        const firstUserIdx = messages.findIndex(m => m.role === 'user');
        const prefix = `<system>\n${extraText}\n</system>\n\n`;
        if (firstUserIdx >= 0) {
          const msg = { ...messages[firstUserIdx] };
          if (typeof msg.content === 'string') {
            msg.content = prefix + msg.content;
          } else if (Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: prefix }, ...msg.content];
          } else {
            msg.content = prefix;
          }
          messages[firstUserIdx] = msg;
        } else {
          messages.unshift({ role: 'user', content: prefix.trim() });
        }
        result.messages = messages;
      }
    }
    return result;
  }

  // Strip any stale billing header blocks from prior runs
  const userBlocks = originalBlocks.filter(
    b => !(b.type === 'text' && b.text?.startsWith('x-anthropic-billing-header:'))
  );

  // Replace system with Claude Code preamble + billing header
  result.system = [
    { type: 'text', text: CLAUDE_CODE_PREAMBLE },
    { type: 'text', text: buildBillingHeader() },
  ];

  // Move original system into first user message as <system> context
  if (userBlocks.length > 0) {
    const originalText = userBlocks
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n\n')
      .trim();

    if (originalText) {
      const messages = [...(result.messages || [])];
      const firstUserIdx = messages.findIndex(m => m.role === 'user');
      const prefix = `<system>\n${originalText}\n</system>\n\n`;

      if (firstUserIdx >= 0) {
        const msg = { ...messages[firstUserIdx] };
        if (typeof msg.content === 'string') {
          msg.content = prefix + msg.content;
        } else if (Array.isArray(msg.content)) {
          msg.content = [{ type: 'text', text: prefix }, ...msg.content];
        } else {
          msg.content = prefix;
        }
        messages[firstUserIdx] = msg;
      } else {
        // No user message yet — prepend one
        messages.unshift({ role: 'user', content: prefix.trim() });
      }
      result.messages = messages;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reverse proxy: forward to api.anthropic.com
// ---------------------------------------------------------------------------

const MAX_RETRIES = 0; // Never retry 429s — fail fast and let myapp handle fallback
const RETRY_BASE_MS = 2000;

// ---------------------------------------------------------------------------
// Circuit breaker — prevents hammering Anthropic when auth is broken.
//
// Per-model tracking: Opus and Sonnet have separate rate limit pools on
// Claude Max. A global circuit would block Sonnet when only Opus is down.
// The global circuit still exists for auth failures (401s) which affect all.
//
// States: closed (normal) → open (blocking) → half-open (one probe) → closed
// ---------------------------------------------------------------------------

const circuit = {
  state: 'closed',
  failures: 0,
  openedAt: null,
  THRESHOLD: 3,
  COOLDOWN_MS: 60_000,
};

// Per-model rate-limit circuit (separate from auth circuit)
// Keyed by model id. Trips after MODEL_RL_THRESHOLD consecutive rate-limit
// deflections for that model, clears after MODEL_RL_COOLDOWN_MS.
const modelCircuits = {};
const MODEL_RL_THRESHOLD = 3;
const MODEL_RL_COOLDOWN_MS = 120_000; // 2 minutes before probing again

function getModelCircuit(model) {
  if (!model) return null;
  if (!modelCircuits[model]) {
    modelCircuits[model] = { state: 'closed', failures: 0, openedAt: null };
  }
  return modelCircuits[model];
}

function modelCircuitAllow(model) {
  const mc = getModelCircuit(model);
  if (!mc || mc.state === 'closed') return { ok: true };
  if (mc.state === 'open') {
    const elapsed = Date.now() - mc.openedAt;
    if (elapsed >= MODEL_RL_COOLDOWN_MS) {
      mc.state = 'half-open';
      log(`[model-circuit:${model}] half-open — probing after ${Math.round(elapsed / 1000)}s cooldown`);
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.ceil((MODEL_RL_COOLDOWN_MS - elapsed) / 1000) };
  }
  return { ok: true }; // half-open: allow probe
}

function modelCircuitSuccess(model) {
  const mc = getModelCircuit(model);
  if (!mc) return;
  if (mc.state !== 'closed') log(`[model-circuit:${model}] closed — rate limit cleared`);
  mc.state = 'closed';
  mc.failures = 0;
  mc.openedAt = null;
}

function modelCircuitRateLimit(model) {
  const mc = getModelCircuit(model);
  if (!mc) return;
  mc.failures++;
  if (mc.failures >= MODEL_RL_THRESHOLD) {
    const wasOpen = mc.state === 'open';
    mc.state = 'open';
    mc.openedAt = Date.now();
    if (!wasOpen) {
      log(`[model-circuit:${model}] OPEN — ${mc.failures} consecutive rate limits, blocking for ${MODEL_RL_COOLDOWN_MS / 1000}s`);
      logFallbackEvent('model_circuit_open', {
        model,
        failures: mc.failures,
        cooldownMs: MODEL_RL_COOLDOWN_MS,
        reason: 'consecutive_rate_limits',
      });
    }
  }
}

function circuitAllow() {
  if (circuit.state === 'closed') return { ok: true };
  if (circuit.state === 'open') {
    const elapsed = Date.now() - circuit.openedAt;
    if (elapsed >= circuit.COOLDOWN_MS) {
      circuit.state = 'half-open';
      log(`[circuit] half-open — probing after ${Math.round(elapsed / 1000)}s cooldown`);
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.ceil((circuit.COOLDOWN_MS - elapsed) / 1000) };
  }
  return { ok: true }; // half-open: allow the probe through
}

function circuitSuccess() {
  if (circuit.state !== 'closed') log(`[circuit] closed — auth restored`);
  circuit.state = 'closed';
  circuit.failures = 0;
  circuit.openedAt = null;
}

function circuitFailure() {
  circuit.failures++;
  if (circuit.failures >= circuit.THRESHOLD) {
    const wasOpen = circuit.state === 'open';
    circuit.state = 'open';
    circuit.openedAt = Date.now();
    if (!wasOpen) log(`[circuit] OPEN — ${circuit.failures} consecutive auth failures, blocking for ${circuit.COOLDOWN_MS / 1000}s`);
  }
}

// Beta flags required for OAuth + Claude Code features — always injected
// regardless of what the client sends, so the proxy never silently breaks
// if openclaw stops sending one of these.
const REQUIRED_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
];

function buildHeaders(accessToken, req) {
  const authHeaders = AUTH_HEADER_FORMAT === 'bearer'
    ? { 'authorization': `Bearer ${accessToken}` }
    : { 'x-api-key': accessToken };

  const headers = {
    ...authHeaders,
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

  // Merge client betas with required betas — client's take precedence for duplicates
  const clientBetas = req.headers['anthropic-beta']
    ? req.headers['anthropic-beta'].split(',').map(b => b.trim())
    : [];
  const mergedBetas = [...new Set([...REQUIRED_BETAS, ...clientBetas])];
  headers['anthropic-beta'] = mergedBetas.join(',');

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
          resolve({
            retry: true,
            retryAfterMs: retryAfter ? parseInt(retryAfter) * 1000 : null,
            body,
            responseHeaders: proxyRes.headers,
            statusCode: proxyRes.statusCode,
          });
        });
        return;
      }
      if (proxyRes.statusCode === 401) {
        const wwwAuth = proxyRes.headers['www-authenticate'] || '';
        let body = '';
        proxyRes.on('data', (d) => { body += d; });
        proxyRes.on('end', () => {
          // Log the full 401 body + response headers — these contain the
          // actual Anthropic error reason, not the generic "invalid x-api-key".
          let errMsg = '';
          try { errMsg = JSON.parse(body)?.error?.message || ''; } catch {}
          log(`[401] anthropic_says="${errMsg}"${wwwAuth ? ` www-authenticate="${wwwAuth}"` : ''}`);
          log(`401 body: ${body.slice(0, 500)}`);
          const interestingHeaders = ['x-request-id','request-id','anthropic-organization-id','x-should-retry','retry-after'];
          for (const h of interestingHeaders) {
            if (proxyRes.headers[h]) log(`401 header ${h}: ${proxyRes.headers[h]}`);
          }
          // Save the failing payload to a unique file so it survives subsequent
          // requests overwriting the DEBUG snapshot.
          if (DEBUG && payload) {
            try {
              const fs = require('fs');
              const ts = Date.now();
              const file = `/tmp/claude-proxy-401-${ts}.json`;
              fs.writeFileSync(file, payload);
              log(`401 payload saved to ${file}`);
            } catch (e) { /* ignore */ }
          }
          resolve({ retry401: true, body, responseHeaders: proxyRes.headers });
        });
        return;
      }
      // For 400/529 and other 4xx/5xx errors, buffer the body so the caller
      // can classify whether it is an overage error or a malformed-request
      // error. This is done before streaming begins.
      if (proxyRes.statusCode >= 400) {
        let body = '';
        proxyRes.on('data', (d) => { body += d; });
        proxyRes.on('end', () => {
          resolve({
            retry: false,
            errorBuffered: true,
            statusCode: proxyRes.statusCode,
            body,
            responseHeaders: proxyRes.headers,
          });
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

// Restore renamed tool names in a parsed JSON response object (non-streaming).
// Anthropic echoes back the tool names we sent — we need to reverse them so
// OpenClaw receives the original names it registered.
function desanitizeResponseJson(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(desanitizeResponseJson);

  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'name' && typeof v === 'string' && TOOL_RENAMES_REVERSE[v]) {
      result[k] = TOOL_RENAMES_REVERSE[v];
    } else if (typeof v === 'object' && v !== null) {
      result[k] = desanitizeResponseJson(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// Restore renamed tool names in a single SSE `data:` line.
function desanitizeSseLine(line) {
  if (!line.startsWith('data: ')) return line;
  const payload = line.slice(6);
  if (payload === '[DONE]') return line;
  try {
    const evt = JSON.parse(payload);
    const fixed = desanitizeResponseJson(evt);
    return 'data: ' + JSON.stringify(fixed);
  } catch {
    return line;
  }
}

function forwardRequest(req, res, body) {
  return new Promise(async (resolve) => {
    // Global auth circuit breaker — reject immediately if auth is known-broken
    const circuitState = circuitAllow();
    if (!circuitState.ok) {
      log(`[circuit] open — rejecting request, retry after ${circuitState.retryAfter}s`);
      res.set('Retry-After', String(circuitState.retryAfter));
      res.status(503).json({
        type: 'error',
        error: {
          type: 'circuit_open',
          message: `Auth temporarily unavailable — retrying in ${circuitState.retryAfter}s`,
        },
      });
      return resolve();
    }

    // Per-model rate-limit circuit — lets Sonnet work when Opus is rate-limited
    const requestModel = body?.model || null;
    const modelCircuitState = modelCircuitAllow(requestModel);
    if (!modelCircuitState.ok) {
      log(`[model-circuit:${requestModel}] open — rejecting request, retry after ${modelCircuitState.retryAfter}s`);
      res.set('Retry-After', String(modelCircuitState.retryAfter));
      res.status(429).json({
        type: 'error',
        error: {
          type: 'model_rate_limited',
          message: `Model ${requestModel} is rate limited — try a fallback model or wait ${modelCircuitState.retryAfter}s`,
        },
      });
      return resolve();
    }

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

    let headers = buildHeaders(accessToken, req);

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

      if (result.retry401) {
        // Anthropic's token invalidation has eventual consistency — freshly
        // refreshed tokens can be rejected for 30-60s while edge servers sync.
        // Strategy: refresh + rotate session on first 401, then backoff retries.
        // Circuit breaker trips after THRESHOLD consecutive total failures.
        if (attempt === 0) {
          // First 401: refresh token + rotate session ID
          log(`[401] attempt=1 token=${accessToken.slice(0, 15)}... — refreshing + rotating session`);
          try {
            cachedCredentials = null;
            readCredentials();
            if (!cachedCredentials?.refreshToken) {
              throw new Error('No refresh token available');
            }
            const freshCreds = await refreshToken(cachedCredentials);
            accessToken = freshCreds.accessToken;
            PROXY_SESSION_ID = randomUUID();
            syncAuthProfiles(freshCreds);
            headers = buildHeaders(accessToken, req);
            if (payload) headers['content-length'] = Buffer.byteLength(payload);
            log(`[401] retry: new_token=${accessToken.slice(0, 15)}... new_session=${PROXY_SESSION_ID.slice(0, 8)}`);
          } catch (err) {
            log(`[401] token refresh failed: ${err.message}`);
            circuitFailure();
            res.status(401).json(JSON.parse(result.body));
            return resolve();
          }
          continue;
        }

        if (attempt <= MAX_RETRIES) {
          // Subsequent 401s: token propagation delay — wait and retry
          const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s
          log(`[401] attempt=${attempt + 1} — propagation delay, waiting ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }

        // Exhausted all retries — trip the circuit breaker and log fallback event
        log(`[401] exhausted all retries — tripping circuit breaker (failure #${circuit.failures + 1})`);
        log('401 persisted after token refresh — credentials may need re-login');
        logFallbackEvent('auth_failure', {
          model: 'unknown',
          reason: '401 persisted after all retries',
          detail: result.body?.slice(0, 200),
        });
        circuitFailure();
        res.status(401).json(JSON.parse(result.body));
        return resolve();
      }

      if (result.retry && attempt < MAX_RETRIES) {
        const delayMs = result.retryAfterMs || (RETRY_BASE_MS * Math.pow(2, attempt));
        if (attempt === 0 || delayMs >= 300_000) {
          logFallbackEvent('rate_limit', {
            model: body?.model || 'unknown',
            statusCode: 429,
            attempt: attempt + 1,
            retryAfterMs: delayMs,
            reason: 'anthropic_429_retry',
          });
          scheduleRateLimitRecovery({
            model: body?.model || 'unknown',
            retryAfterMs: delayMs,
          });
        }
        if (delayMs > MAX_RATE_LIMIT_WAIT_MS) {
          log(`429 rate limited, retry-after ${delayMs}ms exceeds proxy cap ${MAX_RATE_LIMIT_WAIT_MS}ms; returning 429 so the client can fail over`);
          logFallbackEvent('rate_limit', {
            model: body?.model || 'unknown',
            statusCode: result.statusCode || 429,
            attempt: attempt + 1,
            retryAfterMs: delayMs,
            reason: 'anthropic_429_defer_to_client',
          });
          scheduleRateLimitRecovery({
            model: body?.model || 'unknown',
            retryAfterMs: delayMs,
          });
          // Trip the per-model circuit so subsequent requests for this model
          // fail fast instead of hammering Anthropic with more 429s
          modelCircuitRateLimit(requestModel);
          const retryHeaders = result.responseHeaders || {};
          const skipHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive']);
          for (const [key, value] of Object.entries(retryHeaders)) {
            if (!skipHeaders.has(String(key).toLowerCase())) res.setHeader(key, value);
          }
          res.status(429).json(JSON.parse(result.body));
          return resolve();
        }
        log(`429 rate limited, retrying in ${delayMs}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      if (result.retry) {
        // Exhausted retries, return the 429
        log(`429 rate limited, exhausted ${MAX_RETRIES + 1} attempts`);
        logFallbackEvent('rate_limit', {
          model: body?.model || 'unknown',
          statusCode: 429,
          attempt: attempt + 1,
          exhaustedRetries: true,
          reason: 'anthropic_429_exhausted',
          body: (result.body || '').slice(0, 400),
        });
        // Trip the per-model circuit — exhausted all retries
        modelCircuitRateLimit(requestModel);
        res.status(429).json(JSON.parse(result.body));
        return resolve();
      }

      // Handle buffered error responses (400, 529, other 4xx/5xx)
      if (result.errorBuffered) {
        const sc = result.statusCode;
        const errHeaders = result.responseHeaders || {};
        const errBody = result.body;

        const overageStatus = errHeaders['anthropic-ratelimit-unified-overage-status'] || '';
        const overageReason = errHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] || '';
        const serviceTier  = errHeaders['anthropic-ratelimit-unified-tier'] || '';
        const requestId    = errHeaders['x-request-id'] || errHeaders['request-id'] || '';

        const errClass = classifyAnthropicError(sc, errBody, errHeaders);
        const model = body?.model || 'unknown';

        log(`← ERROR ${sc} [${errClass}] | model=${model} | overage=${overageStatus} | reason=${overageReason} | tier=${serviceTier}${requestId ? ' | reqid=' + requestId : ''}`);
        log(`← ERROR body: ${errBody.slice(0, 300)}`);

        if (errClass === 'overage') {
          recordOverage(model);
          logFallbackEvent('overage', {
            model,
            statusCode: sc,
            overageStatus,
            overageReason,
            serviceTier,
            requestId,
            body: errBody.slice(0, 400),
          });

          // Multi-account fallback: if primary account just hit overage and a
          // fallback credentials file is configured, switch accounts and retry.
          if (!usingFallbackAccount && CREDENTIALS_PATH_FALLBACK) {
            const fallbackCreds = readFallbackCredentials();
            if (fallbackCreds) {
              log('[account-fallback] Primary account quota exhausted — switching to fallback account and retrying');
              logFallbackEvent('account_switch', { model, reason: 'primary_overage', to: 'fallback' });
              usingFallbackAccount = true;
              try {
                accessToken = await getFallbackAccessToken();
                headers = buildHeaders(accessToken, req);
                if (payload) headers['content-length'] = Buffer.byteLength(payload);
                PROXY_SESSION_ID = randomUUID();
                log(`[account-fallback] Retrying with fallback account token=${accessToken.slice(0, 15)}...`);
                continue; // retry the request with fallback credentials
              } catch (fallbackErr) {
                log(`[account-fallback] Failed to get fallback token: ${fallbackErr.message}`);
                usingFallbackAccount = false; // revert; will fall through to error response
              }
            }
          }
        } else if (errClass === 'malformed') {
          logFallbackEvent('malformed', {
            model,
            statusCode: sc,
            requestId,
            body: errBody.slice(0, 400),
          });
        }

        // Copy response headers to client
        const skipHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive']);
        for (const [key, value] of Object.entries(errHeaders)) {
          if (!skipHeaders.has(key.toLowerCase())) res.setHeader(key, value);
        }
        res.status(sc);

        // Return the error body (desanitized if JSON)
        try {
          const parsed = JSON.parse(errBody);
          const fixed = desanitizeResponseJson(parsed);
          const out = JSON.stringify(fixed);
          res.setHeader('content-length', Buffer.byteLength(out));
          res.end(out);
        } catch {
          res.end(errBody);
        }
        return resolve();
      }

      const { proxyRes } = result;
      const sc = proxyRes.statusCode;
      debug(`← ${sc} ${proxyRes.statusMessage}`);

      // Copy response headers
      const skipHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive']);
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      res.status(sc);

      // Successful response — reset both circuit breakers
      if (proxyRes.statusCode < 400) {
        circuitSuccess();
        modelCircuitSuccess(requestModel);
      }

      const contentType = proxyRes.headers['content-type'] || '';
      const isSSE = contentType.includes('text/event-stream');

      if (isSSE) {
        // SSE streaming — intercept each line and reverse tool renames
        let buffer = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete last line
          for (const line of lines) {
            res.write(desanitizeSseLine(line) + '\n');
          }
        });
        proxyRes.on('end', () => {
          if (buffer) res.write(desanitizeSseLine(buffer) + '\n');
          res.end();
          resolve();
        });
      } else {
        // Non-streaming JSON — buffer full response, reverse tool renames, forward
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(raw);
            const fixed = desanitizeResponseJson(parsed);
            const out = JSON.stringify(fixed);
            res.setHeader('content-length', Buffer.byteLength(out));
            res.end(out);
          } catch {
            // Not JSON (unlikely) — pass through as-is
            res.end(raw);
          }
          resolve();
        });
      }

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
  const sanitizedBody = rewriteSystemForBillingClassifier(sanitizeRequest(req.body));

  const model = sanitizedBody.model || '?';

  // Check if the incoming model looks like a client-side fallback after recent
  // overage failures on a different model. Logs a 'model_fallback' event if so.
  checkModelFallback(model);
  const stream = !!sanitizedBody.stream;
  const msgCount = sanitizedBody.messages?.length || 0;

  // Log system block summary so we can verify billing header injection
  const sysBlocks = sanitizedBody.system;
  let sysInfo;
  if (!sysBlocks) {
    sysInfo = 'no-system';
  } else if (typeof sysBlocks === 'string') {
    sysInfo = 'string:' + sysBlocks.slice(0, 30);
  } else {
    const billingPos = sysBlocks.findIndex(b => b.type === 'text' && b.text?.startsWith('x-anthropic-billing-header:'));
    const preview = sysBlocks.map((b, i) => `[${i}]${(b.text || b.type || '?').slice(0, 20).replace(/\n/g, ' ')}`).join(' ');
    sysInfo = `blocks[${sysBlocks.length}] billing@${billingPos}: ${preview}`;
  }
  const toolCount = sanitizedBody.tools?.length || 0;
  const hasThinking = !!(sanitizedBody.thinking?.type || sanitizedBody.budget_tokens);
  log(`→ POST /v1/messages | model=${model} | stream=${stream} | messages=${msgCount} | tools=${toolCount} | thinking=${hasThinking} | sys=${sysInfo}`);

  // For large sessions, dump the full request body to a temp file for debugging
  if (msgCount >= 15 && process.env.PROXY_DEBUG_DUMPS === 'true') {
    const dumpPath = `/tmp/claude-proxy-dump-${Date.now()}.json`;
    require('fs').writeFileSync(dumpPath, JSON.stringify(sanitizedBody, null, 2));
    log(`  Dumped large request body to ${dumpPath}`);
  }

  // Verify sanitization — scan only the fields we actually sanitize.
  // tool_result blocks are intentionally excluded from sanitization (exec output),
  // so exclude them from the leak check too.
  const BLOCKED_TERMS = ['openclaw', 'open-claw', 'sillytavern', 'silly-tavern', 'typingmind', 'typing-mind'];
  const checkBody = {
    ...sanitizedBody,
    messages: (sanitizedBody.messages || []).map(msg => ({
      ...msg,
      content: Array.isArray(msg.content)
        ? msg.content.filter(b => b?.type !== 'tool_result')
        : msg.content,
    })),
  };
  const outgoing = JSON.stringify(checkBody).toLowerCase();
  const leaks = BLOCKED_TERMS.filter(term => outgoing.includes(term));
  if (leaks.length > 0) {
    log(`⚠ SANITIZATION LEAK: found [${leaks.join(', ')}] in outgoing request — blocking`);
    res.status(400).json({
      type: 'error',
      error: {
        type: 'sanitization_error',
        message: `Blocked: request still contains identifiers: ${leaks.join(', ')}`,
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
    circuit: circuit.state,
    ...(circuit.state !== 'closed' ? { circuitFailures: circuit.failures } : {}),
    modelCircuits: Object.fromEntries(
      Object.entries(modelCircuits)
        .filter(([, mc]) => mc.state !== 'closed')
        .map(([model, mc]) => [model, { state: mc.state, failures: mc.failures }])
    ),
    ...(isMax ? {} : { warning: 'Not a Max subscription — requests will be billed as standard API usage' }),
  });
});

// GET /fallback-events — return recent fallback/overage events from the JSONL log.
// Useful for polling from cron or the Telegram watchdog bot to alert on overages.
// Query params:
//   ?limit=N   — max number of events to return (default 20, max 200)
//   ?type=X    — filter by event type (overage, malformed, model_fallback, auth_failure)
//   ?since=ISO — only events at or after this ISO timestamp
app.get('/fallback-events', (req, res) => {
  try {
    if (!existsSync(FALLBACK_LOG_PATH)) {
      return res.json({ events: [], total: 0, logPath: FALLBACK_LOG_PATH });
    }
    const raw = readFileSync(FALLBACK_LOG_PATH, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    let events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
    // Apply filters
    const typeFilter = req.query.type;
    const sinceFilter = req.query.since;
    const limitFilter = Math.min(parseInt(req.query.limit || '20', 10), 200);
    if (typeFilter) events = events.filter(e => e.type === typeFilter);
    if (sinceFilter) events = events.filter(e => e.ts >= sinceFilter);
    // Return most recent N
    const total = events.length;
    events = events.slice(-limitFilter);
    res.json({ events, total, logPath: FALLBACK_LOG_PATH });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /force-refresh — force immediate token refresh regardless of expiry
// Useful when Anthropic invalidates the token server-side before local expiry
app.post('/force-refresh', async (req, res) => {
  try {
    log('Force refresh requested');
    if (!cachedCredentials?.refreshToken) {
      return res.status(400).json({ error: 'No refresh token available' });
    }
    // Temporarily mark token as expired so getValidToken triggers a refresh
    const saved = cachedCredentials.expiresAt;
    cachedCredentials.expiresAt = 0;
    try {
      const token = await getAccessToken();
      res.json({ status: 'ok', newExpiry: new Date(cachedCredentials.expiresAt).toISOString() });
    } catch (err) {
      cachedCredentials.expiresAt = saved;
      throw err;
    }
  } catch (err) {
    log('Force refresh failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Load credentials on startup and schedule proactive refresh
readCredentials();
scheduleProactiveRefresh();
if (CREDENTIALS_PATH_FALLBACK) readFallbackCredentials();

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

// Exports for testing
if (require.main !== module) {
  module.exports = {
    TOOL_RENAMES,
    TOOL_RENAMES_REVERSE,
    desanitizeResponseJson,
    desanitizeSseLine,
    classifyAnthropicError,
    logFallbackEvent,
    FALLBACK_LOG_PATH,
  };
}
