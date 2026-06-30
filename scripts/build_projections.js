/* Tournament projections generator.
 *
 * The 7 managers' drafts together are exactly the 48-team field, so the union of
 * the draft IS the World Cup. This Monte-Carlo simulates the tournament many
 * times, scoring every match with the SAME rules as the live app
 * (data/rules.js / scoreTeamInMatch in app.js), and writes the aggregated
 * distributions to data/projections.js (window.PROJECTIONS), which the
 * Projections tab renders.
 *
 * The simulation is CONDITIONED on reality (data/matches.js):
 *   - the real groups are derived from the fixture list;
 *   - matches that have been played are locked at their actual score and the
 *     actual fantasy points they produced — only remaining games are simulated;
 *   - once the Round of 32 is drawn the knockout follows FIFA's fixed bracket
 *     (data/bracket.js): survivors flow to their known opponents, played games
 *     are locked, the rest simulated. Before the bracket exists it falls back to
 *     real pairings where they're announced + random pairing for the rest. A
 *     level knockout game with no shootoutWinner recorded yet is decided per-sim
 *     by rating.
 * Run scripts/fetch_scores.js first so data/matches.js is fresh. A CI workflow
 * (.github/workflows/update-projections.yml) does this daily at 10:00 UTC.
 *
 *     node scripts/build_projections.js [nSims]
 *
 * The core simulation is exposed as simulate(matches, N) and the CLI body only
 * runs when invoked directly (require.main guard), so other scripts — e.g.
 * scripts/backfill_mrr.js — can reuse the exact same model against an arbitrary
 * (e.g. historical) match list without triggering a file write.
 *
 * Model: Elo-style team ratings -> per-match expected goals via Poisson, which
 * naturally produces realistic W/D/L, clean-sheet, 2+/4+ goal and win-by-2 rates
 * that feed the bonus rules. If no fixture list exists yet, the group draw falls
 * back to balanced seeding pots. Ratings are hand-set from ~2026 form and are
 * the one thing to tweak if you disagree with a team.
 */

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/* ---- draft = single source of truth (data/draft.js) ---- */
const window = {};
eval(fs.readFileSync(path.join(ROOT, "data/draft.js"), "utf8"));   // window.DRAFT
eval(fs.readFileSync(path.join(ROOT, "data/matches.js"), "utf8")); // window.MATCHES
eval(fs.readFileSync(path.join(ROOT, "data/ratings.js"), "utf8")); // window.RATINGS
eval(fs.readFileSync(path.join(ROOT, "data/bracket.js"), "utf8")); // window.BRACKET
const DRAFT = window.DRAFT;
const ALL_MATCHES = window.MATCHES || [];
const BR = window.BRACKET;

/* ---- team strength: shared model from data/ratings.js (window.RATINGS), the
   single source of truth the What-If tab (app.js) reads too. Tweak it there. ----
   Note a known tension: the high K that keeps minnows realistic (few upset wins)
   also pushes the group draw rate a bit low (~20% vs a real ~25–30%), since
   pure-strength pots manufacture lopsided games. We favor realistic minnows over
   realistic draws; one global K can't do both. The projected standings ORDER is
   stable across MU, so MU only nudges absolute point totals, not the ranking. */
const RATING = Object.assign({}, window.RATINGS.base);
const DROP = window.RATINGS.drop;
for (const t in DROP) RATING[t] += DROP[t];
const MU = window.RATINGS.MU;   // baseline goals per team per game
const K  = window.RATINGS.K;    // rating sensitivity (higher = fewer upsets, wider spread)
const ET = window.RATINGS.ET;   // extra-time goal-rate multiplier

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

const hasResult = (m) =>
  m.scoreA !== null && m.scoreA !== "" && Number.isFinite(Number(m.scoreA)) &&
  m.scoreB !== null && m.scoreB !== "" && Number.isFinite(Number(m.scoreB));

