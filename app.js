/* Fantasy World Cup — scoring engine + UI
   No build step. Reads data/*.js (global vars); edits are saved to the repo via
   the /api/save-result serverless function (Vercel). */

(function () {
  "use strict";

  const DRAFT = window.DRAFT || {};
  const RULES = window.RULES || {};

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

  // The advancing rounds, in order. A team that reaches the next round is, by
  // definition, the one that won its match in the previous one — so when a
  // shootout winner hasn't been recorded yet we can recover it from the draw.
  const KO_ROUNDS = ["Round of 32", "Round of 16", "Quarter-Final", "Semi-Final", "Final"];

  // Who advanced from a knockout match. Prefers an explicitly recorded shootout
  // winner; otherwise (a level score with no winner entered) infers it from the
  // next round's fixtures — whichever of the two teams turns up there won. The
  // Third-Place play-off and the Final have no "next round", so those fall back
  // to the recorded winner (null until an admin enters it).
  function koAdvancer(m) {
    if (m.shootoutWinner) return m.shootoutWinner;
    const a = Number(m.scoreA), b = Number(m.scoreB);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b ? m.teamA : m.teamB;
    const i = KO_ROUNDS.indexOf(m.roundLabel);
    if (i < 0 || i + 1 >= KO_ROUNDS.length) return null;
    const nextLabel = KO_ROUNDS[i + 1];
    for (const n of MATCHES) {
      if (n.stage !== "knockout" || n.roundLabel !== nextLabel) continue;
      if (n.teamA === m.teamA || n.teamB === m.teamA) return m.teamA;
      if (n.teamA === m.teamB || n.teamB === m.teamB) return m.teamB;
    }
    return null;
  }

  // Teams that are out of the tournament: knocked out in a played knockout game
  // (the loser — i.e. anyone who isn't the advancer), or, once the group stage
  // is complete, any team that didn't reach the knockout field at all.
  function eliminatedTeams() {
    const out = new Set();
    const koTeams = new Set();
    for (const m of MATCHES) {
      if (m.stage !== "knockout" || !m.teamA || !m.teamB) continue;
      koTeams.add(m.teamA); koTeams.add(m.teamB);
      if (hasResult(m)) {
        const adv = koAdvancer(m);
        if (adv) out.add(adv === m.teamA ? m.teamB : m.teamA);
      }
    }
    const groupGames = MATCHES.filter((m) => m.stage === "group");
    const groupDone = koTeams.size > 0 && groupGames.length > 0 && groupGames.every(hasResult);
    if (groupDone) for (const t of ALL_TEAMS) if (!koTeams.has(t)) out.add(t);
    return out;
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
      if (knockout) { isWin = koAdvancer(m) === team; isDraw = false; }
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
    // Kyle's compensation for an unrelated draft issue: 7 × the league-wide
    // average points-per-dollar — every drafted team's fantasy points so far
    // divided by every auction dollar spent. Recomputed live, so it grows as
    // results come in. See the note on the Standings tab.
    const PR = window.PRICES || {};
    let totPts = 0, totPrice = 0;
    for (const s of Object.values(table)) {
      for (const row of s.teams) { totPts += row.points; totPrice += PR[row.team] || 0; }
    }
    const draftBonus = totPrice > 0 ? 7 * (totPts / totPrice) : 0;
    if (table.KYLE) { table.KYLE.draftBonus = draftBonus; table.KYLE.points += draftBonus; }

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
    const elim = eliminatedTeams();
    const played = MATCHES.filter(hasResult).length;
    const intro = el("p", "muted");
    intro.textContent = played
      ? `${played} of ${MATCHES.length} matches scored.`
      : "No results yet — the tournament kicks off June 11. Standings will fill in automatically.";
    root.appendChild(intro);

    const fmtPts = (p) => (Number.isInteger(p) ? String(p) : p.toFixed(1)); // bonus is fractional

    standings.forEach((s, rank) => {
      const card = el("div", "standing-card");
      const head = el("button", "standing-head");
      head.setAttribute("aria-expanded", "false");
      head.innerHTML = `
        <span class="rank">${rank + 1}</span>
        <span class="name">${esc(s.manager)}</span>
        <span class="sub muted">${s.teams.length} teams · ${s.played} GP</span>
        <span class="pts">${fmtPts(s.points)}<small>pts</small></span>
        <span class="chev">▾</span>`;
      const body = el("div", "standing-body");
      const tbl = el("table", "mini");
      tbl.innerHTML = `<thead><tr><th>Team</th><th class="num">GP</th><th class="num">Pts</th></tr></thead>`;
      const tb = el("tbody");
      s.teams.forEach((t) => {
        const tr = el("tr");
        const nm = elim.has(t.team) ? `<span class="elim">${esc(t.team)}</span>` : esc(t.team);
        tr.innerHTML = `<td>${nm}</td><td class="num">${t.played}</td><td class="num">${t.points}</td>`;
        tb.appendChild(tr);
      });
      if (s.draftBonus) {
        const tr = el("tr", "draft-bonus-row");
        tr.innerHTML = `<td>Kyle's extra points from draft mistake</td><td class="num">—</td><td class="num">+${s.draftBonus.toFixed(1)}</td>`;
        tb.appendChild(tr);
      }
      tbl.appendChild(tb); body.appendChild(tbl);
      head.addEventListener("click", () => {
        const open = card.classList.toggle("open");
        head.setAttribute("aria-expanded", open ? "true" : "false");
      });
      card.appendChild(head); card.appendChild(body); root.appendChild(card);
    });

    const kyle = standings.find((s) => s.draftBonus);
    if (kyle) {
      root.appendChild(el("p", "muted draft-bonus-note",
        `* Kyle's extra points from draft mistake: <b>+${kyle.draftBonus.toFixed(1)}</b>, added to his total. ` +
        `It's 7 × the league-wide average points per dollar (every drafted team's points so far ÷ every auction dollar spent), ` +
        `recalculated each day as results come in.`));
    }
    return root;
  }

  /* ---------- teams ---------- */

  // Actual points and games played per team, from the results so far.
  function teamActuals() {
    const pts = {}, gp = {};
    ALL_TEAMS.forEach((t) => { pts[t] = 0; gp[t] = 0; });
    for (const m of MATCHES) {
      if (!hasResult(m)) continue;
      for (const team of [m.teamA, m.teamB]) {
        if (!(team in pts)) continue;
        pts[team] += scoreTeamInMatch(team, m).total; gp[team] += 1;
      }
    }
    return { pts, gp };
  }

  let teamsSort = { key: "pts", dir: -1 }; // persists across re-renders; dir 1=asc, -1=desc

  function renderTeams() {
    const root = el("div");
    const { pts, gp } = teamActuals();
    const elim = eliminatedTeams();
    const cols = [
      { key: "team",    label: "Team",    num: false, get: (t) => t },
      { key: "manager", label: "Manager", num: false, get: (t) => TEAM_OWNER[t] || "" },
      { key: "gp",      label: "GP",      num: true,  get: (t) => gp[t] },
      { key: "pts",     label: "Pts",     num: true,  get: (t) => pts[t] },
    ];

    function draw() {
      const col = cols.find((c) => c.key === teamsSort.key) || cols[3];
      const dir = teamsSort.dir;
      const rows = ALL_TEAMS.slice().sort((a, b) => {
        const va = col.get(a), vb = col.get(b);
        let cmp = col.num ? va - vb : String(va).localeCompare(String(vb));
        if (cmp === 0) cmp = a.localeCompare(b); // stable tiebreak by team name
        return cmp * dir;
      });

      const arrow = (c) => (c.key === teamsSort.key ? (dir === 1 ? " ▲" : " ▼") : "");
      const tbl = el("table", "full");
      tbl.innerHTML = `<thead><tr>${cols
        .map((c) => `<th class="sortable${c.num ? " num" : ""}${c.key === teamsSort.key ? " sorted" : ""}" data-key="${c.key}">${c.label}${arrow(c)}</th>`)
        .join("")}</tr></thead>`;
      const tb = el("tbody");
      rows.forEach((t) => {
        const tr = el("tr");
        const nm = elim.has(t) ? `<span class="elim">${esc(t)}</span>` : esc(t);
        tr.innerHTML = `<td>${nm}</td><td class="muted">${esc(TEAM_OWNER[t])}</td><td class="num">${gp[t]}</td><td class="num">${pts[t]}</td>`;
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      tbl.querySelector("thead").addEventListener("click", (e) => {
        const th = e.target.closest("th.sortable");
        if (!th) return;
        const key = th.dataset.key;
        if (teamsSort.key === key) teamsSort.dir *= -1;       // re-click flips direction
        else teamsSort = { key, dir: cols.find((c) => c.key === key).num ? -1 : 1 }; // numbers default high→low, text A→Z
        draw();
      });
      root.replaceChildren(tbl);
    }

    draw();
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
    // Points per MANAGER (one entry if the same manager owns both teams, none
    // if no involved team is owned).
    const mgrPts = {};
    if (played) {
      for (const team of [m.teamA, m.teamB]) {
        const o = TEAM_OWNER[team];
        if (o) mgrPts[o] = (mgrPts[o] || 0) + scoreTeamInMatch(team, m).total;
      }
    }
    const ptsCell = played && Object.keys(mgrPts).length
      ? Object.entries(mgrPts)
          .map(([o, p]) => `<span class="pts-owner">${esc(o)} <span class="badge">+${p}</span></span>`)
          .join(" ")
      : '<span class="muted">—</span>';
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
      <td class="num pts-cell">${ptsCell}</td>`;

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

  /* ---------- AI commentary ---------- *
     Generated offline by scripts/build_commentary.js (local Ollama) into
     data/commentary.js, then committed. Renders window.COMMENTARY.text. */
  function renderCommentary() {
    const root = el("div", "commentary");
    const C = window.COMMENTARY;
    const entries = (C && C.entries) || [];
    if (!entries.length) {
      root.appendChild(el("p", "muted",
        "No commentary yet — run `node scripts/build_commentary.js` (with Ollama running) and push the result."));
      return root;
    }
    entries.forEach((e) => {
      const post = el("article", "post");
      if (e.headline) post.appendChild(el("h3", "post-headline", esc(e.headline)));
      const meta = [e.date ? fmtDate(e.date) : "", e.model ? "written by " + e.model : "",
        e.playedMatches ? "after " + e.playedMatches + " matches" : ""].filter(Boolean).join(" · ");
      if (meta) post.appendChild(el("p", "muted post-meta", esc(meta)));
      (e.text || "").split(/\n\s*\n/).forEach((para) => {
        const t = para.trim();
        if (t) post.appendChild(el("p", null, esc(t)));
      });
      root.appendChild(post);
    });
    return root;
  }

  /* ---------- per-game fantasy points ---------- */

  function koSuffix(m) {
    if (m.stage !== "knockout") return "";
    const adv = koAdvancer(m);
    if (m.penalties && adv) return ` · ${esc(adv)} won on penalties`;
    if (m.penalties) return " · decided on penalties";
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

  // Manager line colors (odds-history chart + legend).
  const MGR_COLORS = ["#2f81f7", "#f7b32f", "#2ea043", "#f85149", "#a371f7", "#39c5cf", "#e85aad"];

  // Title-odds-over-time line chart from window.ODDS_HISTORY (one entry/day).
  function oddsHistorySection() {
    const hist = window.ODDS_HISTORY;
    if (!hist || !hist.length) return null;
    const managers = Object.keys(DRAFT);
    const latest = hist[hist.length - 1].titleOdds || {};
    const order = managers.slice().sort((a, b) => (latest[b] || 0) - (latest[a] || 0));
    const color = {};
    order.forEach((m, i) => (color[m] = MGR_COLORS[i % MGR_COLORS.length]));

    const W = 600, H = 380, padL = 44, padR = 10, padT = 16, padB = 30;
    const n = hist.length;
    const maxP = Math.max(0.05, ...hist.flatMap((h) => order.map((m) => h.titleOdds[m] || 0))) * 1.15;
    const sx = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
    const sy = (p) => padT + (1 - p / maxP) * (H - padT - padB);
    const grid = [0, maxP / 2, maxP].map((p) =>
      `<line x1="${padL}" y1="${sy(p)}" x2="${W - padR}" y2="${sy(p)}" stroke="${PC.border}" stroke-width="1" stroke-dasharray="2 3"/>` +
      `<text x="${padL - 6}" y="${sy(p) + 4}" fill="${PC.muted}" font-size="13" text-anchor="end">${Math.round(p * 100)}%</text>`).join("");
    const step = Math.max(1, Math.ceil(n / 6));
    const labels = hist.map((h, i) => (i % step === 0 || i === n - 1)
      ? `<text x="${sx(i)}" y="${H - 8}" fill="${PC.muted}" font-size="12" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(fmtDate(h.date))}</text>` : "").join("");
    const series = order.map((m) => {
      const ptsStr = hist.map((h, i) => `${sx(i)},${sy(h.titleOdds[m] || 0)}`).join(" ");
      const dots = hist.map((h, i) => `<circle cx="${sx(i)}" cy="${sy(h.titleOdds[m] || 0)}" r="3" fill="${color[m]}"/>`).join("");
      return (n > 1 ? `<polyline points="${ptsStr}" fill="none" stroke="${color[m]}" stroke-width="2.5"/>` : "") + dots;
    }).join("");

    const sec = el("div");
    sec.appendChild(el("h3", "proj-h", "Title odds over time"));
    sec.appendChild(el("p", "proj-sub muted",
      "Each manager's probability of finishing 1st, from the daily re-projection." +
      (n === 1 ? " The chart grows as the tournament progresses." : "")));
    const legend = order.map((m) =>
      `<span class="odds-key"><span class="odds-swatch" style="background:${color[m]}"></span>${esc(m)} <b>${pctTxt(latest[m] || 0)}</b></span>`).join("");
    sec.appendChild(el("div", "odds-legend", legend));
    const box = el("div", "proj-chart-box odds-chart");
    box.innerHTML = `<svg class="chart tall" viewBox="0 0 ${W} ${H}" role="img">${grid}${series}${labels}</svg>`;
    sec.appendChild(box);
    return sec;
  }

  // Average-finishing-position-over-time line chart from window.ODDS_HISTORY.
  // Each entry's `avgFinish` is the expected final position — every finishing
  // place weighted by its probability (place × P(place)). 1 = certain to win the
  // league, 7 = certain last; LOWER is better, so the axis is inverted (best on
  // top, like a league ladder). Only days carrying the field are plotted.
  function avgFinishHistorySection() {
    const all = window.ODDS_HISTORY;
    if (!all || !all.length) return null;
    const hist = all.filter((h) => h.avgFinish && Object.keys(h.avgFinish).length);
    if (!hist.length) return null;
    const managers = Object.keys(DRAFT);
    const latest = hist[hist.length - 1].avgFinish || {};
    // best (lowest avg position) first
    const order = managers.slice().sort((a, b) => (latest[a] || 99) - (latest[b] || 99));
    const color = {};
    order.forEach((m, i) => (color[m] = MGR_COLORS[i % MGR_COLORS.length]));
    const fmtPos = (v) => (v || 0).toFixed(2);

    const W = 600, H = 380, padL = 44, padR = 10, padT = 16, padB = 30;
    const n = hist.length;
    // Full place range 1..N with a gridline at every integer position.
    const lo = 1, hi = managers.length;
    const sx = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
    // inverted: smaller position (better) maps higher up the plot
    const sy = scale(lo, hi, padT, H - padB);
    const grid = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).map((v) =>
      `<line x1="${padL}" y1="${sy(v)}" x2="${W - padR}" y2="${sy(v)}" stroke="${PC.border}" stroke-width="1" stroke-dasharray="2 3"/>` +
      `<text x="${padL - 6}" y="${sy(v) + 4}" fill="${PC.muted}" font-size="13" text-anchor="end">${v}</text>`).join("");
    const step = Math.max(1, Math.ceil(n / 6));
    const labels = hist.map((h, i) => (i % step === 0 || i === n - 1)
      ? `<text x="${sx(i)}" y="${H - 8}" fill="${PC.muted}" font-size="12" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(fmtDate(h.date))}</text>` : "").join("");
    const series = order.map((m) => {
      const ptsStr = hist.map((h, i) => `${sx(i)},${sy(h.avgFinish[m])}`).join(" ");
      const dots = hist.map((h, i) => `<circle cx="${sx(i)}" cy="${sy(h.avgFinish[m])}" r="3" fill="${color[m]}"/>`).join("");
      return (n > 1 ? `<polyline points="${ptsStr}" fill="none" stroke="${color[m]}" stroke-width="2.5"/>` : "") + dots;
    }).join("");

    const sec = el("div");
    sec.appendChild(el("h3", "proj-h", "Projected average finish over time"));
    sec.appendChild(el("p", "proj-sub muted",
      "Each manager's expected final position — every finishing place weighted by its probability (place × P(place)). " +
      "1.00 = certain to win the league, 7.00 = certain last. Lower is better, so best sits on top." +
      (n === 1 ? " The chart grows as the tournament progresses." : "")));
    const legend = order.map((m) =>
      `<span class="odds-key"><span class="odds-swatch" style="background:${color[m]}"></span>${esc(m)} <b>${fmtPos(latest[m] || 0)}</b></span>`).join("");
    sec.appendChild(el("div", "odds-legend", legend));
    const box = el("div", "proj-chart-box odds-chart");
    box.innerHTML = `<svg class="chart tall" viewBox="0 0 ${W} ${H}" role="img">${grid}${series}${labels}</svg>`;
    sec.appendChild(box);
    return sec;
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

    // ===== Section 2b: title odds over time (grows daily) =====
    const oddsSec = oddsHistorySection();
    if (oddsSec) root.appendChild(oddsSec);

    // ===== Section 2c: projected average finish over time =====
    const avgFinishSec = avgFinishHistorySection();
    if (avgFinishSec) root.appendChild(avgFinishSec);

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

  /* ---------- draft value: steals & busts by auction price ---------- */

  function renderValue() {
    const root = el("div", "value");
    const PR = window.PRICES;
    const P = window.PROJECTIONS;
    if (!PR || !P || !P.teams) {
      root.appendChild(el("p", "muted", "Draft value needs data/prices.js and data/projections.js."));
      return root;
    }
    const { pts: actual, gp } = teamActuals();
    const projByTeam = {};
    P.teams.forEach((t) => (projByTeam[t.team] = t.mean));

    const rows = ALL_TEAMS
      .filter((t) => PR[t] != null && projByTeam[t] != null)
      .map((t) => ({ team: t, owner: TEAM_OWNER[t], price: PR[t], actual: actual[t], gp: gp[t], proj: projByTeam[t] }));
    const totalProj = rows.reduce((s, r) => s + r.proj, 0);
    const totalPrice = rows.reduce((s, r) => s + r.price, 0);
    const rate = totalProj / totalPrice; // league market rate: pts per $
    rows.forEach((r) => {
      r.fair = r.price * rate;             // what $price should buy at the league rate
      r.value = r.proj - r.fair;           // surplus (+) or shortfall (−)
      r.ppd = r.proj / Math.max(1, r.price);
    });
    rows.sort((a, b) => b.value - a.value);

    const anyPlayed = MATCHES.some(hasResult);
    root.appendChild(el("p", "muted",
      `Was each team worth what its manager paid? The whole field cost $${totalPrice} for ${Math.round(totalProj)} projected points — ` +
      `a league-average rate of ${rate.toFixed(2)} pts per $. A team's "fair" return is its price × ${rate.toFixed(2)}, ` +
      `and its Value (last column) is projected final points minus that fair return: ` +
      `+N means it's projected to beat its price tag by N points (a steal), −N means it falls short (a bust). ` +
      `"Proj" is each team's expected FINAL fantasy points from the daily simulation` +
      (anyPlayed ? ", conditioned on results so far" : "") +
      `; "Proj pts/$" is just that projection divided by price. Updates daily as results come in.`));

    // steals & busts podium
    const pod = el("div", "value-podium");
    const chip = (r, cls) =>
      `<span class="value-chip ${cls}">${esc(r.team)} <span class="muted">$${r.price} · ${esc(r.owner)}</span> <b>${r.value > 0 ? "+" : ""}${r.value.toFixed(0)}</b></span>`;
    pod.innerHTML =
      `<div class="value-col"><h3 class="proj-h">Steals</h3>${rows.slice(0, 5).map((r) => chip(r, "steal")).join("")}</div>` +
      `<div class="value-col"><h3 class="proj-h">Busts</h3>${rows.slice(-5).reverse().map((r) => chip(r, "bust")).join("")}</div>`;
    root.appendChild(pod);

    // manager draft efficiency
    const spent = {}, mgrProj = {};
    rows.forEach((r) => (spent[r.owner] = (spent[r.owner] || 0) + r.price));
    (P.managers || []).forEach((m) => (mgrProj[m.name] = m.mean));
    const mgrs = Object.keys(DRAFT)
      .map((m) => ({
        name: m, spent: spent[m] || 0,
        actual: DRAFT[m].reduce((s, t) => s + (actual[t] || 0), 0),
        proj: mgrProj[m],
      }))
      .filter((m) => m.proj != null && m.spent > 0)
      .map((m) => ({ ...m, ppd: m.proj / m.spent }))
      .sort((a, b) => b.ppd - a.ppd);
    root.appendChild(el("h3", "proj-h", "Manager draft efficiency"));
    const mt = el("table", "full");
    mt.innerHTML = `<thead><tr><th>Manager</th><th class="num">Spent</th><th class="num">Pts so far</th><th class="num">Proj final</th><th class="num">Proj pts/$</th></tr></thead>`;
    const mtb = el("tbody");
    mgrs.forEach((m) => {
      const tr = el("tr");
      tr.innerHTML = `<td>${esc(m.name)}</td><td class="num">$${m.spent}</td><td class="num">${m.actual}</td>` +
        `<td class="num">${m.proj}</td><td class="num"><b>${m.ppd.toFixed(2)}</b></td>`;
      mtb.appendChild(tr);
    });
    mt.appendChild(mtb);
    root.appendChild(mt);

    // full team table
    root.appendChild(el("h3", "proj-h", "All teams by value"));
    const tbl = el("table", "full");
    tbl.innerHTML = `<thead><tr>
      <th>Team</th><th>Manager</th><th class="num">$</th><th class="num">Pts so far</th>
      <th class="num">Proj final</th><th class="num">Proj pts/$</th><th class="num">Value</th>
    </tr></thead>`;
    const tb = el("tbody");
    rows.forEach((r) => {
      const tr = el("tr");
      const v = r.value;
      tr.innerHTML =
        `<td>${esc(r.team)}</td><td class="muted">${esc(r.owner)}</td><td class="num">$${r.price}</td>` +
        `<td class="num">${r.gp ? r.actual : '<span class="muted">—</span>'}</td>` +
        `<td class="num">${r.proj}</td><td class="num">${r.ppd.toFixed(2)}</td>` +
        `<td class="num"><b class="${v >= 0 ? "value-pos" : "value-neg"}">${v > 0 ? "+" : ""}${v.toFixed(0)}</b></td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    root.appendChild(tbl);
    return root;
  }

  /* ---------- auto-update status ----------
     Scores import event-driven now: the update-scores workflow polls every
     10 minutes during each game's post-game window (see scripts/
     should_fetch.js), so a result lands minutes after the API ingests it.
     Instead of a cron countdown, show what we're actually waiting for. */

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
    const POST_GAME_HOURS = 7; // matches scripts/should_fetch.js GIVE_UP_HOURS
    const tick = () => {
      const now = Date.now();
      const pending = (window.MATCHES || []).filter((m) =>
        !(Number.isFinite(m.scoreA) && Number.isFinite(m.scoreB)) &&
        m.kickoff && !isNaN(Date.parse(m.kickoff)));
      const inWindow = pending.filter((m) => {
        const ko = Date.parse(m.kickoff);
        return ko <= now && now - ko <= POST_GAME_HOURS * 3600 * 1000;
      });
      const nextKo = pending.map((m) => Date.parse(m.kickoff))
        .filter((t) => t > now).sort((a, b) => a - b)[0];

      let main;
      if (inWindow.length) {
        const names = inWindow.map((m) => `${m.teamA}–${m.teamB}`).join(", ");
        main = `<b>${names}</b> under way — score auto-imports minutes after full time`;
      } else if (nextKo) {
        const ko = new Date(nextKo);
        const time = ko.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        const days = Math.floor((ko - new Date(new Date(now).toDateString())) / 86400000);
        const day = days === 0 ? "today" : days === 1 ? "tomorrow"
          : ko.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        main = `Next match ${day} at <b>${time}</b> — score auto-imports after full time`;
      } else {
        main = `Scores auto-import minutes after each game ends`;
      }
      const updated = relTime(window.MATCHES_GENERATED_AT);
      node.innerHTML =
        `<span class="dot"></span><span>${main}</span>` +
        (updated ? `<span class="muted">· results updated ${updated}</span>` : "");
    };
    tick();
    setInterval(tick, 30000);
  }

  /* ====================================================================
     What If  (EXPERIMENTAL)
     --------------------------------------------------------------------
     Interactive title-path explorer. Full-tournament Monte-Carlo:
       1) Monte-Carlo the unplayed group games with the same Elo/Poisson
          model as scripts/build_projections.js, then play FIFA's real 2026
          knockout bracket (R32 → final + third-place) to the end, scored
          with the live rules, to get each manager's P(finish 1st).
       2) Let you PIN any of your teams' remaining games to Win/Draw/Loss
          and re-simulate the rest, to see how your odds and the required
          results move.
       3) A worst→best scenario dial shows the bracket and your projected
          total points across percentile outcomes (and forced win/lose-out).
     Conditional odds ("what each team needs") are read straight off the
     baseline run: bucket the sims by each fixture's outcome and measure
     how often you end up 1st in each bucket — no extra sims per row.
     ==================================================================== */

  // --- model port (keep in sync with scripts/build_projections.js) ---
  // Team-strength model from data/ratings.js (window.RATINGS) — the SAME source
  // the projections build reads, so the What-If sims use the same formula and
  // never drift from the Projections tab. Tweak ratings in data/ratings.js.
  const WC_RATING = Object.assign({}, window.RATINGS.base);
  for (const t in window.RATINGS.drop) if (WC_RATING[t] != null) WC_RATING[t] += window.RATINGS.drop[t];
  const WC_MU = window.RATINGS.MU, WC_K = window.RATINGS.K;
  const wcLam = (a, b) => WC_MU * Math.exp(WC_K * (WC_RATING[a] - WC_RATING[b]) / 400);
  function wcPois(l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }
  function wcGroupPts(gf, ga) { let p = 0; if (gf > ga) p += 6; else if (gf === ga) p += 2; if (ga === 0) p += 1; if (gf >= 2) p += 1; if (gf >= 4) p += 1; if (gf - ga >= 2) p += 1; return p; }
  // Sample a scoreline, optionally conditioned on a pinned result for teamA's
  // perspective: 'A' (A wins), 'B' (B wins), 'D' (draw), or null (free).
  function wcSampleScore(a, b, pin) {
    for (let t = 0; t < 60; t++) {
      const ga = wcPois(wcLam(a, b)), gb = wcPois(wcLam(b, a));
      if (!pin) return [ga, gb];
      if (pin === "A" && ga > gb) return [ga, gb];
      if (pin === "B" && gb > ga) return [ga, gb];
      if (pin === "D" && ga === gb) return [ga, gb];
    }
    return pin === "A" ? [1, 0] : pin === "B" ? [0, 1] : [0, 0];
  }

  // --- official 2026 group draw (verified team-for-team against the fixture
  //     list) so we can apply FIFA's real bracket template by group letter ---
  const WC_GROUP = {
    Mexico:"A", "South Africa":"A", "South Korea":"A", Czechia:"A",
    Canada:"B", "Bosnia & Herz":"B", Qatar:"B", Switzerland:"B",
    Brazil:"C", Morocco:"C", Haiti:"C", Scotland:"C",
    USA:"D", Paraguay:"D", Australia:"D", Turkey:"D",
    Germany:"E", Curacao:"E", "Ivory Coast":"E", Ecuador:"E",
    Netherlands:"F", Japan:"F", Sweden:"F", Tunisia:"F",
    Belgium:"G", Egypt:"G", Iran:"G", "New Zealand":"G",
    Spain:"H", "Cape Verde":"H", "Saudi Arabia":"H", Uruguay:"H",
    France:"I", Senegal:"I", Iraq:"I", Norway:"I",
    Argentina:"J", Algeria:"J", Austria:"J", Jordan:"J",
    Portugal:"K", "DR Congo":"K", Uzbekistan:"K", Colombia:"K",
    England:"L", Croatia:"L", Ghana:"L", Panama:"L",
  };
  const WC_ET = window.RATINGS.ET; // extra-time goal-rate multiplier (shared via data/ratings.js)

  function wcKoPts(gf, ga, advanced, et, pk) {
    let p = 0;
    if (advanced) p += 6;
    if (ga === 0) p += 1;
    if (gf >= 2) p += 1;
    if (gf >= 4) p += 1;
    if (gf - ga >= 2) p += 1;
    if (et) p += 1;
    if (pk) p += 1;
    return p;
  }

  // FIFA's Round-of-32 third-place slots and which groups are eligible for each
  // (from the official 2026 bracket). Given the 8 group letters whose third-
  // placed team qualifies, assign each slot a distinct eligible letter.
  const WF_THIRD_SLOTS = {
    M74:["A","B","C","D","F"], M77:["C","D","F","G","H"], M79:["C","E","F","H","I"],
    M80:["E","H","I","J","K"], M81:["B","E","F","I","J"], M82:["A","E","H","I","J"],
    M85:["E","F","G","I","J"], M87:["D","E","I","J","L"],
  };
  function wfMatchThirds(qualLetters, slotKeys) {
    const slots = slotKeys || Object.keys(WF_THIRD_SLOTS);
    const qual = new Set(qualLetters);
    const used = new Set();
    const assign = {};
    // hardest slots (fewest qualifying options) first, then backtrack
    const order = slots.slice().sort((a, b) =>
      WF_THIRD_SLOTS[a].filter((g) => qual.has(g)).length -
      WF_THIRD_SLOTS[b].filter((g) => qual.has(g)).length);
    const bt = (k) => {
      if (k === order.length) return true;
      const s = order[k];
      for (const g of WF_THIRD_SLOTS[s]) {
        if (qual.has(g) && !used.has(g)) {
          assign[s] = g; used.add(g);
          if (bt(k + 1)) return true;
          used.delete(g); delete assign[s];
        }
      }
      return false;
    };
    bt(0);
    return assign; // { M74: <letter>, ... }
  }

  // FIFA's official Round-of-32 template: slot → the two seed specs that meet in
  // it. A spec is ["p1",L] (group L winner), ["p2",L] (runner-up) or ["3",slot]
  // (a best-third placed into that slot). Lives in one place; both the simulator
  // and the bracket visual read it. Slot numbers thread into the R16→Final tree.
  const WF_R32_SPEC = [
    [73, ["p2","A"], ["p2","B"]], [74, ["p1","E"], ["3","M74"]], [75, ["p1","F"], ["p2","C"]], [76, ["p1","C"], ["p2","F"]],
    [77, ["p1","I"], ["3","M77"]], [78, ["p2","E"], ["p2","I"]], [79, ["p1","A"], ["3","M79"]], [80, ["p1","L"], ["3","M80"]],
    [81, ["p1","D"], ["3","M81"]], [82, ["p1","G"], ["3","M82"]], [83, ["p2","K"], ["p2","L"]], [84, ["p1","H"], ["p2","J"]],
    [85, ["p1","B"], ["3","M85"]], [86, ["p1","J"], ["p2","H"]], [87, ["p1","K"], ["3","M87"]], [88, ["p2","D"], ["p2","G"]],
  ];
  const wfSeedTeam = (sp, p1, p2, third) => sp[0] === "p1" ? p1[sp[1]] : sp[0] === "p2" ? p2[sp[1]] : third(sp[1]);

  // Map the ACTUAL, already-drawn knockout matchups (from the live data) onto the
  // template slots, so the explorer plays the real bracket instead of re-deriving
  // every matchup from simulated group standings. Returns, per real R32 match:
  //   slot:      { <slotNum>: <data match> }      — the matchup that fills that slot
  //   posLock:   { <group>: {1|2|3: <team>} }     — group positions reality has fixed
  //   thirdLock: { <thirdSlot>: <team> }          — best-third slots already decided
  // Slots/positions not yet decided fall back to the simulated seeds. Memoized on
  // the MATCHES array identity so it recomputes after any results edit.
  let _wfRealCache = null;
  function wfRealKo() {
    if (_wfRealCache && _wfRealCache.ref === MATCHES) return _wfRealCache.val;
    // group seeds from current reality: played group games, with the few still
    // unplayed resolved by rating so already-clinched teams land in their secured
    // position (used only to identify which template slot each real match fills).
    const gr = {};
    for (const t of ALL_TEAMS) if (WC_GROUP[t] != null) gr[t] = { pts: 0, gd: 0, gf: 0 };
    for (const m of MATCHES) {
      if (m.stage !== "group" || WC_GROUP[m.teamA] == null || WC_GROUP[m.teamB] == null) continue;
      let a, b;
      if (hasResult(m)) { a = Number(m.scoreA); b = Number(m.scoreB); }
      else { const hi = WC_RATING[m.teamA] >= WC_RATING[m.teamB]; a = hi ? 1 : 0; b = hi ? 0 : 1; }
      gr[m.teamA].gf += a; gr[m.teamA].gd += a - b; gr[m.teamB].gf += b; gr[m.teamB].gd += b - a;
      if (a > b) gr[m.teamA].pts += 3; else if (b > a) gr[m.teamB].pts += 3; else { gr[m.teamA].pts++; gr[m.teamB].pts++; }
    }
    const byL = {}; for (const t of ALL_TEAMS) if (WC_GROUP[t] != null) (byL[WC_GROUP[t]] = byL[WC_GROUP[t]] || []).push(t);
    const cmp = (x, y) => gr[y].pts - gr[x].pts || gr[y].gd - gr[x].gd || gr[y].gf - gr[x].gf || WC_RATING[y] - WC_RATING[x];
    const pos = {}; for (const L in byL) byL[L].slice().sort(cmp).forEach((t, i) => (pos[t] = { L, p: i + 1 }));
    const specFits = (sp, t) => {
      const P = pos[t]; if (!P) return false;
      if (sp[0] === "p1") return P.p === 1 && P.L === sp[1];
      if (sp[0] === "p2") return P.p === 2 && P.L === sp[1];
      return P.p === 3 && (WF_THIRD_SLOTS[sp[1]] || []).includes(P.L);
    };
    const slot = {}, posLock = {}, thirdLock = {}, used = new Set();
    const lockSpec = (sp, team) => {
      if (sp[0] === "p1") (posLock[sp[1]] = posLock[sp[1]] || {})[1] = team;
      else if (sp[0] === "p2") (posLock[sp[1]] = posLock[sp[1]] || {})[2] = team;
      else { (posLock[pos[team].L] = posLock[pos[team].L] || {})[3] = team; thirdLock[sp[1]] = team; }
    };
    const real = MATCHES.filter((m) => m.stage === "knockout" && m.round === 32 && m.teamA && m.teamB &&
      WC_RATING[m.teamA] != null && WC_RATING[m.teamB] != null);
    for (const m of real) {
      for (const [n, sa, sb] of WF_R32_SPEC) {
        if (used.has(n)) continue;
        let aFits = null, bFits = null;
        if (specFits(sa, m.teamA) && specFits(sb, m.teamB)) { aFits = sa; bFits = sb; }
        else if (specFits(sa, m.teamB) && specFits(sb, m.teamA)) { aFits = sb; bFits = sa; }
        if (aFits) { used.add(n); slot[n] = m; lockSpec(aFits, m.teamA); lockSpec(bFits, m.teamB); break; }
      }
    }
    const val = { slot, posLock, thirdLock };
    _wfRealCache = { ref: MATCHES, val };
    return val;
  }

  // Build the bracket seeds (1st/2nd per group + the eight best thirds slotted
  // into FIFA's template) from a per-group football table `gr`, with reality's
  // already-decided positions/matchups (`real`) pinned in place.
  function wfSeed(byL, gr, real) {
    const cmp = (x, y) => gr[y].pts - gr[x].pts || gr[y].gd - gr[x].gd || gr[y].gf - gr[x].gf || WC_RATING[y] - WC_RATING[x];
    const p1 = {}, p2 = {}, thirdCand = [];
    for (const L in byL) {
      const g = byL[L].slice().sort(cmp);
      const lock = real.posLock[L] || {};
      const arr = [lock[1] || null, lock[2] || null, lock[3] || null, null];
      const rest = g.filter((t) => t !== lock[1] && t !== lock[2] && t !== lock[3]);
      let ri = 0; for (let k = 0; k < 4; k++) if (!arr[k]) arr[k] = rest[ri++];
      p1[L] = arr[0]; p2[L] = arr[1]; thirdCand.push({ L, team: arr[2] });
    }
    const lockedSlots = Object.keys(real.thirdLock);
    const lockedTeams = new Set(Object.values(real.thirdLock));
    const free = thirdCand.filter((c) => !lockedTeams.has(c.team)).sort((x, y) => cmp(x.team, y.team)).slice(0, 8 - lockedSlots.length);
    const freeSlots = Object.keys(WF_THIRD_SLOTS).filter((s) => !real.thirdLock[s]);
    const assign = wfMatchThirds(free.map((c) => c.L), freeSlots);
    const tt = {}; free.forEach((c) => (tt[c.L] = c.team));
    const third = (s) => real.thirdLock[s] || tt[assign[s]];
    return { p1, p2, third };
  }

  const WF = { manager: null, pins: {}, sims: 5000, bracketMode: "avg" };
  const wfId = (m) => String(m.id || m.eventId || keyOf(m));

  // Only remaining GROUP games are explorable/pinnable here; the knockout bracket
  // is driven by the real draw + simulated outcomes (see wfRealKo/wfRun), not by
  // pinning, so including knockout fixtures here would double-count them.
  function wfFixtures() {
    return MATCHES
      .filter((m) => m.stage === "group" && !hasResult(m) && TEAM_OWNER[m.teamA] && TEAM_OWNER[m.teamB] &&
                     WC_RATING[m.teamA] != null && WC_RATING[m.teamB] != null && (m.kickoff || m.date))
      .slice()
      .sort((a, b) => String(a.kickoff || a.date).localeCompare(String(b.kickoff || b.date)));
  }
  function wfBase() { const b = {}; for (const s of computeStandings()) b[s.manager] = s.points; return b; }

  // Full-tournament Monte-Carlo run to the FINAL via FIFA's real bracket.
  // Each sim: finish the remaining group games (honoring pins) → real group
  // standings → 1st/2nd per group + 8 best thirds → seed the official Round-of-32
  // template → play R32→R16→QF→SF→Final (+ 3rd-place game), scoring every match
  // with the live rules → rank managers. Returns P(1st), the finish-position
  // distribution, and per-group-fixture conditional buckets for the explorer.
  function wfRun(manager, pins, N) {
    const fx = wfFixtures();
    const base = wfBase();
    const managers = Object.keys(DRAFT);
    const meta = fx.map((f) => {
      const side = (TEAM_OWNER[f.teamB] === manager && TEAM_OWNER[f.teamA] !== manager) ? "B" : "A";
      return { f, side, mine: TEAM_OWNER[f.teamA] === manager || TEAM_OWNER[f.teamB] === manager };
    });
    const newB = () => ({ n: 0, first: 0, margin: 0, by2: 0 });
    const buckets = fx.map(() => ({ win: newB(), draw: newB(), loss: newB() }));

    // football record (3/1/0, GD, GF) from PLAYED group games — the base each
    // sim extends with simulated remaining group results to rank the groups.
    const fbBase = {};
    for (const t of ALL_TEAMS) if (WC_GROUP[t] != null) fbBase[t] = { pts: 0, gd: 0, gf: 0 };
    for (const m of MATCHES) {
      if (m.stage !== "group" || !hasResult(m) || WC_GROUP[m.teamA] == null || WC_GROUP[m.teamB] == null) continue;
      const a = Number(m.scoreA), b = Number(m.scoreB);
      fbBase[m.teamA].gf += a; fbBase[m.teamA].gd += a - b;
      fbBase[m.teamB].gf += b; fbBase[m.teamB].gd += b - a;
      if (a > b) fbBase[m.teamA].pts += 3; else if (b > a) fbBase[m.teamB].pts += 3;
      else { fbBase[m.teamA].pts += 1; fbBase[m.teamB].pts += 1; }
    }
    const teamsByLetter = {};
    for (const t of ALL_TEAMS) if (WC_GROUP[t] != null) (teamsByLetter[WC_GROUP[t]] = teamsByLetter[WC_GROUP[t]] || []).push(t);
    const real = wfRealKo();

    let firstTotal = 0;
    const finish = new Array(managers.length).fill(0);

    for (let s = 0; s < N; s++) {
      const tot = {}; for (const m of managers) tot[m] = base[m];
      const gr = {}; for (const t in fbBase) gr[t] = { pts: fbBase[t].pts, gd: fbBase[t].gd, gf: fbBase[t].gf };
      const oc = new Array(fx.length);

      // ---- remaining group games ----
      for (let i = 0; i < fx.length; i++) {
        const f = fx[i];
        const [ga, gb] = wcSampleScore(f.teamA, f.teamB, pins[wfId(f)] || null);
        tot[TEAM_OWNER[f.teamA]] += wcGroupPts(ga, gb);
        tot[TEAM_OWNER[f.teamB]] += wcGroupPts(gb, ga);
        gr[f.teamA].gf += ga; gr[f.teamA].gd += ga - gb;
        gr[f.teamB].gf += gb; gr[f.teamB].gd += gb - ga;
        if (ga > gb) gr[f.teamA].pts += 3; else if (gb > ga) gr[f.teamB].pts += 3;
        else { gr[f.teamA].pts += 1; gr[f.teamB].pts += 1; }
        const gf = meta[i].side === "A" ? ga : gb, gAg = meta[i].side === "A" ? gb : ga;
        const o = gf > gAg ? "win" : gf === gAg ? "draw" : "loss";
        oc[i] = o;
        const bk = buckets[i][o]; bk.n++; bk.margin += gf - gAg; if (gf - gAg >= 2) bk.by2++;
      }

      // ---- group standings → seeds (reality's clinched spots pinned) ----
      const { p1, p2, third } = wfSeed(teamsByLetter, gr, real);

      // ---- knockout (scores both teams, returns the winner). A slot whose real
      //      matchup has already been PLAYED uses that fixed result and adds no
      //      points (they're already in `base`); otherwise it's simulated. ----
      const simKo = (a, b, rm) => {
        let ga, gb, et = false, pk = false, w;
        if (rm && hasResult(rm)) {
          ga = Number(rm.scoreA); gb = Number(rm.scoreB); et = !!rm.extraTime || ga === gb; pk = !!rm.penalties || ga === gb;
          if (ga > gb) w = a; else if (gb > ga) w = b; else w = koAdvancer(rm) === b ? b : a;
          return w;
        }
        ga = wcPois(wcLam(a, b)); gb = wcPois(wcLam(b, a));
        if (ga === gb) { et = true; const ea = wcPois(wcLam(a, b) * WC_ET), eb = wcPois(wcLam(b, a) * WC_ET); ga += ea; gb += eb; if (ga === gb) pk = true; }
        if (ga > gb) w = a; else if (gb > ga) w = b;
        else { const pa = 1 / (1 + Math.pow(10, (WC_RATING[b] - WC_RATING[a]) / 400)); w = Math.random() < pa ? a : b; }
        const l = w === a ? b : a;
        const wgf = w === a ? ga : gb, wga = w === a ? gb : ga, lgf = l === a ? ga : gb, lga = l === a ? gb : ga;
        tot[TEAM_OWNER[w]] += wcKoPts(wgf, wga, true, et, pk);
        tot[TEAM_OWNER[l]] += wcKoPts(lgf, lga, false, et, pk);
        return w;
      };

      const W = {}, Lz = {};
      for (const [n, sa, sb] of WF_R32_SPEC) {
        const rm = real.slot[n];
        const a = rm ? rm.teamA : wfSeedTeam(sa, p1, p2, third);
        const b = rm ? rm.teamB : wfSeedTeam(sb, p1, p2, third);
        W[n] = simKo(a, b, rm);
      }
      const pair = (n, x, y) => { W[n] = simKo(W[x], W[y]); Lz[n] = W[n] === W[x] ? W[y] : W[x]; };
      [[89,74,77],[90,73,75],[91,76,78],[92,79,80],[93,83,84],[94,81,82],[95,86,88],[96,85,87]].forEach(([n,x,y]) => pair(n,x,y));
      [[97,89,90],[98,93,94],[99,91,92],[100,95,96]].forEach(([n,x,y]) => pair(n,x,y));
      pair(101, 97, 98); pair(102, 99, 100);
      simKo(W[101], W[102]);   // final
      simKo(Lz[101], Lz[102]); // third-place game (a real scoring match)

      // ---- rank ----
      const order = managers.slice().sort((a, b) => tot[b] - tot[a] || a.localeCompare(b));
      const pos = order.indexOf(manager);
      finish[pos]++;
      if (pos === 0) { firstTotal++; for (let i = 0; i < fx.length; i++) buckets[i][oc[i]].first++; }
    }
    return {
      managers, fx, meta, base, N,
      p1st: firstTotal / N,
      finish: finish.map((c) => c / N),
      buckets,
    };
  }

  // One bracket for the visual. mode = "mc" (random sample), "best" (the selected
  // manager's teams win every remaining game and go as deep as the bracket allows),
  // or "worst" (their teams lose out). Non-selected games resolve by seeding/rating
  // in best/worst so the rest of the bracket still fills in deterministically.
  function wfSampleBracket(manager, mode, basePts) {
    const fx = wfFixtures();
    const mineT = (t) => TEAM_OWNER[t] === manager;
    let myPts = basePts != null ? basePts : (wfBase()[manager] || 0); // manager's total points this sim
    // a deterministic scoreline by rating, optionally forcing a winner
    // big=true → the forced winner takes a 4-0 result (the point-maximizing
    // scoreline: win + clean sheet + 2/4 goals + win-by-2 all bonus), used for
    // the selected manager's own games in best/worst so the numbers show the
    // ideal max (4-0) / min (0-4) outcome.
    const detScore = (a, b, forced, big) => {
      if (big && forced) return forced === a ? [4, 0] : [0, 4];
      let ga = Math.max(0, Math.round(wcLam(a, b))), gb = Math.max(0, Math.round(wcLam(b, a)));
      const w = forced || (ga > gb ? a : gb > ga ? b : (WC_RATING[a] >= WC_RATING[b] ? a : b));
      if (w === a && ga <= gb) ga = gb + 1;
      if (w === b && gb <= ga) gb = ga + 1;
      return [ga, gb];
    };
    const groupScore = (f) => {
      if (mode === "mc") return wcSampleScore(f.teamA, f.teamB, null);
      // both teams are yours → maximise YOUR combined points. Groups can't go to
      // penalties, so the ceiling is a 6-4 win: winner banks win+2-goal+4-goal+
      // win-by-2 (9), loser banks 2-goal+4-goal (2) = 11 total.
      if (mode === "best" && mineT(f.teamA) && mineT(f.teamB))
        return WC_RATING[f.teamA] >= WC_RATING[f.teamB] ? [6, 4] : [4, 6];
      let forced = null;
      if (mineT(f.teamA) !== mineT(f.teamB)) {
        const winSide = mode === "best" ? (mineT(f.teamA) ? f.teamA : f.teamB)
                                        : (mineT(f.teamA) ? f.teamB : f.teamA);
        forced = winSide;
      }
      return detScore(f.teamA, f.teamB, forced, true);
    };

    const gr = {};
    for (const t of ALL_TEAMS) if (WC_GROUP[t] != null) gr[t] = { pts: 0, gd: 0, gf: 0 };
    for (const m of MATCHES) {
      if (m.stage !== "group" || !hasResult(m) || WC_GROUP[m.teamA] == null || WC_GROUP[m.teamB] == null) continue;
      const a = Number(m.scoreA), b = Number(m.scoreB);
      gr[m.teamA].gf += a; gr[m.teamA].gd += a - b; gr[m.teamB].gf += b; gr[m.teamB].gd += b - a;
      if (a > b) gr[m.teamA].pts += 3; else if (b > a) gr[m.teamB].pts += 3; else { gr[m.teamA].pts += 1; gr[m.teamB].pts += 1; }
    }
    for (const f of fx) {
      const [ga, gb] = groupScore(f);
      gr[f.teamA].gf += ga; gr[f.teamA].gd += ga - gb; gr[f.teamB].gf += gb; gr[f.teamB].gd += gb - ga;
      if (ga > gb) gr[f.teamA].pts += 3; else if (gb > ga) gr[f.teamB].pts += 3; else { gr[f.teamA].pts += 1; gr[f.teamB].pts += 1; }
      if (TEAM_OWNER[f.teamA] === manager) myPts += wcGroupPts(ga, gb);
      if (TEAM_OWNER[f.teamB] === manager) myPts += wcGroupPts(gb, ga);
    }
    const byL = {}; for (const t of ALL_TEAMS) if (WC_GROUP[t] != null) (byL[WC_GROUP[t]] = byL[WC_GROUP[t]] || []).push(t);
    const real = wfRealKo();
    const { p1, p2, third } = wfSeed(byL, gr, real);

    const match = {};
    const simKo = (n, a, b, rm) => {
      let ga, gb, et = false, pk = false, w, big = false;
      if (rm && hasResult(rm)) {
        // already played — fixed result; its points are already in `myPts` (base)
        ga = Number(rm.scoreA); gb = Number(rm.scoreB); et = !!rm.extraTime || ga === gb; pk = !!rm.penalties || ga === gb;
        if (ga > gb) w = a; else if (gb > ga) w = b; else w = koAdvancer(rm) === b ? b : a;
        match[n] = { a, b, sa: ga, sb: gb, w, big: false, tag: pk ? "ET · PK" : et ? "ET" : "" };
        return w;
      }
      if (mode !== "mc") {
        // best/worst: force my team's result; non-mine games by rating
        if (mode === "best" && mineT(a) && mineT(b)) {
          // both teams are yours → maximise YOUR combined points: a 4-4 draw won
          // on penalties. Both bank 2-goal+4-goal+ET+PK; the winner also advances
          // (10), the loser nets 4 → 14 total, the ceiling for an own-vs-own tie.
          ga = 4; gb = 4; et = true; pk = true; big = true;
          w = WC_RATING[a] >= WC_RATING[b] ? a : b;
        } else {
          let forced = null;
          if (mineT(a) !== mineT(b)) forced = mode === "best" ? (mineT(a) ? a : b) : (mineT(a) ? b : a);
          big = forced != null; // my own game → ideal 4-0 / 0-4 scoreline
          [ga, gb] = detScore(a, b, forced, big);
          w = ga > gb ? a : b;
        }
      } else {
        ga = wcPois(wcLam(a, b)); gb = wcPois(wcLam(b, a));
        if (ga === gb) { et = true; const ea = wcPois(wcLam(a, b) * WC_ET), eb = wcPois(wcLam(b, a) * WC_ET); ga += ea; gb += eb; if (ga === gb) pk = true; }
        if (ga > gb) w = a; else if (gb > ga) w = b;
        else { const pa = 1 / (1 + Math.pow(10, (WC_RATING[b] - WC_RATING[a]) / 400)); w = Math.random() < pa ? a : b; }
      }
      match[n] = { a, b, sa: ga, sb: gb, w, big, tag: pk ? "ET · PK" : et ? "ET" : "" };
      const l = w === a ? b : a;
      const wgf = w === a ? ga : gb, wga = w === a ? gb : ga, lgf = l === a ? ga : gb, lga = l === a ? gb : ga;
      if (TEAM_OWNER[w] === manager) myPts += wcKoPts(wgf, wga, true, et, pk);
      if (TEAM_OWNER[l] === manager) myPts += wcKoPts(lgf, lga, false, et, pk);
      return w;
    };
    const W = {};
    for (const [n, sa, sb] of WF_R32_SPEC) {
      const rm = real.slot[n];
      const a = rm ? rm.teamA : wfSeedTeam(sa, p1, p2, third);
      const b = rm ? rm.teamB : wfSeedTeam(sb, p1, p2, third);
      W[n] = simKo(n, a, b, rm);
    }
    const pr = (n, x, y) => { W[n] = simKo(n, W[x], W[y]); };
    [[89,74,77],[90,73,75],[91,76,78],[92,79,80],[93,83,84],[94,81,82],[95,86,88],[96,85,87]].forEach(([n,x,y]) => pr(n,x,y));
    [[97,89,90],[98,93,94],[99,91,92],[100,95,96]].forEach(([n,x,y]) => pr(n,x,y));
    pr(101, 97, 98); pr(102, 99, 100);
    const champion = simKo(104, W[101], W[102]);
    // third-place play-off — a real scoring match (kept consistent with wfRun
    // and the live standings, which count every knockout game incl. this one)
    const l101 = W[101] === W[97] ? W[98] : W[97];
    const l102 = W[102] === W[99] ? W[100] : W[99];
    simKo(103, l101, l102);
    return { match, champion, score: myPts };
  }

  // Render a sampled bracket as an R32→Final tree. The match order per round is
  // chosen so each later box sits between its two feeders (space-around aligns
  // box j over feeders 2j,2j+1).
  const WF_BRACKET_ORDER = [
    ["Round of 32", [74,77,73,75,83,84,81,82,76,78,79,80,86,88,85,87]],
    ["Round of 16", [89,90,93,94,91,92,95,96]],
    ["Quarter-finals", [97,98,99,100]],
    ["Semi-finals", [101,102]],
    ["Final", [104]],
  ];
  function wfBracketDOM(S, manager) {
    const wrap = el("div", "wf-bracket-wrap");
    const br = el("div", "wf-bracket");
    const teamRow = (team, score, win) => {
      const mine = TEAM_OWNER[team] === manager;
      const r = el("div", "wf-team" + (win ? " w" : "") + (mine ? " mine" : ""));
      r.innerHTML = `<span class="wf-tn">${esc(team || "—")}</span><span>${score == null ? "" : score}</span>`;
      return r;
    };
    for (const [label, nums] of WF_BRACKET_ORDER) {
      const col = el("div", "wf-round");
      col.appendChild(el("div", "wf-rtitle muted", label));
      const mm = el("div", "wf-rmatches");
      for (const n of nums) {
        const m = S.match[n];
        const box = el("div", "wf-match");
        if (m) {
          // ideal best/worst games show the maxed-out side as "4+" (4 goals caps the bonus)
          const dsa = m.big && m.sa >= 4 ? "4+" : m.sa;
          const dsb = m.big && m.sb >= 4 ? "4+" : m.sb;
          box.appendChild(teamRow(m.a, dsa, m.w === m.a));
          box.appendChild(teamRow(m.b, dsb, m.w === m.b));
          if (m.tag) box.appendChild(el("div", "wf-tag muted", m.tag));
        }
        mm.appendChild(box);
      }
      col.appendChild(mm);
      br.appendChild(col);
    }
    wrap.appendChild(br);
    const mine = TEAM_OWNER[S.champion] === manager;
    wrap.appendChild(el("div", "wf-champ",
      `🏆 <b class="${mine ? "wf-mine" : ""}">${esc(S.champion)}</b> ` +
      `<span class="muted">(${esc(TEAM_OWNER[S.champion])})${mine ? " — that's you!" : ""} · simulated champion</span>`));
    const tp = S.match[103];
    if (tp) {
      const w3 = tp.w, m3 = TEAM_OWNER[w3] === manager;
      wrap.appendChild(el("div", "wf-champ wf-third muted",
        `🥉 <b class="${m3 ? "wf-mine" : ""}">${esc(w3)}</b> ` +
        `beat ${esc(tp.w === tp.a ? tp.b : tp.a)} · third-place play-off (counts for points)`));
    }
    return wrap;
  }

  function ensureWhatIfStyles() {
    if (document.getElementById("whatif-style")) return;
    const s = el("style"); s.id = "whatif-style";
    s.textContent =
      ".wf-head{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin:.5rem 0 1rem}" +
      ".wf-select{font-size:1rem;padding:.35rem .5rem;border-radius:8px;background:#0d1117;color:inherit;border:1px solid #30363d}" +
      ".wf-odds{font-size:2.4rem;font-weight:700;line-height:1}" +
      ".wf-odds small{font-size:.9rem;font-weight:400;opacity:.7;margin-left:.4rem}" +
      ".wf-floor{opacity:.75;font-size:.9rem}" +
      ".wf-bars{display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;align-items:center;max-width:420px;margin:.5rem 0 1.2rem}" +
      ".wf-bar{height:12px;background:rgba(47,129,247,.85);border-radius:3px;min-width:2px}" +
      ".wf-bartrk{background:#161b22;border-radius:3px}" +
      ".wf-fx{border:1px solid #30363d;border-radius:10px;padding:.6rem .75rem;margin:.5rem 0;background:#0d1117}" +
      ".wf-fx-top{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;justify-content:space-between}" +
      ".wf-pins{display:inline-flex;gap:4px}" +
      ".wf-pin{padding:.25rem .6rem;border-radius:7px;border:1px solid #30363d;background:#161b22;color:inherit;cursor:pointer;font-size:.85rem}" +
      ".wf-pin.active{background:#2f81f7;border-color:#2f81f7;color:#fff;font-weight:600}" +
      ".wf-pin-pts{opacity:.7;font-weight:600;margin-left:.4em}" +
      ".wf-pin.active .wf-pin-pts{opacity:.95}" +
      ".wf-pts-readout{margin:.5rem 0 .9rem;font-size:1.05rem}" +
      ".wf-pts-end{font-size:1.6rem;color:#2f81f7}" +
      ".wf-cond{display:flex;gap:1rem;flex-wrap:wrap;margin-top:.4rem;font-size:.85rem}" +
      ".wf-cond b{font-variant-numeric:tabular-nums}" +
      ".wf-path li{margin:.25rem 0}" +
      ".wf-mine{font-weight:600}" +
      ".wf-bracket-wrap{overflow-x:auto;margin:.4rem 0 1rem;padding-bottom:6px}" +
      ".wf-bracket{display:flex;gap:12px;min-width:920px;height:780px}" +
      ".wf-round{display:flex;flex-direction:column;min-width:150px}" +
      ".wf-rtitle{text-align:center;font-size:.75rem;margin-bottom:6px}" +
      ".wf-rmatches{flex:1;display:flex;flex-direction:column;justify-content:space-around}" +
      ".wf-match{border:1px solid #30363d;border-radius:6px;background:#0d1117;overflow:hidden}" +
      ".wf-team{display:flex;justify-content:space-between;gap:6px;padding:2px 7px;font-size:.74rem}" +
      ".wf-team .wf-tn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".wf-team.w{font-weight:700;background:rgba(47,129,247,.08)}" +
      ".wf-team.mine .wf-tn{color:#2f81f7}" +
      ".wf-team.w.mine{background:rgba(47,129,247,.18)}" +
      ".wf-tag{font-size:.62rem;text-align:right;padding:0 7px 2px}" +
      ".wf-champ{margin-top:.5rem;font-size:1rem}" +
      ".wf-reroll{margin-left:.6rem}";
    document.head.appendChild(s);
  }

  function renderWhatIf() {
    ensureWhatIfStyles();
    const root = el("div", "whatif");
    const stand = computeStandings();
    if (!WF.manager || !stand.some((s) => s.manager === WF.manager)) WF.manager = stand[0].manager;

    root.appendChild(el("p", "muted",
      "<b>Experimental.</b> Full-tournament title-path explorer: takes everything that's already happened — played results and the " +
      "<b>actual Round-of-32 draw</b> as it stands — then simulates the rest. Remaining group games fill any undecided bracket slots " +
      "(group winners / runners-up / 8 best thirds into FIFA's official template), and the knockout rounds play to the final, scoring " +
      "every match with the live rules."));

    const head = el("div", "wf-head");
    const sel = el("select", "wf-select");
    Object.keys(DRAFT).forEach((m) => {
      const o = el("option"); o.value = m; o.textContent = m;
      if (m === WF.manager) o.selected = true; sel.appendChild(o);
    });
    sel.onchange = () => { WF.manager = sel.value; rebuild(); };
    head.appendChild(el("span", "muted", "Manager:"));
    head.appendChild(sel);
    root.appendChild(head);

    const dyn = el("div");
    root.appendChild(dyn);

    function rebuild() {
      dyn.innerHTML = "";
      const fxAll = wfFixtures(); // remaining GROUP games (drive the explorer sections)
      const anyLeft = MATCHES.some((m) => !hasResult(m) && (m.stage === "group" || m.stage === "knockout") &&
        WC_RATING[m.teamA] != null && WC_RATING[m.teamB] != null);
      if (!anyLeft) {
        dyn.appendChild(el("p", "muted", "The tournament is complete — every match is played, so there's nothing left to simulate."));
        return;
      }
      const sim = wfRun(WF.manager, WF.pins, WF.sims);

      const cur = stand.find((s) => s.manager === WF.manager);
      const curRank = stand.findIndex((s) => s.manager === WF.manager) + 1;

      // ceiling / floor on the GROUP stage: only meaningful while you still have
      // group games left (the knockout dial below covers the rest of the run).
      let clause = "";
      if (fxAll.length) {
        const minePins = (res) => {
          const p = {};
          sim.fx.forEach((f, i) => { if (sim.meta[i].mine) p[wfId(f)] = sim.meta[i].side === res.win ? "A" : "B"; });
          return p;
        };
        const ceil = wfRun(WF.manager, { ...WF.pins, ...minePins({ win: "A" }) }, WF.sims).p1st;
        const floor = wfRun(WF.manager, { ...WF.pins, ...minePins({ win: "B" }) }, WF.sims).p1st;
        clause = ` · if your group teams win out: <b>${pctTxt(ceil)}</b> · if they lose out: <b>${pctTxt(floor)}</b>`;
      }

      // headline
      const hcard = el("div");
      hcard.innerHTML =
        `<div class="wf-odds">${pctTxt(sim.p1st)}<small>chance ${esc(WF.manager)} finishes 1st</small></div>` +
        `<div class="wf-floor">Currently ${curRank}${["st","nd","rd"][curRank-1]||"th"} with <b>${cur.points}</b> pts${clause}</div>`;
      dyn.appendChild(hcard);

      // finish-position distribution
      dyn.appendChild(el("h3", "proj-h", "Where you finish"));
      dyn.appendChild(el("p", "muted", "Your chance of ending the league in each final position across all simulations (1st = winning the league)."));
      const bars = el("div", "wf-bars");
      const maxP = Math.max(...sim.finish);
      sim.finish.forEach((p, i) => {
        bars.appendChild(el("div", "muted", `${i + 1}${["st","nd","rd"][i]||"th"}`));
        const trk = el("div", "wf-bartrk");
        const bar = el("div", "wf-bar"); bar.style.width = `${Math.round((p / (maxP || 1)) * 100)}%`;
        if (i > 0) bar.style.background = "rgba(47,129,247,.45)";
        trk.appendChild(bar); bars.appendChild(trk);
        bars.appendChild(el("div", "muted", pctTxt(p)));
      });
      dyn.appendChild(bars);

      // most likely path to first
      const mineIdx = sim.fx.map((f, i) => i).filter((i) => sim.meta[i].mine);
      const ranked = mineIdx
        .map((i) => {
          const bk = sim.buckets[i];
          const w = bk.win.n ? bk.win.first / bk.win.n : 0;
          const l = bk.loss.n ? bk.loss.first / bk.loss.n : 0;
          return { i, swing: w - l, w, l };
        })
        .sort((a, b) => b.swing - a.swing)
        .slice(0, 6);
      if (ranked.length) {
        dyn.appendChild(el("h3", "proj-h", "Your most leveraged games"));
        dyn.appendChild(el("p", "muted",
          "Your remaining group games ranked by how much they move your <b>title odds</b> — your chance of finishing " +
          "1st overall (winning the league). Each line: title odds if your team wins vs if it loses."));
        const ul = el("ul", "wf-path muted");
        ranked.forEach((r) => {
          const f = sim.fx[r.i], side = sim.meta[r.i].side;
          const myTeam = side === "A" ? f.teamA : f.teamB, opp = side === "A" ? f.teamB : f.teamA;
          const by2 = sim.buckets[r.i].win.by2 / Math.max(1, sim.buckets[r.i].win.n) > 0.5;
          ul.appendChild(el("li", "",
            `<span class="wf-mine">${esc(myTeam)}</span> beat ${esc(opp)}${by2 ? " by 2+" : ""} → ` +
            `<b>${pctTxt(r.w)}</b> title odds <span class="muted">vs <b>${pctTxt(r.l)}</b> if they lose ` +
            `(swing ${r.swing >= 0 ? "+" : ""}${Math.round(r.swing * 100)} pts)</span>`));
        });
        dyn.appendChild(ul);
      }

      // other swing matches (not yours) — who to root for
      const others = sim.fx
        .map((f, i) => i)
        .filter((i) => !sim.meta[i].mine)
        .map((i) => {
          const bk = sim.buckets[i]; // side defaults to A here
          const a = bk.win.n ? bk.win.first / bk.win.n : 0;   // teamA wins
          const b = bk.loss.n ? bk.loss.first / bk.loss.n : 0; // teamA loses
          return { i, spread: Math.abs(a - b), a, b };
        })
        .filter((r) => r.spread > 0.015)
        .sort((x, y) => y.spread - x.spread)
        .slice(0, 12);
      if (others.length) {
        dyn.appendChild(el("h3", "proj-h", "Who to root for elsewhere"));
        dyn.appendChild(el("p", "muted",
          "Games <b>not</b> involving your teams that most move your title odds (your chance of finishing 1st). " +
          "Pull for the team on the left."));
        const ul = el("ul", "wf-path muted");
        others.forEach((r) => {
          const f = sim.fx[r.i];
          const helps = r.a >= r.b ? f.teamA : f.teamB;
          const against = helps === f.teamA ? f.teamB : f.teamA;
          const hi = Math.max(r.a, r.b), lo = Math.min(r.a, r.b);
          ul.appendChild(el("li", "",
            `Root for <b>${esc(helps)}</b> over ${esc(against)} → ` +
            `<b>${pctTxt(hi)}</b> title odds if they win <span class="muted">vs <b>${pctTxt(lo)}</b> if they don't</span>`));
        });
        dyn.appendChild(ul);
      }

      // bracket visual: a 5-step scenario dial from worst to absolute-best
      const brTop = el("div", "wf-fx-top");
      brTop.appendChild(el("h3", "proj-h", "Bracket to the final"));
      const modeBox = el("div", "wf-pins");
      const reroll = el("button", "wf-pin wf-reroll", "↻ Re-roll");
      brTop.appendChild(modeBox);
      brTop.appendChild(reroll);
      dyn.appendChild(brTop);
      const brDesc = el("p", "muted");
      dyn.appendChild(brDesc);
      const brPts = el("div", "wf-pts-readout");
      dyn.appendChild(brPts);
      const brHolder = el("div");
      dyn.appendChild(brHolder);

      const myBase = sim.base[WF.manager] || 0;
      const LEVELS = [
        ["worst", "Worst", "Worst case: your teams lose every remaining game (often knocked out in the group, so they disappear from the bracket). Other games resolve by seeding."],
        ["pess", "Pessimistic", "Pessimistic — a poor-but-plausible run for you (about the 15th-percentile Monte-Carlo tournament: you do better than this ~85% of the time)."],
        ["avg", "Average", "Average — a typical run (the median Monte-Carlo tournament: you do better half the time, worse half the time)."],
        ["opt", "Optimistic", "Optimistic — a strong-but-plausible run (about the 85th-percentile Monte-Carlo tournament: things go this well only ~15% of the time)."],
        ["best", "Absolute best", "Absolute best: your teams win every remaining game and go as deep as the bracket allows. Other games resolve by seeding."],
      ];
      const PCTL = { pess: 0.15, avg: 0.5, opt: 0.85 };
      const POOL_N = 5000; // Monte-Carlo tournaments sampled for the bracket percentiles
      let pool = null;
      const getPool = () => {
        if (pool) return pool;
        pool = [];
        for (let i = 0; i < POOL_N; i++) pool.push(wfSampleBracket(WF.manager, "mc", myBase));
        pool.sort((a, b) => a.score - b.score); // ascending by the manager's points → percentile = how well it went for them
        return pool;
      };
      const drawBracket = () => {
        const lvl = LEVELS.find((l) => l[0] === WF.bracketMode);
        brDesc.textContent = lvl[2];
        const isDet = WF.bracketMode === "best" || WF.bracketMode === "worst";
        reroll.style.display = isDet ? "none" : "";
        let S;
        if (isDet) S = wfSampleBracket(WF.manager, WF.bracketMode, myBase);
        else { const p = getPool(); S = p[Math.min(p.length - 1, Math.round(PCTL[WF.bracketMode] * (p.length - 1)))]; }
        brPts.innerHTML =
          `In the <b>${esc(lvl[1].toLowerCase())}</b> scenario you finish with ` +
          `<b class="wf-pts-end">${Math.round(S.score)}</b> total points ` +
          `<span class="muted">(${cur.points} now${S.score > cur.points ? " +" + (Math.round(S.score) - cur.points) : ""})</span>`;
        brHolder.innerHTML = "";
        brHolder.appendChild(wfBracketDOM(S, WF.manager));
      };
      // points the manager ends up with in each scenario (deterministic for
      // best/worst, the matching percentile sample for pess/avg/opt)
      const detScores = {};
      const levelScore = (m) => {
        if (m === "best" || m === "worst") {
          if (detScores[m] == null) detScores[m] = wfSampleBracket(WF.manager, m, myBase).score;
          return detScores[m];
        }
        const p = getPool();
        return p[Math.min(p.length - 1, Math.round(PCTL[m] * (p.length - 1)))].score;
      };
      const btns = [];
      const labelBtns = () => btns.forEach(({ m, lab, b }) => {
        b.innerHTML = `${lab}<small class="wf-pin-pts">${Math.round(levelScore(m))} pts</small>`;
      });
      LEVELS.forEach(([m, lab]) => {
        const b = el("button", "wf-pin" + (WF.bracketMode === m ? " active" : ""), lab);
        b.onclick = () => {
          WF.bracketMode = m;
          modeBox.querySelectorAll(".wf-pin").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          drawBracket();
        };
        modeBox.appendChild(b);
        btns.push({ m, lab, b });
      });
      reroll.onclick = () => { pool = null; drawBracket(); labelBtns(); }; // fresh sample at the same percentile
      drawBracket();
      labelBtns();

      const foot = el("p", "muted proj-foot");
      foot.innerHTML = `<b>Model.</b> ${WF.sims.toLocaleString()} full-tournament simulations: ` +
        (sim.fx.length ? `the ${sim.fx.length} remaining group match${sim.fx.length === 1 ? "" : "es"} plus ` : "") +
        `the knockout bracket to the final. Already-drawn Round-of-32 matchups are taken ` +
        `from the live data; any slots still undecided are filled from the simulated group standings. Elo-style ratings → ` +
        `Poisson goals (extra time at ${WC_ET}×, shootouts by rating), scored with the live rules. Group ties broken by points/GD/GF; ` +
        `the 8 best third-placed teams are seeded into FIFA's Round-of-32 slots. "Title odds" = your chance of finishing 1st overall; ` +
        `the leverage/root-for odds are read off the baseline run. The bracket's pessimistic/average/optimistic views are the 15th/50th/85th ` +
        `percentile of ${POOL_N.toLocaleString()} sampled tournaments (by your points); best/worst force your teams to win/lose out. Ties for 1st broken arbitrarily.`;
      dyn.appendChild(foot);
    }

    rebuild();
    return root;
  }

  /* ---------- tabs ---------- */

  const TABS = {
    standings:   { label: "Standings", render: renderStandings },
    projections: { label: "Projections", render: renderProjections },
    whatif:      { label: "What If", render: renderWhatIf },
    teams:       { label: "Teams", render: renderTeams },
    value:     { label: "Draft Value", render: renderValue },
    results:   { label: "Results", render: renderResults },
    points:    { label: "Game Points", render: renderGamePoints },
    commentary:{ label: "Commentary", render: renderCommentary },
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
