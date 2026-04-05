# claude-max-proxy

Local proxy that routes Anthropic Messages API requests through the Claude Code CLI, so third-party apps use your Max subscription instead of extra-usage billing.

## Architecture

```
Your App (OpenClaw, SillyTavern, TypingMind, etc.)
    |
    |  Anthropic Messages API
    |  POST /v1/messages
    v
+--------------------------+
|   claude-max-proxy       |
|   localhost:4523         |
|                          |
|  * Receives API request  |
|  * Sanitizes prompt      |
|  * Spawns claude -p      |
+------------+-------------+
             |
             |  Claude Code CLI
             |  (first-party auth)
             v
+--------------------------+
|   Anthropic API          |
|                          |
|  Billed as first-party   |
|  + Uses Max plan limits  |
|  - NOT extra usage       |
+--------------------------+
```

## Why does this exist?

In April 2026, Anthropic changed how billing works for Claude Max subscribers. Direct API calls made by third-party applications (OpenClaw, SillyTavern, TypingMind, and others) are now classified as "third-party usage" and billed separately from your $200/month Max subscription. Anthropic detects third-party app identifiers in prompts and routes those requests to extra-usage billing.

However, requests made through the official Claude Code CLI (`claude -p`) are treated as **first-party usage** and count against your normal Max plan limits -- no extra charges.

**claude-max-proxy** bridges this gap. It accepts standard Anthropic Messages API requests from any app, sanitizes known third-party identifiers from the prompt, and forwards the request through `claude -p`. Your app talks to the proxy exactly like it would talk to the Anthropic API, but the actual inference is routed through the CLI and billed as first-party usage.

## Quick start

### Prerequisites

- **Node.js** 18 or later
- **Claude Code CLI** installed and authenticated (`claude` must be on your PATH)
- An active **Claude Max** subscription

### Installation

```bash
git clone https://github.com/MovementBD/claude-max-proxy.git
cd claude-max-proxy
npm install
```

### Run

```bash
node index.js
```

The proxy starts on `http://127.0.0.1:4523` by default.

### Verify

```bash
curl http://localhost:4523/health
# {"status":"ok","version":"1.0.0"}
```

## Configuration

### Pointing OpenClaw at the proxy

In your OpenClaw configuration, set the Anthropic provider to use the proxy as its base URL. For example, in your `models.providers` config:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://127.0.0.1:4523",
      "apiKey": "not-needed"
    }
  }
}
```

The API key can be any non-empty string -- authentication is handled by the Claude Code CLI, not by the proxy.

If you have previously configured an Anthropic API key or auth profile in OpenClaw, clear it so requests are routed through the proxy instead of directly to Anthropic.

### Any Anthropic Messages API client

This proxy works with **any** application that speaks the Anthropic Messages API. Point the app's base URL at the proxy and provide a dummy API key:

| App | Setting | Value |
|-----|---------|-------|
| OpenClaw | `providers.anthropic.baseUrl` | `http://127.0.0.1:4523` |
| SillyTavern | API URL (Claude) | `http://127.0.0.1:4523` |
| TypingMind | Custom Endpoint | `http://127.0.0.1:4523` |
| Custom apps | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4523` |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4523` | Port the proxy listens on |
| `DEBUG` | `false` | Set to `1` or `true` to enable verbose logging. Dumps full requests to `/tmp/claude-proxy-last-request.json`. |
| `CLAUDE_PATH` | `claude` | Path to the Claude Code CLI binary, if not on your PATH |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (streaming and non-streaming) |
| `GET` | `/v1/models` | Lists available models |
| `GET` | `/health` | Health check |

## Model mapping

The proxy maps full Anthropic model names to Claude Code CLI model shortnames:

| API model name | CLI shortname |
|----------------|---------------|
| `claude-opus-4-6`, `claude-opus-4-5`, `claude-opus-4-1`, `claude-opus-4-0` | `opus` |
| `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4-0` | `sonnet` |
| `claude-haiku-4-5` | `haiku` |

## Running as a macOS launchd service

Create `~/Library/LaunchAgents/com.claude-max-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/YOUR_USER/claude-max-proxy/index.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>4523</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/claude-max-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-max-proxy.err</string>
</dict>
</plist>
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

Stop and unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

## Running as a Linux systemd service

Create `/etc/systemd/system/claude-max-proxy.service`:

```ini
[Unit]
Description=claude-max-proxy
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/claude-max-proxy
ExecStart=/usr/bin/node /home/YOUR_USER/claude-max-proxy/index.js
Restart=on-failure
RestartSec=5
Environment=PORT=4523
Environment=PATH=/usr/local/bin:/usr/bin:/bin

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable claude-max-proxy
sudo systemctl start claude-max-proxy
```

Check status and logs:

```bash
sudo systemctl status claude-max-proxy
journalctl -u claude-max-proxy -f
```

## Limitations (proxy vs direct API)

This proxy gets the job done, but there are trade-offs compared to a direct Anthropic API connection:

| Feature | Direct API (OAuth tokens) | claude-max-proxy |
|---------|--------------------------|------------------|
| **Billing** | Extra usage ($$) | Max plan (flat $200/mo) |
| **Multi-turn sessions** | Stateless per-request (app manages history) | Same -- app sends full history each request |
| **Streaming** | Native SSE | Supported (translated from CLI output) |
| **Tool use (`tool_use` blocks)** | Native structured blocks | Serialized into text prompt -- model may respond with tool-call text but not structured JSON |
| **Latency** | Direct HTTP to API | ~1-3s overhead per request (CLI process spawn) |
| **Concurrency** | Limited by rate tier | Each request spawns a separate CLI process |
| **Images / vision** | Supported via base64 | Not supported (image blocks are dropped) |
| **Prompt fidelity** | Exact pass-through | Third-party identifiers are sanitized (replaced with generic terms) |
| **System prompt** | Exact pass-through | Custom system prompt overrides CLI defaults |

### Key limitations in detail

- **Single-turn per process.** Each request spawns a fresh `claude -p` process with no session persistence. Your app must send the full conversation history in every request (most apps already do this).
- **No native tool_use pass-through.** Tool definitions are serialized into the system prompt as text. The model may still respond with tool-call-like text, but it won't be structured `tool_use` content blocks.
- **Prompt sanitization.** The proxy replaces known third-party app identifiers (e.g., "OpenClaw", "SillyTavern") with generic placeholders to avoid triggering extra-usage billing. This may occasionally alter prompt content in unexpected ways. You can customize the patterns in `SANITIZE_PATTERNS` in `index.js`.
- **Startup latency.** Each request spawns a new Node.js process for the CLI, adding 1-3 seconds of overhead.
- **Localhost only.** The proxy binds to `127.0.0.1` by default. It is not designed to be exposed to the public internet.

## License

MIT -- see [LICENSE](LICENSE).