// The advancing rounds, in order — used to recover a shootout winner that
// hasn't been recorded yet from the next round's draw (the team that turns up
// there is the one that advanced).
const KO_ROUNDS = ["Round of 32", "Round of 16", "Quarter-Final", "Semi-Final", "Final"];
function koAdvancer(f) {
  if (f.shootoutWinner) return f.shootoutWinner;
  const a = Number(f.scoreA), b = Number(f.scoreB);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b ? f.teamA : f.teamB;
  const i = KO_ROUNDS.indexOf(f.roundLabel);
  if (i < 0 || i + 1 >= KO_ROUNDS.length) return null;
  const nextLabel = KO_ROUNDS[i + 1];
  for (const n of ALL_MATCHES) {
    if (n.stage !== "knockout" || n.roundLabel !== nextLabel) continue;
    if (n.teamA === f.teamA || n.teamB === f.teamA) return f.teamA;
    if (n.teamA === f.teamB || n.teamB === f.teamB) return f.teamB;
  }
  return null;
}

// Outcome facts for a played knockout fixture. A level score means ET + PK by
// definition; winner is the shootout winner — recorded, or recovered from the
// next round's draw — and is null only when neither is known yet (then each sim
// decides it by rating, reflecting the real uncertainty).
function actualKoOutcome(f) {
  const level = Number(f.scoreA) === Number(f.scoreB);
  return {
    wentET: level ? true : !!f.extraTime,
    wentPK: level ? true : !!f.penalties,
    winner: !level ? (Number(f.scoreA) > Number(f.scoreB) ? f.teamA : f.teamB)
                   : koAdvancer(f),
  };
}

/* balanced seeding pots (pre-schedule fallback only) */
const ranked = TEAMS.slice().sort((a, b) => RATING[b] - RATING[a]);
const POTS = [ranked.slice(0,12), ranked.slice(12,24), ranked.slice(24,36), ranked.slice(36,48)];
const shuffle = (a) => { for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };

const STAGES = ["Group","R32","R16","QF","SF","Final"];
const stageIdxBySize = { 32:1, 16:2, 8:3, 4:4, 2:5 };
const KO_SIZE = { "Round of 32": 32, "Round of 16": 16, "Quarter-Final": 8, "Semi-Final": 4, "Final": 2 };

