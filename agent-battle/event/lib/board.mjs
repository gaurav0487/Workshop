// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

// Leaderboard state machine for the Agent Battle event server.
//
// Pure in-memory state with debounced disk snapshots. All scoring rules
// live here:
//   - achievements (diamond_1, diamond_2, …) are the source of truth for
//     diamond counts; each POST is gated by run_elapsed_ms <= 305s
//   - /cost posts carry tokens/turns and pick the tiebreaker run
//   - ranking = best-run diamonds DESC, that run's tokens ASC
//   - a "session window" gates all writes; outside it, posts get 403

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { isClean } from './moderation.mjs';

// Legacy milestone/quest points kept for back-compat with older bots that
// still post wooden_pickaxe etc. They don't affect Agent Battle ranking.
const TASK_POINTS = {
  wooden_pickaxe: 200, stone_pickaxe: 200, furnace: 200, iron_ingot: 400,
  iron_pickaxe: 200, diamond: 200,
  first_block: 100, chat_to_player: 100, meet_a_friend: 100,
  home_builder: 100, light_it_up: 100, deep_diver: 100,
};
const MILESTONE_IDS = new Set([
  'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_ingot',
  'iron_pickaxe', 'diamond',
]);
const DIAMOND_RE = /^diamond_\d+$/;

// 5 min + 5s grace; bot.js stamps run_elapsed_ms on every achievement.
export const MAX_RUN_MS = 305_000;

function pointsFor(id) {
  if (TASK_POINTS[id] !== undefined) return TASK_POINTS[id];
  if (DIAMOND_RE.test(id)) return 0;
  return undefined; // unknown → rejected
}

export class Board {
  constructor(snapshotPath) {
    this.snapshotPath = snapshotPath;
    this.participants = new Map(); // name -> participant record
    this.narrations = [];          // {participant, name, kind, text, ts}
    this.session = null;           // {opened_at, closed_at, duration_seconds}
    this._saveTimer = null;
    this._load();
  }

  // ── persistence ───────────────────────────────────────────────────
  _load() {
    if (!this.snapshotPath) return;
    try {
      const s = JSON.parse(readFileSync(this.snapshotPath, 'utf8'));
      for (const p of s.participants || []) {
        // Old snapshots stored completed_tasks as an array (Set);
        // current format is an object (id → ISO ts).
        const ct = Array.isArray(p.completed_tasks)
          ? new Map(p.completed_tasks.map((id) => [id, null]))
          : new Map(Object.entries(p.completed_tasks || {}));
        this.participants.set(p.name, {
          ...p,
          completed_tasks: ct,
          runs: new Map(Object.entries(p.runs || {})),
        });
      }
      this.narrations = s.narrations || [];
      this.session = s.session || null;
      console.log(`[board] restored ${this.participants.size} participants from ${this.snapshotPath}`);
    } catch { /* no snapshot yet */ }
  }

  save() {
    if (!this.snapshotPath || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 500);
  }

