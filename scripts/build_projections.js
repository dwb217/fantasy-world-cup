/* Pre-tournament projections generator.
 *
 * The 7 managers' drafts together are exactly the 48-team field, so the union of
 * the draft IS the World Cup. This Monte-Carlo simulates the whole tournament
 * many times, scoring every match with the SAME rules as the live app
 * (data/rules.js / scoreTeamInMatch in app.js), and writes the aggregated
 * distributions to data/projections.js (window.PROJECTIONS), which the
 * Projections tab renders.
 *
 * Re-run any time the draft or ratings change:
 *     node scripts/build_projections.js [nSims]
 *
 * Model: Elo-style team ratings -> per-match expected goals via Poisson, which
 * naturally produces realistic W/D/L, clean-sheet, 2+/4+ goal and win-by-2 rates
 * that feed the bonus rules. Group draw uses balanced seeding pots; the knockout
 * bracket is random pairing among the 32 qualifiers. Ratings are hand-set from
 * ~2026 form and are the one thing to tweak if you disagree with a team.
 */

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const N = Number(process.argv[2]) || 20000;

/* ---- draft = single source of truth (data/draft.js) ---- */
const draftSrc = fs.readFileSync(path.join(ROOT, "data/draft.js"), "utf8");
const window = {};
eval(draftSrc); // defines window.DRAFT
const DRAFT = window.DRAFT;

/* ---- team strength (Elo-ish, ~2026 form). Tweak these. ---- */
const RATING = {
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
};

// Floor calibration: push the genuine minnows down toward realistic Elo so the
// weakest teams don't bank ~6 pts from upset wins they'd almost never get.
const DROP = {
  Haiti:-110, Curacao:-110, "New Zealand":-80, "Cape Verde":-70, Jordan:-60,
  Iraq:-50, Uzbekistan:-40, "Saudi Arabia":-30, Qatar:-30, Panama:-30,
};
for (const t in DROP) RATING[t] += DROP[t];

// MU sets goals/game (~2.8 at 1.2, matching real WC ~2.5–2.9). K sets how
// strongly the rating gap skews results. Note a known tension: the high K that
// keeps minnows realistic (few upset wins) also pushes the group draw rate a bit
// low (~20% vs a real ~25–30%), since pure-strength pots manufacture lopsided
// games. We favor realistic minnows over realistic draws; one global K can't do
// both. The projected standings ORDER is stable across MU, so this only nudges
// absolute point totals, not the ranking.
const MU = 1.2;    // baseline goals per team per game
const K  = 0.9;    // rating sensitivity (higher = fewer upsets, wider spread)
const ET = 0.33;   // extra-time goal-rate multiplier

const TEAMS = [].concat(...Object.values(DRAFT));
const owner = {};
for (const m of Object.keys(DRAFT)) for (const t of DRAFT[m]) owner[t] = m;
const MANAGERS = Object.keys(DRAFT);
for (const t of TEAMS) if (!(t in RATING)) throw new Error("No rating for " + t);
if (TEAMS.length !== 48) console.warn("Warning: field is " + TEAMS.length + " teams, not 48.");

