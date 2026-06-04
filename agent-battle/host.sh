#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Self-hosted event server launcher — the FALLBACK hosting path.
#
# The recommended way to host an event is a real container platform with
# a stable URL (see event/README.md — Fly.io / Cloud Run / any Docker
# host). Use this script only when that isn't available: it runs the
# event server on THIS machine and exposes it through a cloudflared
# quick-tunnel, whose URL changes if the tunnel ever restarts.
#
#   ./host.sh             start event server + tunnel + watchdog
#   ./host.sh --stop      tear everything down (URL is lost!)
#   ./host.sh --status    show URLs, keys, and service health
#
# Once it's up, ALL event operations (open/close scoring window, reset
# board, see connected bots) happen in the web admin panel:
#   <EVENT_URL>/admin   (admin key printed below / in .host-state/admin-key)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

EVENT_PORT="${EVENT_PORT:-8888}"
KEY="${WORKSHOP_KEY:-devkey}"
EVENT_NAME="${EVENT_NAME:-Agent Battle}"
STATE_DIR="$(pwd)/.host-state"
mkdir -p "${STATE_DIR}"
URLFILE="${STATE_DIR}/host-urls.env"
ADMINFILE="${STATE_DIR}/admin-key"
DATA_DIR="${STATE_DIR}/event-data"

say()  { printf "\033[1;36m▸\033[0m %s\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

# Facilitator-only key for the admin panel / admin API. Persisted across
# restarts; never shared with participants.
[ -f "${ADMINFILE}" ] || python3 -c 'import secrets;print(secrets.token_hex(16))' > "${ADMINFILE}"
ADMIN_KEY="$(cat "${ADMINFILE}")"

case "${1:-}" in
  --stop)
    say "stopping self-hosted event server..."
    ps -eo pid,comm,args | awk '$2=="node" && index($0,"event/server.mjs")>0 {print $1}' \
      | xargs -r kill 2>/dev/null
    ps -eo pid,args | awk -v p=":${EVENT_PORT}" 'index($0,"cloudflared")>0 && index($0,p)>0 {print $1}' \
      | xargs -r kill 2>/dev/null
    pkill -f "host-watchdog" 2>/dev/null
    rm -f "$URLFILE" /tmp/host-event.log
    ok "stopped (the tunnel URL is gone — a restart mints a NEW one)"
    exit 0 ;;
  --status)
    [ -f "$URLFILE" ] && cat "$URLFILE" || echo "not running (no ${URLFILE})"
    echo
    echo "admin key: ${ADMIN_KEY}"
    curl -fsS -m 5 "http://localhost:${EVENT_PORT}/api/admin/status" -H "x-admin-key: ${ADMIN_KEY}" 2>/dev/null \
      | python3 -m json.tool 2>/dev/null || echo "event server not responding on :${EVENT_PORT}"
    exit 0 ;;
  --watchdog)
    # Internal: keep the event server + tunnel alive. Re-exec'd into the
    # background by the main path below; safe to run interactively too.
    while true; do
      sleep 60
      curl -fsS -m 5 "http://localhost:${EVENT_PORT}/healthz" >/dev/null 2>&1 || {
        echo "[watchdog] $(date -u +%FT%TZ) event server down — restarting" >> "${STATE_DIR}/watchdog.log"
        "$0" >> "${STATE_DIR}/watchdog.log" 2>&1
      }
      if [ -f "$URLFILE" ]; then
        # shellcheck disable=SC1090
        . "$URLFILE"
        curl -fsS -m 10 "${EVENT_URL}/healthz" >/dev/null 2>&1 || {
          echo "[watchdog] $(date -u +%FT%TZ) tunnel dead — restarting (URL may change!)" >> "${STATE_DIR}/watchdog.log"
          "$0" >> "${STATE_DIR}/watchdog.log" 2>&1
        }
      fi
    done ;;
esac

# ── deps ────────────────────────────────────────────────────────────
[ -d event/node_modules ] || ( cd event && npm install --no-audit --no-fund --loglevel=error )

