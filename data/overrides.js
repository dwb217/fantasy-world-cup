// Manual corrections that the importer applies on top of the API data, plus any
// fully manual matches. EDIT THIS FILE BY HAND — it is preserved on every refresh.
//
// Why this exists: TheSportsDB does not expose the penalty-shootout WINNER, and
// its extra-time / penalties status flags are sometimes missing. So whenever a
// knockout match ends level, the importer can't tell who advanced — it flags the
// match (printed in the run summary with its eventId) and you resolve it here.
//
// byEventId: keyed by TheSportsDB idEvent. Any field you set wins over the API.
//   "1543883": {
//     shootoutWinner: "Argentina",   // REQUIRED for a level knockout match
//     extraTime: true,               // optional: force the +1 extra-time bonus
//     penalties: true,               // optional: force the +1 penalties bonus
//     scoreA: 3, scoreB: 3,          // optional: correct a wrong score (home/away)
//   },
//
// manualMatches: full matches the API doesn't have at all. Same shape as the
// entries in data/matches.js. Give each a unique negative id to avoid clashes.
window.OVERRIDES = {
  byEventId: {
  },
  manualMatches: [
  ],
};
