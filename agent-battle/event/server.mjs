// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

// Agent Battle event server — everything the event needs, in one process:
//
//   /                    cast view (leaderboard + chat + how-to-join panel)
//   /admin               web admin panel (open/close window, reset, status)
//   /api/*               leaderboard API (achievement, cost, narration, leaderboard)
//   /api/admin/*         admin API (session window, reset, status, snapshot)
//   /wiki/mcp            Minecraft-wiki MCP server (the opt-in participant lever)
//   /p/<key>/mcp         per-participant bot MCP (relayed over the bot's
//                        outbound WebSocket — no participant tunnels)
//   /relay/ws            WebSocket endpoint participant bots dial out to
//   /healthz             liveness probe
//
// Run it anywhere that gives you a stable public HTTPS URL (Fly.io,
// Cloud Run, Railway, a VM behind caddy, …). See event/README.md.
//
// Configuration (env):
//   PORT            listen port                       (default 8888)
//   WORKSHOP_KEY    participant write key             (default: open)
//   ADMIN_KEY       facilitator key for /api/admin/*  (default: WORKSHOP_KEY)
//   DATA_DIR        where the board snapshot lives    (default ./data)
//   PUBLIC_URL      this server's public base URL, e.g. https://agent-battle.fly.dev
//   EVENT_NAME      display name on the cast view     (default "Agent Battle")
//   REPO_URL        participant clone URL shown on the join panel
//   REPO_DIR        sub-directory participants cd into
//   MC_SEED         the event's shared world seed (shown on join panel/config)

import express from 'express';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import qrcode from 'qrcode-generator';

import { Board } from './lib/board.mjs';
import { Relay } from './lib/relay.mjs';
import { lookup, WIKI_TOOL } from './lib/wiki.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── config ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8888', 10);
const WORKSHOP_KEY = process.env.WORKSHOP_KEY || '';
// Fail closed on admin auth: the workshop key is semi-public (committed to
// .env.event, shared with every participant), so it must NEVER double as
// the admin key. If a deployment sets WORKSHOP_KEY but forgets ADMIN_KEY,
// generate an unguessable one instead of letting participants escalate.
// Both unset = fully open local dev (matches keyMatches() semantics).
let ADMIN_KEY = process.env.ADMIN_KEY || '';
let adminKeyGenerated = false;
if (!ADMIN_KEY && WORKSHOP_KEY) {
  ADMIN_KEY = randomBytes(16).toString('hex');
  adminKeyGenerated = true;
}
if (ADMIN_KEY && ADMIN_KEY === WORKSHOP_KEY) {
  console.log('[event] WARNING: ADMIN_KEY equals WORKSHOP_KEY — every participant '
    + 'can reach the admin panel. Set a distinct ADMIN_KEY.');
}
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const EVENT_NAME = process.env.EVENT_NAME || 'Agent Battle';
const REPO_URL = process.env.REPO_URL || 'https://github.com/anthropics/cwc-workshops';
const REPO_DIR = process.env.REPO_DIR || 'agent-battle';
const MC_SEED = process.env.MC_SEED || '';

const board = new Board(join(DATA_DIR, 'board-snapshot.json'));
const TRUST_PROXY_HOPS = parseInt(process.env.TRUST_PROXY ?? '1', 10);
const relay = new Relay({ workshopKey: WORKSHOP_KEY, trustProxy: TRUST_PROXY_HOPS });
const startedAt = Date.now();

