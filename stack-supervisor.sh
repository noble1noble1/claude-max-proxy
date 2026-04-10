#!/bin/bash
# stack-supervisor — resident process, checks proxy + gateway every 60s.
# Boots services if absent. Never calls launchctl bootout (avoids killing live services).
# Owned by a KeepAlive LaunchAgent so it self-heals too.

PROXY_URL="http://127.0.0.1:4523"
GATEWAY_URL="http://127.0.0.1:18789"
PROXY_PLIST="$HOME/Library/LaunchAgents/com.claude-max-proxy.plist"
GATEWAY_PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
LOG="$HOME/.openclaw/logs/stack-supervisor.log"
CHECK_INTERVAL=60

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "Stack supervisor started (PID $$, interval=${CHECK_INTERVAL}s)"

while true; do
  # ── Proxy check ─────────────────────────────────────────────────────────────
  PROXY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$PROXY_URL/health" 2>/dev/null)
  if [ "$PROXY_STATUS" = "200" ]; then
    : # healthy, silent
  else
    log "WARNING: proxy not responding (HTTP $PROXY_STATUS) — bootstrapping"
    launchctl bootstrap gui/$UID "$PROXY_PLIST" 2>/dev/null
    sleep 3
    PROXY_RECHECK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$PROXY_URL/health" 2>/dev/null)
    if [ "$PROXY_RECHECK" = "200" ]; then
      log "Proxy recovered"
    else
      log "ERROR: proxy still not responding after bootstrap (HTTP $PROXY_RECHECK)"
    fi
  fi

  # ── Gateway check ───────────────────────────────────────────────────────────
  GATEWAY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$GATEWAY_URL/health" 2>/dev/null)
  if [ "$GATEWAY_STATUS" = "200" ] || [ "$GATEWAY_STATUS" = "401" ]; then
    : # healthy, silent
  else
    log "WARNING: gateway not responding (HTTP $GATEWAY_STATUS) — bootstrapping"
    launchctl bootstrap gui/$UID "$GATEWAY_PLIST" 2>/dev/null
    sleep 5
    GATEWAY_RECHECK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$GATEWAY_URL/health" 2>/dev/null)
    if [ "$GATEWAY_RECHECK" = "200" ] || [ "$GATEWAY_RECHECK" = "401" ]; then
      log "Gateway recovered"
    else
      log "ERROR: gateway still not responding after bootstrap (HTTP $GATEWAY_RECHECK)"
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
