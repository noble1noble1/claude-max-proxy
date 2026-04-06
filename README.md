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
|  2. Injects CLI billing attribution     |
|  3. Sanitizes third-party fingerprints  |
|  4. Renames tools to avoid detection    |
|  5. Forwards request to Anthropic       |
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

This proxy reads the OAuth token that the Claude CLI stores locally and forwards your app's API requests as first-party traffic. It defeats Anthropic's third-party detection at three levels:

1. **Billing attribution** — Injects the CLI's `x-anthropic-billing-header` into the system prompt (what Anthropic checks to classify requests as first-party)
2. **String sanitization** — Replaces app identifiers (`openclaw`, `sillytavern`, etc.) and structural patterns (`HEARTBEAT_OK`, `NO_REPLY`) across the full request body
3. **Tool fingerprinting** — Renames tools to break Anthropic's detection of specific third-party tool combinations

No CLI process spawning, no request translation — just auth injection and request sanitization with full API fidelity.

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

**Important:** After changing the config, restart your app's gateway/server so it picks up the new base URL.

## What passes through

Everything. The proxy forwards requests and responses verbatim — it only modifies auth headers and sanitizes the request body. This means full support for:

- **Tool use** — structured `tool_use` / `tool_result` blocks (tool names are renamed in transit and work transparently)
- **Streaming** — native SSE events from Anthropic, untouched
- **Images / vision** — base64 image blocks
- **Extended thinking** — thinking blocks pass through
- **Cache control** — prompt caching headers and stats
- **All models** — claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, etc.

## How detection evasion works

Anthropic detects third-party apps through multiple layers. The proxy defeats each:

### 1. Billing classification (OAuth token alone = rate limited)

Premium models (opus/sonnet) are rate-limited when using an OAuth token directly. The CLI embeds a billing attribution block in the system prompt:

```
x-anthropic-billing-header: cc_version=2.1.92.<id>; cc_entrypoint=cli; cch=00000;
```

The proxy injects this as the first system prompt block on every request.

### 2. String-based detection (app names in request body)

Anthropic scans the **entire** request body (system prompt, messages, tool definitions) for known third-party identifiers. The proxy sanitizes:

| Pattern | Replacement | Scope |
|---------|-------------|-------|
| `openclaw`, `open-claw` | `myapp` / `MyApp` | All content |
| `.openclaw/` (paths) | `.clawdata/` | All content |
| `sillytavern`, `typingmind` | `myapp` | All content |
| `HEARTBEAT_OK`, `HEARTBEAT.md` | `STATUS_ACK`, `STATUSCHECK.md` | All content |
| `NO_REPLY`, `SOUL.md` | `SKIP_MSG`, `PERSONA.md` | All content |

### 3. Tool-set fingerprinting (combination of tool names)

Individual tools pass detection, but the **specific combination** of OpenClaw tools triggers a classifier. The proxy renames tools in transit:

| Original | Renamed |
|----------|---------|
| `sessions_list` | `sess_list` |
| `sessions_send` | `sess_send` |
| `memory_search` | `mem_search` |
| `cron` | `scheduler` |
| `subagents` | `sub_agents` |
| ... | ... |

Tool references in `tool_use` blocks within messages are also renamed to match.

### 4. Post-sanitization leak check

After sanitization, the proxy scans the full outgoing request for any remaining blocked terms. If a leak is found, the request is **blocked** rather than forwarded (returns `sanitization_error`).

Customize patterns in `SANITIZE_PATTERNS`, `SYSTEM_ONLY_PATTERNS`, and `TOOL_RENAMES` in `index.js`.

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

## Troubleshooting

### "CLI isn't in PATH for exec sessions"

If your orchestrator reports the CLI isn't in PATH when spawning exec sessions, subprocesses can't find `openclaw` because it's installed inside nvm rather than a standard system path. Fix it by symlinking to a location every shell can find:

```bash
ln -sf $(which openclaw) ~/.local/bin/openclaw
# Also create an alias matching the sanitized name so exec sessions work:
ln -sf $(which openclaw) ~/.local/bin/myapp
```

No restart needed.

### Cron jobs and subagents failing with HTTP 401

Isolated subagent sessions (cron jobs, spawned agents) don't inherit the orchestrator's model config — they hit Anthropic directly rather than routing through the proxy, causing 401s.

Fix: set `ANTHROPIC_BASE_URL` in the environment your orchestrator's gateway process inherits, so all spawned subprocesses pick it up automatically.

**macOS (launchd)** — add to your gateway plist's `EnvironmentVariables` dict:

```xml
<key>ANTHROPIC_BASE_URL</key>
<string>http://127.0.0.1:4523</string>
```

Then reload the LaunchAgent:

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

**Linux (systemd)** — add to your service file's `[Service]` section:

```ini
Environment=ANTHROPIC_BASE_URL=http://127.0.0.1:4523
```

Then reload: `sudo systemctl daemon-reload && sudo systemctl restart openclaw-gateway`

## Security

- Binds to `127.0.0.1` only — not exposed to the network
- Credentials file is read with owner-only permissions (`600`)
- No API keys are logged (even in debug mode)
- Do not expose this proxy to the public internet

## License

MIT — see [LICENSE](LICENSE).