// ── auth helpers ──────────────────────────────────────────────────────
function keyMatches(provided, expected) {
  if (!expected) return true; // no key configured → open (local dev)
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Participant writes (achievement/cost/narration). Same model the bots and
// harness already use: x-workshop-key shared secret.
function requireWorkshopKey(req, res, next) {
  if (keyMatches(req.headers['x-workshop-key'], WORKSHOP_KEY)) return next();
  res.status(401).json({ error: 'unauthorized (x-workshop-key)' });
}

// Facilitator ops. Never satisfied by the workshop key unless no admin key
// is configured at all.
function requireAdminKey(req, res, next) {
  if (keyMatches(req.headers['x-admin-key'], ADMIN_KEY)) return next();
  res.status(401).json({ error: 'unauthorized (x-admin-key)' });
}

// ── app ───────────────────────────────────────────────────────────────
const app = express();
// TRUST_PROXY=1 (default) is for the documented deploy paths — Cloud Run /
// Fly always front the container and append the REAL client IP to
// X-Forwarded-For, so trusting exactly 1 hop makes req.ip that address
// while ignoring client-spoofable earlier entries. If you expose the
// container DIRECTLY (no fronting proxy), set TRUST_PROXY=0: otherwise
// any client can spoof X-Forwarded-For and rotate fake IPs past the
// per-IP rate limits below. req.ip is never used for auth, only limits.
const TRUST_PROXY = TRUST_PROXY_HOPS;
app.set('trust proxy', TRUST_PROXY);

// Operator validation aid: log the first few distinct client IPs the rate
// limiter resolves. If proxy-trust is wrong, this shows up immediately as
// every request resolving to the same infrastructure IP (or a loopback).
// Additionally detect the actually-dangerous misconfiguration at runtime:
// TRUST_PROXY > 0 while connections arrive DIRECTLY from public addresses
// means there is no fronting proxy and X-Forwarded-For is client-spoofable.
// (Default stays 1 because the documented deploy paths — Cloud Run / Fly —
// are always proxied, and trusting 0 hops there collapses every client
// into one shared rate bucket.)
function isPrivateOrLocalAddr(addr) {
  if (!addr) return true;
  const ip = String(addr).replace(/^::ffff:/, '');
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.')
    || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || ip.startsWith('169.254.') || /^f[cd]/i.test(ip) || ip.toLowerCase().startsWith('fe80');
}
const seenIps = new Set();
let warnedDirectExposure = false;
app.use((req, _res, next) => {
  if (seenIps.size < 3 && !seenIps.has(req.ip)) {
    seenIps.add(req.ip);
    console.log(`[event] rate-limit identity sample ${seenIps.size}/3: req.ip=${req.ip} `
      + `(TRUST_PROXY=${TRUST_PROXY}; distinct real clients should produce distinct values)`);
  }
  if (!warnedDirectExposure && TRUST_PROXY > 0
      && !isPrivateOrLocalAddr(req.socket?.remoteAddress)) {
    warnedDirectExposure = true;
    console.log(`[event] WARNING: TRUST_PROXY=${TRUST_PROXY} but this connection arrived `
      + `DIRECTLY from a public address (${req.socket.remoteAddress}) — there is no fronting `
      + `proxy, so X-Forwarded-For is client-spoofable and per-IP rate limits can be bypassed. `
      + `Set TRUST_PROXY=0 for direct exposure.`);
  }
  next();
});
app.use(express.json({ limit: '256kb' }));

// Security headers (web-security pre-deployment checklist). CSP permits
// inline script/style because both views inline them by design; the
// primary XSS defense is textContent-escaping of all user strings — CSP
// adds the backstop against external script injection and framing.
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; "
      + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
      + "font-src https://fonts.gstatic.com; img-src 'self' data:; "
      + "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
});

// App-level rate limiting (checklist requirement; a WAF can't see inside
// WebSocket traffic and Cloud Run has no built-in per-IP cap). Fixed
// 60s-window per-IP counters, by route class. Budgets are flood-stoppers
// sized for venue NAT: an entire conference room legitimately shares one
// public IP (dozens of bots + browsers), so per-IP limits must be generous
// — the goal is stopping abuse loops, not precision quotas.
const RATE_LIMITS = { write: 1200, mcp: 1200, status: 120, read: 6000 };
const rateBuckets = new Map(); // `${class}:${bucketKey}` -> {windowStart, count}
// keyFn defaults to client IP; routes with a better (unspoofable) identity
// can supply their own — e.g. the per-bot MCP path keys on the relay key,
// which is per-participant and immune to X-Forwarded-For games.
function rateLimit(cls, keyFn = (req) => req.ip) {
  const max = RATE_LIMITS[cls];
  return (req, res, next) => {
    const now = Date.now();
    const key = `${cls}:${keyFn(req)}`;
    let b = rateBuckets.get(key);
    if (!b || now - b.windowStart >= 60_000) {
      b = { windowStart: now, count: 0 };
      rateBuckets.set(key, b);
    }
    if (++b.count > max) {
      return res.status(429).json({ error: 'rate limited — slow down and retry shortly' });
    }
    next();
  };
}
// Cap bucket cardinality: on a misconfigured direct-exposure deploy an
// XFF-rotating client could otherwise balloon this map. Past the cap we
// wipe and start over — under a key-rotation flood, losing counters for a
// window is strictly better than unbounded memory.
const MAX_RATE_BUCKETS = 50_000;
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [k, b] of rateBuckets) {
    if (b.windowStart < cutoff) rateBuckets.delete(k);
  }
  if (rateBuckets.size > MAX_RATE_BUCKETS) rateBuckets.clear();
}, 60_000).unref();

const httpServer = createServer(app);
relay.attach(httpServer, '/relay/ws');

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) }));

