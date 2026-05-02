#!/usr/bin/env bash
set -euo pipefail

# run-draft-answers.sh — draft application answers via claude -p.
#
# Usage: run-draft-answers.sh <report-num> <slug> <date> <fields-file>
#
# Mirrors batch/run-generate-cv.sh: shells `claude -p` headlessly with a
# resolved system prompt that points the worker at modes/_profile.md, cv.md,
# article-digest.md (when present), and the report markdown for this role.
# The worker reads the fields-file, drafts each answer, and emits one
# `DRAFT: {json}` stdout line per answer. The server parses those lines and
# writes data/applications/<reportId>/drafts.json on completion.
#
# fields-file is JSON: { reportId, applyUrl?, fields: ScrapedField[] }
# (the orchestrator wrote it before invoking this script).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ $# -lt 4 ]]; then
  echo "Usage: run-draft-answers.sh <report-num> <slug> <date> <fields-file>" >&2
  exit 2
fi

REPORT_NUM="$1"
SLUG="$2"
DATE="$3"
FIELDS_FILE="$4"

# --- prerequisites ----------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not found in PATH. Install Claude Code to use draft-answers." >&2
  exit 127
fi
if [[ ! -f "$PROJECT_DIR/cv.md" ]]; then
  echo "ERROR: $PROJECT_DIR/cv.md not found." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/modes/_profile.md" ]]; then
  echo "ERROR: $PROJECT_DIR/modes/_profile.md not found." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/app/server/prompts/draft-answers.md" ]]; then
  echo "ERROR: prompt template not found at $PROJECT_DIR/app/server/prompts/draft-answers.md." >&2
  exit 1
fi
if [[ ! -f "$FIELDS_FILE" ]]; then
  echo "ERROR: fields file not found: $FIELDS_FILE" >&2
  exit 1
fi

# Zero-pad the report number to 3 digits to match the reports/ filename
# convention (reports/001-slug-2026-04-22.md), so the system prompt can name
# the exact file the worker should read.
printf -v REPORT_NUM_PADDED "%03d" "$REPORT_NUM"

# --- build resolved system prompt ------------------------------------------
SYS_PROMPT="$(mktemp -t draft-answers-sys.XXXXXX)"
cleanup() {
  rm -f "$SYS_PROMPT" "$SYS_PROMPT.bak"
}
trap cleanup EXIT

cp "$PROJECT_DIR/app/server/prompts/draft-answers.md" "$SYS_PROMPT"

# Substitute placeholders. Match batch-runner.sh's escape pattern: backslashes
# and the sed delimiter (|) need backslash-escaping; & means "matched text" in
# sed replacements so it must be escaped too.
esc()  { local v="$1"; v="${v//\\/\\\\}"; v="${v//|/\\|}"; v="${v//&/\\&}"; printf '%s' "$v"; }
esc_num=$(esc "$REPORT_NUM")
esc_padded=$(esc "$REPORT_NUM_PADDED")
esc_slug=$(esc "$SLUG")
esc_date=$(esc "$DATE")
esc_fields=$(esc "$FIELDS_FILE")

sed -i.bak \
  -e "s|{{REPORT_NUM_PADDED}}|$esc_padded|g" \
  -e "s|{{REPORT_NUM}}|$esc_num|g" \
  -e "s|{{SLUG}}|$esc_slug|g" \
  -e "s|{{DATE}}|$esc_date|g" \
  -e "s|{{FIELDS_FILE}}|$esc_fields|g" \
  "$SYS_PROMPT"
rm -f "$SYS_PROMPT.bak"

USER_PROMPT="Draft application answers for report #${REPORT_NUM} (slug: ${SLUG}, date: ${DATE}). The fields are in ${FIELDS_FILE}. Follow the system prompt brief exactly: read the candidate files, then emit one DRAFT: line per question, then a final DRAFT_ANSWERS_DONE: line."

cd "$PROJECT_DIR"
exec claude -p --dangerously-skip-permissions --append-system-prompt-file "$SYS_PROMPT" "$USER_PROMPT"
