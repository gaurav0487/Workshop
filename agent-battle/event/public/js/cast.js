// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

/* Agent Battle cast view.
   Polls /api/leaderboard, /api/narration, /api/admin/session, /api/config
   and renders the projector page: board + chat ticker + how-to-join panel.

   Space management: the join panel expands while people are still joining
   (board sparse / window not open) and collapses to a strip once the
   competition is underway. An empty board shows a full-width join hero so
   the projector is useful before GO. Clicking the join header overrides
   the automatic behavior for the rest of the page load. */

const Cast = {
  config: null,
  _joinManual: null,        // null = auto, true = expanded, false = collapsed
  _narrationSince: null,
  _narrationLines: [],
  _firstLoad: true,
  _showAll: false,
  _sessionClosesAt: null,
  _sessionOpen: false,
  _sessionFetchedAt: 0,
  _rowCount: 0,

  // ── boot ───────────────────────────────────────────────────────────
  async init() {
    await this.loadConfig();
    this.refreshBoard();
    this.refreshNarrations();
    this.refreshSession();
    setInterval(() => this.refreshBoard(), 10000);
    setInterval(() => this.refreshNarrations(), 2000);
    setInterval(() => this.refreshSession(), 1000);
  },

  async loadConfig() {
    try {
      this.config = await fetch('/api/config').then((r) => r.json());
      if (this.config.event_name) {
        document.getElementById('event-title').textContent =
          `${this.config.event_name} — Diamond Leaderboard`;
        document.title = `${this.config.event_name} — Diamond Leaderboard`;
      }
      this.renderJoinPanel();
    } catch (e) {
      console.error('config load failed:', e);
    }
  },

  // ── helpers ────────────────────────────────────────────────────────
  esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  },

  nameColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return `hsl(${((h % 360) + 360) % 360} 65% 60%)`;
  },

  fmtTokens(n) {
    n = n || 0;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  },

  // ── join panel ─────────────────────────────────────────────────────
  joinStepsHtml() {
    const c = this.config || {};
    const repoTail = (c.repo_url || '').replace(/^https?:\/\//, '');
    return `
      <ol class="join-steps">
        <li><div>
          <code>git clone ${this.esc(c.repo_url || '')}</code><br>
          <code>cd ${this.esc((c.repo_url || '').split('/').pop() || 'repo')}/${this.esc(c.repo_dir || '')}</code>
        </div></li>
        <li><div>
          export <code>ANTHROPIC_API_KEY</code>, <code>PARTICIPANT</code>,
          <code>MINECRAFT_EULA=accept</code>
          <div class="step-note">key: console.anthropic.com &middot; EULA: minecraft.net/eula</div>
        </div></li>
        <li><div>
          <code>claude --permission-mode acceptEdits</code> then type <code>/cwc-setup</code>
          <div class="step-note">Claude Code installs deps + starts your bot (~90s)</div>
        </div></li>
        <li><div>
          <code>python3 my_agent.py</code>
          <div class="step-note">5-min run, posts here automatically &middot; best run counts</div>
        </div></li>
      </ol>`;
  },

  renderJoinPanel() {
    const c = this.config || {};
    const body = document.getElementById('join-body');
    if (!body) return;
    const repoDisplay = (c.repo_url || '').replace(/^https?:\/\//, '');
    body.innerHTML = `
      <div class="join-qr-row">
        <div class="join-qr">${c.repo_qr_svg || ''}</div>
        <div class="join-repo">
          ${this.esc(repoDisplay)}<br>
          <span class="dim">&rarr; ${this.esc(c.repo_dir || '')}/</span>
        </div>
      </div>
      ${this.joinStepsHtml()}`;
  },

  // Auto expand/collapse based on event phase, unless manually toggled.
  updateJoinAuto() {
    if (this._joinManual !== null) return;
    const underway = this._sessionOpen && this._rowCount >= 3;
    this.setJoinExpanded(!underway);
  },

  setJoinExpanded(expanded) {
    const panel = document.getElementById('join-panel');
    if (!panel) return;
    panel.classList.toggle('expanded', expanded);
    panel.classList.toggle('collapsed', !expanded);
  },

  toggleJoin() {
    const panel = document.getElementById('join-panel');
    const nowExpanded = panel.classList.contains('collapsed');
    this._joinManual = nowExpanded;
    this.setJoinExpanded(nowExpanded);
  },

  // ── leaderboard ────────────────────────────────────────────────────
  toggleShowAll(ev) {
    if (ev) ev.preventDefault();
    this._showAll = !this._showAll;
    this.refreshBoard();
  },

  async refreshBoard() {
    let data;
    try {
      data = await fetch('/api/leaderboard').then((r) => r.json());
    } catch (e) {
      console.error('leaderboard fetch failed:', e);
      return;
    }
    const el = document.getElementById('leaderboard-content');
    const stats = document.getElementById('stats-bar');
    if (!el) return;

    const board = data.leaderboard || [];
    this._rowCount = board.length;
    this.updateJoinAuto();

    if (board.length === 0) {
      // Empty board: the projector's job is recruiting. Show the join
      // hero full-width (the sidebar panel stays too — it's harmless).
      stats.innerHTML = '';
      const c = this.config || {};
      el.innerHTML = `
        <div class="join-hero">
          <div class="join-qr">${c.repo_qr_svg || ''}</div>
          <div>
            <h2>&#x26CF;&#xFE0F; Join the battle</h2>
            <div class="join-repo">${this.esc((c.repo_url || '').replace(/^https?:\/\//, ''))}
              <span class="dim">&rarr; ${this.esc(c.repo_dir || '')}/</span></div>
            ${this.joinStepsHtml()}
          </div>
        </div>`;
      this._firstLoad = false;
      return;
    }

    const total = board.length;
    const totalDiamonds = board.reduce((s, p) => s + (p.diamonds_count || 0), 0);
    const topDiamonds = board[0]?.diamonds_count || 0;
    const liveCount = board.filter((p) => p.run_remaining_s != null).length;
    const limit = this._showAll ? total : 20;
    const rows = board.slice(0, limit);
    const noAnim = !this._firstLoad;

    stats.innerHTML = `
      <div class="stats-bar">
        <div class="stat"><div class="stat-value">${total}</div><div class="stat-label">Agents</div></div>
        <div class="stat"><div class="stat-value">&#x1F48E; ${totalDiamonds}</div><div class="stat-label">Diamonds mined</div></div>
        <div class="stat"><div class="stat-value">${topDiamonds}</div><div class="stat-label">Leader</div></div>
        <div class="stat"><div class="stat-value">${liveCount}</div><div class="stat-label">Running now</div></div>
      </div>`;

    const footer = total > 20 ? `
      <div class="board-footer">
        Showing ${rows.length} of ${total}
        &middot; <a href="#" onclick="Cast.toggleShowAll(event)">${this._showAll ? 'Show top 20' : 'Show all'}</a>
      </div>` : '';

    el.innerHTML = `
      <table class="board-table">
        <thead>
          <tr>
            <th style="width:56px">Rank</th>
            <th>Participant</th>
            <th style="width:90px">Status</th>
            <th style="width:100px">Run left</th>
            <th style="width:110px">&#x1F48E; This run</th>
            <th style="width:120px">&#x1F48E; Best run</th>
            <th style="width:100px">Tokens</th>
            <th style="width:70px">Runs</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((p, i) => this.renderRow(p, i, noAnim)).join('')}
        </tbody>
      </table>` + footer;
    this._firstLoad = false;
  },

  renderRow(p, i, noAnim) {
    const ageS = p.last_activity
      ? Math.round((Date.now() - new Date(p.last_activity).getTime()) / 1000)
      : Infinity;
    const left = p.run_remaining_s;
    const live = left != null || ageS < 30;
    const ago = ageS < 60 ? `${ageS}s`
      : ageS < 3600 ? `${Math.floor(ageS / 60)}m`
      : `${Math.floor(ageS / 3600)}h`;
    const nRuns = p.runs_count || (p.runs ? Object.keys(p.runs).length : 0);
    // "This run" = most recently updated run's live diamond counter.
    const latest = Object.values(p.runs || {})
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
    const thisRun = (live && latest)
      ? `<span style="opacity:.85">&#x1F48E; ${latest.diamonds ?? 0}</span>`
      : '<span style="opacity:.3">&mdash;</span>';
    const status = live
      ? '<span style="color:#22c55e" title="active now">&#9679; live</span>'
      : `<span style="opacity:.45;font-size:.85em">${ago} ago</span>`;
    const runLeft = left != null
      ? `<span style="font-family:var(--mono);font-weight:600;color:${left < 60 ? 'var(--red)' : 'var(--amber)'}">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span>`
      : '<span style="opacity:.3">&mdash;</span>';
    return `
      <tr style="--row-index:${i}${noAnim ? ';animation:none' : ''}">
        <td><span class="rank-badge ${i < 3 ? `rank-${i + 1}` : ''}">${i + 1}</span></td>
        <td class="p-name" style="color:${this.nameColor(p.name)}">${this.esc(p.name)}</td>
        <td>${status}</td>
        <td>${runLeft}</td>
        <td>${thisRun}</td>
        <td class="p-diamonds">&#x1F48E; ${p.diamonds_count || 0}</td>
        <td class="p-tokens">${this.fmtTokens(p.tokens)}</td>
        <td style="opacity:.6">${nRuns || '&mdash;'}</td>
      </tr>`;
  },

  // ── chat ticker ────────────────────────────────────────────────────
  async refreshNarrations() {
    const body = document.getElementById('chat-body');
    if (!body) return;
    try {
      const since = this._narrationSince ? `?since=${encodeURIComponent(this._narrationSince)}` : '';
      const data = await fetch(`/api/narration${since}`).then((r) => r.json());
      const rows = data.narrations || [];
      if (rows.length === 0) return;
      this._narrationSince = rows[rows.length - 1].ts;
      this._narrationLines.push(...rows);
      if (this._narrationLines.length > 100) {
        this._narrationLines.splice(0, this._narrationLines.length - 100);
      }
      body.innerHTML = this._narrationLines.map((n) => `
        <div class="chat-line ${n.kind === 'thought' ? 'thought' : ''}">
          <span class="chat-name" style="color:${this.nameColor(n.name || '?')}">${this.esc(n.name || '?')}</span>
          <span class="chat-text">${this.esc(n.text)}</span>
        </div>`).join('');
      body.scrollTop = body.scrollHeight;
    } catch { /* poll continues */ }
  },

  // ── session countdown ──────────────────────────────────────────────
  async refreshSession() {
    const el = document.getElementById('session-countdown');
    if (!el) return;
    // Re-fetch every 5s; tick locally in between.
    if (Date.now() - this._sessionFetchedAt > 5000) {
      try {
        const s = await fetch('/api/admin/session').then((r) => r.json());
        this._sessionFetchedAt = Date.now();
        this._sessionOpen = !!s.open && !s.devAlwaysOpen;
        this._sessionClosesAt = s.open && s.closes_at ? new Date(s.closes_at).getTime() : null;
        if (!s.open && s.opened_at) this._sessionClosesAt = 0; // explicitly closed
        this.updateJoinAuto();
      } catch { /* keep last known */ }
    }
    if (this._sessionClosesAt === null) {
      el.textContent = '';
      return;
    }
    const remaining = Math.max(0, Math.floor((this._sessionClosesAt - Date.now()) / 1000));
    if (remaining === 0) {
      el.textContent = "TIME'S UP";
      el.style.color = 'var(--red)';
      return;
    }
    const h = Math.floor(remaining / 3600);
    const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    el.textContent = `⏱ ${h > 0 ? h + ':' : ''}${mm}:${ss}`;
    el.style.color = remaining < 300 ? 'var(--red)' : 'var(--amber)';
  },
};

document.addEventListener('DOMContentLoaded', () => Cast.init());
