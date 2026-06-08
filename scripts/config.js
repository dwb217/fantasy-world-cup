// Configuration for the score importer (scripts/fetch_scores.js).
"use strict";

const CONFIG = {
  // TheSportsDB free/test key is "123". Set SPORTSDB_KEY to use a premium key.
  apiKey: process.env.SPORTSDB_KEY || "123",
  base: "https://www.thesportsdb.com/api/v1/json",

  leagueId: "4429", // FIFA World Cup
  season: process.env.WC_SEASON || "2026",

  // Rounds to request. Group matchdays are 1–3. Knockout rounds appear once the
  // bracket is set; these are TheSportsDB's usual cup round numbers. Extras are
  // included so nothing is silently missed — any round that returns data but
  // isn't labelled below is logged and treated as a knockout round.
  requestRounds: [1, 2, 3, 100, 110, 120, 125, 140, 150, 160, 170, 180, 200],

  roundLabels: {
    1: "Matchday 1",
    2: "Matchday 2",
    3: "Matchday 3",
    100: "Round of 32",
    125: "Round of 16",
    150: "Quarter-Final",
    160: "Semi-Final",
    170: "Third Place",
    200: "Final",
  },

  // Rounds 1–3 are the group stage; everything else is knockout.
  groupRounds: new Set([1, 2, 3]),

  // strStatus values that mean the match is over.
  finishedStatuses: new Set(["FT", "AET", "AP", "Match Finished", "FT_PEN"]),
  // strStatus values that mean not-yet-final (skip these even if a score shows).
  pendingStatuses: new Set([
    "NS", "1H", "2H", "HT", "ET", "BT", "P", "PEN", "LIVE", "BREAK",
    "SUSP", "INT", "POSTP", "PST", "CANC", "ABD", "AWD", "WO", "TBD", "",
  ]),

  reqDelayMs: 700, // spacing between requests (free tier = 30/min)
  maxRetries: 3,
};

module.exports = { CONFIG };
