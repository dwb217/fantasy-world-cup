# 🏆 Fantasy World Cup

A website for a draft-style fantasy World Cup league. Results are pulled from a
sports API automatically as soon as each match finishes, standings and
projections recompute on their own, an LLM writes a daily commentary blog, and
trusted editors can correct results right in the app. No database, no build
step — just static files plus one Vercel serverless function.

## How it works

- Each manager drafted a set of national teams (`data/draft.js`).
- Match results land in `data/matches.js`; the site scores every owned team and
  rolls the points up into the manager standings. The repo is the single source
  of truth — there's no browser storage.

### Scoring (per team, per match)

| Points | For |
|---|---|
| 6 | Win |
| 2 | Draw *(group stage only)* |
| 1 | Clean sheet |
| 1 | Scored 2+ goals |
| 1 | Scored 4+ goals |
| 1 | Won by 2+ goals |
| 1 | Reached extra time (knockout) |
| 1 | Reached penalties (knockout) |

Bonuses stack. Example: a **4–0 group win** = 6 + 1 (clean sheet) + 1 (2+ goals)
+ 1 (4+ goals) + 1 (won by 2+) = **10 points**.

**Knockout round:** there are no draws. The team that advances (higher score, or
the penalty-shootout winner if level after extra time) gets the Win; the other
team gets 0 for the win/draw category. Both still earn any extra-time / penalty
bonuses. Penalty-shootout goals do **not** count toward goal totals — use the
score at the end of extra time.

## The tabs

- **Standings** — managers ranked by total points; click a manager to expand the per-team breakdown.
- **Projections** — Monte-Carlo simulation of the rest of the tournament: each manager's title-win odds and projected final points, plus a **"title odds over time"** chart. Conditioned on reality — played matches are locked at their actual scores, only the remaining games are simulated.
- **Teams** — every team, its owner, and its points.
- **Draft Value** — auction prices (`data/prices.js`) vs. projected value: biggest steals and busts, and each manager's points-per-dollar efficiency.
- **Results** — the full match list, with an **✎ Edit** mode for corrections (see below).
- **Game Points** — per match, the fantasy points each involved manager earned, with the itemized bonus breakdown.
- **Commentary** — a daily, auto-written blog recapping/previewing the league (see below).
- **Rules** — the scoring reference.

The header status line shows which match is currently under way (or the next
kickoff time) and when the results last changed. The whole site is
**password-gated** (Edge middleware + `api/login.js`), reusing the `EDIT_PASSWORD`.

## How results get in

### Automatic — event-driven pull from TheSportsDB