// ── leaderboard API ───────────────────────────────────────────────────
app.post('/api/achievement', rateLimit('write'), requireWorkshopKey, (req, res) => {
  const { status, body } = board.recordAchievement(req.body || {});
  res.status(status).json(body);
});

app.post('/api/cost', rateLimit('write'), requireWorkshopKey, (req, res) => {
  const { status, body } = board.recordCost(req.body || {});
  res.status(status).json(body);
});

app.post('/api/narration', rateLimit('write'), requireWorkshopKey, (req, res) => {
  const { status, body } = board.recordNarration(req.body || {});
  res.status(status).json(body);
});

app.get('/api/narration', rateLimit('read'), (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const limit = parseInt(req.query.limit || '200', 10);
  res.json({ narrations: board.getNarrations({ since, limit }) });
});

app.get('/api/leaderboard', rateLimit('read'), (_req, res) => {
  res.json({ leaderboard: board.leaderboard() });
});

// Join-panel / participant config. Public by design — these values are
// committed to the public repo's .env.event anyway.
const repoQrSvg = (() => {
  const qr = qrcode(0, 'M');
  qr.addData(REPO_URL);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
})();

app.get('/api/config', (req, res) => {
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    event_name: EVENT_NAME,
    repo_url: REPO_URL,
    repo_dir: REPO_DIR,
    repo_qr_svg: repoQrSvg,
    leaderboard_url: `${base}/api`,
    wiki_mcp_url: `${base}/wiki/mcp`,
    relay_url: base,
    // workshop_key intentionally NOT here: this endpoint is unauthenticated
    // (the cast view reads it), and the write key shouldn't be handed to
    // anyone who merely knows the event URL. Participants get the key from
    // .env.event; the presenter sees it in /api/admin/status (admin-authed).
    mc_seed: MC_SEED,
  });
});

// ── admin API ─────────────────────────────────────────────────────────
// GET session state is public (the cast view countdown polls it).
app.get('/api/admin/session', (_req, res) => res.json(board.sessionWindow()));

app.post('/api/admin/session', requireAdminKey, (req, res) => {
  const { action, duration, duration_seconds } = req.body || {};
  if (action === 'open') {
    return res.json({ ok: true, session: board.openSession(duration_seconds ?? duration ?? 1800) });
  }
  if (action === 'close') {
    const closed = board.closeSession();
    if (!closed) return res.status(400).json({ error: 'no open session' });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'action must be "open" or "close"' });
});

app.post('/api/admin/reset', requireAdminKey, (_req, res) => {
  res.json({ ok: true, ...board.reset() });
});

app.get('/api/admin/status', requireAdminKey, (_req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    session: board.sessionWindow(),
    participants: board.participants.size,
    narrations: board.narrations.length,
    relays: relay.status(),
    // For the admin panel's .env.event share block — admin-authed only.
    workshop_key: WORKSHOP_KEY || 'devkey',
  });
});

// Board backup / restore — the presenter's safety net on hosts with
// ephemeral disks (Cloud Run) or before a risky reset.
app.get('/api/admin/snapshot', requireAdminKey, (_req, res) => {
  res.setHeader('content-disposition', 'attachment; filename="board-snapshot.json"');
  res.json(board.toJSON());
});

app.post('/api/admin/snapshot', requireAdminKey, (req, res) => {
  try {
    board.restore(req.body || {});
    res.json({ ok: true, participants: board.participants.size });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── MCP endpoints (stateless streamable HTTP) ─────────────────────────
// Stateless on purpose: every POST creates a fresh Server+transport, so a
// server restart mid-event never strands client sessions, and multiple
// instances behind a load balancer would also work.
function mountMcp(path, buildServer, rateKeyFn) {
  app.post(path, rateLimit('mcp', rateKeyFn), async (req, res) => {
    try {
      const server = buildServer(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.log(`[mcp ${path}] error:`, e.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      }
    }
  });
  const reject = (_req, res) => res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'stateless server: POST only' },
    id: null,
  });
  app.get(path, reject);
  app.delete(path, reject);
}

// Wiki MCP — the facilitator-provided knowledge lever.
mountMcp('/wiki/mcp', () => {
  const server = new Server(
    { name: 'minecraft-wiki', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [WIKI_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: lookup(req.params.arguments?.query) }],
  }));
  return server;
});

// Bot MCP server bound to one relay key — shared by both auth styles below.
function buildBotMcp(key) {
  const server = new Server(
    { name: 'minecraft-bot', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: relay.tools(key) || [],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (mcpReq) => {
    const { name, arguments: args } = mcpReq.params;
    const out = await relay.call(key, name, args || {});
    if (out.ok) {
      return { content: [{ type: 'text', text: JSON.stringify(out.result) }] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: out.error }) }],
      isError: true,
    };
  });
  return server;
}

