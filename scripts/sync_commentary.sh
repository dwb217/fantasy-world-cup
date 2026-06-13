#!/usr/bin/env bash
# Two-way daily sync for the commentary blog:
#   1. pull the latest SCORES down from GitHub (matches/projections/odds_history,
#      written by the GitHub Actions cron)
#   2. generate/refresh today's commentary entry with the local Ollama model
#   3. push the regenerated data/commentary.js back up to GitHub
#
# The cron and this script write DIFFERENT files, so the pull and push never
# conflict. Safe to run repeatedly; re-running the same day just refreshes that
# day's entry. Run by the launchd agent (com.fantasywc.commentary), or by hand.
#
# Usage:  scripts/sync_commentary.sh [model-tag]
set -euo pipefail

REPO="/Users/dwb/Code/fantasy_world_cup"
MODEL="${1:-${OLLAMA_MODEL:-gemma4:12b-mlx}}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"  # cron/launchd has a bare PATH

cd "$REPO"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }

# 1. Make sure Ollama is up before we bother pulling.
if ! curl -sf http://localhost:11434/api/tags >/dev/null; then
  log "Ollama not reachable at localhost:11434 — skipping run."
  exit 0
fi

# 2. Pull latest scores down (autostash guards any stray local changes).
log "Pulling latest from origin…"
git pull --rebase --autostash

# 3. Generate / refresh today's entry.
log "Generating commentary with ${MODEL}…"
node scripts/build_commentary.js "$MODEL"

# 4. Push commentary up only if it actually changed.
if [[ -n "$(git status --porcelain data/commentary.js)" ]]; then
  git add data/commentary.js
  git commit -m "Update commentary ($(date -u +'%Y-%m-%d'))"
  git push
  log "Pushed updated commentary."
else
  log "No commentary change — nothing to push."
fi
