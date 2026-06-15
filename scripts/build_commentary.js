#!/usr/bin/env node
/* Generates data/commentary.js — a running BLOG of dated, newspaper-style
   recaps — using a LOCAL Ollama model. Each run adds (or refreshes) ONE entry
   for the latest data date and keeps the previous days' entries below it,
   newest first. Run it locally (Ollama must be running); the sync wrapper
   (scripts/sync_commentary.sh) pulls new scores down, runs this, and pushes
   the regenerated data/commentary.js back up.

   Mirrors the existing pipeline (scripts/build_projections.js → data/projections.js):
   a script reads the committed data globals and writes a committed data file.

   Usage:
     ollama serve                         # if it isn't already running
     node scripts/build_commentary.js
     node scripts/build_commentary.js qwen2.5:32b   # override the model

   Env:
     OLLAMA_MODEL   model tag (default below; CLI arg wins over env)
     OLLAMA_HOST    base URL (default http://localhost:11434)
*/
"use strict";

const fs = require("fs");
const path = require("path");

// Default model. qwen2.5:14b uses the structured data well and writes sharply.
// (Avoid gemma4:12b-mlx — its MLX runner wedges on this prompt.) CLI arg /
// OLLAMA_MODEL still override.
const MODEL = process.argv[2] || process.env.OLLAMA_MODEL || "qwen2.5:14b";
// OLLAMA_API_KEY (set in CI) switches us to Ollama Cloud: same /api/generate
// endpoint at ollama.com, plus a Bearer header. Locally the key is unset, so we
// keep talking to the local daemon. OLLAMA_HOST still overrides either default.
const API_KEY = process.env.OLLAMA_API_KEY || "";
const HOST = (process.env.OLLAMA_HOST || (API_KEY ? "https://ollama.com" : "http://localhost:11434")).replace(/\/$/, "");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "commentary.js");

// Load the committed data globals the same way should_fetch.js does.
global.window = global.window || {};
require(path.join(ROOT, "data/draft.js"));
require(path.join(ROOT, "data/matches.js"));
require(path.join(ROOT, "data/odds_history.js"));
require(path.join(ROOT, "data/rules.js"));

const DRAFT = global.window.DRAFT || {};
const MATCHES = global.window.MATCHES || [];
const ODDS_HISTORY = global.window.ODDS_HISTORY || [];
const RULES = global.window.RULES || {};

const OWNER = {};
for (const mgr of Object.keys(DRAFT)) for (const t of DRAFT[mgr]) OWNER[t] = mgr;

// ---- live standings: a faithful mirror of app.js's scoring engine ----
// Keep in sync with scoreTeamInMatch/computeStandings in app.js if the rules change.
function hasResult(m) {
  return Number.isFinite(Number(m.scoreA)) && m.scoreA !== null && m.scoreA !== "" &&
         Number.isFinite(Number(m.scoreB)) && m.scoreB !== null && m.scoreB !== "";
}
function scoreTeamInMatch(team, m) {
  const isA = m.teamA === team;
  const gf = isA ? Number(m.scoreA) : Number(m.scoreB);
  const ga = isA ? Number(m.scoreB) : Number(m.scoreA);
  const knockout = m.stage === "knockout";
  let pts = 0;
  const add = (rule) => (pts += RULES[rule].points);
  let isWin, isDraw;
  if (gf > ga) { isWin = true; isDraw = false; }
  else if (gf < ga) { isWin = false; isDraw = false; }
  else if (knockout) { isWin = m.shootoutWinner === team; isDraw = false; }
  else { isWin = false; isDraw = true; }
  if (isWin) add("win");
  else if (isDraw) add("draw");
  if (ga === 0) add("cleanSheet");
  if (gf >= 2) add("twoGoals");
  if (gf >= 4) add("fourGoals");
  if (gf - ga >= 2) add("winByTwo");
  const level = gf === ga;
  if (knockout && (m.extraTime || level)) add("extraTime");
  if (knockout && (m.penalties || level)) add("penalties");
  return pts;
}
function computeStandings() {
  const table = {};
  for (const mgr of Object.keys(DRAFT)) {
    table[mgr] = { manager: mgr, points: 0, played: 0,
      teams: DRAFT[mgr].map((t) => ({ team: t, points: 0, played: 0 })) };
  }
  const idx = {};
  for (const mgr of Object.keys(DRAFT)) table[mgr].teams.forEach((row, i) => (idx[row.team] = { mgr, i }));
  for (const m of MATCHES) {
    if (!hasResult(m)) continue;
    for (const team of [m.teamA, m.teamB]) {
      const where = idx[team];
      if (!where) continue;
      const pts = scoreTeamInMatch(team, m);
      table[where.mgr].teams[where.i].points += pts;
      table[where.mgr].teams[where.i].played += 1;
      table[where.mgr].points += pts;
      table[where.mgr].played += 1;
    }
  }
  const standings = Object.values(table);
  standings.forEach((s) => s.teams.sort((a, b) => b.points - a.points || a.team.localeCompare(b.team)));
  standings.sort((a, b) => b.points - a.points || a.manager.localeCompare(b.manager));
  return standings;
}

