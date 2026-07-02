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
const crypto = require("crypto");

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
require(path.join(ROOT, "data/prices.js"));

const DRAFT = global.window.DRAFT || {};
const MATCHES = global.window.MATCHES || [];
const ODDS_HISTORY = global.window.ODDS_HISTORY || [];
const RULES = global.window.RULES || {};
const PRICES = global.window.PRICES || {};

const OWNER = {};
for (const mgr of Object.keys(DRAFT)) for (const t of DRAFT[mgr]) OWNER[t] = mgr;

// ---- live standings: a faithful mirror of app.js's scoring engine ----
// Keep in sync with scoreTeamInMatch/computeStandings in app.js if the rules change.
function hasResult(m) {
  return Number.isFinite(Number(m.scoreA)) && m.scoreA !== null && m.scoreA !== "" &&
         Number.isFinite(Number(m.scoreB)) && m.scoreB !== null && m.scoreB !== "";
}
// Who advanced from a knockout tie (mirrors app.js): recorded shootout winner,
// else the higher score, else — for a level tie with no winner recorded — the
// team that turns up in the next round's draw.
const KO_ROUNDS = ["Round of 32", "Round of 16", "Quarter-Final", "Semi-Final", "Final"];
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
  else if (knockout) { isWin = koAdvancer(m) === team; isDraw = false; }
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
  // Kyle's draft-mistake bonus (mirrors app.js): round(7 × league-wide points
  // per dollar so far), added to his total.
  let totPts = 0, totPrice = 0;
  for (const s of Object.values(table)) for (const row of s.teams) { totPts += row.points; totPrice += PRICES[row.team] || 0; }
  if (table.KYLE && totPrice > 0) table.KYLE.points += Math.round(7 * (totPts / totPrice));

  const standings = Object.values(table);
  standings.forEach((s) => s.teams.sort((a, b) => b.points - a.points || a.team.localeCompare(b.team)));
  standings.sort((a, b) => b.points - a.points || a.manager.localeCompare(b.manager));
  return standings;
}

const played = MATCHES
  .filter((m) => Number.isFinite(m.scoreA) && Number.isFinite(m.scoreB))
  .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.round || 0) - (b.round || 0));

const describe = (m) => {
  const level = Number(m.scoreA) === Number(m.scoreB);
  const d = {
    date: m.date,
    round: m.roundLabel || (m.stage === "knockout" ? "Knockout" : "Group"),
    score: `${m.teamA} ${m.scoreA}-${m.scoreB} ${m.teamB}`,
    owners: `${m.teamA} (${OWNER[m.teamA] || "undrafted"}) vs ${m.teamB} (${OWNER[m.teamB] || "undrafted"})`,
  };
  // Spell out the result so the model never misstates it — especially who went
  // through a level knockout tie on penalties.
  if (m.stage === "knockout") {
    const adv = koAdvancer(m);
    d.outcome = adv ? `${adv} (${OWNER[adv] || "undrafted"}) advanced${level ? " on penalties" : ""}` : "advancer not yet decided";
  } else if (level) {
    d.outcome = "draw";
  } else {
    const w = Number(m.scoreA) > Number(m.scoreB) ? m.teamA : m.teamB;
    d.outcome = `${w} (${OWNER[w] || "undrafted"}) won`;
  }
  return d;
};

// The entry's date = latest odds-history date, else the last played match date.
const latestOdds = ODDS_HISTORY[ODDS_HISTORY.length - 1] || { titleOdds: {}, meanPts: {} };
const prevOdds = ODDS_HISTORY[ODDS_HISTORY.length - 2] || null;   // yesterday, for day-over-day movement
const entryDate = latestOdds.date || (played.length ? played[played.length - 1].date : null);

// Most recent RESULTS: the latest date that actually has played games. This
// dispatch is written in the MORNING (10:30 UTC cron), so today's games usually
// haven't kicked off yet — "what just happened" is the previous game day, not
// entryDate. Pulling entryDate-only here left the model with no results to be
// precise about.
const lastResultDate = played.length ? played[played.length - 1].date : null;
const recentResults = played.filter((m) => m.date === lastResultDate).map(describe);

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
// NEXT fixtures: the upcoming (unplayed, real) games on the next 1–2 scheduled
// dates from entryDate onward — so the model can preview who plays whom TODAY
// and the NEXT DAY, not just leftover games that happen to share today's date.
const upcomingSorted = MATCHES
  .filter((m) => !hasResult(m) && m.teamA && m.teamB && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
    String(a.kickoff || "").localeCompare(String(b.kickoff || "")) || (a.round || 0) - (b.round || 0));
