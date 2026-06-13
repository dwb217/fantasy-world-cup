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

// Default model. gemma4:12b-mlx wedges its MLX runner on this prompt; gemma3:12b
// (standard engine) is reliable. CLI arg / OLLAMA_MODEL still override.
const MODEL = process.argv[2] || process.env.OLLAMA_MODEL || "gemma3:12b";
const HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "commentary.js");

// Load the committed data globals the same way should_fetch.js does.
global.window = global.window || {};
require(path.join(ROOT, "data/draft.js"));
require(path.join(ROOT, "data/matches.js"));
require(path.join(ROOT, "data/odds_history.js"));

const DRAFT = global.window.DRAFT || {};
const MATCHES = global.window.MATCHES || [];
const ODDS_HISTORY = global.window.ODDS_HISTORY || [];

const OWNER = {};
for (const mgr of Object.keys(DRAFT)) for (const t of DRAFT[mgr]) OWNER[t] = mgr;

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
const firstOdds = ODDS_HISTORY[0] || latestOdds;
const entryDate = latestOdds.date || (played.length ? played[played.length - 1].date : null);

const latestResults = played.filter((m) => m.date === entryDate).map(describe);
const allResults = played.map(describe);

const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const titleRace = Object.entries(latestOdds.titleOdds || {})
  .sort((a, b) => b[1] - a[1])
  .map(([mgr, odds]) => ({
    manager: mgr,
    titleOdds: pct(odds),
    sinceStart: `${pct(firstOdds.titleOdds?.[mgr])} → ${pct(odds)}`,
    projectedPoints: Math.round(latestOdds.meanPts?.[mgr] ?? 0),
  }));

const context = {
  entryDate,
  newestResults: latestResults,         // lead with these — that's today's news
  allResultsSoFar: allResults,          // background for the standings picture
  titleRace,                            // current odds + movement since the start
  rosters: Object.fromEntries(Object.entries(DRAFT).map(([m, t]) => [m, t])),
};

const prompt = `You are the resident pundit for a fantasy World Cup draft league. Seven friends — ${Object.keys(DRAFT).join(", ")} — each drafted national teams and score fantasy points from how their teams do.

Write today's dispatch (dated ${entryDate}) as one blog entry. LEAD with the newest results and how they just shifted the title race; you may reference the broader standings for context, but don't simply re-summarize the whole tournament — earlier days already have their own entries. Be specific: name managers, cite real scorelines, call out who surged or sank. Talk serious trash using brutal, vulgar, and insulting language including lots of curse words and lots of creative insults like in the show VEEP or South Park — it's a friendly league amd everyone will find this very funny. No jokes about death or suicide, though. Keep the language funny and hyperbollic.

Format EXACTLY like this: first a punchy one-line headline, then a blank line, then 3-5 paragraphs of plain prose. No markdown, no bullet points, no "HEADLINE:" label.

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0.8 } }),
    });
  } catch (e) {
    console.error(`\nCould not reach Ollama at ${HOST}. Is it running? Try: ollama serve`);
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