Results import from [TheSportsDB](https://www.thesportsdb.com) as soon as
possible after full time, then everything downstream updates in the same run.

- **`.github/workflows/update-scores.yml`** wakes every 20 minutes but only calls the
  API when it's worth it: `scripts/should_fetch.js` gates each run to when there's an
  unscored match dated today/yesterday (UTC) that kicked off 2+ hours ago. Polling starts
  ~2h after kickoff and retries every 20 min until the final lands — **including games that
  finish after midnight** (eligibility is bounded by date, not a fixed post-game window).
- When a fetch brings in a new result, the **same run rebuilds the Monte-Carlo projections**
  (`scripts/build_projections.js`) and commits `matches.js` + `projections.js` +
  `odds_history.js` together, so the odds move with the scores. The commit triggers a Vercel
  deploy and the whole app refreshes on its own.
- **`.github/workflows/update-projections.yml`** does a full daily refresh at **09:30 UTC**
  (re-fetches fixtures/kickoffs, re-runs projections, guarantees one odds-history point per
  day even on gameless days).
- Run the importer yourself any time: `node scripts/fetch_scores.js` (Node 18+, no npm install).
  The free TheSportsDB key (`123`) works out of the box; for a premium key add a repository
  secret named `SPORTSDB_KEY`.

**Two things the API can't give us, and how they're handled:**

1. **Team names** that differ from the draft (e.g. "Czech Republic" → "Czechia") are
   translated in `scripts/team_aliases.js`; a new mismatch prints a warning telling you what to add.
2. **Penalty-shootout winners.** The API gives the after-extra-time score and a status code
   (so the +1 extra-time / +1 penalties bonuses are detected automatically) but **not who won
   the shootout.** A level knockout match is flagged with its `eventId` for you to resolve —
   easiest in the **Results → Edit** screen, or by hand in `data/overrides.js`.

### Editing results in the web app

The **Results** tab has an **✎ Edit** mode. Anyone with the **edit password** can fix a
score, set a shootout winner, toggle the extra-time / penalty flags, or **add a match the API
missed**, then **Save to repo**.

Saving POSTs to the `/api/save-result` serverless function, which commits the change to
`data/overrides.js` in the GitHub repo (gated by the password, using a server-side token).
Because edits live in `data/overrides.js` — which the importer applies on top of the API data
on every run — **your edits survive the automatic refreshes** instead of being overwritten.

## Commentary (the daily blog)

A vulgar, VEEP/South-Park-style pundit roasts the seven managers every morning.

- **`.github/workflows/update-commentary.yml`** runs daily at **10:00 UTC = 6:00am EDT**
  (just after the projections refresh, so the day's odds point exists). It generates one new
  dated entry and commits `data/commentary.js`.
- Generation uses **[Ollama Cloud](https://ollama.com)** (model `gpt-oss:120b`). The script
  reads the live standings, day-over-day title odds, and today's not-yet-played fixtures, and
  the model uses them as ammunition for jokes (it previews the day's slate rather than reciting
  scores). Requires an `OLLAMA_API_KEY` repository secret.
- Run it locally instead with a local Ollama daemon: `node scripts/build_commentary.js`
  (no `OLLAMA_API_KEY` → talks to `localhost:11434`; pass a model tag or set `OLLAMA_MODEL`
  to override).

## Deploying on Vercel

1. Push this repo to GitHub (already done if you're reading this there).
2. In Vercel, **Add New Project → import the repo.** Zero-config static site with a
   serverless function in `api/` and Edge middleware; no build settings needed.
3. Add three **Environment Variables** (Project → Settings → Environment Variables — see
   `.env.example`):
   - `GH_TOKEN` — a fine-grained GitHub PAT with **Contents: read & write** on this repo
     ([create one](https://github.com/settings/tokens?type=beta))
   - `GH_REPO` — `dwb217/fantasy-world-cup`
   - `EDIT_PASSWORD` — the shared password (gates both the site and saving edits)
4. Add the **GitHub repository secrets** the Actions need (repo → Settings → Secrets → Actions):
   - `OLLAMA_API_KEY` — Ollama Cloud key for the commentary job ([create one](https://ollama.com/settings/keys))
   - `SPORTSDB_KEY` — *optional*, a premium TheSportsDB key
5. Redeploy. Every push (from an Action *or* a web-app edit) auto-deploys, so the live site
   stays current.

GitHub Actions handle the score pulls, daily projections, and daily commentary (GitHub's
cron is free and generous); the Vercel function handles on-demand edits. Everything just
commits to the repo, which stays the single source of truth.

## Files

```
index.html                       the page
styles.css                       styling
middleware.js                    Edge auth gate for the whole site
app.js                           scoring engine + UI (all tabs)
data/draft.js                    who drafted which teams
data/rules.js                    scoring rules (labels + points)
data/prices.js                   auction prices (Draft Value tab)
data/matches.js                  match results from the API (generated; has a "last updated" stamp)
data/overrides.js                corrections layered on top (shootout winners, fixes, manual games)
data/projections.js              Monte-Carlo title odds + projected points (generated)
data/odds_history.js             one title-odds snapshot per day (generated; drives the chart)
data/commentary.js               the daily blog entries (generated)
api/save-result.js               serverless function: commits edits to data/overrides.js
api/login.js                     sets the auth cookie for the password gate
scripts/fetch_scores.js          TheSportsDB importer
scripts/should_fetch.js          gate: is an API call worth it right now?
scripts/build_projections.js     Monte-Carlo projections + odds history
scripts/build_commentary.js      LLM commentary generator (Ollama Cloud or local Ollama)
scripts/config.js                league id, season, rounds, status codes, knockout windows
scripts/team_aliases.js          API team name -> draft name map
.github/workflows/update-scores.yml        event-driven score import (+ projections rebuild)
.github/workflows/update-projections.yml   daily 09:30 UTC projections refresh
.github/workflows/update-commentary.yml    daily 06:00 EDT commentary via Ollama Cloud
.env.example                     the env vars the serverless function needs
```