const played = MATCHES
  .filter((m) => Number.isFinite(m.scoreA) && Number.isFinite(m.scoreB))
  .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.round || 0) - (b.round || 0));

const describe = (m) => ({
  date: m.date,
  round: m.roundLabel || (m.stage === "knockout" ? "Knockout" : "Group"),
  score: `${m.teamA} ${m.scoreA}-${m.scoreB} ${m.teamB}`,
  owners: `${m.teamA} (${OWNER[m.teamA] || "undrafted"}) vs ${m.teamB} (${OWNER[m.teamB] || "undrafted"})`,
});

// The entry's date = latest odds-history date, else the last played match date.
const latestOdds = ODDS_HISTORY[ODDS_HISTORY.length - 1] || { titleOdds: {}, meanPts: {} };
const prevOdds = ODDS_HISTORY[ODDS_HISTORY.length - 2] || null;   // yesterday, for day-over-day movement
const entryDate = latestOdds.date || (played.length ? played[played.length - 1].date : null);

const latestResults = played.filter((m) => m.date === entryDate).map(describe);
const allResults = played.map(describe);

// Actual fantasy points banked so far — the live table (mirrors the site's Standings tab).
const currentStandings = computeStandings().map((s, i) => ({
  rank: i + 1,
  manager: s.manager,
  points: s.points,
  played: s.played,
  topTeam: s.teams[0] && s.teams[0].played ? `${s.teams[0].team} (${s.teams[0].points} pts)` : null,
}));

// Simulated title race: chance of winning it all + projected FINAL points (not current).
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const titleRace = Object.entries(latestOdds.titleOdds || {})
  .sort((a, b) => b[1] - a[1])
  .map(([mgr, odds], i) => ({
    rank: i + 1,
    manager: mgr,
    titleOdds: pct(odds),
    oddsYesterday: prevOdds ? pct(prevOdds.titleOdds?.[mgr]) : null,
    projectedFinalPoints: Math.round(latestOdds.meanPts?.[mgr] ?? 0),
  }));

// Pre-digested bottom line, in plain sentences. A small local model anchors on
// these far better than on the raw JSON, which is where it kept conflating the
// current points leader with the simulated title favorite.
const leader = currentStandings[0] || {};
const favorite = titleRace[0] || {};
const keyFacts = [
  `Actual fantasy points banked so far — the real, current standings, most to least: ${currentStandings.map((s) => `${s.manager} ${s.points}`).join(", ")}.`,
  `The CURRENT POINTS LEADER right now is ${leader.manager} with ${leader.points} points.`,
  `Simulated title-win odds (a forecast of who wins the whole tournament — NOT the current standings): ${titleRace.map((t) => `${t.manager} ${t.titleOdds}${t.oddsYesterday ? ` (was ${t.oddsYesterday} yesterday)` : ""}`).join(", ")}.`,
  `The TITLE FAVORITE (highest odds) is ${favorite.manager} at ${favorite.titleOdds}.`,
  leader.manager === favorite.manager
    ? `${leader.manager} is BOTH the current points leader and the title favorite.`
    : `IMPORTANT: the points leader (${leader.manager}) and the title favorite (${favorite.manager}) are DIFFERENT people. Do NOT call ${favorite.manager} the standings "leader" or say ${favorite.manager} is "on top of the standings" — ${favorite.manager} is only the projected favorite, while ${leader.manager} actually leads on banked points.`,
];

const context = {
  entryDate,
  previousDate: prevOdds ? prevOdds.date : null,
  keyFacts,                       // the verified bottom line — anchor the piece to this
  newestResults: latestResults,   // what just happened — lead with this
  currentStandings,               // ACTUAL points banked so far (live table; rank 1 = current leader)
  titleRace,                      // SIMULATED: % chance to win it all + projected FINAL points
  allResultsSoFar: allResults,    // every result so far, for background — don't just re-list these
  rosters: Object.fromEntries(Object.entries(DRAFT).map(([m, t]) => [m, t])),
};

