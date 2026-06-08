/* Fantasy World Cup — scoring engine + UI
   No build step, no server. All data comes from data/*.js (global vars). */

(function () {
  "use strict";

  const DRAFT = window.DRAFT || {};
  const RULES = window.RULES || {};
  let MATCHES = (window.MATCHES || []).slice();

  /* ---------- lookups ---------- */

  // team name -> manager who owns it
  const TEAM_OWNER = {};
  for (const manager of Object.keys(DRAFT)) {
    for (const team of DRAFT[manager]) TEAM_OWNER[team] = manager;
  }
  const ALL_TEAMS = Object.keys(TEAM_OWNER).sort((a, b) => a.localeCompare(b));

  /* ---------- scoring engine ---------- */

  // Returns { total, items: [{label, points}] } for one team in one match.
  function scoreTeamInMatch(team, m) {
    const isA = m.teamA === team;
    const gf = isA ? Number(m.scoreA) : Number(m.scoreB);
    const ga = isA ? Number(m.scoreB) : Number(m.scoreA);
    const knockout = m.stage === "knockout";

    const items = [];
    const add = (rule) => items.push({ label: RULES[rule].label, points: RULES[rule].points });

    // Determine win / draw / loss
    let isWin, isDraw;
    if (gf > ga) {
      isWin = true; isDraw = false;
    } else if (gf < ga) {
      isWin = false; isDraw = false;
    } else {
      // level scoreline
      if (knockout) {
        // no draws in knockout — decided by shootout
        isWin = m.shootoutWinner === team;
        isDraw = false;
      } else {
        isWin = false; isDraw = true;
      }
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

  // Standings per manager, with per-team breakdown.
  function computeStandings() {
    const table = {};
    for (const manager of Object.keys(DRAFT)) {
      table[manager] = {
        manager,
        points: 0,
        played: 0,
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
        if (!idx) continue; // team not owned by anyone
        const res = scoreTeamInMatch(team, m);
        const row = table[idx.manager].teams[idx.i];
        row.points += res.total;
        row.played += 1;
        table[idx.manager].points += res.total;
        table[idx.manager].played += 1;
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
  const matchResultLabel = (m) => {
    let s = `${m.scoreA}–${m.scoreB}`;
    if (m.stage === "knockout") {
      if (m.penalties && m.shootoutWinner) {
        const a = m.shootoutWinner === m.teamA ? "(P)" : "";
        const b = m.shootoutWinner === m.teamB ? "(P)" : "";
        s = `${m.scoreA}${a ? " " + a : ""}–${m.scoreB}${b ? " " + b : ""}`;
      } else if (m.extraTime) {
        s += " (AET)";
      }
    }
    return s;
  };

  /* ---------- rendering ---------- */

  function renderStandings() {
    const root = el("div");
    const standings = computeStandings();

    const intro = el("p", "muted");
    intro.textContent = MATCHES.length
      ? `${MATCHES.length} match${MATCHES.length === 1 ? "" : "es"} scored.`
      : "No results entered yet. Add some on the “Add Result” tab to see the table come to life.";
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
      tbl.appendChild(tb);
      body.appendChild(tbl);
      head.addEventListener("click", () => {
        const open = card.classList.toggle("open");
        head.setAttribute("aria-expanded", open ? "true" : "false");
      });
      card.appendChild(head);
      card.appendChild(body);
      root.appendChild(card);
    });
    return root;
  }

  function renderTeams() {
    const root = el("div");
    // points per team
    const pts = {};
    const gp = {};
    ALL_TEAMS.forEach((t) => { pts[t] = 0; gp[t] = 0; });
    for (const m of MATCHES) {
      for (const team of [m.teamA, m.teamB]) {
        if (!(team in pts)) continue;
        pts[team] += scoreTeamInMatch(team, m).total;
        gp[team] += 1;
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
    tbl.appendChild(tb);
    root.appendChild(tbl);
    return root;
  }

  function renderMatches() {
    const root = el("div");
    if (!MATCHES.length) {
      root.appendChild(el("p", "muted", "No matches yet."));
      return root;
    }
    const sorted = MATCHES.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
    sorted.forEach((m) => {
      const card = el("div", "match-card");
      const aPts = (m.teamA in TEAM_OWNER) ? scoreTeamInMatch(m.teamA, m).total : null;
      const bPts = (m.teamB in TEAM_OWNER) ? scoreTeamInMatch(m.teamB, m).total : null;
      const tag = (t, p) => p === null
        ? `<span class="unowned">${esc(t)}</span>`
        : `${esc(t)} <span class="badge">+${p}</span>`;
      card.innerHTML = `
        <div class="match-meta">
          <span class="stage ${m.stage}">${esc(m.roundLabel || (m.stage === "knockout" ? "Knockout" : "Group"))}</span>
          <span class="muted">${fmtDate(m.date)}</span>
        </div>
        <div class="match-line">
          <span class="t">${tag(m.teamA, aPts)}</span>
          <span class="score">${matchResultLabel(m)}</span>
          <span class="t right">${tag(m.teamB, bPts)}</span>
        </div>`;
      root.appendChild(card);
    });
    return root;
  }

  function renderRules() {
    const root = el("div", "rules");
    const list = el("ul");
    Object.values(RULES).forEach((r) => {
      list.appendChild(el("li", null, `<b>+${r.points}</b> ${esc(r.label)}`));
    });
    root.appendChild(list);
    root.appendChild(el("p", "muted", "Bonuses stack: e.g. a 4–0 group win earns 6 (win) + 1 (clean sheet) + 1 (2+ goals) + 1 (4+ goals) + 1 (won by 2+) = 10 points. In the knockout round there are no draws — the team that advances gets the win, the other gets 0 for win/draw."));
    return root;
  }

  /* ---------- Add Result form ---------- */

  function renderAddResult() {
    const root = el("div", "form-wrap");
    const teamOptions = ALL_TEAMS.map((t) => `<option value="${esc(t)}">${esc(t)} — ${esc(TEAM_OWNER[t])}</option>`).join("");

    root.innerHTML = `
      <p class="muted">Enter a result below. It updates the tables instantly in your browser. To make it permanent / share it with the league, click <b>Download matches.js</b> and replace the file in <code>data/</code>, then re-publish the site.</p>
      <div class="grid">
        <label>Date<input type="date" id="f-date"></label>
        <label>Stage
          <select id="f-stage">
            <option value="group">Group</option>
            <option value="knockout">Knockout</option>
          </select>
        </label>
        <label>Home team<select id="f-teamA"><option value="">—</option>${teamOptions}</select></label>
        <label class="num-in">Goals<input type="number" id="f-scoreA" min="0" step="1" value="0"></label>
        <label>Away team<select id="f-teamB"><option value="">—</option>${teamOptions}</select></label>
        <label class="num-in">Goals<input type="number" id="f-scoreB" min="0" step="1" value="0"></label>
      </div>
      <div id="ko-extra" class="ko-extra hidden">
        <label class="check"><input type="checkbox" id="f-et"> Went to extra time</label>
        <label class="check"><input type="checkbox" id="f-pk"> Went to penalties</label>
        <label id="so-wrap" class="hidden">Shootout winner
          <select id="f-so"><option value="">—</option></select>
        </label>
      </div>
      <div class="actions">
        <button id="f-add" class="btn primary">Add result</button>
        <button id="f-download" class="btn">⬇ Download matches.js</button>
        <button id="f-reset" class="btn ghost">Reset to saved file</button>
      </div>
      <p id="f-msg" class="form-msg"></p>
      <h3>Entered this session</h3>
      <div id="session-list"></div>
    `;

    const $ = (id) => root.querySelector(id);
    const stageSel = $("#f-stage");
    const koExtra = $("#ko-extra");
    const pkBox = $("#f-pk");
    const soWrap = $("#so-wrap");
    const soSel = $("#f-so");
    const teamA = $("#f-teamA");
    const teamB = $("#f-teamB");
    const msg = $("#f-msg");

    const refreshSO = () => {
      const a = teamA.value, b = teamB.value;
      soSel.innerHTML = `<option value="">—</option>` +
        [a, b].filter(Boolean).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    };
    const updateKO = () => {
      koExtra.classList.toggle("hidden", stageSel.value !== "knockout");
      soWrap.classList.toggle("hidden", !pkBox.checked || stageSel.value !== "knockout");
      refreshSO();
    };
    stageSel.addEventListener("change", updateKO);
    pkBox.addEventListener("change", updateKO);
    teamA.addEventListener("change", refreshSO);
    teamB.addEventListener("change", refreshSO);

    const renderSession = () => {
      const list = $("#session-list");
      list.innerHTML = "";
      if (!MATCHES.length) { list.appendChild(el("p", "muted", "Nothing yet.")); return; }
      MATCHES.slice().reverse().forEach((m) => {
        const row = el("div", "session-row");
        row.innerHTML = `<span>${esc(m.teamA)} ${matchResultLabel(m)} ${esc(m.teamB)} <span class="muted">· ${m.stage} · ${fmtDate(m.date)}</span></span>`;
        const del = el("button", "btn ghost tiny", "Remove");
        del.addEventListener("click", () => {
          MATCHES = MATCHES.filter((x) => x.id !== m.id);
          persist(); renderSession(); refreshAll();
        });
        row.appendChild(del);
        list.appendChild(row);
      });
    };

    $("#f-add").addEventListener("click", () => {
      const a = teamA.value, b = teamB.value;
      const sa = parseInt($("#f-scoreA").value, 10);
      const sb = parseInt($("#f-scoreB").value, 10);
      const stage = stageSel.value;
      msg.className = "form-msg";
      if (!a || !b) { msg.classList.add("err"); msg.textContent = "Pick both teams."; return; }
      if (a === b) { msg.classList.add("err"); msg.textContent = "A team can't play itself."; return; }
      if (!(sa >= 0) || !(sb >= 0)) { msg.classList.add("err"); msg.textContent = "Enter valid scores."; return; }
      const et = stage === "knockout" && $("#f-et").checked;
      const pk = stage === "knockout" && pkBox.checked;
      let shootoutWinner = null;
      if (stage === "knockout" && sa === sb) {
        shootoutWinner = soSel.value;
        if (!shootoutWinner) { msg.classList.add("err"); msg.textContent = "Knockout match is level — pick the shootout winner."; return; }
      }
      const nextId = MATCHES.reduce((mx, x) => Math.max(mx, x.id || 0), 0) + 1;
      MATCHES.push({
        id: nextId,
        source: "manual",
        date: $("#f-date").value || "",
        stage,
        teamA: a, teamB: b,
        scoreA: sa, scoreB: sb,
        extraTime: !!et,
        penalties: !!pk,
        shootoutWinner,
      });
      persist();
      msg.classList.add("ok");
      msg.textContent = `Added ${a} ${matchResultLabel(MATCHES[MATCHES.length - 1])} ${b}. Remember to download to save permanently.`;
      $("#f-scoreA").value = 0; $("#f-scoreB").value = 0;
      $("#f-et").checked = false; pkBox.checked = false;
      updateKO();
      renderSession(); refreshAll();
    });

    $("#f-download").addEventListener("click", downloadMatches);
    $("#f-reset").addEventListener("click", () => {
      if (!confirm("Discard all changes made in the browser and reload the saved matches.js file?")) return;
      localStorage.removeItem(LS_KEY);
      MATCHES = (window.MATCHES || []).slice();
      renderSession(); refreshAll();
      msg.className = "form-msg ok"; msg.textContent = "Reverted to saved file.";
    });

    updateKO();
    renderSession();
    return root;
  }

  /* ---------- persistence (browser draft) + export ---------- */

  const LS_KEY = "fwc_matches_draft";
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(MATCHES)); } catch (e) {}
  }
  function loadDraft() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) MATCHES = JSON.parse(raw);
    } catch (e) {}
  }

  function downloadMatches() {
    const header =
`// Match results. This is the single source of truth that drives all standings.
// Generated from the "Add Result" tab. See the original file for field docs.
window.MATCHES = `;
    const body = JSON.stringify(MATCHES, null, 2);
    const blob = new Blob([header + body + ";\n"], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "matches.js";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------- tabs ---------- */

  const TABS = {
    standings: { label: "Standings", render: renderStandings },
    teams:     { label: "Teams", render: renderTeams },
    matches:   { label: "Matches", render: renderMatches },
    add:       { label: "Add Result", render: renderAddResult },
    rules:     { label: "Rules", render: renderRules },
  };
  let current = "standings";

  function refreshAll() {
    // re-render the currently visible tab (and it'll pull fresh MATCHES)
    showTab(current);
  }

  function showTab(key) {
    current = key;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === key));
    const panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(TABS[key].render());
  }

  function init() {
    loadDraft();
    const nav = document.getElementById("tabs");
    Object.entries(TABS).forEach(([key, t]) => {
      const b = el("button", "tab", t.label);
      b.dataset.tab = key;
      b.addEventListener("click", () => showTab(key));
      nav.appendChild(b);
    });
    showTab("standings");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
