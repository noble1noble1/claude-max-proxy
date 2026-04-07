#!/usr/bin/env node
/**
 * telegram-watchdog-trigger
 *
 * Standalone Telegram bot poller that runs the openclaw-auth-watchdog
 * script when it receives /watchdog or /fix from an allowed chat ID.
 *
 * Runs independently of the openclaw gateway — works even when the
 * gateway is completely down.
 *
 * Commands:
 *   /watchdog  — run the watchdog and reply with output
 *   /fix       — alias for /watchdog
 *   /status    — check proxy health without running the full watchdog
 *
 * Config (env vars or auto-detected from openclaw):
 *   BOT_TOKEN       Telegram bot token
 *   ALLOWED_CHAT_ID Chat ID allowed to trigger commands
 *   WATCHDOG_PATH   Path to openclaw-auth-watchdog script
 */

'use strict';

const { execFile } = require('child_process');
const https = require('https');
const os = require('os');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  // Env vars take priority
  if (process.env.BOT_TOKEN && process.env.ALLOWED_CHAT_ID) {
    return {
      botToken: process.env.BOT_TOKEN,
      allowedChatId: String(process.env.ALLOWED_CHAT_ID),
      watchdogPath: process.env.WATCHDOG_PATH || `${os.homedir()}/bin/openclaw-auth-watchdog`,
    };
  }

  // Auto-detect from openclaw config
  try {
    const clawdbot = JSON.parse(fs.readFileSync(`${os.homedir()}/.openclaw/clawdbot.json`, 'utf8'));
    const botToken = clawdbot?.channels?.telegram?.botToken;
    if (!botToken) throw new Error('botToken not found in clawdbot.json');

    const allowFrom = JSON.parse(fs.readFileSync(`${os.homedir()}/.openclaw/credentials/telegram-allowFrom.json`, 'utf8'));
    const chatId = String(allowFrom?.allowFrom?.[0] || allowFrom?.[0] || '');
    if (!chatId) throw new Error('chat ID not found in telegram-allowFrom.json');

    return {
      botToken,
      allowedChatId: chatId,
      watchdogPath: process.env.WATCHDOG_PATH || `${os.homedir()}/bin/openclaw-auth-watchdog`,
    };
  } catch (err) {
    console.error('Config error:', err.message);
    console.error('Set BOT_TOKEN and ALLOWED_CHAT_ID env vars, or ensure openclaw is configured.');
    process.exit(1);
  }
}

const CONFIG = loadConfig();
const POLL_INTERVAL_MS = 15_000;
const WATCHDOG_TIMEOUT_MS = 120_000;

log(`Bot ready. Allowed chat: ${CONFIG.allowedChatId}`);
log(`Watchdog: ${CONFIG.watchdogPath}`);
log(`Polling every ${POLL_INTERVAL_MS / 1000}s`);

// ── Telegram API helpers ──────────────────────────────────────────────────────

function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${CONFIG.botToken}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendMessage(chatId, text) {
  return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
}

// ── Watchdog runner ───────────────────────────────────────────────────────────

function runWatchdog() {
  return new Promise((resolve) => {
    if (!fs.existsSync(CONFIG.watchdogPath)) {
      return resolve({ success: false, output: `Watchdog not found at: ${CONFIG.watchdogPath}\nRun setup.sh to install it.` });
    }

    execFile(CONFIG.watchdogPath, { timeout: WATCHDOG_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      resolve({ success: !err || err.code === 0, output: output || '(no output)' });
    });
  });
}

function checkProxyHealth() {
  return new Promise((resolve) => {
    const req = https.request ? null : null; // use http for localhost
    const http = require('http');
    const req2 = http.get('http://127.0.0.1:4523/health', { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ ok: j.status === 'ok', data: j });
        } catch { resolve({ ok: false, data: { raw: data } }); }
      });
    });
    req2.on('error', () => resolve({ ok: false, data: { error: 'proxy not responding' } }));
    req2.on('timeout', () => { req2.destroy(); resolve({ ok: false, data: { error: 'timeout' } }); });
  });
}

// ── Update handler ────────────────────────────────────────────────────────────

async function handleUpdate(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chatId = String(msg.chat?.id || '');
  const text = (msg.text || '').trim().toLowerCase();

  // Security: only respond to allowed chat
  if (chatId !== CONFIG.allowedChatId) {
    log(`Ignored message from unauthorized chat ${chatId}`);
    return;
  }

  const cmd = text.split('@')[0]; // strip @botname suffix

  if (cmd === '/watchdog' || cmd === '/fix') {
    log(`Running watchdog (requested via Telegram)`);
    await sendMessage(chatId, '🔧 Running watchdog...');

    const { success, output } = await runWatchdog();
    const lines = output.split('\n').slice(-30).join('\n');
    const icon = success ? '✅' : '⚠️';
    await sendMessage(chatId, `${icon} *Watchdog complete*\n\`\`\`\n${lines}\n\`\`\``);

  } else if (cmd === '/status') {
    log(`Status check (requested via Telegram)`);
    const { ok, data } = await checkProxyHealth();
    if (ok) {
      await sendMessage(chatId,
        `✅ *Proxy healthy*\nToken: ${data.token}\nSubscription: ${data.subscription}\nRate tier: ${data.rateLimitTier}`
      );
    } else {
      await sendMessage(chatId,
        `❌ *Proxy not responding*\n\`\`\`${JSON.stringify(data)}\`\`\`\nSend /watchdog to attempt repair.`
      );
    }

  } else if (cmd === '/help') {
    await sendMessage(chatId,
      `*Watchdog commands:*\n/watchdog — repair auth + restart gateway\n/fix — same as /watchdog\n/status — check proxy health`
    );
  }
}

// ── Polling loop ──────────────────────────────────────────────────────────────

let offset = 0;

async function poll() {
  try {
    const result = await tgRequest('getUpdates', {
      offset,
      timeout: 10,
      allowed_updates: ['message', 'channel_post'],
    });

    if (!result.ok) {
      log('getUpdates failed:', JSON.stringify(result).slice(0, 200));
      return;
    }

    for (const update of result.result || []) {
      offset = update.update_id + 1;
      try { await handleUpdate(update); }
      catch (err) { log('Error handling update:', err.message); }
    }
  } catch (err) {
    log('Poll error:', err.message);
  }
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Run immediately then on interval
poll();
setInterval(poll, POLL_INTERVAL_MS);

// Keepalive signal
process.on('SIGTERM', () => { log('SIGTERM — exiting'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT — exiting'); process.exit(0); });
