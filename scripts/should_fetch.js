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

const EARLIEST_FT_MIN = 120; // a match needs ~2h from kickoff to reach full time;
                             // start polling then, and the cron retries every 20 min.

const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
const yesterday = new Date(now - 24 * 3600 * 1000).toISOString().slice(0, 10);

// Keep chasing a result for any unscored match dated TODAY or YESTERDAY (UTC).
// Bounding by date instead of "hours since kickoff" is what fixes the midnight
// bug: a game that kicks off late and finishes after 00:00 UTC used to fall out
// of a fixed post-game window while its first hours passed overnight (when the
// scheduled polls are least reliable). Tying eligibility to the match date keeps
// it pollable through the whole next UTC day, so the daytime polls catch it.
// Anything older is left to the daily refresh / manual entry.
const reasons = [];
for (const m of MATCHES) {
  const hasResult = Number.isFinite(m.scoreA) && Number.isFinite(m.scoreB);
  if (hasResult) continue;
  if (m.date !== today && m.date !== yesterday) continue;

  const ko = m.kickoff ? Date.parse(m.kickoff) : NaN;
  if (Number.isFinite(ko)) {
    const minsAgo = (now - ko) / 60000;
    if (minsAgo >= EARLIEST_FT_MIN) {
      reasons.push(`${m.teamA}–${m.teamB} kicked off ${Math.round(minsAgo)} min ago, still unscored`);
    }
  } else {
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
