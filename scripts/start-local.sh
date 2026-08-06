#!/usr/bin/env bash
# Local one-shot launcher. Picks free ports for the management API and the
# public HTTP listener (unless API_PORT / HTTP_PORT are set), then runs Caddy
# and the API on them, verifying our services actually answer on the public
# port before reporting success.
set -euo pipefail
cd "$(dirname "$0")/.."

# A port is unusable if ANY listener holds it (any interface). The BSD family
# lets a wildcard bind coexist with a specific-address listener, which would
# silently shadow the other service — so a bind() test alone is not enough.
port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

pick_port() {
  while :; do
    P=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
    if ! port_in_use "$P"; then echo "$P"; return; fi
  done
}

API_PORT="${API_PORT:-$(pick_port)}"
HTTP_PORT="${HTTP_PORT:-$(pick_port)}"
while [ "$HTTP_PORT" = "$API_PORT" ]; do HTTP_PORT="$(pick_port)"; done

# Pinned ports must be free as well: honoring an occupied pin silently shadows
# the other service (BSD lets a wildcard bind coexist with a specific-address
# listener, splitting traffic by address family). Fail loudly instead.
for P in "$API_PORT" "$HTTP_PORT"; do
  if port_in_use "$P"; then
    OWNER=$(lsof -nP -iTCP:"$P" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 | awk '{print $1, "pid", $2}')
    echo "Port ${P} is already in use (${OWNER:-unknown owner})." >&2
    echo "If a pin came from your environment (HTTP_PORT/API_PORT), unset it or pick a free one." >&2
    exit 1
  fi
done

if ! command -v caddy >/dev/null 2>&1; then
  echo "caddy not found on PATH. Install it (https://caddyserver.com/download) or run via Docker." >&2
  exit 1
fi

export API_PORT HTTP_PORT
export PORT="$API_PORT"
export DATA_DIR="${DATA_DIR:-$(pwd)/data}"

echo "Management API:  http://localhost:${API_PORT}/api/v1"
echo "Landing page:    http://localhost:${HTTP_PORT}/"
echo "(pin ports with API_PORT=... HTTP_PORT=... if you need them stable)"

caddy run --config Caddyfile &
CADDY_PID=$!
npx tsx src/index.ts &
API_PID=$!
trap 'kill "$API_PID" "$CADDY_PID" 2>/dev/null || true' EXIT

# Self-check: our own services must answer through the public port. Fails
# loudly instead of silently serving (or being shadowed by) something else.
for _ in $(seq 1 30); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "Management API exited during startup — see output above." >&2
    exit 1
  fi
  if curl -sf -o /dev/null "http://localhost:${HTTP_PORT}/api/v1/health" 2>/dev/null; then
    echo "Ready. Landing page: http://localhost:${HTTP_PORT}/"
    break
  fi
  sleep 1
done
if ! curl -sf -o /dev/null "http://localhost:${HTTP_PORT}/api/v1/health" 2>/dev/null; then
  echo "Public port ${HTTP_PORT} does not answer with our services — is something else shadowing it?" >&2
  exit 1
fi

wait "$API_PID"
