# How the Projections Work

This document explains everything that goes into the projections shown on the
Projections tab — what data feeds the model, the assumptions baked in, and the
method that turns it all into the numbers you see (expected points, percentiles,
"chance to advance," title odds, and so on).

It's written for someone comfortable with the general idea of a simulation or a
betting model, but who doesn't want to wade through statistics. No formulas are
required to follow it, though the key ones are included for anyone who wants them.

The code that does all of this lives in
[`scripts/build_projections.js`](../scripts/build_projections.js). It is re-run
automatically every day at 07:47 UTC by a GitHub Action — and again immediately
whenever new scores are imported — and writes its output to `data/projections.js`.

---

## The one-sentence version

We simulate the **entire World Cup 20,000 times** from wherever it currently
stands, score every match with the exact same fantasy rules the live site uses,
and report the distribution of outcomes — averages, ranges, and probabilities —
across all 20,000 runs.

That's it. Everything below is detail.

---

## Why a simulation (and not a spreadsheet)?

The 7 managers' drafts together contain exactly the 48 teams in the tournament,
so **the union of all the drafts *is* the World Cup.** If we can credibly simulate
how the tournament plays out, we automatically get every manager's point total,
because each manager's score is just the sum of their teams' results.

A single "expected" tournament won't do, because fantasy scoring is full of
thresholds — a clean sheet, scoring 2+ goals, winning by 2+, reaching penalties.
These are all-or-nothing bonuses, and you only capture how often they actually
happen by playing the tournament out many times and counting. So we run it 20,000
times and look at the whole spread of results, not just the midpoint.

---

## The data the projections are based on

There are five inputs. Three are real, live data; two are model assumptions we set
by hand.

### 1. The scoring rules — `data/rules.js`
The exact point values, identical to what the live scoreboard uses:

| Event | Points | Notes |
|---|---|---|
| Win | 6 | |
| Draw | 2 | group stage only |
| Clean sheet | 1 | conceded 0 goals |
| Scored 2+ goals | 1 | |
| Scored 4+ goals | 1 | stacks on top of the 2+ bonus |
| Won by 2+ goals | 1 | |
| Reached extra time | 1 | knockout only |
| Reached penalties | 1 | knockout only |

The simulation scores every simulated match with these same rules, so the
projections can never drift away from how points are actually awarded.

### 2. The draft — `data/draft.js`
Which teams each of the 7 managers owns. This is how simulated team results get
rolled up into manager totals.

### 3. The real fixtures and results so far — `data/matches.js`
This file is refreshed daily from TheSportsDB (the same import that updates the
live scoreboard). The projections are **conditioned on reality** using it, which
means:

- **The real group draw is used.** The model reads the actual fixture list to
  reconstruct the 12 real groups, rather than guessing the draw. (If the schedule
  isn't loaded yet, it falls back to balanced seeding pots — see below.)
- **Games that have already been played are locked in** at their actual score and
  the actual points they produced. Only games that *haven't* happened yet are
  simulated. So as the tournament progresses, more of each projection is fact and
  less is simulation, and the ranges tighten.
- **Real knockout pairings are used once they're known.** Rounds whose matchups
  aren't set yet are paired randomly among that simulation's survivors. Once the
  full Round of 32 is announced, the model uses that exact qualifier list rather
  than re-deriving it from simulated standings.

### 4. Team strength ratings — *set by hand* (in `build_projections.js`)
Every team gets an Elo-style rating reflecting roughly 2026 form. These are the
engine that decides who's likely to beat whom. They run from **France at 2080**
down to **Haiti at 1560**:

```
France 2080, Spain 2075, Argentina 2065, Brazil 2050, England 2045,
Portugal 2010, Netherlands 2000, Germany 1990, Belgium 1955, Croatia 1930,
Uruguay 1930, Morocco 1925, Colombia 1910, Japan 1875, Switzerland 1865,
USA 1860, Senegal 1855, Mexico 1840, Ecuador 1830, Turkey 1830,
Austria 1820, Norway 1820, South Korea 1810, Iran 1800, Egypt 1790,
Sweden 1790, Ivory Coast 1790, Algeria 1780, Canada 1770, Czechia 1760,
Australia 1750, Paraguay 1750, Ghana 1740, Scotland 1740, Bosnia & Herz 1740,
DR Congo 1730, Tunisia 1720, South Africa 1710, Panama 1700, Qatar 1700,
Saudi Arabia 1700, Uzbekistan 1690, Iraq 1660, Jordan 1650, Cape Verde 1630,
New Zealand 1620, Curacao 1580, Haiti 1560
```

These are the **single biggest lever** in the model, and the one thing to adjust
if you disagree with how a team is valued.

A small **"floor calibration"** then nudges the genuine minnows down a bit further
(Haiti and Curaçao −110, New Zealand −80, Cape Verde −70, Jordan −60, and a few
others). Without this, the weakest teams banked too many points from upset wins
they'd almost never get in reality.

### 5. The goal model assumptions — *set by hand*
Three numbers control how ratings turn into goals:

| Constant | Value | What it does |
|---|---|---|
| `MU` | 1.2 | Baseline goals per team per game (≈ 2.8 total, matching real World Cup averages of ~2.5–2.9) |
| `K` | 0.9 | How strongly the rating gap skews the result — higher means fewer upsets and a wider spread |
| `ET` | 0.33 | Extra time is ~33% the length of regulation, so goals come at ~⅓ the rate |

---

## How a single match is simulated

This is the heart of the model. For any matchup, we convert the two teams'
ratings into an **expected number of goals** for each side, then draw an actual
scoreline at random around those expectations.

**Step 1 — expected goals.** A team's expected goals rises the more it
out-rates its opponent:

> expected goals for A = `1.2 × e^(0.9 × (rating_A − rating_B) / 400)`

The `/400` and the exponential are the standard Elo shape: a 400-point rating
edge is a big deal, a 20-point edge barely moves the needle. Two evenly-matched
teams each expect about 1.2 goals; a strong favorite expects more and pins its
opponent down to less.

*Example — France (2080) vs. Haiti (1450 after floor calibration):*
- France expects ≈ **5.3 goals**
- Haiti expects ≈ **0.27 goals**

**Step 2 — draw an actual scoreline.** Real matches aren't decided by averages —
a team expecting 1.2 goals sometimes scores 0, sometimes 3. We model each team's
goals as a **Poisson draw** around its expected value (Poisson is the standard,
well-tested choice for counting goals in soccer). So France "expecting 5.3" might
come out 6–0 one simulation, 3–1 the next, and very occasionally 1–1.

**Step 3 — score it.** The resulting scoreline is run through the fantasy rules
above. A simulated 3–0 group win is worth 6 (win) + 1 (clean sheet) + 1 (2+ goals)
+ 1 (won by 2+) = **9 points** to the winner, 0 to the loser.

Because we draw realistic scorelines rather than just declaring a winner, all the
bonus categories — clean sheets, 2+/4+ goals, winning by 2 — fall out naturally at
believable rates. We never have to hand-estimate "how often does Brazil keep a
clean sheet"; the goal model produces it.

### Knockouts: extra time and penalties
Knockout games are scored slightly differently (a draw isn't possible — someone
advances):

- If the 90-minute score is **level**, the game goes to **extra time**: each team
  gets another short Poisson draw at the reduced (⅓) rate, and both sides earn the
  "reached extra time" bonus.
- If it's **still level** after extra time, it goes to **penalties** (both sides
  earn that bonus too), and the **winner is decided by the ratings** — the stronger
  team is more likely, but not certain, to win the shootout. (When a real shootout
  has already happened, we use the actual winner instead.)
