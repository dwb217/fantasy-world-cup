# 🏆 Fantasy World Cup

A website for a draft-style fantasy World Cup league. Results are pulled from a
sports API every 4 hours, standings recompute automatically, and trusted editors
can correct results right in the app. No database, no build step.

## How it works

- Each manager drafted a set of national teams (`data/draft.js`).
- You enter match results; the site scores every owned team and rolls the points
  up into the manager standings.

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

## Viewing the site

Tabs:

- **Standings** — managers ranked by total points; click a manager to expand the per-team breakdown.
- **Teams** — every team, its owner, and its points.
- **Results** — the full match list, with an **Edit** mode for corrections (see below).
- **Rules** — the scoring reference.

The header shows a live **countdown to the next automatic update** and when the
results last changed.

## How results get in

### Automatic — pull from TheSportsDB every 4 hours

A script fetches the 2026 World Cup results from [TheSportsDB](https://www.thesportsdb.com)
and regenerates `data/matches.js`.

- `.github/workflows/update-scores.yml` runs `scripts/fetch_scores.js` every 4 hours and
  commits any changed scores. You can also trigger it manually from the repo's **Actions** tab.
- Run it yourself any time: `node scripts/fetch_scores.js` (Node 18+, no npm install needed).
- The free TheSportsDB key (`123`) works out of the box. For a premium key, add a repository
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
score, set a shootout winner, or toggle the extra-time / penalty flags, then **Save to repo**.

Saving POSTs to the `/api/save-result` serverless function, which commits the change to
`data/overrides.js` in the GitHub repo (gated by the password, using a server-side token).
Because edits live in `data/overrides.js` — which the importer applies on top of the API data
on every run — **your edits survive the automatic refreshes** instead of being overwritten.

## Deploying on Vercel

1. Push this repo to GitHub (already done if you're reading this there).
2. In Vercel, **Add New Project → import the repo.** It's a zero-config static site with a
   serverless function in `api/`; no build settings needed.
3. Add three **Environment Variables** (Project → Settings → Environment Variables — see
   `.env.example`):
   - `GH_TOKEN` — a fine-grained GitHub PAT with **Contents: read & write** on this repo
     ([create one](https://github.com/settings/tokens?type=beta))
   - `GH_REPO` — `dwb217/fantasy-world-cup`
   - `EDIT_PASSWORD` — the shared password editors will type to save
4. Redeploy. Every push (from the 4-hour Action *or* from a web-app edit) auto-deploys, so
   the live site stays current.

The GitHub Action handles the 4-hour score pulls (GitHub's cron is free and generous); the
Vercel function handles on-demand edits. Both just commit to the repo, which stays the single
source of truth.

## Files

```
index.html                       the page
styles.css                       styling
app.js                           scoring engine + UI (standings, editable results, countdown)
data/draft.js                    who drafted which teams
data/rules.js                    scoring rules (labels + points)
data/matches.js                  match results from the API (generated; has a "last updated" stamp)
data/overrides.js                corrections layered on top (shootout winners, fixes, manual games)
api/save-result.js               serverless function: commits edits to data/overrides.js
scripts/fetch_scores.js          TheSportsDB importer
scripts/config.js                league id, season, rounds, status codes
scripts/team_aliases.js          API team name -> draft name map
.github/workflows/update-scores.yml   runs the importer every 4 hours
.env.example                     the env vars the serverless function needs
```
