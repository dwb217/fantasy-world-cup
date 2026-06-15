#!/usr/bin/env node
/* Prints "true" when hitting TheSportsDB is worth it right now — i.e. some
   match without a final score may have just finished — and "false" otherwise.
   The update-scores workflow runs this before fetch_scores.js so it can poll
   every few minutes without burning API calls between match days.

   Diagnostics go to stderr; stdout stays machine-readable (true/false). */
"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..");
global.window = global.window || {};
require(path.join(ROOT, "data/matches.js"));
const MATCHES = global.window.MATCHES || [];

const EARLIEST_FT_MIN = 120; // start polling 2h after kickoff (the workflow then
                             // retries every 20 min until the final score lands)
const GIVE_UP_HOURS = 7;     // past this, leave the game to the daily refresh

const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
const yesterday = new Date(now - 24 * 3600 * 1000).toISOString().slice(0, 10);

const reasons = [];
for (const m of MATCHES) {
  const hasResult = Number.isFinite(m.scoreA) && Number.isFinite(m.scoreB);
  if (hasResult) continue;

  const ko = m.kickoff ? Date.parse(m.kickoff) : NaN;
  if (Number.isFinite(ko)) {
    const minsAgo = (now - ko) / 60000;
    if (minsAgo >= EARLIEST_FT_MIN && minsAgo <= GIVE_UP_HOURS * 60) {
      reasons.push(`${m.teamA}–${m.teamB} kicked off ${Math.round(minsAgo)} min ago`);
    }
  } else if (m.date === today || m.date === yesterday) {
    // No kickoff time on record (data predating the kickoff field, or a manual
    // entry): poll for the whole match day rather than risk missing the result.
    reasons.push(`${m.teamA}–${m.teamB} (${m.date}) has no kickoff time on record`);
  }
}

if (reasons.length) {
  console.error(`Fetch worthwhile:\n  - ${reasons.join("\n  - ")}`);
  console.log("true");
} else {
  console.error("No unscored match in its post-game window — skipping API fetch.");
  console.log("false");
}
