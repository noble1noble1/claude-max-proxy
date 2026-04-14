#!/usr/bin/env node

/**
 * fallback-alert.js — Telegram alert watcher for claude-max-proxy fallback events
 *
 * Tails ~/.claude-max-proxy/fallback-events.jsonl and sends Telegram alerts
 * for critical events (overage, auth_failure, model_fallback).
 *
 * Runs as a separate process alongside the proxy. Keeps the proxy code clean
 * (no Telegram dependency in the proxy itself).
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN  — Bot token (reads from openclaw.json if not set)
 *   TELEGRAM_CHAT_ID    — Chat ID to send alerts to (default: BronHQ group)
 *   TELEGRAM_THREAD_ID  — Topic/thread ID (default: Bron Dev topic 12692)
 *   FALLBACK_LOG_PATH   — Path to JSONL (default: ~/.claude-max-proxy/fallback-events.jsonl)
 *   COOLDOWN_MS         — Minimum ms between alerts of same type (default: 300000 = 5min)
 */

const { readFileSync, watchFile, statSync, existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const https = require('https');

// --- Config ---
const FALLBACK_LOG_PATH = process.env.FALLBACK_LOG_PATH ||
  join(homedir(), '.claude-max-proxy', 'fallback-events.jsonl');

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003763475144';
const TELEGRAM_THREAD_ID = process.env.TELEGRAM_THREAD_ID || '12692';
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '300000', 10); // 5 min

// Resolve bot token: env > openclaw.json
function getBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config?.channels?.telegram?.botToken;
  } catch {
    return null;
  }
}

const BOT_TOKEN = getBotToken();
if (!BOT_TOKEN) {
  console.error('[fallback-alert] No Telegram bot token found. Set TELEGRAM_BOT_TOKEN or configure openclaw.json');
  process.exit(1);
}

// --- State ---
let lastFileSize = 0;
const lastAlertTime = {}; // type -> timestamp

// --- Telegram ---
function sendTelegramAlert(text) {
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    message_thread_id: parseInt(TELEGRAM_THREAD_ID, 10),
    text,
    parse_mode: 'HTML',
    disable_notification: false,
  });

  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error(`[fallback-alert] Telegram API error ${res.statusCode}: ${body}`);
      } else {
        console.log(`[fallback-alert] Alert sent: ${text.substring(0, 60)}...`);
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[fallback-alert] Telegram request failed: ${err.message}`);
  });

  req.write(payload);
  req.end();
}

// --- Event formatting ---
const EVENT_EMOJI = {
  overage: '🔴',
  auth_failure: '🔑',
  model_fallback: '⚠️',
  malformed: '🟡',
  rate_limit: '🟠',
};

const ALERT_EVENTS = new Set(['overage', 'auth_failure', 'model_fallback']);

function formatEvent(event) {
  const emoji = EVENT_EMOJI[event.type] || '❓';
  const time = new Date(event.ts).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
  });

  switch (event.type) {
    case 'overage':
      return `${emoji} <b>Claude quota exhausted</b>\n` +
        `Time: ${time} ET\n` +
        `Model: ${event.model || 'unknown'}\n` +
        `Reason: ${event.reason || 'quota/overage'}\n` +
        `⏰ Resets ~midnight PT daily`;

    case 'auth_failure':
      return `${emoji} <b>Proxy auth failure</b>\n` +
        `Time: ${time} ET\n` +
        `Token refresh failed after retries.\n` +
        `Fix: Check ~/.claude/.credentials.json or re-auth Claude CLI`;

    case 'model_fallback':
      return `${emoji} <b>Model fallback detected</b>\n` +
        `Time: ${time} ET\n` +
        `From: ${event.expected_model || 'Opus'} → ${event.model || 'unknown'}\n` +
        `Reason: ${event.reason || 'upstream failure'}\n` +
        `Sessions may be on wrong model!`;

    default:
      return `${emoji} <b>Proxy event: ${event.type}</b>\n` +
        `Time: ${time} ET\n` +
        `${JSON.stringify(event, null, 2).substring(0, 200)}`;
  }
}

// --- File watcher ---
function processNewLines() {
  if (!existsSync(FALLBACK_LOG_PATH)) return;

  try {
    const stat = statSync(FALLBACK_LOG_PATH);
    if (stat.size <= lastFileSize) {
      if (stat.size < lastFileSize) {
        // File was truncated/rotated
        lastFileSize = 0;
      }
      return;
    }

    // Read only new bytes
    const fd = require('fs').openSync(FALLBACK_LOG_PATH, 'r');
    const newBytes = Buffer.alloc(stat.size - lastFileSize);
    require('fs').readSync(fd, newBytes, 0, newBytes.length, lastFileSize);
    require('fs').closeSync(fd);
    lastFileSize = stat.size;

    const lines = newBytes.toString('utf8').trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        // Only alert on critical events
        if (!ALERT_EVENTS.has(event.type)) continue;

        // Cooldown check
        const now = Date.now();
        const lastAlert = lastAlertTime[event.type] || 0;
        if (now - lastAlert < COOLDOWN_MS) {
          console.log(`[fallback-alert] Suppressed ${event.type} alert (cooldown)`);
          continue;
        }

        lastAlertTime[event.type] = now;
        sendTelegramAlert(formatEvent(event));
      } catch (parseErr) {
        console.error(`[fallback-alert] Failed to parse line: ${parseErr.message}`);
      }
    }
  } catch (err) {
    console.error(`[fallback-alert] File read error: ${err.message}`);
  }
}

// Initialize file position to current end (don't alert on old events)
function initFilePosition() {
  if (existsSync(FALLBACK_LOG_PATH)) {
    try {
      lastFileSize = statSync(FALLBACK_LOG_PATH).size;
      console.log(`[fallback-alert] Starting from byte ${lastFileSize}`);
    } catch {
      lastFileSize = 0;
    }
  }
}

// --- Main ---
console.log(`[fallback-alert] Watching ${FALLBACK_LOG_PATH}`);
console.log(`[fallback-alert] Alerting to chat ${TELEGRAM_CHAT_ID} thread ${TELEGRAM_THREAD_ID}`);
console.log(`[fallback-alert] Cooldown: ${COOLDOWN_MS}ms`);

initFilePosition();

// Poll every 5 seconds (watchFile is more reliable than fs.watch for appended files)
watchFile(FALLBACK_LOG_PATH, { interval: 5000 }, () => {
  processNewLines();
});

// Also check every 30s as a safety net
setInterval(processNewLines, 30000);

// Heartbeat log every hour
setInterval(() => {
  console.log(`[fallback-alert] Heartbeat — watching ${FALLBACK_LOG_PATH}, ` +
    `last alerts: ${JSON.stringify(lastAlertTime)}`);
}, 3600000);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[fallback-alert] Shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[fallback-alert] Shutting down');
  process.exit(0);
});
