#!/usr/bin/env bash
# One-command NAS deployment. Builds the compose stack and starts it on a
# public port that is actually free (overriding HTTP_PORT from .env when it is
# occupied), then prints the URL. All apps share this one port — no per-app
# port decisions, ever.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env — create one with MANAGEMENT_API_KEY=... (see .env.example)" >&2
  exit 1
fi

# The public port must have no listener at all (any interface); a bind() test
# alone can be fooled by BSD wildcard/specific-address coexistence.
port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

pick_port() {
  while :; do
    P=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
    if ! port_in_use "$P"; then echo "$P"; return; fi
  done
}

# Respect HTTP_PORT from the environment, then from .env — but never start on
# an occupied port.
HTTP_PORT="${HTTP_PORT:-$(grep -E '^HTTP_PORT=' .env | tail -1 | cut -d= -f2 || true)}"
if [ -n "${HTTP_PORT:-}" ] && port_in_use "$HTTP_PORT"; then
  echo "HTTP_PORT=${HTTP_PORT} from .env is in use — picking a free port instead." >&2
  HTTP_PORT=""
fi
if [ -z "${HTTP_PORT:-}" ]; then
  HTTP_PORT="$(pick_port)"
fi
export HTTP_PORT

echo "Building and starting leafdock on port ${HTTP_PORT}..."
if ! docker compose up -d --build 2>&1 | tee /tmp/leafdock-compose.log; then
  if grep -q 'incorrect label com.docker.compose.network' /tmp/leafdock-compose.log; then
    echo "leafdock_default exists but was created outside compose. Stop other leafdock containers and run:" >&2
    echo "  docker network rm leafdock_default" >&2
  fi
  exit 1
fi

URL="http://localhost:${HTTP_PORT}"
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "${URL}/api/v1/health" 2>/dev/null; then
    echo "Leafdock ready: ${URL}"
    echo "Landing page:   ${URL}/"
    exit 0
  fi
  sleep 2
done
echo "Started but health check timed out — check: docker compose logs leafdock" >&2
exit 1
