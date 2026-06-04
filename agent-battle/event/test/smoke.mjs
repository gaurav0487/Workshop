// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

// End-to-end smoke test for the event server. Starts a server on a test
// port, exercises every seam a real event uses, and exits non-zero on
// any failure.
//
//   node test/smoke.mjs
//
// Covers:
//   1. leaderboard API: auth, achievement gating, cost, ranking
//   2. admin API: session window, reset, status, snapshot round-trip
//   3. wiki MCP: list + lookup via raw streamable-HTTP JSON-RPC
//   4. relay: fake bot registers over WS, MCP tool call round-trips
//   5. config endpoint + static cast view

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8899;
const BASE = `http://localhost:${PORT}`;
const WORKSHOP_KEY = 'test-workshop-key';
const ADMIN_KEY = 'test-admin-key';
const DATA_DIR = join(__dirname, '.smoke-data');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const wkHdr = { 'content-type': 'application/json', 'x-workshop-key': WORKSHOP_KEY };
const adHdr = { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY };

async function post(path, body, headers = wkHdr) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function get(path, headers = {}) {
  const r = await fetch(`${BASE}${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Minimal MCP streamable-HTTP client: initialize → call. Enough to verify
// the protocol handshake that CMA does, without pulling in a client SDK.
async function mcpRequest(path, method, params, id = 1, extraHeaders = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await r.text();
  // Streamable HTTP may answer as JSON or as an SSE event stream.
  if (text.startsWith('event:') || text.includes('\ndata: ') || text.startsWith('data: ')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(dataLine.slice(6));
  }
  return JSON.parse(text);
}

async function mcpInitThenCall(path, callName, callArgs, extraHeaders = {}) {
  const init = await mcpRequest(path, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  }, 1, extraHeaders);
  const tools = await mcpRequest(path, 'tools/list', {}, 2, extraHeaders);
  let call = null;
  if (callName) {
    call = await mcpRequest(path, 'tools/call', { name: callName, arguments: callArgs }, 3, extraHeaders);
  }
  return { init, tools, call };
}

// ── start server ──────────────────────────────────────────────────────
rmSync(DATA_DIR, { recursive: true, force: true });
console.log('starting event server on :' + PORT);
const server = spawn('node', [join(__dirname, '..', 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    WORKSHOP_KEY,
    ADMIN_KEY,
    DATA_DIR,
    EVENT_NAME: 'Smoke Test Event',
    MC_SEED: '12345',
    PUBLIC_URL: BASE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`    [server] ${d}`));
server.stderr.on('data', (d) => process.stdout.write(`    [server!] ${d}`));

try {
  // wait for ready
  let up = false;
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) { up = true; break; }
    } catch { /* retry */ }
  }
  if (!up) throw new Error('server did not start');

  // ── 1. leaderboard API ────────────────────────────────────────────
  console.log('\n[1] leaderboard API');

  let r = await post('/api/achievement', { participant: 'alice', id: 'diamond_1', run_elapsed_ms: 1000 },
    { 'content-type': 'application/json' });
  check('achievement without key → 401', r.status === 401);

  r = await post('/api/achievement', { participant: 'alice', id: 'diamond_1', run_elapsed_ms: 1000 });
  check('achievement with key → 200', r.status === 200, JSON.stringify(r.body));

  r = await post('/api/achievement', { participant: 'alice', id: 'diamond_2', run_elapsed_ms: 400_000 });
  check('achievement past 305s → 403', r.status === 403);

  r = await post('/api/achievement', { participant: 'alice', id: 'not_a_thing', run_elapsed_ms: 1000 });
  check('unknown achievement → 400', r.status === 400);

  r = await post('/api/cost', { participant: 'alice', tokens: 5000, turns: 10, diamonds: 1, run_id: 'r1' });
  check('cost post → 200', r.status === 200);

  r = await post('/api/cost', { participant: 'bob', tokens: 9000, turns: 12, diamonds: 0, run_id: 'r1' });
  await post('/api/achievement', { participant: 'bob', id: 'diamond_1', run_elapsed_ms: 2000 });
  await post('/api/achievement', { participant: 'bob', id: 'diamond_2', run_elapsed_ms: 3000 });

  r = await post('/api/narration', { participant: 'alice', kind: 'thought', text: 'digging down…' });
  check('narration post → 200', r.status === 200);

  r = await post('/api/narration', { participant: 'alice', kind: 'chat', text: 'this fucking pickaxe broke' });
  check('offensive narration → 422', r.status === 422);
  r = await post('/api/cost', { participant: 'f.u.c.k', tokens: 1, turns: 1 });
  check('offensive participant name (evasion) → 422', r.status === 422);
  r = await post('/api/narration', { participant: 'alice', kind: 'chat', text: 'classic Scunthorpe assassin class title' });
  check('benign substring-containing text passes', r.status === 200);

  r = await get('/api/leaderboard');
  const rows = r.body.leaderboard || [];
  check('leaderboard has 2 rows', rows.length === 2, `got ${rows.length}`);
  check('bob ranks first (2 diamonds)', rows[0]?.name === 'bob' && rows[0]?.diamonds_count === 2,
    JSON.stringify(rows.map((x) => [x.name, x.diamonds_count])));
  check('alice second (1 diamond)', rows[1]?.name === 'alice' && rows[1]?.diamonds_count === 1);

  r = await get('/api/narration');
  check('narration GET returns rows', (r.body.narrations || []).length === 2);

  // ── 2. admin API ──────────────────────────────────────────────────
  console.log('\n[2] admin API');

  r = await post('/api/admin/session', { action: 'open', duration_seconds: 60 }, wkHdr);
  check('admin op with workshop key → 401', r.status === 401);

  r = await post('/api/admin/session', { action: 'open', duration_seconds: 60 }, adHdr);
  check('open window → 200', r.status === 200);

  r = await get('/api/admin/session');
  check('window is open', r.body.open === true && !r.body.devAlwaysOpen);

  // achievements posted before the window opened are now out-of-window
  r = await get('/api/leaderboard');
  check('pre-window achievements filtered out', (r.body.leaderboard || []).every((p) => p.diamonds_count === 0),
    JSON.stringify(r.body.leaderboard?.map((x) => [x.name, x.diamonds_count])));

  r = await post('/api/achievement', { participant: 'carol', id: 'diamond_1', run_elapsed_ms: 1000 });
  check('in-window achievement counts', r.status === 200);
  r = await get('/api/leaderboard');
  check('carol on board with 1', r.body.leaderboard?.find((p) => p.name === 'carol')?.diamonds_count === 1);

  r = await post('/api/admin/session', { action: 'close' }, adHdr);
  check('close window → 200', r.status === 200);

  r = await post('/api/achievement', { participant: 'carol', id: 'diamond_2', run_elapsed_ms: 2000 });
  check('post after close → 403', r.status === 403);

  r = await get('/api/admin/status', adHdr);
  check('admin status', r.status === 200 && r.body.participants === 3, JSON.stringify(r.body));

  // snapshot round-trip
  const snap = await get('/api/admin/snapshot', adHdr);
  check('snapshot download', snap.status === 200 && Array.isArray(snap.body.participants));

  r = await post('/api/admin/reset', {}, adHdr);
  check('reset → 200', r.status === 200);
  r = await get('/api/leaderboard');
  check('board empty after reset', (r.body.leaderboard || []).length === 0);

  r = await post('/api/admin/snapshot', snap.body, adHdr);
  check('snapshot restore', r.status === 200 && r.body.participants === 3, JSON.stringify(r.body));

  // ── 3. wiki MCP ───────────────────────────────────────────────────
  console.log('\n[3] wiki MCP');
  const wiki = await mcpInitThenCall('/wiki/mcp', 'lookup', { query: 'where do diamonds spawn' });
  check('wiki initialize', wiki.init?.result?.serverInfo?.name === 'minecraft-wiki', JSON.stringify(wiki.init));
  check('wiki lists lookup tool', wiki.tools?.result?.tools?.[0]?.name === 'lookup');
  check('wiki lookup returns diamond depth', /y=-58/.test(wiki.call?.result?.content?.[0]?.text || ''),
    JSON.stringify(wiki.call));

  // ── 4. relay ──────────────────────────────────────────────────────
  console.log('\n[4] bot relay');
  const KEY = 'smoketestkey1234567890abcdef';

  // MCP against a key with no bot → tool call errors cleanly
  let offline = await mcpInitThenCall(`/p/${KEY}/mcp`, null, null);
  check('relay MCP works with no bot (empty tools)', Array.isArray(offline.tools?.result?.tools)
    && offline.tools.result.tools.length === 0);

  // Registration without the workshop key must be rejected
  const wsBad = new WebSocket(`ws://localhost:${PORT}/relay/ws`);
  const badReply = await new Promise((resolve) => {
    wsBad.on('open', () => wsBad.send(JSON.stringify({
      type: 'register', participant: 'evil', key: 'attacker-key-12345678', tools: [],
      workshop_key: 'wrong',
    })));
    wsBad.on('message', (d) => resolve(JSON.parse(d.toString())));
    wsBad.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });
  check('register with wrong workshop key → rejected', badReply?.type === 'error',
    JSON.stringify(badReply));
  try { wsBad.close(); } catch { /* already closed by server */ }
  r = await get('/p/attacker-key-12345678/status');
  check('rejected registration leaves no record', r.body.connected === false && !r.body.participant);

  // Fake bot: connect WS, register (with the workshop key), answer calls
  const FAKE_TOOLS = [
    { name: 'get_state', description: 'state', inputSchema: { type: 'object', properties: {} } },
    { name: 'mine_block', description: 'mine', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  ];
  const ws = new WebSocket(`ws://localhost:${PORT}/relay/ws`);
  const registered = new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'register', participant: 'smokebot', key: KEY, tools: FAKE_TOOLS,
      workshop_key: WORKSHOP_KEY,
    })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') resolve(msg);
      if (msg.type === 'call') {
        // echo the call back as a result, with a marker
        ws.send(JSON.stringify({
          type: 'result', id: msg.id, ok: true,
          result: { ok: true, echoed: msg.name, args: msg.args, position: { y: -40 } },
        }));
      }
    });
  });
  const reg = await Promise.race([registered, sleep(5000).then(() => null)]);
  check('bot registered over WS', reg?.mcp_path === `/p/${KEY}/mcp`, JSON.stringify(reg));

  r = await get(`/p/${KEY}/status`);
  check('relay status shows connected (boolean only — no identity leak)',
    r.body.connected === true && !('participant' in r.body));

  const relayed = await mcpInitThenCall(`/p/${KEY}/mcp`, 'mine_block', { name: 'diamond_ore' });
  check('relay MCP lists bot tools', relayed.tools?.result?.tools?.length === 2,
    JSON.stringify(relayed.tools?.result));
  const callText = relayed.call?.result?.content?.[0]?.text || '';
  check('relay MCP tool call round-trips', /diamond_ore/.test(callText) && /echoed/.test(callText), callText);

  // Header-auth endpoint (preferred): same bot, key in Authorization header,
  // secret never in the URL path.
  const bearer = { authorization: `Bearer ${KEY}` };
  const viaHeader = await mcpInitThenCall('/bot/smokebot/mcp', 'get_state', {}, bearer);
  check('header-auth MCP lists bot tools', viaHeader.tools?.result?.tools?.length === 2,
    JSON.stringify(viaHeader.tools?.result));
  const headerCallText = viaHeader.call?.result?.content?.[0]?.text || '';
  check('header-auth MCP call routes by bearer', /echoed/.test(headerCallText), headerCallText);
  const noBearer = await mcpInitThenCall('/bot/smokebot/mcp', null, null);
  check('missing bearer → no tools exposed', (noBearer.tools?.result?.tools || []).length === 0);
  const wrongBearer = await mcpInitThenCall('/bot/smokebot/mcp', 'get_state', {},
    { authorization: 'Bearer wrong-key-1234567890' });
  const wrongText = wrongBearer.call?.result?.content?.[0]?.text || '';
  check('wrong bearer → clean not-connected error', /not connected/.test(wrongText), wrongText);

  // Disconnect → status flips, calls error cleanly
  ws.close();
  await sleep(500);
  r = await get(`/p/${KEY}/status`);
  check('relay status shows disconnected after WS close', r.body.connected === false);
  const offlineCall = await mcpInitThenCall(`/p/${KEY}/mcp`, 'mine_block', { name: 'stone' });
  const offText = offlineCall.call?.result?.content?.[0]?.text || '';
  check('tool call while offline → clean error', /not connected/.test(offText), offText);
  check('tools list survives disconnect (cached)', offlineCall.tools?.result?.tools?.length === 2);

  // ── 5. config + static ────────────────────────────────────────────
  console.log('\n[5] config + cast view');
  r = await get('/api/config');
  check('config endpoint', r.body.event_name === 'Smoke Test Event'
    && r.body.relay_url === BASE
    && r.body.wiki_mcp_url === `${BASE}/wiki/mcp`
    && (r.body.repo_qr_svg || '').startsWith('<svg'), JSON.stringify(Object.keys(r.body)));
  check('public config does NOT leak the workshop key',
    !JSON.stringify(r.body).includes(WORKSHOP_KEY));
  r = await get('/api/admin/status', adHdr);
  check('admin status carries workshop key (for share block)',
    r.body.workshop_key === WORKSHOP_KEY);

  const idxRes = await fetch(`${BASE}/`);
  const idx = await idxRes.text();
  check('cast view served', idx.includes('Diamond Leaderboard'));
  check('security headers present',
    idxRes.headers.get('x-content-type-options') === 'nosniff'
    && idxRes.headers.get('x-frame-options') === 'DENY'
    && (idxRes.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  const adminPage = await fetch(`${BASE}/admin`).then((x) => x.text());
  check('admin panel served', adminPage.includes('Agent Battle Admin'));
  const css = await fetch(`${BASE}/css/cast.css`);
  check('static css served', css.ok);

  // Rate limiting: the status endpoint has the tightest bucket (120/min).
  // We already spent a few status calls above; 130 more must trip it.
  let got429 = false;
  for (let i = 0; i < 130 && !got429; i++) {
    const rr = await fetch(`${BASE}/p/ratelimit-probe-key/status`);
    if (rr.status === 429) got429 = true;
  }
  check('per-IP rate limit returns 429', got429);

  // ── 6. persistence across restart ─────────────────────────────────
  console.log('\n[6] snapshot persistence across restart');
  server.kill('SIGTERM');
  await sleep(1000);
  const server2 = spawn('node', [join(__dirname, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), WORKSHOP_KEY, ADMIN_KEY, DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let up2 = false;
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      try { if ((await fetch(`${BASE}/healthz`)).ok) { up2 = true; break; } } catch { /* retry */ }
    }
    check('server restarted', up2);
    r = await get('/api/leaderboard');
    check('board survived restart', (r.body.leaderboard || []).length === 3,
      `got ${(r.body.leaderboard || []).length} rows`);
  } finally {
    server2.kill('SIGKILL');
  }
} catch (e) {
  failures++;
  console.error('\nFATAL:', e);
} finally {
  server.kill('SIGKILL');
  rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
