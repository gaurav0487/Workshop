import WebSocket from 'ws';
const URL = (process.env.EVENT_URL || 'http://localhost:8888').replace(/\/$/, '');
const WS_URL = URL.replace(/^http/, 'ws') + '/relay/ws';
const WK = process.env.WORKSHOP_KEY;
const KEY = process.env.LIVE_VERIFY_KEY || 'live-verify-key-' + Math.random().toString(16).slice(2, 14) + Date.now().toString(16);
if (!WK) { console.error('Set WORKSHOP_KEY (and optionally EVENT_URL, LIVE_VERIFY_KEY)'); process.exit(1); }
const TOOLS = [{ name: 'get_state', description: 'state', inputSchema: { type: 'object', properties: {} } }];

const results = [];
function check(name, ok, detail = '') { results.push([ok, name, detail]); }

async function mcp(path, method, params, id, headers = {}) {
  const r = await fetch(URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await r.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

// 1. register over live WSS
const ws = new WebSocket(WS_URL);
const reg = await new Promise((resolve) => {
  ws.on('open', () => ws.send(JSON.stringify({ type: 'register', participant: 'live-verify', key: KEY, tools: TOOLS, workshop_key: WK })));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'registered') resolve(m);
    if (m.type === 'call') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result: { ok: true, live: 'round-trip', tool: m.name } }));
  });
  ws.on('error', (e) => resolve({ error: e.message }));
  setTimeout(() => resolve(null), 15000);
});
check('bot registered over live WSS', reg?.mcp_path === `/p/${KEY}/mcp`, JSON.stringify(reg));

// 2. status boolean
const st = await fetch(`${URL}/p/${KEY}/status`).then((r) => r.json());
check('live status connected (boolean only)', st.connected === true && !('participant' in st), JSON.stringify(st));

// 3. header-auth MCP round-trip
await mcp('/bot/live-verify/mcp', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'v', version: '0' } }, 1, { authorization: `Bearer ${KEY}` });
const tools = await mcp('/bot/live-verify/mcp', 'tools/list', {}, 2, { authorization: `Bearer ${KEY}` });
check('header-auth lists tools', tools?.result?.tools?.length === 1, JSON.stringify(tools?.result));
const call = await mcp('/bot/live-verify/mcp', 'tools/call', { name: 'get_state', arguments: {} }, 3, { authorization: `Bearer ${KEY}` });
const text = call?.result?.content?.[0]?.text || '';
check('header-auth tool call round-trips through live relay', /round-trip/.test(text), text);

// 4. wrong bearer
const bad = await mcp('/bot/live-verify/mcp', 'tools/list', {}, 4, { authorization: 'Bearer wrong-key-000000' });
check('wrong bearer sees no tools', (bad?.result?.tools || []).length === 0);

// 5. legacy URL-key endpoint still functional (kill switch not yet flipped)
await mcp(`/p/${KEY}/mcp`, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'v', version: '0' } }, 5);
const legacy = await mcp(`/p/${KEY}/mcp`, 'tools/list', {}, 6);
check('legacy URL-key endpoint live (pre-kill-switch)', legacy?.result?.tools?.length === 1);

ws.close();
for (const [ok, name, detail] of results) console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
process.exit(results.every(([ok]) => ok) ? 0 : 1);