function bearerKey(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

// Rate-limit identity for bot MCP routes is hybrid: a KNOWN relay key
// (which can only exist via a workshop-key-authenticated registration)
// gets its own bucket — fair per-participant budgets even behind shared
// venue NAT. Unknown keys fall back to the caller's IP bucket, so neither
// rotating made-up keys nor spoofed XFF mints fresh buckets.
const botMcpRateKey = (keyOf) => (req) => {
  const k = keyOf(req);
  return relay.isKnown(k) ? `k:${k}` : `ip:${req.ip}`;
};

// PREFERRED: header-authenticated bot MCP. The relay key arrives as
// `Authorization: Bearer <key>` (CMA injects it via a vault static_bearer
// credential), so the secret never appears in URL paths — which Cloud Run
// request logs record at the infrastructure layer, visible to all project
// viewers. The :name segment is the (public) participant name; it exists
// only because vault credentials bind to a unique URL per participant —
// routing is purely by the bearer key.
mountMcp('/bot/:name/mcp', (req) => buildBotMcp(bearerKey(req)),
  botMcpRateKey(bearerKey));

// LEGACY: URL-keyed bot MCP, kept for solo/local mode and older configs.
// The key in the path is the credential; on shared deployments prefer the
// header route above. DISABLE_URL_KEY_MCP=1 turns this endpoint off at
// request time (env change only — no redeploy): set it on the production
// service once the header-auth path is live-verified, so credentials can
// never appear in infrastructure request logs.
function buildDisabledMcp() {
  const server = new Server(
    { name: 'minecraft-bot', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'URL-keyed endpoint disabled on this deployment — use the header-authenticated /bot/<name>/mcp endpoint' }) }],
    isError: true,
  }));
  return server;
}

mountMcp('/p/:key/mcp', (req) => (
  process.env.DISABLE_URL_KEY_MCP === '1'
    ? buildDisabledMcp()
    : buildBotMcp(req.params.key)
), botMcpRateKey((req) => req.params.key));

// Relay status for a specific key — lets the participant's setup.sh and
// my_agent.py verify "is MY bot connected" without admin auth. Returns
// ONLY a boolean: no participant name (that would make this a key→identity
// oracle) and no tool list. Rate-limited to blunt key scanning, though the
// 128-bit keyspace is the real defense.
app.get('/p/:key/status', rateLimit('status'), (req, res) => {
  res.json({ connected: relay.isConnected(req.params.key) });
});

// ── static (cast view + admin panel) ──────────────────────────────────
const PUBLIC_DIR = join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));
app.get('/admin', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'admin.html')));
// Fallback: bare GET paths (no extension, not API/MCP/relay) get the cast
// view, so e.g. /tokyo or /?cast=1 land on the leaderboard.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const p = req.path;
  if (p.startsWith('/api/') || p.startsWith('/p/') || p.startsWith('/wiki')
      || p.startsWith('/relay') || p.includes('.')) return next();
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// ── start ─────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[event] Agent Battle event server on :${PORT}`);
  console.log(`[event]   cast view    http://localhost:${PORT}/`);
  console.log(`[event]   admin panel  http://localhost:${PORT}/admin`);
  console.log(`[event]   wiki MCP     http://localhost:${PORT}/wiki/mcp`);
  console.log(`[event]   bot relay    ws(s)://<host>/relay/ws  →  /p/<key>/mcp`);
  console.log(`[event]   auth         workshop key ${WORKSHOP_KEY ? 'SET' : 'OPEN (dev)'}, admin key ${ADMIN_KEY ? 'SET' : 'OPEN (dev)'}`);
  if (TRUST_PROXY > 0) {
    console.log(`[event]   NOTE: TRUST_PROXY=${TRUST_PROXY} — per-IP rate limits assume a fronting `
      + `proxy (Cloud Run/Fly). If this container is exposed DIRECTLY, set `
      + `TRUST_PROXY=0 or clients can spoof X-Forwarded-For past the limits.`);
  }
  if (adminKeyGenerated) {
    console.log(`[event]   NOTE: ADMIN_KEY was not set — generated an ephemeral one `
      + `(${ADMIN_KEY.slice(0, 8)}…). The admin panel is unreachable until you `
      + `restart with an explicit ADMIN_KEY env var.`);
  }
});

// Graceful shutdown: flush the snapshot so a platform restart (deploy,
// scale event, OOM) never loses more than the last 500ms of writes.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[event] ${sig} — flushing snapshot and exiting`);
    try { board.flush(); } catch { /* best effort */ }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