# ── seed ────────────────────────────────────────────────────────────
# Preserve the existing seed across re-runs so the event config stays
# consistent. New seed only if MC_SEED is unset AND no prior URLFILE.
SEED="${MC_SEED:-}"
[ -z "$SEED" ] && [ -f "$URLFILE" ] && SEED="$(grep MC_SEED "$URLFILE" | sed -n "s/.*='\([^']*\)'.*/\1/p")"
[ -z "$SEED" ] && SEED="$(python3 -c 'import secrets; print(secrets.randbelow(10**18 - 10**17) + 10**17)')"

# ── event server ────────────────────────────────────────────────────
say "event server"
if ! curl -fsS -m 2 "http://localhost:${EVENT_PORT}/healthz" 2>/dev/null | grep -q '"ok":true'; then
  # Replace anything stale on the port (e.g. the retired dev-server.mjs).
  lsof -ti:"${EVENT_PORT}" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null
  sleep 1
  # nohup + full fd redirection, no subshell — see setup.sh for why a
  # subshell hangs output-capturing callers (and why not setsid: macOS).
  WORKSHOP_KEY="${KEY}" ADMIN_KEY="${ADMIN_KEY}" PORT="${EVENT_PORT}" \
    DATA_DIR="${DATA_DIR}" MC_SEED="${SEED}" EVENT_NAME="${EVENT_NAME}" \
    nohup node event/server.mjs < /dev/null > /tmp/host-event.log 2>&1 &
  for _ in $(seq 1 15); do
    curl -fsS -m 2 "http://localhost:${EVENT_PORT}/healthz" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS -m 2 "http://localhost:${EVENT_PORT}/healthz" >/dev/null 2>&1 \
    || die "event server failed — see /tmp/host-event.log"
fi
ok "event server :${EVENT_PORT} (leaderboard + wiki MCP + bot relay + admin)"

# ── tunnel ──────────────────────────────────────────────────────────
say "public tunnel"
TUNNEL_URL="$(TUNNEL_PORT=${EVENT_PORT} ./bot/tunnel.sh 2>/dev/null)" \
  || die "tunnel failed — see /tmp/cf-tunnel-${EVENT_PORT}.log"
TUNNEL_URL="${TUNNEL_URL%/}"
[ -n "$TUNNEL_URL" ] || die "tunnel produced no URL — see /tmp/cf-tunnel-${EVENT_PORT}.log"
ok "tunnel ${TUNNEL_URL}"

# ── watchdog ────────────────────────────────────────────────────────
if ! pgrep -f "host.sh --watchdog" >/dev/null 2>&1; then
  nohup bash -c "exec -a host-watchdog \"$(pwd)/host.sh\" --watchdog" \
    < /dev/null > /dev/null 2>&1 &
  disown
  ok "watchdog started (checks every 60s, log: .host-state/watchdog.log)"
fi

# ── persist + print ─────────────────────────────────────────────────
cat > "$URLFILE" <<EOF
EVENT_URL='${TUNNEL_URL}'
LEADERBOARD_KEY='${KEY}'
MC_SEED='${SEED}'
EOF

echo
echo "════════════════════════════════════════════════════════════════"
echo " EVENT IS UP — self-hosted (quick-tunnel URL, can change on restart)"
echo "════════════════════════════════════════════════════════════════"
echo
echo " 1. Commit this as .env.event in the public repo so participants"
echo "    get it automatically:"
echo
cat "$URLFILE" | sed 's/^/      /'
echo
echo " 2. Presenter bookmarks (keep these private):"
echo "      admin panel   ${TUNNEL_URL}/admin"
echo "      admin key     ${ADMIN_KEY}"
echo
echo " 3. Projector:"
echo "      cast view     ${TUNNEL_URL}/"
echo
echo " Open/close the scoring window, reset the board, and watch"
echo " connected bots from the admin panel — no shell needed."
echo
echo " NOTE: prefer real hosting (event/README.md) — if this machine's"
echo " tunnel dies, the URL changes and every participant must re-pull"
echo " .env.event."
