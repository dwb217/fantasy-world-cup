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
    // API matches come from the committed file; manual matches are rebuilt from
    // overrides (the single source of truth) so web-app adds/removals apply
    // immediately, even before the importer regenerates data/matches.js.
    const base = (window.MATCHES || []).filter((m) => m.source !== "manual").map((m) => ({ ...m }));
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

  // Fixtures are listed before they're played (scores null); only matches with
  // a real result — from the API or a manual edit — count for points.
  function hasResult(m) {
    return Number.isFinite(Number(m.scoreA)) && m.scoreA !== null && m.scoreA !== "" &&
           Number.isFinite(Number(m.scoreB)) && m.scoreB !== null && m.scoreB !== "";
  }

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
    // A level knockout score implies extra time + a shootout by definition,
    // even if the imported flags missed it (the API's status field is flaky).
    const level = gf === ga;
    if (knockout && (m.extraTime || level)) add("extraTime");
    if (knockout && (m.penalties || level)) add("penalties");

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
      if (!hasResult(m)) continue;
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
    const played = MATCHES.filter(hasResult).length;
    const intro = el("p", "muted");
    intro.textContent = played
      ? `${played} of ${MATCHES.length} matches scored.`
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
      if (!hasResult(m)) continue;
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
        : "Scores fill in automatically from the API. Click Edit to enter or correct a score by hand (e.g. if the auto-import is down)."}</span>`;
    root.appendChild(bar);

    if (!MATCHES.length) {
      root.appendChild(el("p", "muted",
        "No results yet — the first games are June 11, 2026. Matches appear here automatically " +
        "(pulled from the API every 4 hours), and you'll be able to edit scores and set shootout winners once they're played."));
    } else {
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
    }

    root.appendChild(addMatchBar());

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

  /* ---------- manual match entry (backup when the auto-import misses a game) ---------- */

  const ROUND_OPTIONS = [
    { label: "Matchday 1", stage: "group" },
    { label: "Matchday 2", stage: "group" },
    { label: "Matchday 3", stage: "group" },
    { label: "Round of 32", stage: "knockout" },
    { label: "Round of 16", stage: "knockout" },
    { label: "Quarter-Final", stage: "knockout" },
    { label: "Semi-Final", stage: "knockout" },
    { label: "Third Place", stage: "knockout" },
    { label: "Final", stage: "knockout" },
  ];

  function addMatchBar() {
    const wrap = el("div", "add-bar");
    const teamOpts = ALL_TEAMS.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    const roundOpts = ROUND_OPTIONS.map((o, i) => `<option value="${i}">${esc(o.label)}</option>`).join("");
    const today = new Date().toISOString().slice(0, 10);
    wrap.innerHTML = `
      <div class="add-title"><b>Add a match manually</b>
        <span class="muted">— backup in case the auto-import misses a game. Use the match's scheduled date:
        if the API later imports the same game (same date + teams), the imported result takes over automatically.</span></div>
      <div class="add-fields">
        <input type="date" id="add-date" value="${today}">
        <select id="add-round">${roundOpts}</select>
        <select id="add-a">${teamOpts}</select>
        <input type="number" id="add-sa" min="0" value="0">
        <span class="muted">–</span>
        <input type="number" id="add-sb" min="0" value="0">
        <select id="add-b">${teamOpts}</select>
        <button id="add-btn" class="btn">+ Add match</button>
        <span id="add-msg" class="form-msg err"></span>
      </div>`;
    wrap.querySelector("#add-b").selectedIndex = Math.min(1, ALL_TEAMS.length - 1);
    wrap.querySelector("#add-btn").addEventListener("click", () => {
      const msg = wrap.querySelector("#add-msg");
      const date = wrap.querySelector("#add-date").value;
      const opt = ROUND_OPTIONS[Number(wrap.querySelector("#add-round").value)] || ROUND_OPTIONS[0];
      const teamA = wrap.querySelector("#add-a").value;
      const teamB = wrap.querySelector("#add-b").value;
      const scoreA = Math.max(0, Number(wrap.querySelector("#add-sa").value) || 0);
      const scoreB = Math.max(0, Number(wrap.querySelector("#add-sb").value) || 0);
      if (!date) { msg.textContent = "Pick the match date."; return; }
      if (teamA === teamB) { msg.textContent = "Pick two different teams."; return; }
      if (MATCHES.some((m) => keyOf(m) === keyOf({ date, teamA, teamB }))) {
        msg.textContent = "That match is already listed — edit it in the table instead.";
        return;
      }
      const used = OVERRIDES_EDIT.manualMatches.map((m) => Math.abs(Number(m.id) || 0));
      const id = -(Math.max(0, ...used) + 1);
      collectEdits(document.getElementById("panel")); // keep other unsaved row edits across the re-render
      OVERRIDES_EDIT.manualMatches.push({
        id, source: "manual", date, stage: opt.stage, roundLabel: opt.label,
        teamA, teamB, scoreA, scoreB,
        extraTime: false, penalties: false, shootoutWinner: null,
      });
      dirty.add("manual:" + id);
      refreshMatches();
      showTab("results");
    });
    return wrap;
  }

  function resultRow(m) {
    const key = m.eventId || ("manual:" + m.id);
    const tr = el("tr");
    tr.dataset.key = key;
    const ko = m.stage === "knockout";
    const played = hasResult(m);
    if (!played) tr.className = "upcoming";
    const aPts = played && (m.teamA in TEAM_OWNER) ? scoreTeamInMatch(m.teamA, m).total : null;
    const bPts = played && (m.teamB in TEAM_OWNER) ? scoreTeamInMatch(m.teamB, m).total : null;
    const overridden = !!(m.eventId && OVERRIDES_EDIT.byEventId[m.eventId]) || m.source === "manual";

    tr.innerHTML = `
      <td class="muted">${fmtDate(m.date)}</td>
      <td><span class="stage ${m.stage}">${esc(m.roundLabel || (ko ? "Knockout" : "Group"))}</span>${overridden ? ' <span class="edited" title="has a manual override">✎</span>' : ""}${m.source === "manual" ? ' <button class="rm-btn" title="Remove this manually added match">✕</button>' : ""}</td>
      <td>${esc(m.teamA)} <span class="muted owner">${esc(TEAM_OWNER[m.teamA] || "")}</span></td>
      <td class="num score-cell">
        <span class="ro-score">${played ? `${m.scoreA}–${m.scoreB}` : '<span class="muted">vs</span>'}</span>
        <span class="edit-score">
          <input type="number" min="0" class="sc" data-side="A" value="${played ? m.scoreA : ""}" placeholder="–">
          <input type="number" min="0" class="sc" data-side="B" value="${played ? m.scoreB : ""}" placeholder="–">
        </span>
      </td>
      <td>${esc(m.teamB)} <span class="muted owner">${esc(TEAM_OWNER[m.teamB] || "")}</span></td>
      <td class="ko-cell">${ko ? koControls(m) : '<span class="muted">—</span>'}</td>
      <td class="num">${played ? `<span class="badge">${aPts}</span> / <span class="badge">${bPts}</span>` : '<span class="muted">—</span>'}</td>`;

    // mark dirty on any input change
    tr.querySelectorAll("input,select").forEach((inp) =>
      inp.addEventListener("change", () => { dirty.add(key); updateSaveState(); }));

    const rm = tr.querySelector(".rm-btn");
    if (rm) rm.addEventListener("click", () => {
      const id = Number(key.slice("manual:".length));
      collectEdits(document.getElementById("panel")); // keep other unsaved row edits across the re-render
      OVERRIDES_EDIT.manualMatches = OVERRIDES_EDIT.manualMatches.filter((x) => Number(x.id) !== id);
      dirty.delete(key);
      dirty.add("removed:" + id); // a removal is also an unsaved change
      refreshMatches();
      showTab("results");
    });
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
      // An empty score box means "no result entered" — never turn it into 0.
      const scores = {};
      tr.querySelectorAll(".sc").forEach((i) => {
        if (i.value !== "") scores[i.dataset.side] = Number(i.value);
      });
      const et = tr.querySelector(".et");
      const pk = tr.querySelector(".pk");
      const so = tr.querySelector(".so");
      const patch = {};
      if ("A" in scores) patch.scoreA = scores.A;
      if ("B" in scores) patch.scoreB = scores.B;
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

  /* ---------- per-game fantasy points ---------- */

  function koSuffix(m) {
    if (m.stage !== "knockout") return "";
    if (m.penalties && m.shootoutWinner) return ` · ${esc(m.shootoutWinner)} won on penalties`;
    if (m.extraTime) return " · after extra time";
    return "";
  }

  function gamePointsCard(m) {
    const card = el("div", "gp-card");
    const ko = m.stage === "knockout";
    const head = el("div", "gp-head");
    head.innerHTML = `
      <span class="stage ${m.stage}">${esc(m.roundLabel || (ko ? "Knockout" : "Group"))}</span>
      <span class="gp-score">${esc(m.teamA)} <b>${m.scoreA}–${m.scoreB}</b> ${esc(m.teamB)}<span class="muted">${koSuffix(m)}</span></span>
      <span class="muted gp-date">${fmtDate(m.date)}</span>`;
    card.appendChild(head);

    [m.teamA, m.teamB].forEach((team) => {
      const owner = TEAM_OWNER[team];
      const res = scoreTeamInMatch(team, m);
      const row = el("div", "gp-row");
      const chips = res.items.length
        ? res.items.map((i) => `<span class="gp-chip">${esc(i.label)} <b>+${i.points}</b></span>`).join("")
        : `<span class="muted">no points</span>`;
      row.innerHTML = `
        <div class="gp-owner"><span class="gp-mgr">${esc(owner || "—")}</span><span class="muted">via ${esc(team)}</span></div>
        <div class="gp-chips">${chips}</div>
        <div class="gp-total"><span class="badge">+${res.total}</span></div>`;
      card.appendChild(row);
    });
    return card;
  }

  function renderGamePoints() {
    const root = el("div");
    const played = MATCHES.filter(hasResult);
    if (!played.length) {
      root.appendChild(el("p", "muted",
        "No games played yet — once results come in, this shows the fantasy points each manager earns from every game."));
      return root;
    }
    root.appendChild(el("p", "muted",
        "Fantasy points each manager earned from every game, with the bonus breakdown. Only the managers who own a team in the match score from it."));
    const sorted = played.slice().sort((a, b) =>
      String(b.date).localeCompare(String(a.date)) || (b.round || 0) - (a.round || 0) || (b.id || 0) - (a.id || 0));
    sorted.forEach((m) => root.appendChild(gamePointsCard(m)));
    return root;
  }

  /* ---------- projections ---------- */

  // Palette (mirrors styles.css custom props; SVG needs literal colors).
  const PC = { accent: "#2f81f7", accent2: "#f7b32f", green: "#2ea043", muted: "#8b97a6", border: "#2a3340", panel2: "#1c232c" };
  const pctTxt = (p) => (p >= 0.1 ? Math.round(p * 100) : (p * 100).toFixed(p >= 0.01 ? 0 : 1)) + "%";
  const scale = (lo, hi, x0, x1) => (v) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0);

  // Horizontal box-and-whisker (p5–p95 whisker, p25–p75 box, median, mean) over a shared domain.
  function boxPlotSVG(p, mean, dom) {
    const W = 600, H = 30, pad = 4, mid = H / 2;
    const sx = scale(dom.lo, dom.hi, pad, W - pad);
    const x5 = sx(p.p5), x25 = sx(p.p25), x50 = sx(p.p50), x75 = sx(p.p75), x95 = sx(p.p95), xm = sx(mean);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
      <line x1="${x5}" y1="${mid}" x2="${x95}" y2="${mid}" stroke="${PC.muted}" stroke-width="2"/>
      <line x1="${x5}" y1="${mid-6}" x2="${x5}" y2="${mid+6}" stroke="${PC.muted}" stroke-width="2"/>
      <line x1="${x95}" y1="${mid-6}" x2="${x95}" y2="${mid+6}" stroke="${PC.muted}" stroke-width="2"/>
      <rect x="${x25}" y="${mid-9}" width="${Math.max(1,x75-x25)}" height="18" fill="${PC.accent}" fill-opacity="0.35" stroke="${PC.accent}" stroke-width="1.5"/>
      <line x1="${x50}" y1="${mid-9}" x2="${x50}" y2="${mid+9}" stroke="${PC.accent}" stroke-width="3"/>
      <line x1="${xm}" y1="${mid-9}" x2="${xm}" y2="${mid+9}" stroke="${PC.accent2}" stroke-width="2" stroke-dasharray="2 2"/>
    </svg>`;
  }

  // Vertical histogram from {start,width,probs}; marks median & mean ticks, with a
  // local y-axis (probability) so the bars fill the plot.
  function histSVG(h, median, mean) {
    const W = 600, H = 380, padL = 40, padR = 10, padB = 30, padT = 16;
    const n = h.probs.length;
    const maxP = Math.max(...h.probs) || 1;
    const bw = (W - padL - padR) / n;
    const sy = (p) => padT + (1 - p / maxP) * (H - padT - padB);
    const xOfVal = (v) => padL + ((v - h.start) / (h.width * n)) * (W - padL - padR);
    const axisY = H - padB;
    let bars = "";
    for (let i = 0; i < n; i++) {
      const x = padL + i * bw, hgt = axisY - sy(h.probs[i]);
      bars += `<rect x="${x + 0.5}" y="${sy(h.probs[i])}" width="${Math.max(0.5, bw - 1)}" height="${Math.max(0, hgt)}" fill="${PC.accent}" fill-opacity="0.7"/>`;
    }
    // y gridlines/labels (probability %)
    const grid = [0, maxP / 2, maxP].map((p) =>
      `<line x1="${padL}" y1="${sy(p)}" x2="${W - padR}" y2="${sy(p)}" stroke="${PC.border}" stroke-width="1" stroke-dasharray="2 3"/>` +
      `<text x="${padL - 6}" y="${sy(p) + 4}" fill="${PC.muted}" font-size="13" text-anchor="end">${(p * 100).toFixed(0)}%</text>`).join("");
    const tick = (v, color, dash) => `<line x1="${xOfVal(v)}" y1="${padT}" x2="${xOfVal(v)}" y2="${axisY}" stroke="${color}" stroke-width="2" ${dash ? 'stroke-dasharray="4 3"' : ""}/>`;
    const labels = [0, Math.floor(n / 2), n - 1].map((i) => {
      const v = h.start + i * h.width, x = padL + (i + 0.5) * bw;
      return `<text x="${x}" y="${H - 8}" fill="${PC.muted}" font-size="13" text-anchor="middle">${v}</text>`;
    }).join("");
    return `<svg class="chart tall" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}${bars}${tick(median, PC.accent, false)}${tick(mean, PC.accent2, true)}
      <line x1="${padL}" y1="${axisY}" x2="${W - padR}" y2="${axisY}" stroke="${PC.border}"/>${labels}
    </svg>`;
  }

  // Expected cumulative points by stage: p25–p75 band + mean line, on a y-axis
  // scaled to THIS manager's own range so the accumulation shape is visible.
  function cumulativeSVG(cum) {
    const W = 600, H = 380, padL = 40, padR = 10, padT = 16, padB = 30;
    const n = cum.length;
    const lo0 = Math.min(...cum.map((c) => c.p25));
    const hi0 = Math.max(...cum.map((c) => c.p75));
    const span = hi0 - lo0 || 1;
    const lo = lo0 - span * 0.12, hi = hi0 + span * 0.12;
    const sx = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
    const sy = scale(lo, hi, H - padB, padT);
    const up = cum.map((c, i) => `${sx(i)},${sy(c.p75)}`).join(" ");
    const dn = cum.map((c, i) => `${sx(i)},${sy(c.p25)}`).reverse().join(" ");
    const meanLine = cum.map((c, i) => `${sx(i)},${sy(c.mean)}`).join(" ");
    const dots = cum.map((c, i) => `<circle cx="${sx(i)}" cy="${sy(c.mean)}" r="3.5" fill="${PC.accent}"/>`).join("");
    const grid = [lo0, (lo0 + hi0) / 2, hi0].map((v) =>
      `<line x1="${padL}" y1="${sy(v)}" x2="${W - padR}" y2="${sy(v)}" stroke="${PC.border}" stroke-width="1" stroke-dasharray="2 3"/>` +
      `<text x="${padL - 6}" y="${sy(v) + 4}" fill="${PC.muted}" font-size="13" text-anchor="end">${Math.round(v)}</text>`).join("");
    const labels = cum.map((c, i) => `<text x="${sx(i)}" y="${H - 8}" fill="${PC.muted}" font-size="13" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(c.stage)}</text>`).join("");
    return `<svg class="chart tall" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}
      <polygon points="${up} ${dn}" fill="${PC.accent}" fill-opacity="0.18"/>
      <polyline points="${meanLine}" fill="none" stroke="${PC.accent}" stroke-width="3"/>
      ${dots}${labels}
    </svg>`;
  }

  // Tiny Poisson goal-distribution sparkline (P(0),P(1),...,P(4),P(5+)).
  function poissonSpark(dist) {
    const W = 78, H = 24, n = dist.length, bw = W / n, maxP = Math.max(...dist) || 1;
    let bars = "";
    for (let i = 0; i < n; i++) {
      const hgt = (dist[i] / maxP) * (H - 2);
      bars += `<rect x="${i * bw + 0.5}" y="${H - hgt}" width="${bw - 1}" height="${hgt}" fill="${PC.green}" fill-opacity="0.8"/>`;
    }
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="goal distribution">${bars}</svg>`;
  }

  function renderProjections() {
    const root = el("div", "proj");
    const P = window.PROJECTIONS;
    if (!P || !P.managers) {
      root.appendChild(el("p", "muted",
        "Projections haven't been generated yet. Run <code>node scripts/build_projections.js</code> to create <code>data/projections.js</code>."));
      return root;
    }
    const mgrs = P.managers;

    const intro = el("div", "proj-intro");
    const playedN = P.meta.playedMatches || 0;
    intro.innerHTML = playedN
      ? `<p class="muted">Monte-Carlo forecast over <b>${P.meta.nSims.toLocaleString()}</b> simulated tournaments, ` +
        `conditioned on the <b>${playedN}</b> result${playedN === 1 ? "" : "s"} so far — played games are locked at their actual points, ` +
        `only the remaining games are simulated. Refreshes daily at 10:00 UTC. ${esc(P.meta.format)}.</p>`
      : `<p class="muted">Pre-tournament Monte-Carlo projection over <b>${P.meta.nSims.toLocaleString()}</b> simulated World Cups. ` +
        `${esc(P.meta.format)}. Every simulated match is scored with the same rules as the live standings. ` +
        `Once games kick off, this updates daily (10:00 UTC) based on the results that have come in.</p>`;
    root.appendChild(intro);

    // ---- shared domain for points charts ----
    const lo = Math.floor(Math.min(...mgrs.map((m) => m.pct.p5)) / 10) * 10;
    const hi = Math.ceil(Math.max(...mgrs.map((m) => m.pct.p95)) / 10) * 10;
    const dom = { lo: Math.max(0, lo - 5), hi: hi + 5 };

    // ===== Section 1: projected standings with uncertainty =====
    root.appendChild(el("h3", "proj-h", "Projected standings"));
    root.appendChild(el("p", "proj-sub muted",
      `Box = middle 50% of outcomes (25th–75th percentile); whiskers span the 5th–95th. ` +
      `<span class="lg-median">┃</span> median · <span class="lg-mean">┋</span> mean. Range: ${dom.lo}–${dom.hi} pts.`));
    const bp = el("div", "boxplots");
    mgrs.forEach((m, i) => {
      const row = el("div", "bp-row");
      row.innerHTML =
        `<div class="bp-rank">${i + 1}</div>` +
        `<div class="bp-name">${esc(m.name)}<span class="muted">${m.teamCount} teams</span></div>` +
        `<div class="bp-chart">${boxPlotSVG(m.pct, m.mean, dom)}</div>` +
        `<div class="bp-val">${m.mean}<small>±${m.std}</small></div>`;
      bp.appendChild(row);
    });
    root.appendChild(bp);

    // ===== Section 2: finishing-position heatmap =====
    root.appendChild(el("h3", "proj-h", "Probability of finishing in each position"));
    const heat = el("div", "heat-wrap");
    const ht = el("table", "heat");
    let head = `<thead><tr><th>Manager</th>`;
    for (let i = 0; i < mgrs.length; i++) head += `<th class="num">${i + 1}${["st","nd","rd"][i] || "th"}</th>`;
    head += `</tr></thead>`;
    let body = "<tbody>";
    mgrs.forEach((m) => {
      body += `<tr><td class="heat-name">${esc(m.name)}</td>`;
      m.finish.forEach((p) => {
        const op = Math.min(1, 0.08 + p * 1.4);
        const strong = p >= 0.18;
        body += `<td class="num heat-cell" style="background:rgba(47,129,247,${op.toFixed(3)})">` +
          `<span class="${strong ? "" : "muted"}">${p >= 0.005 ? pctTxt(p) : "·"}</span></td>`;
      });
      body += `</tr>`;
    });
    body += "</tbody>";
    ht.innerHTML = head + body;
    heat.appendChild(ht);
    root.appendChild(heat);

    // ===== Section 3: per-manager detail cards =====
    root.appendChild(el("h3", "proj-h", "Manager detail"));
    root.appendChild(el("p", "proj-sub muted", "Tap a manager for their points distribution, how points accumulate through the rounds, and a team-by-team breakdown."));
    const teamsByOwner = {};
    P.teams.forEach((t) => { (teamsByOwner[t.owner] = teamsByOwner[t.owner] || []).push(t); });

    mgrs.forEach((m, i) => {
      const card = el("div", "standing-card proj-card");
      const head2 = el("button", "standing-head");
      head2.setAttribute("aria-expanded", "false");
      head2.innerHTML = `
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(m.name)}</span>
        <span class="sub muted">1st ${pctTxt(m.finish[0])} · top-2 ${pctTxt(m.finish[0] + m.finish[1])}</span>
        <span class="pts">${m.mean}<small>pts</small></span>
        <span class="chev">▾</span>`;
      const body2 = el("div", "standing-body");

      // distribution + cumulative side by side
      const charts = el("div", "proj-charts");
      const c1 = el("div", "proj-chart-box");
      c1.innerHTML = `<div class="chart-title">Points distribution <span class="muted">(P5 ${m.pct.p5} · median ${m.pct.p50} · P95 ${m.pct.p95})</span></div>` +
        histSVG(m.hist, m.pct.p50, m.mean);
      const c2 = el("div", "proj-chart-box");
      c2.innerHTML = `<div class="chart-title">Expected points by stage <span class="muted">(mean + 25–75% band)</span></div>` +
        cumulativeSVG(m.cumulative);
      charts.appendChild(c1); charts.appendChild(c2);
      body2.appendChild(charts);

      // team table
      const tbl = el("table", "mini proj-teams");
      tbl.innerHTML = `<thead><tr>
        <th>Team</th><th class="num">Proj</th><th>Goals/game</th>
        <th class="num">Adv</th><th class="num">R16</th><th class="num">QF</th><th class="num">SF</th><th class="num">Win</th>
      </tr></thead>`;
      const tb = el("tbody");
      (teamsByOwner[m.name] || []).slice().sort((a, b) => b.mean - a.mean).forEach((t) => {
        const tr = el("tr");
        tr.innerHTML =
          `<td>${esc(t.team)}</td>` +
          `<td class="num"><b>${t.mean}</b></td>` +
          `<td class="spark-cell">${poissonSpark(t.goalDist)}<span class="muted lam">${t.lambda}</span></td>` +
          `<td class="num">${pctTxt(t.prog.advance)}</td>` +
          `<td class="num">${pctTxt(t.prog.r16)}</td>` +
          `<td class="num">${pctTxt(t.prog.qf)}</td>` +
          `<td class="num">${pctTxt(t.prog.sf)}</td>` +
          `<td class="num">${pctTxt(t.prog.champion)}</td>`;
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      body2.appendChild(tbl);

      head2.addEventListener("click", () => {
        const open = card.classList.toggle("open");
        head2.setAttribute("aria-expanded", open ? "true" : "false");
      });
      card.appendChild(head2); card.appendChild(body2);
      root.appendChild(card);
    });

    // model footnote
    const foot = el("p", "muted proj-foot");
    foot.innerHTML = `<b>Model.</b> ${esc(P.meta.note)} ` +
      `Goals/game shows each team's Poisson goal distribution — bars are P(0),P(1),P(2),P(3),P(4),P(5+); the number is the mean (λ). ` +
      `Generated ${esc((P.meta.generatedAt || "").slice(0, 10))}. Re-run with <code>node scripts/build_projections.js</code>.`;
    root.appendChild(foot);
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
    standings:   { label: "Standings", render: renderStandings },
    projections: { label: "Projections", render: renderProjections },
    teams:       { label: "Teams", render: renderTeams },
    results:   { label: "Results", render: renderResults },
    points:    { label: "Game Points", render: renderGamePoints },
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
