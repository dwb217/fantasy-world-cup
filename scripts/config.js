// Configuration for the score importer (scripts/fetch_scores.js).
"use strict";

const CONFIG = {
  // TheSportsDB free/test key is "123". Set SPORTSDB_KEY to use a premium key.
  apiKey: process.env.SPORTSDB_KEY || "123",
  base: "https://www.thesportsdb.com/api/v1/json",

  leagueId: "4429", // FIFA World Cup
  season: process.env.WC_SEASON || "2026",

  // Rounds to request. Group matchdays are 1–3. Knockout round NUMBERS are not
  // reliable across seasons (2022 actually used: R16=16, QF=125, SF=150,
  // Third=160, Final=200 — shifted from the "documented" constants), so this
  // list casts a wide net (sequential 4–8, literal 16/32, and the cup
  // constants). On top of this, fetch_scores.js queries eventsnextleague /
  // eventspastleague every run and adds any round number it sees there, so a
  // scheme we didn't anticipate still gets picked up automatically.
  requestRounds: [1, 2, 3, 4, 5, 6, 7, 8, 16, 32, 100, 110, 120, 125, 140, 150, 160, 170, 180, 200],

  roundLabels: {
    1: "Matchday 1",
    2: "Matchday 2",
    3: "Matchday 3",
  },

  // Knockout matches are labelled by DATE (the official 2026 schedule), since
  // the API's round numbers can't be trusted. Windows are padded into the rest
  // days to absorb timezone date shifts. Used for display only — scoring just
  // needs group vs knockout.
  knockoutWindows: [
    { from: "2026-06-28", to: "2026-07-03", label: "Round of 32" },
    { from: "2026-07-04", to: "2026-07-08", label: "Round of 16" },
    { from: "2026-07-09", to: "2026-07-12", label: "Quarter-Final" },
    { from: "2026-07-13", to: "2026-07-16", label: "Semi-Final" },
    { from: "2026-07-17", to: "2026-07-18", label: "Third Place" },
    { from: "2026-07-19", to: "2026-07-20", label: "Final" },
  ],

  // Rounds 1–3 are the group stage; everything else is knockout.
  groupRounds: new Set([1, 2, 3]),

  // strStatus values that mean the match is over.
  finishedStatuses: new Set(["FT", "AET", "AP", "Match Finished", "FT_PEN"]),
  // strStatus values that mean not-yet-final (skip these even if a score shows).
  pendingStatuses: new Set([
    "NS", "1H", "2H", "HT", "ET", "BT", "P", "PEN", "LIVE", "BREAK",
    "SUSP", "INT", "POSTP", "PST", "CANC", "ABD", "AWD", "WO", "TBD", "",
  ]),

  reqDelayMs: 2000, // spacing between requests — keeps ~22 calls/run under the free tier's ~30/min
  maxRetries: 3,
};

module.exports = { CONFIG };