- Advancing in a knockout is worth 6 points (in place of the "win" points), plus
  the same goal/clean-sheet/margin bonuses as the group stage.

---

## From one match to a full tournament

Each of the 20,000 simulations plays out a complete, internally-consistent
tournament:

1. **Group stage** — every group game is played (real results locked in,
   the rest simulated). Standings are computed with the usual tiebreakers
   (points, then goal difference, then goals scored, then rating).
2. **Qualification** — the top 2 from each group plus the 8 best third-place
   teams advance to the Round of 32. (Or, once the real Round of 32 is set, that
   exact list is used.)
3. **Knockout rounds** — Round of 32 → 16 → Quarter-Final → Semi-Final → Final,
   each played out with the knockout rules above, using real pairings where known
   and random pairings among survivors where not.
4. **Tally** — every team's points are summed and rolled up to its manager.

That whole sequence happens 20,000 times, each time producing one possible final
scoreboard.

---

## What the model reports

Across the 20,000 simulated tournaments, we don't just average — we keep the whole
distribution. For each **manager** that yields:

- **Mean** projected final points (the headline number)
- **Spread** — standard deviation, plus percentiles (5th / 25th / median / 75th /
  95th) so you can see a realistic floor-to-ceiling range, not just the average
- **A histogram** of possible final totals
- **Finish probabilities** — the share of simulations in which they came 1st, 2nd,
  3rd, etc. (the 1st-place share is their **title odds**)
- **Stage-by-stage trajectory** — expected cumulative points after the group
  stage, after the Round of 32, and so on

For each **team** it yields:

- Mean and spread of fantasy points
- Average goals per game
- The full goal distribution (chance of scoring 0, 1, 2, … in a game)
- **Progression probabilities** — chance to advance from the group, reach the
  Round of 16, Quarter-Final, Semi-Final, Final, and **win the tournament**

A separate daily snapshot of every manager's title odds and projected points is
appended to `data/odds_history.js`, which is what drives the odds-over-time chart.

---

## What is *not* used (a common point of confusion)

- **Auction prices / "Draft Value" do not feed the projections.** The Draft Value
  view is a *separate, after-the-fact* comparison: it takes each team's projected
  mean points (from this model) and divides by what was paid for it, to show who
  was a bargain. Prices never influence the simulation — projections are based
  purely on team strength and the schedule.
- **No betting-market odds are used as inputs.** The "title odds" you see are an
  *output* of our simulation (how often each manager won across 20,000 runs), not
  imported from a sportsbook.

---

## Honest limitations

A model is only as good as its assumptions. The main ones to keep in mind:

- **The team ratings are hand-set judgment calls.** They're the dominant input. If
  a rating is wrong, that team's projection — and its owner's — is wrong with it.
- **There's a deliberate trade-off in the goal model.** The fairly high `K` that
  keeps minnows realistic (few flukey upset wins) also makes the simulated group
  draw rate a little low (~20% vs. a real ~25–30%), because pure strength-vs-strength
  matchups manufacture lopsided games. A single setting can't perfect both, and
  we chose realistic minnows over realistic draw frequency. This mostly nudges
  absolute point totals, not the **ranking** of managers, which is stable.
- **No injuries, suspensions, fatigue, weather, or in-tournament momentum** — each
  match depends only on the two ratings and the dice.
- **20,000 simulations** is plenty for stable means and the common probabilities,
  but the rarest outcomes (a minnow's tiny title chance, the extreme tails of the
  histogram) will wobble a little from one daily run to the next.

The single most important knob, by a wide margin, is the team-ratings table. If
you ever think a projection looks off, that's the first place to look.
