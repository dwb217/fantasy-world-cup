// Single source of truth for the team-strength model, shared by BOTH Monte-Carlo
// engines — the projections build (scripts/build_projections.js) and the What-If
// tab (app.js) — so the two can never drift apart. Tweak ratings here only.
//
// Goal model: a team's expected goals vs an opponent is
//   lambda(a, b) = MU * exp(K * (rating[a] - rating[b]) / 400)
// sampled as Poisson. A level knockout game adds extra-time goals at ET× the
// rate, then (if still level) a shootout decided by the Elo win probability
//   1 / (1 + 10^((rating[b] - rating[a]) / 400)).
window.RATINGS = {
  // Elo-ish base ratings (~2026 form).
  base: {
    France:2080, Spain:2075, Argentina:2065, Brazil:2050, England:2045,
    Portugal:2010, Netherlands:2000, Germany:1990, Belgium:1955, Croatia:1930,
    Uruguay:1930, Morocco:1925, Colombia:1910, Japan:1875, Switzerland:1865,
    USA:1860, Senegal:1855, Mexico:1840, Ecuador:1830, Turkey:1830,
    Austria:1820, Norway:1820, "South Korea":1810, Iran:1800, Egypt:1790,
    Sweden:1790, "Ivory Coast":1790, Algeria:1780, Canada:1770, Czechia:1760,
    Australia:1750, Paraguay:1750, Ghana:1740, Scotland:1740, "Bosnia & Herz":1740,
    "DR Congo":1730, Tunisia:1720, "South Africa":1710, Panama:1700, Qatar:1700,
    "Saudi Arabia":1700, Uzbekistan:1690, Iraq:1660, Jordan:1650, "Cape Verde":1630,
    "New Zealand":1620, Curacao:1580, Haiti:1560,
  },
  // Floor calibration: push the genuine minnows down toward realistic Elo so the
  // weakest teams don't bank ~6 pts from upset wins they'd almost never get.
  drop: {
    Haiti:-110, Curacao:-110, "New Zealand":-80, "Cape Verde":-70, Jordan:-60,
    Iraq:-50, Uzbekistan:-40, "Saudi Arabia":-30, Qatar:-30, Panama:-30,
  },
  // MU sets goals/game (~2.8 at 1.2, matching real WC ~2.5–2.9). K sets how
  // strongly the rating gap skews results (higher = fewer upsets, wider spread).
  MU: 1.2,
  K: 0.9,
  ET: 0.33, // extra-time goal-rate multiplier
};
