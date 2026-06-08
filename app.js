/* Fantasy World Cup — scoring engine + UI
   No build step. Reads data/*.js (global vars); edits are saved to the repo via
   the /api/save-result serverless function (Vercel). */

(function () {
  "use strict";

  const DRAFT = window.DRAFT || {};
  const RULES = window.RULES || {};

  // Auto-update cadence — keep in sync with .github/workflows/update-scores.yml
  const UPDATE_INTERVAL_HOURS = 4;
  const SAVE_ENDPOINT = "/api/save-result";

  /* ---------- lookups ---------- */

  const TEAM_OWNER = {};
  for (const manager of Object.keys(DRAFT)) {
    for (const team of DRAFT[manager]) TEAM_OWNER[team] = manager;
  }
  const ALL_TEAMS = Object.keys(TEAM_OWNER).sort((a, b) => a.localeCompare(b));

  /* ---------- overrides merge (mirror of scripts/fetch_scores.js) ---------- *
     The committed data/matches.js already has overrides baked in by the importer,
     but we re-apply data/overrides.js here so edits made between refreshes show
     up immediately. Re-applying the same overrides is idempotent. */

  function keyOf(m) {
    const pair = [m.teamA, m.teamB].slice().sort().join("|");
    return `${m.date}|${pair}`;
  }

  function buildMatches() {
    const ov = window.OVERRIDES || { byEventId: {}, manualMatches: [] };
    const base = (window.MATCHES || []).map((m) => ({ ...m }));
    for (const m of base) {
      if (m.eventId && ov.byEventId && ov.byEventId[m.eventId]) Object.assign(m, ov.byEventId[m.eventId]);
    }
    const keys = new Set(base.map(keyOf));
    const manual = (ov.manualMatches || [])
      .map((m) => ({ source: "manual", ...m }))
      .filter((m) => !keys.has(keyOf(m)));
    return [...base, ...manual];
  }

  // In-memory working copies. OVERRIDES_EDIT is what we mutate + save.
  let MATCHES = buildMatches();
  let OVERRIDES_EDIT = deepClone(window.OVERRIDES || { byEventId: {}, manualMatches: [] });
  if (!OVERRIDES_EDIT.byEventId) OVERRIDES_EDIT.byEventId = {};
  if (!OVERRIDES_EDIT.manualMatches) OVERRIDES_EDIT.manualMatches = [];

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function refreshMatches() {
    window.OVERRIDES = OVERRIDES_EDIT;
    MATCHES = buildMatches();
  }

  /* ---------- scoring engine ---------- */

  function scoreTeamInMatch(team, m) {
    const isA = m.teamA === team;
    const gf = isA ? Number(m.scoreA) : Number(m.scoreB);
    const ga = isA ? Number(m.scoreB) : Number(m.scoreA);
    const knockout = m.stage === "knockout";

    const items = [];
    const add = (rule) => items.push({ label: RULES[rule].label, points: RULES[rule].points });

    let isWin, isDraw;
    if (gf > ga) { isWin = true; isDraw = false; }
    else if (gf < ga) { isWin = false; isDraw = false; }
    else {
      if (knockout) { isWin = m.shootoutWinner === team; isDraw = false; }
      else { isWin = false; isDraw = true; }
    }

    if (isWin) add("win");
    else if (isDraw) add("draw");
    if (ga === 0) add("cleanSheet");
    if (gf >= 2) add("twoGoals");
    if (gf >= 4) add("fourGoals");
    if (gf - ga >= 2) add("winByTwo");
    if (knockout && m.extraTime) add("extraTime");
    if (knockout && m.penalties) add("penalties");

    const total = items.reduce((s, i) => s + i.points, 0);
    return { total, items };
  }

  function computeStandings() {
    const table = {};
    for (const manager of Object.keys(DRAFT)) {
      table[manager] = {
        manager, points: 0, played: 0,
        teams: DRAFT[manager].map((t) => ({ team: t, points: 0, played: 0 })),
      };
    }
    const teamRowIndex = {};
    for (const manager of Object.keys(DRAFT)) {
      table[manager].teams.forEach((row, i) => (teamRowIndex[row.team] = { manager, i }));
    }
    for (const m of MATCHES) {
      for (const team of [m.teamA, m.teamB]) {
        const idx = teamRowIndex[team];
        if (!idx) continue;
        const res = scoreTeamInMatch(team, m);
        const row = table[idx.manager].teams[idx.i];
        row.points += res.total; row.played += 1;
        table[idx.manager].points += res.total; table[idx.manager].played += 1;
      }
    }
    const standings = Object.values(table);
    standings.forEach((s) => s.teams.sort((a, b) => b.points - a.points || a.team.localeCompare(b.team)));
    standings.sort((a, b) => b.points - a.points || a.manager.localeCompare(b.manager));
    return standings;
  }

  /* ---------- helpers ---------- */

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtDate = (d) => {
    if (!d) return "";
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  /* ---------- standings ---------- */

  function renderStandings() {
    const root = el("div");
    const standings = computeStandings();
    const played = MATCHES.length;
    const intro = el("p", "muted");
    intro.textContent = played
      ? `${played} match${played === 1 ? "" : "es"} scored.`
      : "No results yet — the tournament kicks off June 11. Standings will fill in automatically.";
    root.appendChild(intro);

    standings.forEach((s, rank) => {
      const card = el("div", "standing-card");
      const head = el("button", "standing-head");
      head.setAttribute("aria-expanded", "false");
      head.innerHTML = `
        <span class="rank">${rank + 1}</span>
        <span class="name">${esc(s.manager)}</span>
        <span class="sub muted">${s.teams.length} teams · ${s.played} GP</span>
        <span class="pts">${s.points}<small>pts</small></span>
        <span class="chev">▾</span>`;
      const body = el("div", "standing-body");
      const tbl = el("table", "mini");
      tbl.innerHTML = `<thead><tr><th>Team</th><th class="num">GP</th><th class="num">Pts</th></tr></thead>`;
      const tb = el("tbody");
      s.teams.forEach((t) => {
        const tr = el("tr");
        tr.innerHTML = `<td>${esc(t.team)}</td><td class="num">${t.played}</td><td class="num">${t.points}</td>`;
        tb.appendChild(tr);
      });
      tbl.appendChild(tb); body.appendChild(tbl);
      head.addEventListener("click", () => {
        const open = card.classList.toggle("open");
        head.setAttribute("aria-expanded", open ? "true" : "false");
      });
      card.appendChild(head); card.appendChild(body); root.appendChild(card);
    });
    return root;
  }

  /* ---------- teams ---------- */

  function renderTeams() {
    const root = el("div");
    const pts = {}, gp = {};
    ALL_TEAMS.forEach((t) => { pts[t] = 0; gp[t] = 0; });
    for (const m of MATCHES) {
      for (const team of [m.teamA, m.teamB]) {
        if (!(team in pts)) continue;
        pts[team] += scoreTeamInMatch(team, m).total; gp[team] += 1;
      }
    }
    const sorted = ALL_TEAMS.slice().sort((a, b) => pts[b] - pts[a] || a.localeCompare(b));
    const tbl = el("table", "full");
    tbl.innerHTML = `<thead><tr><th>Team</th><th>Manager</th><th class="num">GP</th><th class="num">Pts</th></tr></thead>`;
    const tb = el("tbody");
    sorted.forEach((t) => {
      const tr = el("tr");
      tr.innerHTML = `<td>${esc(t)}</td><td class="muted">${esc(TEAM_OWNER[t])}</td><td class="num">${gp[t]}</td><td class="num">${pts[t]}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); root.appendChild(tbl);
    return root;
  }

  /* ---------- editable results table ---------- */

  let dirty = new Set();      // eventIds (or manual ids) with unsaved edits
  let unlocked = false;       // edit mode toggled on

  function renderResults() {
    const root = el("div", "results-wrap");

    const bar = el("div", "edit-bar");
    bar.innerHTML = `
      <button id="edit-toggle" class="btn">${unlocked ? "Done editing" : "✎ Edit results"}</button>
      <span id="edit-hint" class="muted">${unlocked
        ? "Change scores, set shootout winners, then Save."
        : "Results update automatically. Click Edit to correct a score or set a shootout winner."}</span>`;
    root.appendChild(bar);

    if (!MATCHES.length) {
      root.appendChild(el("p", "muted", "No results yet. Matches will appear here once games are played."));
      wireEditToggle(root);
      return root;
    }

    const sorted = MATCHES.slice().sort((a, b) =>
      String(a.date).localeCompare(String(b.date)) || (a.round || 0) - (b.round || 0) || (a.id || 0) - (b.id || 0));

    const tbl = el("table", "full results-table");
    tbl.innerHTML = `<thead><tr>
      <th>Date</th><th>Round</th><th>Home</th><th class="num">Score</th><th>Away</th>
      <th>Knockout extras</th><th>Pts</th>
    </tr></thead>`;
    const tb = el("tbody");
    sorted.forEach((m) => tb.appendChild(resultRow(m)));
    tbl.appendChild(tb);
    root.appendChild(tbl);

    // Save controls (only meaningful in edit mode)
    const save = el("div", "save-bar");
    save.innerHTML = `
      <label class="pw">Edit password <input type="password" id="edit-pw" placeholder="required to save" autocomplete="off"></label>
      <button id="save-btn" class="btn primary" disabled>Save to repo</button>
      <span id="save-msg" class="form-msg"></span>`;
    root.appendChild(save);

    wireEditToggle(root);
    wireSave(root);
    applyEditMode(root);
    return root;
  }

  function resultRow(m) {
    const key = m.eventId || ("manual:" + m.id);
    const tr = el("tr");
    tr.dataset.key = key;
    const ko = m.stage === "knockout";
    const aPts = (m.teamA in TEAM_OWNER) ? scoreTeamInMatch(m.teamA, m).total : 0;
    const bPts = (m.teamB in TEAM_OWNER) ? scoreTeamInMatch(m.teamB, m).total : 0;
    const overridden = !!(m.eventId && OVERRIDES_EDIT.byEventId[m.eventId]) || m.source === "manual";

    tr.innerHTML = `
      <td class="muted">${fmtDate(m.date)}</td>
      <td><span class="stage ${m.stage}">${esc(m.roundLabel || (ko ? "Knockout" : "Group"))}</span>${overridden ? ' <span class="edited" title="has a manual override">✎</span>' : ""}</td>
      <td>${esc(m.teamA)} <span class="muted owner">${esc(TEAM_OWNER[m.teamA] || "")}</span></td>
      <td class="num score-cell">
        <span class="ro-score">${m.scoreA}–${m.scoreB}</span>
        <span class="edit-score">
          <input type="number" min="0" class="sc" data-side="A" value="${m.scoreA}">
          <input type="number" min="0" class="sc" data-side="B" value="${m.scoreB}">
        </span>
      </td>
      <td>${esc(m.teamB)} <span class="muted owner">${esc(TEAM_OWNER[m.teamB] || "")}</span></td>
      <td class="ko-cell">${ko ? koControls(m) : '<span class="muted">—</span>'}</td>
      <td class="num"><span class="badge">${aPts}</span> / <span class="badge">${bPts}</span></td>`;

    // mark dirty on any input change
    tr.querySelectorAll("input,select").forEach((inp) =>
      inp.addEventListener("change", () => { dirty.add(key); updateSaveState(); }));
    return tr;
  }

  function koControls(m) {
    const win = m.shootoutWinner || "";
    return `
      <label class="check"><input type="checkbox" class="et" ${m.extraTime ? "checked" : ""}> ET</label>
      <label class="check"><input type="checkbox" class="pk" ${m.penalties ? "checked" : ""}> PK</label>
      <label class="check">SO
        <select class="so">
          <option value="">—</option>
          <option value="${esc(m.teamA)}" ${win === m.teamA ? "selected" : ""}>${esc(m.teamA)}</option>
          <option value="${esc(m.teamB)}" ${win === m.teamB ? "selected" : ""}>${esc(m.teamB)}</option>
        </select>
      </label>
      <span class="ro-ko muted">${m.extraTime ? "ET " : ""}${m.penalties ? "PK " : ""}${win ? "→ " + esc(win) : ""}</span>`;
  }

  function wireEditToggle(root) {
    const btn = root.querySelector("#edit-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => { unlocked = !unlocked; showTab("results"); });
  }

  function applyEditMode(root) {
    root.classList.toggle("editing", unlocked);
    updateSaveState(root);
  }

  function updateSaveState(root) {
    root = root || document.getElementById("panel");
    const btn = root.querySelector("#save-btn");
    const pw = root.querySelector("#edit-pw");
    if (!btn) return;
    btn.disabled = !(unlocked && dirty.size > 0 && pw && pw.value.trim());
  }

  function collectEdits(root) {
    // Read every dirty row's inputs into OVERRIDES_EDIT.
    root.querySelectorAll("tr[data-key]").forEach((tr) => {
      const key = tr.dataset.key;
      if (!dirty.has(key)) return;
      const scores = {};
      tr.querySelectorAll(".sc").forEach((i) => (scores[i.dataset.side] = Number(i.value)));
      const et = tr.querySelector(".et");
      const pk = tr.querySelector(".pk");
      const so = tr.querySelector(".so");
      const patch = { scoreA: scores.A, scoreB: scores.B };
      if (et) patch.extraTime = et.checked;
      if (pk) patch.penalties = pk.checked;
      if (so) patch.shootoutWinner = so.value || null;

      if (key.startsWith("manual:")) {
        const id = Number(key.slice("manual:".length));
        const mm = OVERRIDES_EDIT.manualMatches.find((x) => x.id === id);
        if (mm) Object.assign(mm, patch);
      } else {
        OVERRIDES_EDIT.byEventId[key] = Object.assign(OVERRIDES_EDIT.byEventId[key] || {}, patch);
      }
    });
  }

  function wireSave(root) {
    const pw = root.querySelector("#edit-pw");
    const btn = root.querySelector("#save-btn");
    const msg = root.querySelector("#save-msg");
    if (pw) pw.addEventListener("input", () => updateSaveState(root));
    if (!btn) return;
    btn.addEventListener("click", async () => {
      collectEdits(root);
      msg.className = "form-msg"; msg.textContent = "Saving…"; btn.disabled = true;
      try {
        const res = await fetch(SAVE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pw.value, overrides: OVERRIDES_EDIT }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        msg.className = "form-msg ok";
        msg.textContent = "Saved to the repo. The live site updates in ~1 minute as it redeploys.";
        dirty.clear();
        refreshMatches();      // apply edits locally right away
        showTab("results");
      } catch (e) {
        msg.className = "form-msg err";
        msg.textContent = "Save failed: " + e.message;
        btn.disabled = false;
      }
    });
  }

  /* ---------- rules ---------- */

  function renderRules() {
    const root = el("div", "rules");
    const list = el("ul");
    Object.values(RULES).forEach((r) => list.appendChild(el("li", null, `<b>+${r.points}</b> ${esc(r.label)}`)));
    root.appendChild(list);
    root.appendChild(el("p", "muted", "Bonuses stack: e.g. a 4–0 group win earns 6 (win) + 1 (clean sheet) + 1 (2+ goals) + 1 (4+ goals) + 1 (won by 2+) = 10 points. In the knockout round there are no draws — the team that advances gets the win, the other gets 0 for win/draw."));
    return root;
  }

  /* ---------- auto-update countdown ---------- */

  function nextRun(now) {
    // GitHub Action cron: minute 0 of every Nth UTC hour, stepping from UTC midnight.
    const step = UPDATE_INTERVAL_HOURS * 3600 * 1000;
    let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
    while (t <= now.getTime()) t += step;
    return new Date(t);
  }

  function relTime(iso) {
    if (!iso) return null;
    const then = new Date(iso); if (isNaN(then)) return null;
    const diff = Date.now() - then.getTime();
    const m = Math.round(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  function startCountdown() {
    const node = document.getElementById("update-status");
    if (!node) return;
    const tick = () => {
      const now = new Date();
      const next = nextRun(now);
      let s = Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
      const h = Math.floor(s / 3600); s -= h * 3600;
      const mm = Math.floor(s / 60); const ss = s - mm * 60;
      const pad = (n) => String(n).padStart(2, "0");
      const localTime = next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const updated = relTime(window.MATCHES_GENERATED_AT);
      node.innerHTML =
        `<span class="dot"></span>` +
        `<span>Next auto-update in <b>${h}h ${pad(mm)}m ${pad(ss)}s</b> ` +
        `<span class="muted">(~${localTime}, every ${UPDATE_INTERVAL_HOURS}h)</span></span>` +
        (updated ? `<span class="muted">· results updated ${updated}</span>` : "");
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- tabs ---------- */

  const TABS = {
    standings: { label: "Standings", render: renderStandings },
    teams:     { label: "Teams", render: renderTeams },
    results:   { label: "Results", render: renderResults },
    rules:     { label: "Rules", render: renderRules },
  };
  function showTab(key) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === key));
    const panel = document.getElementById("panel");
    panel.innerHTML = "";
    refreshMatches();
    panel.appendChild(TABS[key].render());
  }

  function init() {
    const nav = document.getElementById("tabs");
    Object.entries(TABS).forEach(([key, t]) => {
      const b = el("button", "tab", t.label);
      b.dataset.tab = key;
      b.addEventListener("click", () => showTab(key));
      nav.appendChild(b);
    });
    startCountdown();
    showTab("standings");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
