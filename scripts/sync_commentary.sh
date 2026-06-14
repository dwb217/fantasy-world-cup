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
MARKER="$HOME/.fwc_commentary_last_run"   # records the last UTC date we generated for
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"  # cron/launchd has a bare PATH

# `--force` (or FORCE=1) bypasses the UTC gate for manual testing.
FORCE="${FORCE:-0}"
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi
MODEL="${1:-${OLLAMA_MODEL:-qwen3.6:27b}}"   # avoid gemma4:12b-mlx (its MLX runner wedges)

cd "$REPO"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }

# 0. UTC gate: run at most once per UTC day, only at/after 12:00 UTC. launchd
# polls every 10 min (see the plist), so the real work fires at the first poll
# at/after noon UTC — and if the Mac was asleep/off then, at the first poll
# after it wakes. Pure-UTC, so it's immune to daylight-saving shifts. The marker
# is written only after a successful generation, so a transient failure (e.g.
# Ollama down at noon) just retries on the next poll instead of being skipped.
TODAY_UTC="$(date -u +%Y-%m-%d)"
HOUR_UTC=$((10#$(date -u +%H)))   # 10# forces base-10 so "08"/"09" don't error
if [ "$FORCE" != "1" ]; then
  if [ "$(cat "$MARKER" 2>/dev/null || true)" = "$TODAY_UTC" ]; then
    exit 0   # already generated today
  fi
  if [ "$HOUR_UTC" -lt 12 ]; then
    exit 0   # before noon UTC — wait for a later poll
  fi
fi

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

# Mark this UTC day done so later polls don't regenerate.
echo "$TODAY_UTC" > "$MARKER"
log "Done for $TODAY_UTC."
