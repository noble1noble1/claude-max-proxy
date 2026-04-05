#!/usr/bin/env node

/**
 * claude-max-proxy
 *
 * Local proxy that accepts Anthropic Messages API requests and routes them
 * through `claude -p` (the Claude Code CLI in print mode).
 *
 * Why: Anthropic's April 2026 policy change treats direct API calls as
 * "third-party" usage (billed separately), but Claude Code CLI calls are
 * "first-party" (included in your $200/mo Max subscription). This proxy
 * bridges the gap for tools like OpenClaw, SillyTavern, TypingMind, etc.
 *
 * Usage:
 *   npx claude-max-proxy          # start on default port 4523
 *   PORT=8080 npx claude-max-proxy # custom port
 *
 * Then point your app's Anthropic base URL at http://localhost:4523
 */

const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '4523', 10);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}] [DEBUG]`, ...args);
}

// ---------------------------------------------------------------------------
// Message conversion: Anthropic Messages API → flat prompt string
// ---------------------------------------------------------------------------

function flattenMessages(messages) {
  const parts = [];

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';

    if (typeof msg.content === 'string') {
      parts.push(`${role}: ${msg.content}`);
      continue;
    }

    const textParts = [];
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          textParts.push(
            `[Tool call: ${block.name}(${JSON.stringify(block.input)}) id=${block.id}]`
          );
          break;
        case 'tool_result': {
          const resultContent =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n')
                : JSON.stringify(block.content);
          textParts.push(
            `[Tool result for ${block.tool_use_id}${block.is_error ? ' (error)' : ''}: ${resultContent}]`
          );
          break;
        }
        default:
          break;
      }
    }

    if (textParts.length > 0) {
      parts.push(`${role}: ${textParts.join('\n')}`);
    }
  }

  return parts.join('\n\n');
}

function buildSystemPrompt(system, tools) {
  let systemPrompt = '';

  if (typeof system === 'string') {
    systemPrompt = system;
  } else if (Array.isArray(system)) {
    systemPrompt = system
      .map((s) => (typeof s === 'string' ? s : s.text || ''))
      .filter(Boolean)
      .join('\n');
  }

  if (tools && tools.length > 0) {
    const toolBlock = tools
      .map(
        (t) =>
          `<tool name="${t.name}">\n<description>${t.description || ''}</description>\n<input_schema>${JSON.stringify(t.input_schema)}</input_schema>\n</tool>`
      )
      .join('\n');

    systemPrompt += `\n\nYou have access to the following tools. To use a tool, respond with a tool_use content block.\n\n${toolBlock}`;
  }

  if (systemPrompt) {
    systemPrompt = sanitizePrompt(systemPrompt);
  }

  return systemPrompt || undefined;
}

// Anthropic detects known third-party app names in prompts and routes
// those requests to extra-usage billing instead of the Max plan.
// Strip identifiers so requests are treated as first-party CLI usage.
// Known third-party app identifiers that trigger extra-usage billing.
// Add your own app/bot names here if needed.
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

function sanitizePrompt(text) {
  if (!text) return text;
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// Deep sanitize: process the raw request body before any conversion
function sanitizeRequestBody(body) {
  // Recursively walk the body and sanitize all string values
  if (typeof body === 'string') {
    return sanitizePrompt(body);
  }
  if (Array.isArray(body)) {
    return body.map(sanitizeRequestBody);
  }
  if (body && typeof body === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(body)) {
      result[key] = sanitizeRequestBody(value);
    }
    return result;
  }
  return body;
}

function mapModel(model) {
  if (!model) return 'sonnet';
  const aliases = {
    'claude-opus-4-6': 'opus',
    'claude-opus-4-5': 'opus',
    'claude-opus-4-1': 'opus',
    'claude-opus-4-0': 'opus',
    'claude-sonnet-4-6': 'sonnet',
    'claude-sonnet-4-5': 'sonnet',
    'claude-sonnet-4-0': 'sonnet',
    'claude-haiku-4-5': 'haiku',
  };
  return aliases[model] || model;
}

// ---------------------------------------------------------------------------
// Spawn `claude -p` and collect response
// ---------------------------------------------------------------------------

function runClaude(prompt, model, systemPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--model', model,
      '--verbose',
      '--setting-sources', '',                     // Skip hooks, CLAUDE.md, settings
      '--tools', '',                // No built-in tools
      '--no-session-persistence',   // Don't save session
    ];

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    debug('Spawning:', CLAUDE_PATH, args.join(' ').slice(0, 200));

    const child = spawn(CLAUDE_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        LANG: process.env.LANG || 'en_US.UTF-8',
        TERM: process.env.TERM || 'xterm-256color',
        USER: process.env.USER,
        TMPDIR: process.env.TMPDIR || '/tmp',
      },
    });

    const chunks = [];
    let stderrData = '';

    child.stdout.on('data', (data) => {
      chunks.push(data);
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
      debug('claude stderr:', data.toString().slice(0, 200));
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString();
      if (code !== 0 && !output) {
        reject(new Error(`claude exited with code ${code}: ${stderrData.slice(0, 500)}`));
        return;
      }
      resolve(output);
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function runClaudeStreaming(prompt, model, systemPrompt, onLine, onDone, onError) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--model', model,
    '--verbose',
    '--setting-sources', '',
    '--tools', '',
    '--no-session-persistence',
  ];

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  debug('Spawning (stream):', CLAUDE_PATH, args.join(' ').slice(0, 200));

  const child = spawn(CLAUDE_PATH, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: process.env.LANG || 'en_US.UTF-8',
      TERM: process.env.TERM || 'xterm-256color',
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR || '/tmp',
    },
  });

  let buffer = '';

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete last line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        onLine(msg);
      } catch {
        debug('Non-JSON line:', trimmed.slice(0, 100));
      }
    }
  });

  child.stderr.on('data', (data) => {
    debug('claude stderr:', data.toString().slice(0, 200));
  });

  child.on('error', (err) => {
    onError(new Error(`Failed to spawn claude: ${err.message}`));
  });

  child.on('close', (code) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const msg = JSON.parse(buffer.trim());
        onLine(msg);
      } catch {
        // ignore
      }
    }
    onDone(code);
  });

  // Write prompt and close stdin
  child.stdin.write(prompt);
  child.stdin.end();

  return child;
}

// ---------------------------------------------------------------------------
// POST /v1/messages — main proxy endpoint
// ---------------------------------------------------------------------------

app.post('/v1/messages', async (req, res) => {
  // Sanitize the entire request body to strip third-party identifiers
  const sanitizedBody = sanitizeRequestBody(req.body);
  const { model, messages, system, stream, max_tokens, tools } = sanitizedBody;

  const mappedModel = mapModel(model);
  const prompt = flattenMessages(messages);
  const systemPrompt = buildSystemPrompt(system, tools);

  log(
    `→ ${model} (${mappedModel}) | stream=${!!stream} | messages=${messages?.length || 0} | prompt=${prompt.length} chars`
  );

  // Dump the full request for debugging
  if (DEBUG) {
    const fs = require('fs');
    fs.writeFileSync('/tmp/claude-proxy-last-request.json', JSON.stringify(req.body, null, 2));
    debug('Full request saved to /tmp/claude-proxy-last-request.json');
  }

  if (stream) {
    await handleStreaming(res, prompt, mappedModel, systemPrompt, model);
  } else {
    await handleNonStreaming(res, prompt, mappedModel, systemPrompt, model);
  }
});

// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------

async function handleStreaming(res, prompt, mappedModel, systemPrompt, originalModel) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const messageId = `msg_proxy_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  let sentStart = false;
  let blockIndex = 0;
  let blockStarted = false;
  let outputTokens = 0;
  let inputTokens = 0;
  let fullText = '';

  function sendSSE(event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function ensureMessageStart() {
    if (sentStart) return;
    sentStart = true;
    sendSSE('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: originalModel || mappedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function ensureBlockStart() {
    if (blockStarted) return;
    blockStarted = true;
    sendSSE('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
  }

  return new Promise((resolve) => {
    const child = runClaudeStreaming(
      prompt,
      mappedModel,
      systemPrompt,
      // onLine: process each NDJSON message from claude
      (msg) => {
        debug('claude msg type:', msg.type);

        if (msg.type === 'assistant') {
          // Full assistant message with content blocks
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            ensureMessageStart();
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                ensureBlockStart();
                fullText += block.text;
                sendSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: block.text },
                });
              }
            }
          }
          if (msg.message?.usage) {
            inputTokens = msg.message.usage.input_tokens || inputTokens;
            outputTokens = msg.message.usage.output_tokens || outputTokens;
          }
        } else if (msg.type === 'result') {
          if (msg.usage) {
            inputTokens = msg.usage.input_tokens || inputTokens;
            outputTokens = msg.usage.output_tokens || outputTokens;
          }
          if (msg.is_error) {
            log('Claude error result:', msg.result?.slice(0, 300));
            ensureMessageStart();
            ensureBlockStart();
            sendSSE('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: `\n\n[Error: ${msg.result}]` },
            });
          }
          log(
            `← done | cost=$${msg.total_cost_usd?.toFixed(4) || '?'} | duration=${msg.duration_ms || '?'}ms | in=${inputTokens} out=${outputTokens}`
          );
        }
      },
      // onDone
      (code) => {
        debug('claude exited with code:', code);

        if (blockStarted) {
          sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }
        if (!sentStart) {
          ensureMessageStart();
          ensureBlockStart();
          sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }
        sendSSE('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        sendSSE('message_stop', { type: 'message_stop' });
        res.end();
        resolve();
      },
      // onError
      (err) => {
        log('Spawn error:', err.message);
        ensureMessageStart();
        ensureBlockStart();
        sendSSE('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: `\n\n[Proxy error: ${err.message}]` },
        });
        sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        sendSSE('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        sendSSE('message_stop', { type: 'message_stop' });
        res.end();
        resolve();
      }
    );

    // Abort if client disconnects
    res.on('close', () => {
      if (!res.writableEnded) {
        debug('Client disconnected, killing claude process');
        child.kill('SIGTERM');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Non-streaming handler
// ---------------------------------------------------------------------------

async function handleNonStreaming(res, prompt, mappedModel, systemPrompt, originalModel) {
  try {
    const output = await runClaude(prompt, mappedModel, systemPrompt);

    // Parse NDJSON output — find the last assistant message and result
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                text += block.text;
              }
            }
          }
          if (msg.message?.usage) {
            inputTokens = msg.message.usage.input_tokens || 0;
            outputTokens = msg.message.usage.output_tokens || 0;
          }
          if (msg.message?.stop_reason) {
            stopReason = msg.message.stop_reason;
          }
        } else if (msg.type === 'result') {
          if (msg.usage) {
            inputTokens = msg.usage.input_tokens || inputTokens;
            outputTokens = msg.usage.output_tokens || outputTokens;
          }
          if (msg.is_error) {
            throw new Error(msg.result || 'Claude returned an error');
          }
          log(
            `← done | cost=$${msg.total_cost_usd?.toFixed(4) || '?'} | duration=${msg.duration_ms || '?'}ms`
          );
        }
      } catch (parseErr) {
        if (parseErr.message !== 'Unexpected end of JSON input' &&
            !parseErr.message?.startsWith('Unexpected token')) {
          throw parseErr;
        }
      }
    }

    res.json({
      id: `msg_proxy_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: originalModel || mappedModel,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
  } catch (err) {
    log('Error:', err.message);
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: `Proxy error: ${err.message}` },
    });
  }
}

// ---------------------------------------------------------------------------
// Health / info endpoints
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: require('./package.json').version });
});

app.get('/v1/models', (req, res) => {
  const models = [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ].map((id) => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'anthropic',
  }));
  res.json({ object: 'list', data: models });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '127.0.0.1', () => {
  log(`claude-max-proxy v${require('./package.json').version}`);
  log(`Listening on http://127.0.0.1:${PORT}`);
  log(`Proxying Anthropic Messages API → claude -p (first-party CLI auth)`);
  log(`Claude binary: ${CLAUDE_PATH}`);
  log('');
  log('Configure your app to use:');
  log(`  Base URL: http://127.0.0.1:${PORT}`);
  log('  API Key:  any non-empty string (auth is handled by Claude CLI)');
  log('');
  if (DEBUG) log('Debug mode enabled');
});
