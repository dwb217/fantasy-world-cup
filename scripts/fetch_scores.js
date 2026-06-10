#!/usr/bin/env node
/* Pulls 2026 World Cup results from TheSportsDB and writes data/matches.js.
 *
 * - Imports only finished matches.
 * - Maps API team names to our draft names (scripts/team_aliases.js).
 * - Derives extra-time / penalty bonuses from the match status code.
 * - Applies manual corrections from data/overrides.js (shootout winners, etc.).
 * - Preserves any manual matches already in data/matches.js (source !== "thesportsdb").
 *
 * Usage:  node scripts/fetch_scores.js
 * Exit code is 0 even when matches need attention (so CI still commits); see the
 * printed summary for anything that needs a manual override.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { CONFIG } = require("./config");
const { canonicalTeam } = require("./team_aliases");

const ROOT = path.resolve(__dirname, "..");

/* ---------- load browser-style data files (window.X = ...) ---------- */
function loadWindowFile(rel) {
  global.window = global.window || {};
  const file = path.join(ROOT, rel);
  delete require.cache[require.resolve(file)];
  require(file);
  return global.window;
}

/* ---------- HTTP with retry/backoff for 429s ---------- */
async function getJson(url) {
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "fantasy-world-cup/1.0" } });
    if (res.status === 429) {
      const wait = 2000 * attempt;
      console.warn(`  rate-limited (429); waiting ${wait}ms…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error(`giving up after ${CONFIG.maxRetries} attempts: ${url}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- classify a match status ---------- */
function isFinished(ev) {
  const status = (ev.strStatus || "").trim();
  const hasScores = ev.intHomeScore != null && ev.intHomeScore !== "" &&
                    ev.intAwayScore != null && ev.intAwayScore !== "";
  if (!hasScores) return false;
  if (CONFIG.finishedStatuses.has(status)) return true;
  // Scores present and not in a known pending/live state → treat as final.
  return !CONFIG.pendingStatuses.has(status);
}

/* ---------- discover round numbers actually in use this season ----------
   TheSportsDB's knockout round numbering is unpredictable (2022 put the Round
   of 16 under intRound=16, not 125), so beyond the configured guesses we ask
   the "next events" and "past events" endpoints what round numbers real
   fixtures carry, and fetch those rounds too. */
async function discoverRounds() {
  const found = new Set();
  for (const ep of ["eventsnextleague.php", "eventspastleague.php"]) {
    try {
      const data = await getJson(`${CONFIG.base}/${CONFIG.apiKey}/${ep}?id=${CONFIG.leagueId}`);
      for (const ev of data.events || []) {
        if (ev.strSeason && String(ev.strSeason) !== String(CONFIG.season)) continue;
        const r = Number(ev.intRound);
        if (Number.isInteger(r) && r > 0) found.add(r);
      }
    } catch (e) {
      console.warn(`${ep}: request failed (${e.message})`);
    }
    await sleep(CONFIG.reqDelayMs);
  }
  return found;
}

// Knockout label from the official 2026 calendar (round numbers are unreliable).
function knockoutLabelByDate(date) {
  for (const w of CONFIG.knockoutWindows || []) {
    if (date && date >= w.from && date <= w.to) return w.label;
  }
  return null;
}

async function main() {
  const win = loadWindowFile("data/draft.js");
  loadWindowFile("data/overrides.js");
  const DRAFT = win.DRAFT || {};
  const OVERRIDES = win.OVERRIDES || { byEventId: {}, manualMatches: [] };

  const DRAFT_TEAMS = new Set();
  for (const m of Object.keys(DRAFT)) for (const t of DRAFT[m]) DRAFT_TEAMS.add(t);

  const warnings = { unmapped: new Set(), needsReview: [] };

  /* ---- fetch every configured + discovered round ---- */
  const discovered = await discoverRounds();
  const extraRounds = [...discovered].filter((r) => !CONFIG.requestRounds.includes(r));
  if (extraRounds.length) {
    console.log(`discovered round number(s) in use beyond the configured list: ${extraRounds.join(", ")}`);
  }
  const rounds = [...new Set([...CONFIG.requestRounds, ...discovered])].sort((a, b) => a - b);

  const apiMatches = [];
  const seenEventIds = new Set();
  for (const r of rounds) {
    const url = `${CONFIG.base}/${CONFIG.apiKey}/eventsround.php?id=${CONFIG.leagueId}&s=${CONFIG.season}&r=${r}`;
    let data;
    try {
      data = await getJson(url);
    } catch (e) {
      console.warn(`round ${r}: request failed (${e.message})`);
      await sleep(CONFIG.reqDelayMs);
      continue;
    }
    const events = data.events || [];
    if (!events.length) { await sleep(CONFIG.reqDelayMs); continue; }

    const isGroup = CONFIG.groupRounds.has(r);
    const stage = isGroup ? "group" : "knockout";

    let finished = 0;
    for (const ev of events) {
      if (seenEventIds.has(ev.idEvent)) continue; // same event listed under two rounds
      if (!isFinished(ev)) continue;
      finished++;
      seenEventIds.add(ev.idEvent);

      const roundLabel = isGroup
        ? (CONFIG.roundLabels[r] || `Matchday ${r}`)
        : (knockoutLabelByDate(ev.dateEvent) || CONFIG.roundLabels[r] || `Knockout (round ${r})`);

      const teamA = canonicalTeam(ev.strHomeTeam);
      const teamB = canonicalTeam(ev.strAwayTeam);
      if (!DRAFT_TEAMS.has(teamA)) warnings.unmapped.add(`${ev.strHomeTeam} (home)`);
      if (!DRAFT_TEAMS.has(teamB)) warnings.unmapped.add(`${ev.strAwayTeam} (away)`);

      const status = (ev.strStatus || "").trim();
      const scoreA = Number(ev.intHomeScore);
      const scoreB = Number(ev.intAwayScore);

      const match = {
        id: Number(ev.idEvent),
        eventId: String(ev.idEvent),
        source: "thesportsdb",
        date: ev.dateEvent || "",
        stage,
        round: r,
        roundLabel,
        teamA, teamB,
        scoreA, scoreB,
        extraTime: status === "AET" || status === "AP",
        penalties: status === "AP",
        shootoutWinner: null,
      };

      // A level knockout score means the game went to extra time AND a
      // shootout by definition, even when the API's status flag fails to say
      // so (verified to happen: 2022 Croatia–Brazil was marked plain FT).
      if (match.stage === "knockout" && match.scoreA === match.scoreB) {
        match.extraTime = true;
        match.penalties = true;
      }

      // Apply manual override for this event, if any.
      const ov = OVERRIDES.byEventId && OVERRIDES.byEventId[match.eventId];
      if (ov) Object.assign(match, ov);

      // A level knockout match needs a shootout winner we can't get from the API.
      if (match.stage === "knockout" && match.scoreA === match.scoreB && !match.shootoutWinner) {
        warnings.needsReview.push({
          eventId: match.eventId,
          label: `${teamA} ${scoreA}–${scoreB} ${teamB} (${roundLabel}, ${match.date})`,
        });
      }

      apiMatches.push(match);
    }
    console.log(`round ${r} (${stage}): ${events.length} events, ${finished} finished`);
    await sleep(CONFIG.reqDelayMs);
  }

  /* ---- merge with existing manual matches + override-only manual matches ---- */
  let existing = [];
  try { existing = (loadWindowFile("data/matches.js").MATCHES || []).slice(); } catch (e) {}
  const manualExisting = existing.filter((m) => m.source !== "thesportsdb");
  const manualFromOverrides = (OVERRIDES.manualMatches || []).map((m) => ({ source: "manual", ...m }));

  // De-dupe manual matches against API matches by date + team pair (order-insensitive).
  const apiKeys = new Set(apiMatches.map(keyOf));
  const manual = [...manualFromOverrides, ...manualExisting].filter((m) => !apiKeys.has(keyOf(m)));

  const all = [...apiMatches, ...manual];
  all.sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) ||
    (a.round || 0) - (b.round || 0) ||
    (a.id || 0) - (b.id || 0)
  );

  // Only rewrite the file when the match data actually changed. This keeps the
  // "results updated" timestamp meaningful and avoids an empty commit every run.
  const changed = JSON.stringify(all) !== JSON.stringify(existing);
  if (changed) {
    writeMatches(all, new Date().toISOString());
    console.log(`\nWrote data/matches.js: ${all.length} matches (${apiMatches.length} from API, ${manual.length} manual).`);
  } else {
    console.log(`\nNo change in match data — file left untouched (${all.length} matches).`);
  }

  /* ---- report ---- */
  if (warnings.unmapped.size) {
    console.warn(`\n⚠ Unmapped team names (add to scripts/team_aliases.js):`);
    for (const t of warnings.unmapped) console.warn(`   - ${t}`);
  }
  if (warnings.needsReview.length) {
    console.warn(`\n⚠ ${warnings.needsReview.length} level knockout match(es) need a shootout winner.`);
    console.warn(`  Add each to data/overrides.js under byEventId, e.g. "${warnings.needsReview[0].eventId}": { shootoutWinner: "Team" }`);
    for (const w of warnings.needsReview) console.warn(`   - eventId ${w.eventId}: ${w.label}`);
  }
  if (!warnings.unmapped.size && !warnings.needsReview.length) {
    console.log("\n✓ No issues needing attention.");
  }
}

function keyOf(m) {
  const a = canonicalTeam(m.teamA), b = canonicalTeam(m.teamB);
  const pair = [a, b].sort().join("|");
  return `${m.date}|${pair}`;
}

function writeMatches(matches, generatedAt) {
  const header =
`// AUTO-GENERATED by scripts/fetch_scores.js — do not hand-edit API matches here;
// they are overwritten on every run. To CORRECT a match (e.g. a shootout winner)
// edit data/overrides.js. Manual matches (source:"manual") are preserved.
window.MATCHES_GENERATED_AT = ${JSON.stringify(generatedAt)};
window.MATCHES = `;
  const body = JSON.stringify(matches, null, 2);
  fs.writeFileSync(path.join(ROOT, "data/matches.js"), header + body + ";\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