function koWinner(a, b, ga, gb) {
  if (ga > gb) return a;
  if (gb > ga) return b;
  const pa = 1 / (1 + Math.pow(10, (RATING[b] - RATING[a]) / 400));
  return Math.random() < pa ? a : b;
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

/* ----------------------------------------------------------------------------
 * Core Monte-Carlo. Pure with respect to the file system: takes a match list
 * (so callers can pass a historical snapshot) and the sim count, returns the
 * aggregated manager/team distributions. All conditioning on reality flows from
 * `allMatches` via hasResult / the fixtures present, so passing an older
 * matches.js reproduces exactly that day's projection.
 * -------------------------------------------------------------------------- */
function simulate(allMatches, N) {
  const groupFix = allMatches.filter((m) => m.stage === "group" && m.teamA in RATING && m.teamB in RATING);
  const koFixAll = allMatches.filter((m) => m.stage === "knockout" && m.teamA in RATING && m.teamB in RATING);
  const PLAYED = allMatches.filter(hasResult).length;

  // The real groups fall out of the fixture list: each team's 3 distinct group
  // opponents define its group of 4. Returns null (→ random-pots fallback) if the
  // schedule isn't loaded or doesn't form 12 clean groups.
  function deriveGroups() {
    if (groupFix.length !== 72) return null;
    const opp = {};
    for (const f of groupFix) {
      (opp[f.teamA] = opp[f.teamA] || new Set()).add(f.teamB);
      (opp[f.teamB] = opp[f.teamB] || new Set()).add(f.teamA);
    }
    if (Object.keys(opp).length !== 48) return null;
    const seen = new Set(), groups = [];
    for (const t of Object.keys(opp)) {
      if (seen.has(t)) continue;
      if (opp[t].size !== 3) return null;
      const g = [t, ...opp[t]];
      for (const x of g) { if (seen.has(x)) return null; seen.add(x); }
      groups.push(g);
    }
    return groups.length === 12 ? groups : null;
  }
  const FIXED_GROUPS = deriveGroups();

  // Known knockout fixtures, bucketed by round size. Labels come from the
  // importer's date-window mapping; anything unrecognized disables the use of
  // real pairings (random pairing still works) rather than corrupting a bracket.
  let koBySize = { 32: [], 16: [], 8: [], 4: [], 2: [] };
  let thirdPlaceFix = null;
  for (const f of koFixAll) {
    if (f.roundLabel === "Third Place") { thirdPlaceFix = f; continue; }
    const s = KO_SIZE[f.roundLabel];
    if (!s) {
      console.warn(`Unrecognized knockout round label "${f.roundLabel}" — ignoring real knockout pairings.`);
      koBySize = { 32: [], 16: [], 8: [], 4: [], 2: [] };
      thirdPlaceFix = null;
      break;
    }
    koBySize[s].push(f);
  }

  // Once the full Round of 32 is announced, the qualifier list is a fact — use it
  // instead of re-deriving from standings (our tiebreakers approximate FIFA's and
  // could differ in razor-thin cases).
  const REAL_QUALIFIERS = (() => {
    if (koBySize[32].length !== 16) return null;
    const q = [...new Set(koBySize[32].flatMap((f) => [f.teamA, f.teamB]))];
    return q.length === 32 ? q : null;
  })();

  /* ---- fixed bracket: once the R32 is drawn, the whole tree is determined by
     FIFA's template (data/bracket.js), so survivors flow to known opponents
     instead of being re-shuffled each round. We map each real R32 tie onto its
     template slot via the final group positions, then play the fixed tree
     (data/bracket.js r16/qf/sf/final/third), locking any games already played. ---- */
  const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const koByPair = {};
  for (const f of koFixAll) koByPair[pairKey(f.teamA, f.teamB)] = f;

  // Final group positions (letter + 1/2/3), only when every group game is in.
  function realPositions() {
    if (groupFix.length !== 72 || !groupFix.every(hasResult)) return null;
    const rec = {};
    for (const f of groupFix) {
      const a = Number(f.scoreA), b = Number(f.scoreB);
      rec[f.teamA] = rec[f.teamA] || [0, 0, 0]; rec[f.teamB] = rec[f.teamB] || [0, 0, 0];
      if (a > b) rec[f.teamA][0] += 3; else if (b > a) rec[f.teamB][0] += 3; else { rec[f.teamA][0]++; rec[f.teamB][0]++; }
      rec[f.teamA][1] += a - b; rec[f.teamB][1] += b - a; rec[f.teamA][2] += a; rec[f.teamB][2] += b;
    }
    const byL = {};
    for (const t in rec) { const L = BR.group[t]; if (L == null) return null; (byL[L] = byL[L] || []).push(t); }
    const cmp = (x, y) => rec[y][0] - rec[x][0] || rec[y][1] - rec[x][1] || rec[y][2] - rec[x][2] || RATING[y] - RATING[x];
    const pos = {};
    for (const L in byL) byL[L].slice().sort(cmp).forEach((t, i) => (pos[t] = { L, p: i + 1 }));
    return pos;
  }

  // slot number -> the real R32 fixture that fills it (all 16, or null to bail).
  // Spec-match over ALL knockout fixtures rather than trusting roundLabel: a tie
  // dated into the next window can be mislabeled (e.g. a July-4 R32 game tagged
  // "Round of 16"), but only the genuine R32 group-position pairs fit a slot.
  const slotFix = (() => {
    const pos = realPositions();
    if (!pos) return null;
    const fits = (sp, t) => {
      const P = pos[t]; if (!P) return false;
      if (sp[0] === "p1") return P.p === 1 && P.L === sp[1];
      if (sp[0] === "p2") return P.p === 2 && P.L === sp[1];
      return P.p === 3 && (BR.thirdSlots[sp[1]] || []).includes(P.L);
    };
    const out = {};
    for (const f of koFixAll) {
      for (const [n, sa, sb] of BR.r32) {
        if (out[n]) continue;
        if ((fits(sa, f.teamA) && fits(sb, f.teamB)) || (fits(sa, f.teamB) && fits(sb, f.teamA))) { out[n] = f; break; }
      }
    }
    return Object.keys(out).length === 16 ? out : null; // fall back if any slot unmatched
  })();
  const USE_TREE = !!slotFix;

  /* accumulators */
  const mgrTotals = {}; MANAGERS.forEach(m => mgrTotals[m] = []);
  const mgrCum = {};    MANAGERS.forEach(m => mgrCum[m] = STAGES.map(() => []));   // per stage: array of cumulative pts
  const finishCounts = {}; MANAGERS.forEach(m => finishCounts[m] = new Array(MANAGERS.length).fill(0));
  const teamTotals = {}; TEAMS.forEach(t => teamTotals[t] = []);
  const teamGoals = {};  TEAMS.forEach(t => teamGoals[t] = 0);
  const teamGames = {};  TEAMS.forEach(t => teamGames[t] = 0);
  const teamProg = {};   TEAMS.forEach(t => teamProg[t] = { advance:0, r16:0, qf:0, sf:0, final:0, champion:0 });

  for (let s = 0; s < N; s++) {
    const pts = {}; TEAMS.forEach(t => pts[t] = 0);
    const mPts = {}; MANAGERS.forEach(m => mPts[m] = STAGES.map(() => 0));
    const addTeam = (t, p, stageIdx) => { pts[t] += p; mPts[owner[t]][stageIdx] += p; };

    // groups: the real draw when the schedule is known, otherwise random pots
    const groups = FIXED_GROUPS ||
      (() => {
        const pots = POTS.map(p => shuffle(p.slice()));
        const out = [];
        for (let g = 0; g < 12; g++) out.push([pots[0][g], pots[1][g], pots[2][g], pots[3][g]]);
        return out;
      })();

    const stand = {};
    for (const g of groups) for (const t of g) stand[t] = [0,0,0]; // pts, gd, gf

    const playGroupGame = (a, b, ga, gb) => {
      addTeam(a, scoreGroup(ga,gb), 0); addTeam(b, scoreGroup(gb,ga), 0);
      teamGoals[a]+=ga; teamGoals[b]+=gb; teamGames[a]++; teamGames[b]++;
      if (ga>gb) stand[a][0]+=3; else if (gb>ga) stand[b][0]+=3; else {stand[a][0]++;stand[b][0]++;}
      stand[a][1]+=ga-gb; stand[b][1]+=gb-ga; stand[a][2]+=ga; stand[b][2]+=gb;
    };

    if (FIXED_GROUPS) {
      // real fixtures: played ones locked at the actual score, the rest simulated
      for (const f of groupFix) {
        if (hasResult(f)) playGroupGame(f.teamA, f.teamB, Number(f.scoreA), Number(f.scoreB));
        else playGroupGame(f.teamA, f.teamB, pois(lam(f.teamA,f.teamB)), pois(lam(f.teamB,f.teamA)));
      }
    } else {
      for (const g of groups) {
        for (let i = 0; i < 4; i++) for (let j = i+1; j < 4; j++) {
          playGroupGame(g[i], g[j], pois(lam(g[i],g[j])), pois(lam(g[j],g[i])));
        }
      }
    }

    let qualifiers;
    if (REAL_QUALIFIERS) {
      qualifiers = REAL_QUALIFIERS.slice();
    } else {
      const cmp = (x,y) => (stand[y][0]-stand[x][0]) || (stand[y][1]-stand[x][1]) || (stand[y][2]-stand[x][2]) || (RATING[y]-RATING[x]);
      qualifiers = []; const thirds = [];
      for (const g of groups) { const gs = g.slice().sort(cmp); qualifiers.push(gs[0], gs[1]); thirds.push(gs[2]); }
      thirds.sort(cmp); qualifiers = qualifiers.concat(thirds.slice(0,8)); // 32
    }
    for (const t of qualifiers) teamProg[t].advance++;

    // a single knockout game: locked if played, simulated otherwise
    const playKoGame = (a, b, fixture, si) => {
      let ga, gb, wentET = false, wentPK = false, w;
      if (fixture && hasResult(fixture)) {
        const aIsHome = fixture.teamA === a; // a/b may arrive in either order (tree)
        ga = Number(aIsHome ? fixture.scoreA : fixture.scoreB);
        gb = Number(aIsHome ? fixture.scoreB : fixture.scoreA);
        const o = actualKoOutcome(fixture);
        wentET = o.wentET; wentPK = o.wentPK;
        w = o.winner || koWinner(a, b, 0, 0); // level, shootout winner not recorded yet
        teamGoals[a]+=ga; teamGoals[b]+=gb; teamGames[a]++; teamGames[b]++;
      } else {
        ga = pois(lam(a,b)); gb = pois(lam(b,a));
        teamGoals[a]+=ga; teamGoals[b]+=gb; teamGames[a]++; teamGames[b]++;
        if (ga === gb) { wentET=true; const ea=pois(lam(a,b)*ET), eb=pois(lam(b,a)*ET); ga+=ea; gb+=eb; teamGoals[a]+=ea; teamGoals[b]+=eb; if (ga===gb) wentPK=true; }
        w = koWinner(a,b,ga,gb);
      }
      const l = (w===a)?b:a;
      const wgf=(w===a)?ga:gb, wga=(w===a)?gb:ga, lgf=(l===a)?ga:gb, lga=(l===a)?gb:ga;
      addTeam(w, scoreKo(wgf,wga,true,wentET,wentPK), si);
      addTeam(l, scoreKo(lgf,lga,false,wentET,wentPK), si);
      return w;
    };

    if (USE_TREE) {
      // R32 is drawn → walk FIFA's fixed bracket (data/bracket.js): survivors flow
      // to their known opponents, played games are locked, the rest simulated.
      const W = {}, Lz = {};
      const playSlot = (a, b, si) => {
        const w = playKoGame(a, b, koByPair[pairKey(a, b)] || null, si);
        return [w, w === a ? b : a];
      };
      for (const [n] of BR.r32)        { const f = slotFix[n]; const [w] = playSlot(f.teamA, f.teamB, 1); W[n] = w; teamProg[w].r16++; }
      for (const [n, x, y] of BR.r16)  { const [w] = playSlot(W[x], W[y], 2); W[n] = w; teamProg[w].qf++; }
      for (const [n, x, y] of BR.qf)   { const [w] = playSlot(W[x], W[y], 3); W[n] = w; teamProg[w].sf++; }
      for (const [n, x, y] of BR.sf)   { const [w, l] = playSlot(W[x], W[y], 4); W[n] = w; Lz[n] = l; teamProg[w].final++; }
      { const [, x, y] = BR.final; const [w] = playSlot(W[x], W[y], 5); teamProg[w].champion++; }
      { const [, x, y] = BR.third; if (Lz[x] && Lz[y]) playSlot(Lz[x], Lz[y], 5); } // SF losers
    } else {
      // R32 not yet drawn: real pairings where fixtures exist, random pairing for the rest
      let cur = shuffle(qualifiers.slice());
      let sfLosers = [];
      while (cur.length > 1) {
        const S = cur.length;
        const si = stageIdxBySize[S];
        const inRound = new Set(cur);
        const next = [];
        const paired = new Set();
        const actual = (koBySize[S] || []).filter(f =>
          inRound.has(f.teamA) && inRound.has(f.teamB) && !paired.has(f.teamA) && !paired.has(f.teamB) &&
          (paired.add(f.teamA), paired.add(f.teamB), true));
        for (const f of actual) next.push(playKoGame(f.teamA, f.teamB, f, si));
        const pool = shuffle(cur.filter(t => !paired.has(t)));
        for (let i = 0; i + 1 < pool.length; i += 2) next.push(playKoGame(pool[i], pool[i+1], null, si));
        if (S === 32) for (const t of next) teamProg[t].r16++;
        else if (S === 16) for (const t of next) teamProg[t].qf++;
        else if (S === 8) for (const t of next) teamProg[t].sf++;
        else if (S === 4) { for (const t of next) teamProg[t].final++; sfLosers = cur.filter(t => !next.includes(t)); }
        cur = next;
      }
      teamProg[cur[0]].champion++;

      // third-place game (a real, points-scoring match between the SF losers)
      if (sfLosers.length === 2) {
        const [a, b] = sfLosers;
        const fix = (thirdPlaceFix &&
          ((thirdPlaceFix.teamA === a && thirdPlaceFix.teamB === b) ||
           (thirdPlaceFix.teamA === b && thirdPlaceFix.teamB === a)))
          ? thirdPlaceFix : null;
        playKoGame(fix ? fix.teamA : a, fix ? fix.teamB : b, fix, 5);
      }
    }

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

  return { managersOut, teamsOut, PLAYED, FIXED_GROUPS, N };
}

// Expected (mean) finishing position from a manager's finishing distribution:
// sum over every place of place × P(finishing there). finish[i] is P(finish in
// place i+1), so place = i+1. Ranges 1 (certain 1st) to N (certain last); LOWER
// is better. A plain, legible weighted average of where they end up.
const avgFinishOf = (finish) => r4(finish.reduce((s, p, i) => s + p * (i + 1), 0));

module.exports = { simulate, avgFinishOf, ALL_MATCHES, MANAGERS, DRAFT, hasResult };

/* ----------------------------------------------------------------------------
 * CLI: only when run directly. Simulates today's matches.js, writes
 * data/projections.js, and appends today's point to the odds-history series.
 * -------------------------------------------------------------------------- */
if (require.main === module) {
  const N = Number(process.argv[2]) || 20000;
  const { managersOut, teamsOut, PLAYED, FIXED_GROUPS } = simulate(ALL_MATCHES, N);

  const noteParts = [];
  if (PLAYED) {
    noteParts.push(`Conditioned on the ${PLAYED} match result${PLAYED === 1 ? "" : "s"} so far: played games are locked at their actual scores and points; only the remaining games are simulated.`);
  } else {
    noteParts.push("Pre-tournament estimate, not a prediction of any single outcome.");
  }
  noteParts.push("Team strength is Elo-style (hand-set, ~2026 form); per-match goals are Poisson from the rating gap, scored with the live app's exact rules.");
  noteParts.push(FIXED_GROUPS
    ? "Groups are the real draw; once the Round of 32 is set the knockout follows FIFA's fixed bracket (played games locked, the rest simulated) — random pairing only before the bracket exists."
    : "Group draw uses balanced pots; knockout bracket is random pairing.");

  const out = {
    meta: {
      nSims: N,
      generatedAt: new Date().toISOString(),
      playedMatches: PLAYED,
      scheduledMatches: ALL_MATCHES.length,
      model: { mu: MU, k: K, etFactor: ET },
      stages: STAGES,
      format: "48 teams · 12 groups of 4 · top 2 + 8 best thirds → R32 → R16 → QF → SF → Final",
      note: noteParts.join(" "),
    },
    managers: managersOut,
    teams: teamsOut,
  };

  /* ---- title-odds history: one entry per UTC day, drives the "odds over time"
     chart. Same-day reruns overwrite that day's entry. ---- */
  const histPath = path.join(ROOT, "data/odds_history.js");
  let history = [];
  try {
    const src = fs.readFileSync(histPath, "utf8");
    const m = src.match(/=\s*(\[[\s\S]*\]);?\s*$/);
    if (m) history = JSON.parse(m[1]);
  } catch (e) { /* first run: no history file yet */ }
  const today = out.meta.generatedAt.slice(0, 10);
  const entry = { date: today, playedMatches: PLAYED, titleOdds: {}, meanPts: {}, avgFinish: {} };
  for (const m of managersOut) {
    entry.titleOdds[m.name] = m.finish[0];
    entry.meanPts[m.name] = m.mean;
    entry.avgFinish[m.name] = avgFinishOf(m.finish);
  }
  history = history.filter((h) => h.date !== today);
  history.push(entry);
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  fs.writeFileSync(histPath,
    `// AUTO-GENERATED by scripts/build_projections.js — daily title-odds history.\n` +
    `window.ODDS_HISTORY = ` + JSON.stringify(history, null, 1) + ";\n");

  const banner =
`// AUTO-GENERATED by scripts/build_projections.js — do not hand-edit.
// Monte-Carlo projections (${N} simulated tournaments), conditioned on the
// results in data/matches.js at build time (${PLAYED} played). Refreshed daily
// at 10:00 UTC by .github/workflows/update-projections.yml.
`;
  fs.writeFileSync(path.join(ROOT, "data/projections.js"),
    banner + "window.PROJECTIONS = " + JSON.stringify(out, null, 2) + ";\n");

  console.log(`Wrote data/projections.js (${N} sims, ${PLAYED} real results locked in, groups ${FIXED_GROUPS ? "real" : "random pots"}).`);
  console.log(`Wrote data/odds_history.js (${history.length} day${history.length === 1 ? "" : "s"} of title odds).`);
  console.log("Projected standings:");
  managersOut.forEach((m,i) => console.log(`  ${i+1}. ${m.name.padEnd(8)} ${String(m.mean).padStart(6)} ±${m.std}  (win title region p95=${m.pct.p95})`));
}