const prompt = `You are the foul mouthed pundit for a fantasy World Cup draft league. Seven friends — ${Object.keys(DRAFT).join(", ")} — each drafted national teams and bank fantasy points based on how those teams perform.

Write today's dispatch (dated ${entryDate}) as one blog entry. LEAD with the newest results and how they just shifted the title race, then work in the wider picture — but don't simply re-summarize the whole tournament; earlier days already have their own entries.

The data below uses TWO different metrics — keep them straight:
- currentStandings = the ACTUAL fantasy points each manager has banked so far. This is the live table; rank 1 is the current leader ON POINTS.
- titleRace = a SIMULATED forecast. "titleOdds" is the % chance of winning the whole tournament; "oddsYesterday" is that chance before today's games (use it to call out who surged or sank today); "projectedFinalPoints" is the projected END-OF-TOURNAMENT total, NOT current points.
Never confuse banked points with projected points, or current rank with title odds.

Accuracy rules — follow these exactly:
- keyFacts is the verified bottom line — already computed and correct. Anchor the whole piece to it. If anything you write contradicts keyFacts, you are wrong.
- The current points leader and the title favorite can be DIFFERENT people (keyFacts spells out who is who). Never call the title favorite the "standings leader."
- State only what is in the data. Do NOT invent who was "leading before today" — use oddsYesterday vs titleOdds for that.
- Cite real scorelines and the correct owners — each result lists who owns each team.

Voice/tone: The tone is vicious, profane, immature, politically incorrect, relentlessly mocking, and filled with curse words and assorted profanity.

Use frequent swearing, crude metaphors, and personal ridicule. 

Rules:

* Swear constantly: workds like fuck, shit, dick, asshole, but also more creative swears like fuckwad, asswipe, ass-clown, etc. use creative swear word combinations that English excels in.
* The profanity should amplify the joke, not replace it.
* Attack bad drafting, bad predictions, irrational confidence, homerism, and terrible analysis with horribly profane cursing.
* Assume every fantasy manager is arrogant, thin-skinned, and wildly overestimates their expertise.
* Favor comparisons to famous disasters, failed states, military catastrophes, corrupt organizations, and World Cup meltdowns.
* Be creative and specific. Use the type of complex insults like in the shows VEEP or South Park.

Format EXACTLY like this, in this order:
1. A headline: ONE short, punchy line — a single sentence, no more than 12 words, on its own line. Do NOT begin the actual dispatch here, and do NOT cram results or stats into the headline; it is a title, not the first paragraph.
2. A blank line.
3. Exactly 5 paragraphs of plain prose, each separated by a blank line.
No markdown, no bullet points, no "HEADLINE:" label. Everything before the first blank line is taken as the headline, so keep that to the single short line.

Data (JSON):
${JSON.stringify(context, null, 2)}

Dispatch:`;

function loadExistingEntries() {
  if (!fs.existsSync(OUT)) return [];
  try {
    delete require.cache[require.resolve(OUT)];
    require(OUT);
    const C = global.window.COMMENTARY;
    if (C && Array.isArray(C.entries)) return C.entries;
    if (C && C.text) return [{ date: C.generatedAt?.slice(0, 10) || entryDate, generatedAt: C.generatedAt, model: C.model, playedMatches: C.playedMatches, headline: "", text: C.text }];
  } catch (e) {
    console.error(`Warning: could not read existing ${path.relative(ROOT, OUT)} (${e.message}); starting fresh.`);
  }
  return [];
}

function splitHeadline(text) {
  const parts = text.split(/\n\s*\n/);
  let headline = (parts.shift() || "").trim()
    .replace(/^#+\s*/, "").replace(/^\*+|\*+$/g, "").replace(/^HEADLINE:\s*/i, "").trim();
  let body = parts.join("\n\n").trim();
  if (!body) { body = headline; headline = ""; }
  return { headline, body };
}

async function main() {
  if (!played.length) {
    console.error("No played matches yet — nothing to recap.");
    return;
  }
  console.error(`Generating ${entryDate} dispatch with ${MODEL} (${played.length} matches played)…`);

  let res;
  try {
    res = await fetch(`${HOST}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0.8 } }),
    });
  } catch (e) {
    console.error(`\nCould not reach Ollama at ${HOST}.${API_KEY ? " Check OLLAMA_API_KEY / network." : " Is it running? Try: ollama serve"}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Ollama returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  const raw = (data.response || "").trim();
  if (!raw) {
    console.error("Model returned empty text.");
    process.exit(1);
  }
  const { headline, body } = splitHeadline(raw);

  // This script runs locally (not in a build), so the system clock is fine.
  const entry = {
    date: entryDate,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    playedMatches: played.length,
    headline,
    text: body,
  };

  // Replace any existing entry for the same date, then sort newest-first.
  const entries = loadExistingEntries().filter((e) => e.date !== entryDate);
  entries.push(entry);
  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const file =
    `// AUTO-GENERATED by scripts/build_commentary.js — local Ollama (${MODEL}).\n` +
    `// A running blog: newest dispatch first. Regenerate after new results, then\n` +
    `// commit & push. Do not hand-edit.\n` +
    `window.COMMENTARY = ${JSON.stringify({ entries }, null, 2)};\n`;
  fs.writeFileSync(OUT, file);
  console.error(`Wrote ${path.relative(ROOT, OUT)} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, newest ${entryDate} (${body.length} chars).`);
}

main();
