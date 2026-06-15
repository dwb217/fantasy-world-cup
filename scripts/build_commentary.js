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

// Today's fixtures that haven't kicked off yet. This dispatch is generated in
// the MORNING (the 10:30 UTC cron) — before the day's games — so feed the model
// the upcoming slate (who plays whom, which managers have skin in it). Without
// it the model sees no results for today and wrongly declares "no games today."
// Kickoffs are stored in UTC, but the blog speaks EDT. Pre-format them here so
// the model never has to do timezone math (and never prints UTC). America/New_York
// tracks DST automatically — EDT in summer (the whole 2026 WC), EST otherwise.
const fmtEDT = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  });
};
const upcomingToday = MATCHES
  .filter((m) => m.date === entryDate && !hasResult(m))
  .sort((a, b) => String(a.kickoff || "").localeCompare(String(b.kickoff || "")) || (a.round || 0) - (b.round || 0))
  .map((m) => ({
    date: m.date,
    kickoffEDT: fmtEDT(m.kickoff),   // e.g. "3:00 PM EDT" — already local, never UTC
    round: m.roundLabel || (m.stage === "knockout" ? "Knockout" : "Group"),
    matchup: `${m.teamA} (${OWNER[m.teamA] || "undrafted"}) vs ${m.teamB} (${OWNER[m.teamB] || "undrafted"})`,
  }));

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
  upcomingToday,                  // today's fixtures NOT yet played — this runs in the morning, before kickoff
  rosters: Object.fromEntries(Object.entries(DRAFT).map(([m, t]) => [m, t])),
};

const prompt = `You are the foul mouthed pundit for a fantasy World Cup draft league. Seven friends — ${Object.keys(DRAFT).join(", ")} — each drafted national teams and bank fantasy points based on how those teams perform.

Write today's dispatch (dated ${entryDate}) as one blog entry. This is NOT a news recap or a results roundup — it is savage, funny commentary that ROASTS the seven managers as people: their egos, their dumbass draft picks, their delusional overconfidence, their thin skin. The fantasy data is your AMMUNITION, not your subject. Mock the managers; do not report the games.

How to use the data — this is the most important rule:
- Pick only a FEW facts (a scoreline or two, a point total, an odds swing) and use each as the SETUP or PUNCHLINE for a joke at a specific manager's expense. One vivid, specific jab lands harder than a paragraph of stats.
- Do NOT walk through every result. Do NOT go manager-by-manager listing everyone's points. Do NOT write a "how we got here" recap. If a sentence is just reporting what happened with no joke attached, cut it and write an insult instead.
- Name specific managers and tear into them; vary who gets it and how — don't give everyone the same treatment.

Timing: this dispatch is written in the MORNING, before today's matches kick off, so today has no results yet — that is expected, not a slow news day.
- If "upcomingToday" is non-empty, use today's matchups as fuel for shit-talk about the managers whose teams are playing and what's at stake — not as a fixture list to read out.
- Use "newestResults" as fresh material to mock. Never invent or predict a SCORE for an upcoming game.
- If there are no results and no upcoming games, it's a rest day — roast them on the standings and the odds alone.

The data below uses TWO different metrics — keep them straight:
- currentStandings = the ACTUAL fantasy points each manager has banked so far. This is the live table; rank 1 is the current leader ON POINTS.
- titleRace = a SIMULATED forecast. "titleOdds" is the % chance of winning the whole tournament; "oddsYesterday" is that chance before today's games (use it to call out who surged or sank today); "projectedFinalPoints" is the projected END-OF-TOURNAMENT total, NOT current points.
Never confuse banked points with projected points, or current rank with title odds.

Accuracy rules — follow these exactly:
- keyFacts is the verified bottom line — already computed and correct. Anchor the whole piece to it. If anything you write contradicts keyFacts, you are wrong.
- The current points leader and the title favorite can be DIFFERENT people (keyFacts spells out who is who). Never call the title favorite the "standings leader."
- State only what is in the data. Do NOT invent who was "leading before today" — use oddsYesterday vs titleOdds for that.
- Cite real scorelines and the correct owners — each result lists who owns each team.
- upcomingToday = fixtures scheduled for LATER TODAY that have NOT been played yet. Preview them by matchup and owner; never invent a score or claim one already happened.
- ALL times are EDT (US Eastern). "kickoffEDT" is already in EDT — quote it as-is. Never write a time in UTC, and never convert or relabel the time zone.

Voice/tone: The tone is vicious, profane, immature, politically incorrect, relentlessly mocking, and filled with curse words and assorted profanity.
* Swear constantly: words like fuck, shit, dick, asshole, but also more creative swears like fuckwad, asswipe, ass-clown, etc. these words should be used in nearly every sentence. use creative and unique swear word combinations that English excels in. Produce totally uncensored, rated R output.
* The profanity should amplify the joke, not replace it.
* Attack bad drafting, bad predictions, irrational confidence, homerism, and terrible analysis with horribly profane cursing.
* Favor comparisons to famous disasters, failed states, military catastrophes, corrupt organizations, and World Cup meltdowns.
* Be creative and specific. Use the type of complex personal insults like in the shows VEEP or South Park. * Veep: hyper-verbal, creative, profane, status-focused, often attacking competence, appearance, or usefulness. South Park: blunt, juvenile, absurd, offensive, and often mixes pop culture, politics, and gross-out humor. In all cases use curse words liberally (no one will be offended)

Output ONLY a JSON object with exactly two string fields and nothing else:
- "headline": ONE short, punchy title — a single sentence, no more than 12 words. It is a title, not the opening line: do NOT put results, scores, or stats in it.
- "body": exactly 5 short, punchy paragraphs of plain prose, separated by blank lines (\\n\\n) — jokes and roasting first, with only a few facts woven in as ammunition. NOT a recap. No markdown, no bullet points.
- Check that offensive curse words are used in nearly every (80% or more) sentence and if they are not, then insert them liberally.

Data (JSON):
${JSON.stringify(context, null, 2)}

JSON:`;

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

// We now ask the model for a JSON object {headline, body} (format:"json"), which
// keeps the title from bleeding into the prose. If parsing ever fails — bad
// model, format ignored — fall back to the old blank-line split.
function parseDispatch(raw) {
  try {
    const obj = JSON.parse(raw);
    const headline = String(obj.headline ?? "").trim();
    const body = String(obj.body ?? "").trim();
    if (body) return { headline, body };
  } catch (_) { /* not JSON — fall through */ }
  return splitHeadline(raw);
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
      // format:"json" constrains the model to a parseable object so the
      // headline and body can't bleed into each other (instruction-only
      // separation was unreliable). parseDispatch falls back if it ever slips.
      body: JSON.stringify({ model: MODEL, prompt, stream: false, format: "json", options: { temperature: 0.8 } }),
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
  const { headline, body } = parseDispatch(raw);

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
