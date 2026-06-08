# 🏆 Fantasy World Cup

A self-contained website for a draft-style fantasy World Cup league. Standings
recompute automatically from match results — no server, no database, no build step.

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

Just open `index.html` in a browser (double-click works). Tabs:

- **Standings** — managers ranked by total points; click a manager to expand the per-team breakdown.
- **Teams** — every team, its owner, and its points.
- **Matches** — log of all results with points awarded.
- **Add Result** — enter scores in the browser.
- **Rules** — the scoring reference.

## Getting results in

There are two ways results reach the site. You can use either or both.

### Automatic — pull from TheSportsDB every 4 hours (recommended)

A script fetches the 2026 World Cup results from [TheSportsDB](https://www.thesportsdb.com)
and regenerates `data/matches.js`. A GitHub Actions workflow runs it on a schedule.

- Run it yourself any time: `node scripts/fetch_scores.js` (Node 18+; no npm install needed).
- Scheduled: `.github/workflows/update-scores.yml` runs every 4 hours, commits any
  changed scores, and — if the repo serves the site via GitHub Pages — auto-publishes.
  You can also trigger it manually from the repo's **Actions** tab.
- The free TheSportsDB key (`123`) works out of the box. To use a premium key, add a
  repository secret named `SPORTSDB_KEY`.

**Two things the API can't give us, and how they're handled:**

1. **Team names** that differ from the draft (e.g. "Czech Republic" → "Czechia") are
   translated in `scripts/team_aliases.js`. If a new mismatch ever appears, the script
   prints a warning telling you exactly what to add.
2. **Penalty-shootout winners.** The API provides the after-extra-time score and a status
   (so the +1 extra-time and +1 penalties bonuses are detected automatically) but **not
   who won the shootout.** When a knockout match ends level, the script flags it with its
   `eventId`. Resolve it in `data/overrides.js`:
   ```js
   byEventId: {
     "1665716": { shootoutWinner: "Argentina" },
   }
   ```
   Overrides also let you correct a wrong score or force the extra-time/penalty flags.
   **`data/overrides.js` is never overwritten** — your corrections persist across refreshes.

### Manual — enter a result by hand

- **In the browser:** go to the **Add Result** tab, enter the match (it updates instantly),
  then click **⬇ Download matches.js** and replace the file. Manual entries are tagged
  `source:"manual"` and are **preserved** when the automatic importer runs.
- **Or** add a full match to `manualMatches` in `data/overrides.js` (handy for anything
  the API is missing entirely).

> The importer treats `data/matches.js` as generated output: it refreshes all
> TheSportsDB matches, keeps your manual ones, and applies your overrides.

## Publishing (free)

Any static host works. Easiest options:

- **GitHub Pages:** push this folder to a repo, enable Pages on the `main` branch.
- **Netlify / Vercel / Cloudflare Pages:** drag-and-drop the folder, or connect the repo.

Because everything is static, hosting is free and the standings update for
everyone whenever you publish a new `data/matches.js`.

## Files

```
index.html                       the page
styles.css                       styling
app.js                           scoring engine + UI
data/draft.js                    who drafted which teams
data/rules.js                    scoring rules (labels + points)
data/matches.js                  match results that drive the site (generated + manual)
data/overrides.js                hand-maintained corrections (shootout winners, etc.)
scripts/fetch_scores.js          TheSportsDB importer
scripts/config.js                league id, season, rounds, status codes
scripts/team_aliases.js          API team name -> draft name map
.github/workflows/update-scores.yml   runs the importer every 4 hours
```

## Note on the 4-hour automation

The scheduled refresh needs an always-on runner, which is what GitHub Actions
provides for free — so to get true hands-off updates, the project should live in a
GitHub repo (serving the site via GitHub Pages is the simplest pairing). If you'd
rather not use GitHub, you can run `node scripts/fetch_scores.js` on any machine on
a schedule (e.g. macOS `launchd`/`cron`), but it only updates while that machine is on.
