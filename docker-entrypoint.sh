#!/bin/sh
set -e

# Caddy's storage (locks, instance id) lives on the data volume so container
# recreation doesn't lose state; it also keeps state off the image layer.
export XDG_DATA_HOME="${XDG_DATA_HOME:-/data/caddy}"

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

# The API is the primary process; if Caddy dies (bad config push, OOM), keep
# the container alive and bring it back instead of silently losing HTTP.
( while :; do
    wait "$CADDY_PID" 2>/dev/null || true
    sleep 2
    caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
    CADDY_PID=$!
  done ) &

exec node dist/index.js