const lam = (a, b) => MU * Math.exp(K * (RATING[a] - RATING[b]) / 400);
function pois(l) { // Knuth
  const L = Math.exp(-l); let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function scoreGroup(gf, ga) {
  let p = 0;
  if (gf > ga) p += 6; else if (gf === ga) p += 2;
  if (ga === 0) p += 1;
  if (gf >= 2) p += 1;
  if (gf >= 4) p += 1;
  if (gf - ga >= 2) p += 1;
  return p;
}
function scoreKo(gf, ga, advanced, wentET, wentPK) {
  let p = 0;
  if (advanced) p += 6;
  if (ga === 0) p += 1;
  if (gf >= 2) p += 1;
  if (gf >= 4) p += 1;
  if (gf - ga >= 2) p += 1;
  if (wentET) p += 1;
  if (wentPK) p += 1;
  return p;
}

/* balanced seeding pots */
const ranked = TEAMS.slice().sort((a, b) => RATING[b] - RATING[a]);
const POTS = [ranked.slice(0,12), ranked.slice(12,24), ranked.slice(24,36), ranked.slice(36,48)];
const shuffle = (a) => { for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };

const STAGES = ["Group","R32","R16","QF","SF","Final"];
const stageIdxBySize = { 32:1, 16:2, 8:3, 4:4, 2:5 };

/* accumulators */
const mgrTotals = {}; MANAGERS.forEach(m => mgrTotals[m] = []);
const mgrCum = {};    MANAGERS.forEach(m => mgrCum[m] = STAGES.map(() => []));   // per stage: array of cumulative pts
const finishCounts = {}; MANAGERS.forEach(m => finishCounts[m] = new Array(MANAGERS.length).fill(0));
const teamTotals = {}; TEAMS.forEach(t => teamTotals[t] = []);
const teamGoals = {};  TEAMS.forEach(t => teamGoals[t] = 0);
const teamGames = {};  TEAMS.forEach(t => teamGames[t] = 0);
const teamProg = {};   TEAMS.forEach(t => teamProg[t] = { advance:0, r16:0, qf:0, sf:0, final:0, champion:0 });

function koWinner(a, b, ga, gb) {
  if (ga > gb) return a;
  if (gb > ga) return b;
  const pa = 1 / (1 + Math.pow(10, (RATING[b] - RATING[a]) / 400));
  return Math.random() < pa ? a : b;
}

for (let s = 0; s < N; s++) {
  const pts = {}; TEAMS.forEach(t => pts[t] = 0);
  const mPts = {}; MANAGERS.forEach(m => mPts[m] = STAGES.map(() => 0));
  const addTeam = (t, p, stageIdx) => { pts[t] += p; mPts[owner[t]][stageIdx] += p; };

  // group draw
  const pots = POTS.map(p => shuffle(p.slice()));
  const groups = [];
  for (let g = 0; g < 12; g++) groups.push([pots[0][g], pots[1][g], pots[2][g], pots[3][g]]);

  const stand = {};
  for (const g of groups) {
    for (const t of g) stand[t] = [0,0,0]; // pts, gd, gf
    for (let i = 0; i < 4; i++) for (let j = i+1; j < 4; j++) {
      const a = g[i], b = g[j];
      const ga = pois(lam(a,b)), gb = pois(lam(b,a));
      addTeam(a, scoreGroup(ga,gb), 0); addTeam(b, scoreGroup(gb,ga), 0);
      teamGoals[a]+=ga; teamGoals[b]+=gb; teamGames[a]++; teamGames[b]++;
      if (ga>gb) stand[a][0]+=3; else if (gb>ga) stand[b][0]+=3; else {stand[a][0]++;stand[b][0]++;}
      stand[a][1]+=ga-gb; stand[b][1]+=gb-ga; stand[a][2]+=ga; stand[b][2]+=gb;
    }
  }
  const cmp = (x,y) => (stand[y][0]-stand[x][0]) || (stand[y][1]-stand[x][1]) || (stand[y][2]-stand[x][2]) || (RATING[y]-RATING[x]);
  let qualifiers = []; const thirds = [];
  for (const g of groups) { const gs = g.slice().sort(cmp); qualifiers.push(gs[0], gs[1]); thirds.push(gs[2]); }
  thirds.sort(cmp); qualifiers = qualifiers.concat(thirds.slice(0,8)); // 32
  for (const t of qualifiers) teamProg[t].advance++;

  // knockout: random bracket
  let cur = shuffle(qualifiers.slice());
  while (cur.length > 1) {
    const si = stageIdxBySize[cur.length];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i], b = cur[i+1];
      let ga = pois(lam(a,b)), gb = pois(lam(b,a)), wentET=false, wentPK=false;
      teamGoals[a]+=ga; teamGoals[b]+=gb; teamGames[a]++; teamGames[b]++;
      if (ga === gb) { wentET=true; const ea=pois(lam(a,b)*ET), eb=pois(lam(b,a)*ET); ga+=ea; gb+=eb; teamGoals[a]+=ea; teamGoals[b]+=eb; if (ga===gb) wentPK=true; }
      const w = koWinner(a,b,ga,gb), l = (w===a)?b:a;
      const wgf=(w===a)?ga:gb, wga=(w===a)?gb:ga, lgf=(l===a)?ga:gb, lga=(l===a)?gb:ga;
      addTeam(w, scoreKo(wgf,wga,true,wentET,wentPK), si);
      addTeam(l, scoreKo(lgf,lga,false,wentET,wentPK), si);
      next.push(w);
    }
    if (cur.length === 32) for (const t of next) teamProg[t].r16++;
    else if (cur.length === 16) for (const t of next) teamProg[t].qf++;
    else if (cur.length === 8) for (const t of next) teamProg[t].sf++;
    else if (cur.length === 4) for (const t of next) teamProg[t].final++;
    cur = next;
  }
  teamProg[cur[0]].champion++;

  // record
  const totals = {};
  for (const t of TEAMS) teamTotals[t].push(pts[t]);
  for (const m of MANAGERS) {
    let run = 0;
    for (let i = 0; i < STAGES.length; i++) { run += mPts[m][i]; mgrCum[m][i].push(run); }
    totals[m] = run; mgrTotals[m].push(run);
  }
  const order = MANAGERS.slice().sort((a,b) => totals[b]-totals[a]);
  order.forEach((m, rank) => finishCounts[m][rank]++);
}