  // Synchronous write — used by save()'s debounce timer and by graceful
  // shutdown (where waiting 500ms isn't an option).
  flush() {
    if (!this.snapshotPath) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      writeFileSync(this.snapshotPath, JSON.stringify(this.toJSON()));
    } catch (e) {
      console.log('[board] snapshot save failed:', e.message);
    }
  }

  toJSON() {
    return {
      participants: [...this.participants.values()].map((p) => ({
        ...p,
        completed_tasks: Object.fromEntries(p.completed_tasks),
        runs: Object.fromEntries(p.runs),
      })),
      narrations: this.narrations.slice(-200),
      session: this.session,
    };
  }

  restore(json) {
    this.participants = new Map();
    this.narrations = [];
    this.session = null;
    for (const p of json.participants || []) {
      this.participants.set(p.name, {
        ...p,
        completed_tasks: new Map(Object.entries(p.completed_tasks || {})),
        runs: new Map(Object.entries(p.runs || {})),
      });
    }
    this.narrations = json.narrations || [];
    this.session = json.session || null;
    this.save();
  }

  // ── session window ────────────────────────────────────────────────
  // Until a session is first opened, the window is treated as always-
  // open so local/solo testing needs no admin steps. Once opened, the
  // window is enforced strictly.
  sessionWindow() {
    const s = this.session;
    if (!s) return { open: true, devAlwaysOpen: true };
    const opened = new Date(s.opened_at).getTime();
    const closes = s.closed_at
      ? new Date(s.closed_at).getTime()
      : opened + (s.duration_seconds || 2700) * 1000;
    const now = Date.now();
    // Strict `<`: an explicit close means closed from that instant — a
    // write landing in the same millisecond as closeSession() must not
    // slip in (this was an observable race under test).
    const open = now >= opened && now < closes;
    return {
      open,
      opened_at: s.opened_at,
      closes_at: new Date(closes).toISOString(),
      remaining_seconds: open ? Math.max(0, Math.floor((closes - now) / 1000)) : 0,
    };
  }

  openSession(durationSeconds) {
    this.session = {
      opened_at: new Date().toISOString(),
      closed_at: null,
      duration_seconds: Math.round(durationSeconds) || 1800,
    };
    this.save();
    return this.session;
  }

  closeSession() {
    if (!this.session || this.session.closed_at) return null;
    this.session.closed_at = new Date().toISOString();
    this.save();
    return this.session;
  }

  // Clear all scores/chat. Session is also cleared so the next event
  // starts from "window not yet opened".
  reset() {
    const n = this.participants.size;
    this.participants = new Map();
    this.narrations = [];
    this.session = null;
    this.save();
    return { cleared_participants: n };
  }

  // ── participants ──────────────────────────────────────────────────
  participant(rawName) {
    // Cap the name (matches the relay's 64-char cap) so unbounded
    // attacker-chosen names can't bloat memory/snapshots, and so the
    // same long name maps to one record everywhere.
    const name = String(rawName).slice(0, 64);
    if (!this.participants.has(name)) {
      this.participants.set(name, {
        id: name,
        name,
        completed_tasks: new Map(), // id -> ISO ts of first achievement
        runs: new Map(),            // run_id -> {tokens, turns, diamonds, updated_at}
        last_activity: null,
      });
    }
    return this.participants.get(name);
  }

  // ── writes (called from authenticated routes) ─────────────────────
  recordAchievement({ participant, id, run_elapsed_ms }) {
    if (!participant || !id) {
      return { status: 400, body: { error: 'participant and id required' } };
    }
    if (!isClean(participant)) {
      return { status: 422, body: { error: 'participant name rejected' } };
    }
    if (!this.sessionWindow().open) {
      return { status: 403, body: { error: 'session not open' } };
    }
    // Hard 5-min run cap, enforced server-side. null/missing = old bot;
    // reject so participants must update.
    if (typeof run_elapsed_ms !== 'number' || run_elapsed_ms > MAX_RUN_MS) {
      return {
        status: 403,
        body: { error: `run_elapsed_ms ${run_elapsed_ms} outside 0..${MAX_RUN_MS}` },
      };
    }
    const points = pointsFor(id);
    if (points === undefined) {
      return { status: 400, body: { error: `unknown achievement: ${id}` } };
    }
    const p = this.participant(participant);
    p.completed_tasks.set(id, new Date().toISOString());
    p.last_activity = new Date().toISOString();
    // Track the live run's clock so the cast view can show per-participant
    // time remaining.
    p.live_run = { at: Date.now(), remaining_ms: MAX_RUN_MS - run_elapsed_ms };
    this.save();
    return { status: 200, body: { ok: true, participant_id: p.id, task_id: id, points } };
  }

  recordCost({ participant, tokens, turns, diamonds = 0, run_id }) {
    if (!participant || tokens === undefined || turns === undefined) {
      return { status: 400, body: { error: 'participant, tokens, turns required' } };
    }
    if (!isClean(participant)) {
      return { status: 422, body: { error: 'participant name rejected' } };
    }
    if (!this.sessionWindow().open) {
      return { status: 403, body: { error: 'session not open' } };
    }
    const p = this.participant(participant);
    // Mark live on /cost too — achievements only fire on diamond pickup,
    // so a participant who's running but hasn't found one yet would
    // otherwise show as idle on the cast view.
    p.last_activity = new Date().toISOString();
    const rid = run_id || 'default';
    // diamonds is self-reported (participant owns the bot AND the harness).
    // Real integrity = top-3 verify.py replay. This monotonic clamp just
    // makes the trivial curl cheat show as a slow climb instead of a spike.
    const prev = p.runs.get(rid);
    const prevD = prev?.diamonds ?? 0;
    const reqD = Math.max(0, Math.round(diamonds));
    const clampedD = Math.max(prevD, Math.min(reqD, prevD + 10));
    p.runs.set(rid, {
      tokens: Math.round(tokens),
      turns: Math.round(turns),
      diamonds: clampedD,
      updated_at: new Date().toISOString(),
    });
    this.save();
    return { status: 200, body: { ok: true, diamonds: clampedD, clamped: clampedD !== reqD } };
  }

  recordNarration({ participant, kind, text }) {
    if (!participant || !text) {
      return { status: 400, body: { error: 'participant and text required' } };
    }
    if (!isClean(participant) || !isClean(text)) {
      return { status: 422, body: { error: 'content rejected' } };
    }
    // Note: deliberately does NOT create a participant record — chat alone
    // shouldn't add rows to the board (kept the ticker usable pre-window
    // without letting it pollute the standings).
    const name = String(participant).slice(0, 64);
    this.narrations.push({
      participant: name,
      name,
      kind: kind || 'chat',
      text: String(text).slice(0, 500),
      ts: Date.now(),
    });
    if (this.narrations.length > 500) {
      this.narrations.splice(0, this.narrations.length - 500);
    }
    this.save();
    return { status: 200, body: { ok: true } };
  }

  // ── reads ─────────────────────────────────────────────────────────
  getNarrations({ since = 0, limit = 200 } = {}) {
    const lim = Math.min(limit, 500);
    return this.narrations.filter((n) => n.ts > since).slice(-lim);
  }

  leaderboard() {
    const w = this.sessionWindow();
    const inWindow = (ts) => w.devAlwaysOpen
      || (ts && ts >= w.opened_at && ts <= w.closes_at);
    return [...this.participants.values()].map((p) => {
      const tasks = [...p.completed_tasks.entries()]
        .filter(([, ts]) => inWindow(ts))
        .map(([id]) => id);
      const pts = tasks.reduce((s, t) => s + (pointsFor(t) || 0), 0);
      // Best single run within the session window: max diamonds, then min tokens.
      let best = null;
      for (const [rid, r] of p.runs) {
        if (!inWindow(r.updated_at)) continue;
        if (!best
            || r.diamonds > best.diamonds
            || (r.diamonds === best.diamonds && r.tokens < best.tokens)) {
          best = { run_id: rid, ...r };
        }
      }
      // diamond_N achievements are server-gated (rejected past 305s), so
      // max(N) over them is the trusted best-run count. The /cost
      // 'diamonds' field is self-reported and NOT time-gated.
      const diamondNs = tasks
        .map((t) => { const m = /^diamond_(\d+)$/.exec(t); return m ? +m[1] : 0; })
        .filter((n) => n > 0);
      const diamondsCount = diamondNs.length ? Math.max(...diamondNs) : 0;
      return {
        id: p.id,
        name: p.name,
        achievement_points: pts,
        tokens: best?.tokens ?? 0,
        turns: best?.turns ?? 0,
        diamonds_count: diamondsCount,
        best_run_id: best?.run_id ?? null,
        runs: Object.fromEntries(p.runs),
        runs_count: p.runs.size,
        run_remaining_s: (() => {
          if (!p.live_run) return null;
          const left = Math.round((p.live_run.remaining_ms - (Date.now() - p.live_run.at)) / 1000);
          return left > 0 ? left : null;
        })(),
        milestones: tasks.filter((t) => MILESTONE_IDS.has(t)).length,
        quests: tasks.filter((t) => !MILESTONE_IDS.has(t) && !DIAMOND_RE.test(t)).length,
        completed_tasks: tasks,
        last_activity: p.last_activity,
      };
    }).sort((a, b) => {
      // Agent Battle: best-run diamonds desc, then that run's tokens asc.
      if (b.diamonds_count !== a.diamonds_count) return b.diamonds_count - a.diamonds_count;
      return a.tokens - b.tokens;
    });
  }
}