const nextDates = [...new Set(upcomingSorted.map((m) => m.date))].filter((d) => d >= entryDate).slice(0, 2);
const nextFixtures = upcomingSorted
  .filter((m) => nextDates.includes(m.date))
  .map((m) => ({
    date: m.date,
    kickoffEDT: fmtEDT(m.kickoff),   // e.g. "3:00 PM EDT" — already local, never UTC
    round: m.roundLabel || (m.stage === "knockout" ? "Knockout" : "Group"),
    matchup: `${m.teamA} (${OWNER[m.teamA] || "undrafted"}) vs ${m.teamB} (${OWNER[m.teamB] || "undrafted"})`,
  }));

// Each manager's OWN upcoming games, stated from his side ("your <team> plays
// <opponent> (owner)"), so the model can't mix up which team in a fixture is his
// — the owners in nextFixtures alone weren't enough (managers own many teams).
const nextGameByManager = {};
for (const mgr of Object.keys(DRAFT)) {
  const games = upcomingSorted
    .filter((m) => nextDates.includes(m.date) && (OWNER[m.teamA] === mgr || OWNER[m.teamB] === mgr))
    .map((m) => {
      const mine = OWNER[m.teamA] === mgr ? m.teamA : m.teamB;
      const opp = mine === m.teamA ? m.teamB : m.teamA;
      const bothMine = OWNER[m.teamA] === mgr && OWNER[m.teamB] === mgr;
      return bothMine
        ? `your ${m.teamA} plays your own ${m.teamB} (you own both)${m.kickoff ? " at " + fmtEDT(m.kickoff) : ""} on ${m.date}`
        : `your ${mine} plays ${opp} (${OWNER[opp] || "undrafted"})${m.kickoff ? " at " + fmtEDT(m.kickoff) : ""} on ${m.date}`;
    });
  if (games.length) nextGameByManager[mgr] = games;
}

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

// Recent dispatches (newest first), excluding any existing entry for today's
// date since we're regenerating that one. Feed these to the model so each day's
// piece follows on naturally and doesn't recycle the same jokes, insults, and
// comparisons. loadExistingEntries is a hoisted function declaration, so it's
// safe to call here (it's reused by main() below — no double read needed).
const PREV_FOR_CONTEXT = 3;
const priorEntries = loadExistingEntries();
const recentDispatches = priorEntries
  .filter((e) => e.date !== entryDate)
  .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  .slice(0, PREV_FOR_CONTEXT)
  .map((e) => ({ date: e.date, headline: e.headline || "", text: e.text || "" }));

// ---- the day's "golden boy" ----
// Each dispatch lavishes ONE randomly chosen manager with effusive, sincere
// praise while still gutting the other six. To keep it fresh, the pick must be
// TRULY random AND must exclude anyone praised in the last few days — we read
// the `kindTo` field off recent entries and remove those managers from the
// eligible pool. crypto.randomInt gives an unbiased draw (not Math.random).
const KIND_COOLDOWN_DAYS = 3;
const recentlyPraised = new Set(
  priorEntries
    .filter((e) => e.date !== entryDate)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, KIND_COOLDOWN_DAYS)
    .map((e) => e.kindTo)
    .filter(Boolean),
);
const managers = Object.keys(DRAFT);
let kindPool = managers.filter((m) => !recentlyPraised.has(m));
// Safety net: if the cooldown ever empties the pool (tiny league, gappy data),
// fall back to the full roster so we still pick someone.
if (!kindPool.length) kindPool = managers.slice();
// KIND_TARGET env forces the day's golden boy (case-insensitive), bypassing the
// random pick + cooldown — for manual reruns. Otherwise pick truly at random.
const forcedKind = process.env.KIND_TARGET
  ? managers.find((m) => m.toLowerCase() === process.env.KIND_TARGET.toLowerCase())
  : null;
const kindTarget = forcedKind || kindPool[crypto.randomInt(kindPool.length)];

