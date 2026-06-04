#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0

# Expose a local port over a public cloudflared quick-tunnel and print the
# resulting https URL on stdout. Used in SOLO mode only, to make the local
# event server (leaderboard + wiki + bot relay) reachable by the cloud
# agent. EVENT mode needs no tunnels at all — the bot dials out to the
# shared event server instead.
#
# Idempotent — reuses an existing live tunnel for the same port rather
# than minting a new URL (quick-tunnel creation is rate-limited per
# source IP, and a new URL invalidates the agent's registered MCP URL).
#
# Usage:
#   ./bot/tunnel.sh                   # tunnels :8888 (the event server)
#   TUNNEL_PORT=9000 ./bot/tunnel.sh  # tunnels another port
#   ./bot/tunnel.sh --stop
set -euo pipefail

TUNNEL_PORT="${TUNNEL_PORT:-8888}"
LOG="/tmp/cf-tunnel-${TUNNEL_PORT}.log"
BIN="${CLOUDFLARED:-/tmp/cloudflared}"

if [ "${1:-}" = "--stop" ]; then
  pkill -f "cloudflared tunnel --url http://localhost:${TUNNEL_PORT}" 2>/dev/null || true
  rm -f "${LOG}"
  echo "[tunnel] stopped" >&2
  exit 0
fi

if [ ! -x "${BIN}" ] && ! command -v cloudflared >/dev/null 2>&1; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   asset=cloudflared-linux-amd64 ;;
    Linux-aarch64)  asset=cloudflared-linux-arm64 ;;
    Darwin-arm64)   asset=cloudflared-darwin-arm64.tgz ;;
    Darwin-x86_64)  asset=cloudflared-darwin-amd64.tgz ;;
    *) echo "[tunnel] no prebuilt cloudflared for $(uname -s)-$(uname -m); install it yourself (e.g. brew install cloudflared)" >&2; exit 1 ;;
  esac
  echo "[tunnel] downloading cloudflared (${asset})..." >&2
  if [[ "${asset}" == *.tgz ]]; then
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}" \
      | tar -xz -O cloudflared > "${BIN}"
  else
    curl -fsSL -o "${BIN}" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}"
  fi
  chmod +x "${BIN}"
fi
[ -x "${BIN}" ] || BIN="$(command -v cloudflared)"

# Reuse a live tunnel if its URL still answers. The health check goes to
# /healthz (event server liveness); fall back to plain reachability for
# any other port.
url="$(grep -ao 'https://[a-z0-9-]*\.trycloudflare\.com' "${LOG}" 2>/dev/null | tail -1 || true)"
alive() {
  curl -fsS -m 5 "$1/healthz" -o /dev/null 2>/dev/null \
    || curl -fsS -m 5 "$1" -o /dev/null 2>/dev/null
}
if [ -z "${url}" ] || ! alive "${url}"; then
  echo "[tunnel] starting cloudflared for :${TUNNEL_PORT}..." >&2
  pkill -f "cloudflared tunnel --url http://localhost:${TUNNEL_PORT}" 2>/dev/null || true
  : > "${LOG}"
  # nohup + ALL THREE fds redirected: cloudflared must never hold this
  # script's stdout — callers capture it via $() and would hang waiting
  # for pipe EOF. Deliberately nohup, NOT setsid: some hardened hosts'
  # security tooling SIGKILLs a /tmp binary that detaches into its own
  # session, while the same binary under nohup runs fine.
  nohup "${BIN}" tunnel --url "http://localhost:${TUNNEL_PORT}" < /dev/null > "${LOG}" 2>&1 &
  url=""
  for _ in $(seq 1 20); do
    sleep 1
    url="$(grep -ao 'https://[a-z0-9-]*\.trycloudflare\.com' "${LOG}" 2>/dev/null | tail -1 || true)"
    [ -n "${url}" ] && break
  done
fi

if [ -z "${url}" ]; then
  echo "[tunnel] failed — see ${LOG}" >&2
  exit 1
fi

echo "[tunnel] ${url} → localhost:${TUNNEL_PORT}" >&2
echo "${url}"
