---
description: Figure out why the Agent Battle stack isn't working and fix it
---

Something broke mid-session. Diagnose and fix the infrastructure
without touching the participant's `AGENT` config.

## Health check (run all of these, then reason from the results)

```bash
echo "── processes ──"
ps -eo pid,comm,args | grep -E 'java.*server.jar|node.*bot.js|node.*server.mjs|cloudflared' | grep -v grep
echo "── bot state (local) ──"
curl -fsS -m 3 http://localhost:8088/state 2>&1 | head -c 400 || echo "(unreachable)"
echo "── relay registration ──"
. .env.setup 2>/dev/null
[ -n "${RELAY_URL:-}" ] && curl -fsS -m 5 "${RELAY_URL%/}/p/${RELAY_KEY}/status" 2>&1 || echo "(no .env.setup — run ./setup.sh first)"
echo "── event server ──"
curl -fsS -m 5 "${LEADERBOARD_URL:-http://localhost:8888/api}/leaderboard" 2>&1 | head -c 200 || echo "(unreachable)"
echo "── recent errors ──"
tail -20 /tmp/mc-server.log /tmp/mc-bot.log /tmp/event-local.log 2>/dev/null
grep '\[relay\]' /tmp/mc-bot.log 2>/dev/null | tail -10
```

## Decision tree

- **No `java` process** → server died. `./setup.sh --restart`.
- **No `node bot.js` process** → bot died (often heap OOM after long
  runs, or kicked by server). `./setup.sh --restart`.
- **Bot state unreachable but process alive** → bot hung. Kill and
  restart: `./setup.sh --restart`.
- **Bot reachable locally, relay status `"connected":false`** → the
  bot's outbound WebSocket to the event server is down. Look at the
  `[relay]` lines in `/tmp/mc-bot.log`:
  - `reconnecting in Ns` lines → it's retrying; if the event server
    is up (`curl $EVENT_URL/api/config`), wait ~30s. If still down,
    `./setup.sh --restart`.
  - `superseded by another registration` → they ran setup on two
    machines with the same copied repo/key. `rm .relay-key &&
    ./setup.sh --restart` mints a fresh key on this machine.
- **Event server unreachable** (`$EVENT_URL/api/config` fails) → that's
  the **facilitator's** problem (they restart it from their hosting
  dashboard). Nothing to fix on this machine; tell the participant
  to flag the facilitator. Their bot reconnects automatically when
  it's back.
- **`my_agent.py` says "no tools"** or hangs at "looking for existing
  agent" forever → stale `.agent_cache.json` pointing at a dead agent.
  `rm -f .agent_cache.json` and retry.
- **Viewer at :8088/view is blank blue** → prismarine-viewer y<0 bug.
  `(cd bot && node patch-viewer.cjs) && ./setup.sh --restart`, then
  hard-refresh the browser (Cmd-Shift-R / Ctrl-Shift-R).
- **SOLO mode: tunnel unreachable** → `rm -f /tmp/cf-tunnel-8888.log
  && ./setup.sh` re-mints the tunnel. The public hostname changes,
  so also `rm -f .agent_cache.json` (the agent's MCP URL moved).

## When in doubt

```bash
./setup.sh --restart && rm -f .agent_cache.json
```

This is the universal fix: fresh world, fresh bot, fresh relay
registration, fresh agent. ~30s. Tell them to re-run
`python3 my_agent.py`.

## Don't

- Don't touch `AGENT["system"]` or any participant-edited config —
  the problem is infrastructure, not their agent.
- Don't edit `bot/`, `harness/`, `event/`, `setup.sh`, `host.sh` —
  workshop rules. If you find an actual bug in these, describe it;
  the facilitator can fix it upstream.
- Never echo their `ANTHROPIC_API_KEY` value into the chat.