/* ---- aggregate helpers ---- */
const mean = (a) => a.reduce((s,x)=>s+x,0)/a.length;
const std = (a) => { const mu=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-mu)*(x-mu),0)/a.length); };
const pct = (sorted, q) => sorted[Math.min(sorted.length-1, Math.max(0, Math.round(q*(sorted.length-1))))];
function hist(arr, width) {
  const lo = Math.floor(Math.min(...arr)/width)*width;
  const hi = Math.max(...arr);
  const n = Math.floor((hi-lo)/width)+1;
  const counts = new Array(n).fill(0);
  for (const x of arr) counts[Math.min(n-1, Math.floor((x-lo)/width))]++;
  return { start: lo, width, probs: counts.map(c => +(c/arr.length).toFixed(5)) };
}
const r2 = (x) => +x.toFixed(2);
const r4 = (x) => +x.toFixed(4);

function poissonPmf(lambda, kmax) {
  const out = []; let cum = 0;
  for (let k = 0; k < kmax; k++) {
    let p = Math.exp(-lambda) * Math.pow(lambda, k);
    for (let i = 2; i <= k; i++) p /= i;
    out.push(+p.toFixed(4)); cum += p;
  }
  out.push(+Math.max(0, 1-cum).toFixed(4)); // k >= kmax tail
  return out;
}

const managersOut = MANAGERS.map(m => {
  const sorted = mgrTotals[m].slice().sort((a,b)=>a-b);
  return {
    name: m, teams: DRAFT[m].slice(), teamCount: DRAFT[m].length,
    mean: r2(mean(sorted)), std: r2(std(sorted)),
    min: sorted[0], max: sorted[sorted.length-1],
    pct: { p5:pct(sorted,.05), p25:pct(sorted,.25), p50:pct(sorted,.5), p75:pct(sorted,.75), p95:pct(sorted,.95) },
    hist: hist(mgrTotals[m], 10),
    finish: finishCounts[m].map(c => r4(c/N)),
    cumulative: STAGES.map((st, i) => {
      const cs = mgrCum[m][i].slice().sort((a,b)=>a-b);
      return { stage: st, mean: r2(mean(cs)), p25: pct(cs,.25), p75: pct(cs,.75) };
    }),
  };
}).sort((a,b) => b.mean - a.mean);

const teamsOut = TEAMS.map(t => {
  const sorted = teamTotals[t].slice().sort((a,b)=>a-b);
  const lambda = teamGoals[t]/teamGames[t];
  const pr = teamProg[t];
  return {
    team: t, owner: owner[t], rating: RATING[t],
    mean: r2(mean(sorted)), std: r2(std(sorted)),
    pct: { p5:pct(sorted,.05), p50:pct(sorted,.5), p95:pct(sorted,.95) },
    hist: hist(teamTotals[t], 3),
    lambda: r2(lambda),
    goalDist: poissonPmf(lambda, 5), // P(0),P(1),P(2),P(3),P(4),P(5+)
    prog: { advance:r4(pr.advance/N), r16:r4(pr.r16/N), qf:r4(pr.qf/N), sf:r4(pr.sf/N), final:r4(pr.final/N), champion:r4(pr.champion/N) },
  };
}).sort((a,b) => b.mean - a.mean);

const out = {
  meta: {
    nSims: N,
    generatedAt: new Date().toISOString(),
    model: { mu: MU, k: K, etFactor: ET },
    stages: STAGES,
    format: "48 teams · 12 groups of 4 · top 2 + 8 best thirds → R32 → R16 → QF → SF → Final",
    note: "Monte-Carlo projection. Team strength is Elo-style (hand-set, ~2026 form); per-match goals are Poisson from the rating gap, scored with the live app's exact rules. Group draw uses balanced pots; knockout bracket is random pairing. Pre-tournament estimate, not a prediction of any single outcome.",
  },
  managers: managersOut,
  teams: teamsOut,
};

const banner =
`// AUTO-GENERATED by scripts/build_projections.js — do not hand-edit.
// Pre-tournament Monte-Carlo projections (${N} simulated World Cups).
// Re-run: node scripts/build_projections.js
`;
fs.writeFileSync(path.join(ROOT, "data/projections.js"),
  banner + "window.PROJECTIONS = " + JSON.stringify(out, null, 2) + ";\n");

console.log(`Wrote data/projections.js (${N} sims).`);
console.log("Projected standings:");
managersOut.forEach((m,i) => console.log(`  ${i+1}. ${m.name.padEnd(8)} ${String(m.mean).padStart(6)} ±${m.std}  (win title region p95=${m.pct.p95})`));
