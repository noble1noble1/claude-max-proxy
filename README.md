# claude-max-proxy

Thin OAuth proxy that forwards Anthropic Messages API requests using your Claude Code CLI credentials. Your apps get full API fidelity (tool use, streaming, images) billed as first-party Max subscription usage.

## How it works

```
Your App (OpenClaw, SillyTavern, TypingMind, etc.)
    |
    |  Standard Anthropic Messages API
    |  POST /v1/messages
    v
+-----------------------------------------+
|   claude-max-proxy                      |
|   localhost:4523                        |
|                                         |
|  1. Reads OAuth token from              |
|     ~/.claude/.credentials.json         |
|  2. Sanitizes system/user text blocks   |
|  3. Injects CLI billing attribution     |
|     into system prompt                  |
|  4. Forwards request verbatim           |
+-----------------------------------------+
    |
    |  x-api-key: <OAuth token>
    |  anthropic-client-platform: cli
    |  + billing header in system prompt
    v
+-----------------------------------------+
|   api.anthropic.com                     |
|                                         |
|  Billed as first-party CLI usage        |
|  Uses Max plan limits                   |
|  NOT extra usage                        |
+-----------------------------------------+
```

## Why?

Anthropic's April 2026 billing change classifies direct API calls from third-party apps as "extra usage" — billed separately from your $200/mo Max subscription. But requests made through the Claude Code CLI are "first-party" and included in your plan.

This proxy reads the OAuth token that the Claude CLI stores locally and forwards your app's API requests as first-party traffic. It also injects the CLI's billing attribution header into the system prompt — this is what Anthropic checks to classify requests as first-party. Without it, premium models (opus/sonnet) are rate-limited even with a valid OAuth token.

No CLI process spawning, no request translation — just auth injection, billing attribution, and prompt sanitization.

## Quick start

### Prerequisites

- **Node.js** 18+
- **Claude Code CLI** installed and authenticated (`claude auth login`)
- Active **Claude Max** subscription

### Install & run

```bash
git clone https://github.com/wiziswiz/claude-max-proxy.git
cd claude-max-proxy
npm install
node index.js
```

### Verify

```bash
curl http://localhost:4523/health
```

```json
{
  "status": "ok",
  "version": "2.0.0",
  "mode": "oauth-proxy",
  "token": "valid",
  "subscription": "max",
  "rateLimitTier": "default_claude_max_20x"
}
```

The health endpoint warns if the account is not a Max subscription.

## App configuration

Point your app's Anthropic base URL at the proxy. The API key can be any non-empty string — auth is handled by the proxy.

| App | Setting | Value |
|-----|---------|-------|
| OpenClaw | `providers.anthropic.baseUrl` | `http://127.0.0.1:4523` |
| SillyTavern | API URL (Claude) | `http://127.0.0.1:4523` |
| TypingMind | Custom Endpoint | `http://127.0.0.1:4523` |
| Custom apps | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4523` |

## What passes through

Everything. The proxy forwards requests and responses verbatim — it only modifies the system prompt (billing header + sanitization) and injects auth headers. This means full support for:

- **Tool use** — structured `tool_use` / `tool_result` blocks pass through natively
- **Streaming** — native SSE events from Anthropic, untouched
- **Images / vision** — base64 image blocks
- **Extended thinking** — thinking blocks pass through
- **Cache control** — prompt caching headers and stats
- **All models** — claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, etc.

## Prompt sanitization

The proxy replaces known third-party app identifiers in **system prompts and user text blocks only**. Tool definitions, tool results, assistant messages, and all other metadata pass through untouched.

| Pattern | Replacement |
|---------|-------------|
| `openclaw`, `open-claw` | `myapp` |
| `sillytavern`, `silly-tavern` | `myapp` |
| `typingmind`, `typing-mind` | `myapp` |
| `HEARTBEAT`, `HEARTBEAT_OK` | `PERIODIC_CHECK`, `HB_ACK` |
| `SOUL.md` | `PERSONA.md` |

A post-sanitization leak check verifies no blocked terms remain in outgoing system/user text. If a leak is detected, the request is blocked with a `sanitization_error` rather than forwarded.

Customize patterns in `SANITIZE_PATTERNS` in `index.js`.

## Rate limit handling

The proxy retries on transient 429 errors (up to 3 attempts with exponential backoff) when Anthropic returns `x-should-retry: true`. This smooths over brief rate limit windows without surfacing errors to your app.

## Token management

The proxy reads OAuth credentials from `~/.claude/.credentials.json` (written by the Claude CLI). Tokens auto-refresh:

- Token validity is checked on each request
- Refreshes 5 minutes before expiry (same as CLI)
- Refresh uses Anthropic's OAuth endpoint with the stored refresh token
- Updated credentials are written back to the file
- File is watched for external changes (e.g., CLI refreshes token independently)
- Concurrent refresh attempts are deduplicated

If the token is missing or invalid, the proxy returns a clear error with the action: `Run "claude auth login" to re-authenticate`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4523` | Port the proxy listens on |
| `DEBUG` | `false` | Set to `1` for verbose logging (saves requests to `/tmp/`) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic API endpoint |
| `CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Path to Claude CLI credentials |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (streaming and non-streaming) |
| `GET` | `/v1/models` | Forwards to Anthropic's model list |
| `GET` | `/health` | Health check with token status and Max plan validation |

## Running as a service

### macOS (launchd)

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
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USER/claude-max-proxy</string>
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

```bash
launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

### Linux (systemd)

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

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-max-proxy
```

## Security

- Binds to `127.0.0.1` only — not exposed to the network
- Credentials file is read with owner-only permissions (`600`)
- No API keys are logged (even in debug mode)
- Do not expose this proxy to the public internet

## License

MIT — see [LICENSE](LICENSE).