const context = {
  entryDate,
  previousDate: prevOdds ? prevOdds.date : null,
  keyFacts,                       // the verified bottom line — anchor the piece to this
  recentResults,                  // the most recent game day's results, WITH who won/advanced — what just happened
  currentStandings,               // ACTUAL points banked so far (live table; rank 1 = current leader)
  titleRace,                      // SIMULATED: % chance to win it all + projected FINAL points
  nextFixtures,                   // the next day(s) of unplayed games — who plays whom next, with owners + EDT kickoff
  nextGameByManager,              // per manager: HIS own upcoming game(s), stated from his side — use this for whose team is whose
  recentDispatches,               // your last few entries — for continuity; do NOT repeat their jokes
  rosters: Object.fromEntries(Object.entries(DRAFT).map(([m, t]) => [m, t])),
  kindTarget,                     // the ONE manager to praise effusively today; roast the rest
};

const prompt = `You are the foul mouthed pundit for a fantasy World Cup draft league. Seven friends — ${Object.keys(DRAFT).join(", ")} — each drafted national teams and bank fantasy points based on how those teams perform.

Write today's dispatch (dated ${entryDate}) as one blog entry. This is NOT a news recap or a results roundup — it is savage, funny commentary that ROASTS the seven managers as people: their egos, their dumbass draft picks, their delusional overconfidence, their thin skin. The fantasy data is your AMMUNITION, not your subject. Mock the managers; do not report the games.

How to use the data — this is the most important rule:
- Pick only a FEW facts (a scoreline or two, a point total, an odds swing) and use each as the SETUP or PUNCHLINE for a joke at a specific manager's expense. One vivid, specific jab lands harder than a paragraph of stats.
- Do NOT walk through every result. Do NOT go manager-by-manager listing everyone's points. Do NOT write a "how we got here" recap. If a sentence is just reporting what happened with no joke attached, cut it and write an insult instead.
- Name specific managers and tear into them; vary who gets it and how — don't give everyone the same treatment.

Structure — one short paragraph per manager:
- Write exactly ONE short, punchy paragraph for EACH of the seven managers (${Object.keys(DRAFT).join(", ")}) — EXACTLY ${Object.keys(DRAFT).length} paragraphs total, no more, each one centered on a single manager and naming him. That manager is the subject of his paragraph; you may reference others inside it, but every manager must headline his own paragraph and get roughly the SAME amount of coverage. Nobody hides, nobody hogs the spotlight, don't merge two managers into one paragraph, and never give a manager TWO paragraphs (e.g. a roast plus a separate fixture preview) — recent results AND his next game both go in his ONE paragraph.

Today's golden boy (${kindTarget}) — ONE manager gets the unconditional-girlfriend treatment:
- "kindTarget" names the ONE manager you must be effusively, sincerely NICE to today. Adopt the voice of an unreasonably supportive, doting girlfriend talking about her perfect boyfriend: gushing, warm, defensive, devoted — he can do no wrong and you're a little offended on his behalf that anyone would suggest otherwise.
- Crucially, whenever his teams lose, his picks flop, or his odds tank, it is NEVER his fault. Explain every single problem away by blaming someone else — pin it on one of the other six managers (name them), or on a famous outside scapegoat (a referee, a coach, a star player who choked, a politician, a celebrity, FIFA, the weather, anyone). His losses are always somebody else's sabotage or bad luck, never his doing.
- Lay the praise on thick and sincere — his draft was visionary, his instincts flawless, he's surrounded by idiots dragging him down. NO sarcasm, no backhanded jabs, no "but" aimed at HIM (the "but" always redirects the blame outward).
- Keep being absolutely vicious to the other six. The contrast is the joke: six get savaged, one gets coddled like a golden child.
- Do NOT explain or lampshade that you're "being nice" to him or that he was "chosen" — just dote on him naturally as if he genuinely walks on water.

Timing: this dispatch is written in the MORNING, before today's matches kick off, so today has no results yet — that is expected, not a slow news day.
- "recentResults" is the MOST RECENT game day that finished (often yesterday). Use it as fresh material to mock, and get it EXACTLY right: the score, the owners, and — for knockout ties — who ACTUALLY advanced (see each result's "outcome" field; a 1-1 that went to penalties still has a winner who went through and a loser who's OUT). Never call an advancing team eliminated or vice versa.
- "nextFixtures" is the next slate of unplayed games (today's remaining games and the next day's), each with its date, EDT kickoff, matchup and owners. Use them as fuel for shit-talk about the managers whose teams play next and what's at stake — name the exact opponents and owners; never invent a matchup or predict a SCORE. Weave a manager's next game INTO his single paragraph — do NOT spin it off into a separate preview paragraph or a fixtures list. Each manager still gets exactly ONE paragraph total.
- If there are no recent results and no upcoming games, it's a rest day — roast them on the standings and the odds alone.

Continuity with your previous dispatches:
- "recentDispatches" holds your last few entries (newest first, with their headlines and text). Read them so today reads like the next chapter of the same running blog, not a cold start.
- Do NOT recycle. Do not reuse the jokes, insults, nicknames, metaphors, running bits, or comparisons (e.g. the same "failed state" or "military disaster" gag) that already appear in recentDispatches — find fresh angles and fresh targets. Repeating yourself is lazy hack work and the whole point of seeing these is to AVOID it.
- The headline must be different from every headline in recentDispatches.
- You MAY carry forward genuine storylines — an ongoing collapse, a brewing rivalry, a manager's earlier trash talk coming back to bite them — but advance them with NEW material and call back to the prior beat only when it sharpens the joke.

The data below uses TWO different metrics — keep them straight:
- currentStandings = the ACTUAL fantasy points each manager has banked so far. This is the live table; rank 1 is the current leader ON POINTS.
- titleRace = a SIMULATED forecast. "titleOdds" is the % chance of winning the whole tournament; "oddsYesterday" is that chance before today's games (use it to call out who surged or sank today); "projectedFinalPoints" is the projected END-OF-TOURNAMENT total, NOT current points.
Never confuse banked points with projected points, or current rank with title odds.

Accuracy rules — follow these exactly:
- keyFacts is the verified bottom line — already computed and correct. Anchor the whole piece to it. If anything you write contradicts keyFacts, you are wrong.
- The current points leader and the title favorite can be DIFFERENT people (keyFacts spells out who is who). Never call the title favorite the "standings leader."
- State only what is in the data. Do NOT invent who was "leading before today" — use oddsYesterday vs titleOdds for that.
- Cite real scorelines and the correct owners — each result lists who owns each team, and its "outcome" says who won or advanced. Do not misstate who beat whom.
- nextFixtures = scheduled games that have NOT been played yet (today's remaining + the next day's). Preview them by exact matchup, owners and EDT kickoff; never invent a score or claim one already happened.
- nextGameByManager = each manager's OWN upcoming game(s), phrased from his side ("your <team> plays <opponent> (owner)"). When you tease a manager about his next match, use HIS entry here — it tells you exactly which team is his. Do NOT attribute an opponent's team to him (e.g. don't call the guy who owns Cape Verde an "Argentina" manager just because they play each other).
- ALL times are EDT (US Eastern). "kickoffEDT" is already in EDT — quote it as-is. Never write a time in UTC, and never convert or relabel the time zone.

Voice/tone: The tone is vicious, profane, immature, politically incorrect, relentlessly mocking, and filled with curse words and assorted profanity.
* Swear constantly: every single sentence must have words like fuck, shit, dick, asshole, or more creative swears like fuckwad, asswipe, ass-clown, etc. use creative and unique swear word combinations that English excels in. Every sentence should be totally uncensored, rated R output.
* The profanity should amplify the joke, not replace it.
* Attack bad drafting, bad predictions, irrational confidence, homerism, and terrible analysis with horribly profane cursing.
* Favor comparisons to famous disasters, failed states, military catastrophes, corrupt organizations, and World Cup meltdowns.
* Be creative and specific. Use the type of complex personal vulgar insults like in the shows VEEP or South Park. * Veep: hyper-verbal, creative, profane, status-focused, often attacking competence, appearance, or usefulness. South Park: blunt, juvenile, absurd, offensive, and often mixes pop culture, politics, and gross-out humor. In all cases use curse words liberally (no one will be offended)

Output ONLY a JSON object with exactly two string fields and nothing else:
- "headline": ONE short, punchy title — a single sentence, no more than 12 words. It is a title, not the opening line: do NOT put results, scores, or stats in it.
- "body": exactly ${Object.keys(DRAFT).length} short, punchy paragraphs of plain prose, separated by blank lines (\\n\\n) — ONE paragraph per manager (${Object.keys(DRAFT).join(", ")}), each centered on and naming that manager, in any order you like. Jokes and roasting first, with only a few facts woven in as ammunition. NOT a recap. No markdown, no bullet points. The paragraph about ${kindTarget} is the effusive girlfriend-style one; the other six are savage.
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
    kindTo: kindTarget,   // who got the effusive praise — drives the no-repeat cooldown
    headline,
    text: body,
  };

  // Replace any existing entry for the same date, then sort newest-first.
  // Reuse priorEntries (already loaded above for the prompt) — no second read.
  const entries = priorEntries.filter((e) => e.date !== entryDate);
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
