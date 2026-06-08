// Maps TheSportsDB team names -> the names used in our draft (data/draft.js).
// Only teams whose API name differs from our draft name need an entry; all
// others match exactly. Verified against the full 2026 World Cup team list.
"use strict";

const TEAM_ALIASES = {
  "Czech Republic": "Czechia",
  "Bosnia-Herzegovina": "Bosnia & Herz",
  "Curaçao": "Curacao",
};

// Resolve an API team name to our canonical draft name.
function canonicalTeam(apiName) {
  if (apiName == null) return apiName;
  const trimmed = String(apiName).trim();
  return TEAM_ALIASES[trimmed] || trimmed;
}

module.exports = { TEAM_ALIASES, canonicalTeam };
