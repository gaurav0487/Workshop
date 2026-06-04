// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

// Relay client — connects the bot OUT to the event server so a Managed
// Agent in Anthropic's cloud can reach it without any tunnel.
//
// The bot dials wss://<event-server>/relay/ws, registers its participant
// name + secret key + MCP tool list, then answers tool calls forwarded
// over the socket. The agent's MCP URL becomes
//   <event-server>/p/<key>/mcp
// which is stable across bot restarts (the key is persisted by setup.sh).
//
// Why outbound-only matters: venue NATs + corporate networks block or
// rate-limit anything that needs an inbound path (cloudflared quick
// tunnels hit Cloudflare's per-IP quota when 30 laptops share one IP).
// An outbound WebSocket is just HTTPS traffic — it works anywhere the
// participant's browser works.

const WebSocket = require('ws');

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * @param {object} opts
 * @param {string} opts.relayUrl    event server base URL (http(s)://…)
 * @param {string} opts.key         participant relay key (the URL secret)
 * @param {string} opts.workshopKey shared event write key (.env.event LEADERBOARD_KEY)
 * @param {string} opts.participant display name
 * @param {Array}  opts.tools       MCP tool schema list to register
 * @param {(name: string, args: object) => Promise<object>} opts.dispatch
 *                                  executes a tool call, throws on error
 */
function startRelayClient({ relayUrl, key, workshopKey = '', participant, tools, dispatch }) {
  const wsUrl = relayUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/relay/ws';
  const mcpUrl = relayUrl.replace(/\/$/, '') + `/p/${key}/mcp`;
  // For logs only: the relay key is a secret (it IS the MCP URL's auth),
  // and bot logs get pasted into chats / shown on screen-shares.
  const mcpUrlMasked = relayUrl.replace(/\/$/, '') + `/p/${key.slice(0, 8)}…/mcp`;
  let ws = null;
  let backoff = BACKOFF_MIN_MS;
  let stopped = false;

  function connect() {
    if (stopped) return;
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      backoff = BACKOFF_MIN_MS;
      ws.send(JSON.stringify({
        type: 'register', participant, key, tools,
        workshop_key: workshopKey,
      }));
    });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'registered') {
        console.log(`[relay] connected — agent MCP URL: ${mcpUrlMasked}`);
        return;
      }
      if (msg.type === 'error') {
        console.log(`[relay] server rejected registration: ${msg.error}`);
        return;
      }
      if (msg.type === 'call') {
        let reply;
        try {
          const result = await dispatch(msg.name, msg.args || {});
          reply = { type: 'result', id: msg.id, ok: true, result };
        } catch (e) {
          reply = { type: 'result', id: msg.id, ok: false, error: String(e.message || e) };
        }
        // The socket may have dropped during a long tool call; the relay
        // already failed the call on its side, so just log.
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(reply));
        } else {
          console.log(`[relay] result for ${msg.name} dropped (socket closed mid-call)`);
        }
      }
    });

    ws.on('close', (code, reason) => {
      if (stopped) return;
      if (code === 4000) {
        // Another bot registered with our key (e.g. the participant ran
        // setup on a second machine). Don't fight it — back off for a
        // while, then re-register; last writer wins.
        console.log('[relay] superseded by another registration with the same key; retrying in 60s');
        setTimeout(connect, 60_000);
        return;
      }
      console.log(`[relay] disconnected (${code}${reason ? ` ${reason}` : ''}) — reconnecting in ${Math.round(backoff / 1000)}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    });

    ws.on('error', (e) => {
      // 'close' fires after 'error'; reconnect logic lives there.
      console.log(`[relay] socket error: ${e.message}`);
    });
  }

  connect();

  return {
    mcpUrl,
    stop() {
      stopped = true;
      try { ws?.close(); } catch { /* noop */ }
    },
  };
}

module.exports = { startRelayClient };
