#!/usr/bin/env bash
set -euo pipefail

# run-profile-diff.sh — draft a unified diff against modes/_profile.md via claude -p.
#
# Usage: run-profile-diff.sh <patterns-file>
#
# Mirrors batch/run-draft-answers.sh: shells `claude -p` headlessly with a
# resolved system prompt that points the worker at the patterns JSON snapshot
# and the absolute path of modes/_profile.md. The worker emits a single
# `PROFILE_DIFF: {json}` stdout line followed by `PROFILE_DIFF_DONE: 1`. The
# server forwards both lines over SSE; the frontend parses the JSON payload and
# previews the diff.
#
# patterns-file is JSON: { patterns, profileMd, profilePath }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: run-profile-diff.sh <patterns-file>" >&2
  exit 2
fi

PATTERNS_FILE="$1"

# --- prerequisites ----------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not found in PATH. Install Claude Code to use profile-diff-draft." >&2
  exit 127
fi
if [[ ! -f "$PROJECT_DIR/modes/_profile.md" ]]; then
  echo "ERROR: $PROJECT_DIR/modes/_profile.md not found." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/app/server/prompts/profile-diff.md" ]]; then
  echo "ERROR: prompt template not found at $PROJECT_DIR/app/server/prompts/profile-diff.md." >&2
  exit 1
fi
if [[ ! -f "$PATTERNS_FILE" ]]; then
  echo "ERROR: patterns file not found: $PATTERNS_FILE" >&2
  exit 1
fi

PROFILE_PATH="$PROJECT_DIR/modes/_profile.md"

# --- build resolved system prompt ------------------------------------------
SYS_PROMPT="$(mktemp -t profile-diff-sys.XXXXXX)"
cleanup() {
  rm -f "$SYS_PROMPT" "$SYS_PROMPT.bak"
}
trap cleanup EXIT

cp "$PROJECT_DIR/app/server/prompts/profile-diff.md" "$SYS_PROMPT"

# Substitute placeholders. Match batch-runner.sh's escape pattern.
esc()  { local v="$1"; v="${v//\\/\\\\}"; v="${v//|/\\|}"; v="${v//&/\\&}"; printf '%s' "$v"; }
esc_patterns=$(esc "$PATTERNS_FILE")
esc_profile=$(esc "$PROFILE_PATH")

sed -i.bak \
  -e "s|{{PATTERNS_FILE}}|$esc_patterns|g" \
  -e "s|{{PROFILE_PATH}}|$esc_profile|g" \
  "$SYS_PROMPT"
rm -f "$SYS_PROMPT.bak"

USER_PROMPT="Draft a unified diff against modes/_profile.md using the rejection patterns in ${PATTERNS_FILE}. Follow the system prompt brief exactly: read the candidate files, then emit one PROFILE_DIFF: line followed by PROFILE_DIFF_DONE: 1."

cd "$PROJECT_DIR"
exec claude -p --dangerously-skip-permissions --append-system-prompt-file "$SYS_PROMPT" "$USER_PROMPT"
