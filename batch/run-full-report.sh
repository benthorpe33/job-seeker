#!/usr/bin/env bash
set -euo pipefail

# run-full-report.sh — promote a triage stub to a full Block A-G report.
#
# Usage: run-full-report.sh <reportNum> <slug> <date> <url>
#
# Mirrors batch/run-generate-cv.sh: shells `claude -p` headlessly with a
# self-contained system prompt (NO Phase-1 splice — single-pass full eval).
# The worker rewrites the existing reports/<num>-<slug>-<date>.md in place
# with full Blocks A-G + a refined Score Global, then prints
# `FULL_REPORT_DONE: <abs-path-to-report>` on its own final stdout line so
# the server can re-parse the file and reconcile applications.md's score.
#
# Why bypass batch-runner.sh: that runner always assigns max+1 for the
# report number via reserve_report_num_unlocked, so re-running it would
# create a NEW report file with a different number — orphaning the stub
# and breaking live-update (different DB id). Single-pass overwrite
# preserves the report id/filename so the watcher's upsertReport
# (DELETE + INSERT) updates the same DB row in place.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"

if [[ $# -lt 4 ]]; then
  echo "Usage: run-full-report.sh <reportNum> <slug> <date> <url>" >&2
  exit 2
fi

REPORT_NUM="$1"
SLUG="$2"
DATE="$3"
URL="$4"

REPORT_PATH="$PROJECT_DIR/reports/${REPORT_NUM}-${SLUG}-${DATE}.md"

# --- prerequisites ----------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not found in PATH. Install Claude Code to use full-report." >&2
  exit 127
fi
if [[ ! -f "$PROJECT_DIR/cv.md" ]]; then
  echo "ERROR: $PROJECT_DIR/cv.md not found." >&2
  exit 1
fi
if [[ ! -f "$REPORT_PATH" ]]; then
  echo "ERROR: $REPORT_PATH not found — cannot promote a stub that doesn't exist." >&2
  exit 1
fi

mkdir -p "$LOGS_DIR"

# --- build resolved system prompt ------------------------------------------
SYS_PROMPT="$(mktemp -t full-report-sys.XXXXXX)"
cleanup() {
  rm -f "$SYS_PROMPT" "$SYS_PROMPT.bak"
}
trap cleanup EXIT

cat > "$SYS_PROMPT" <<'PROMPT'
# Promote-Stub-to-Full — Server Orchestrator Brief

You are a NON-INTERACTIVE worker invoked by the job_seeker server. The user already had a triage stub at the report path below (Block A + B only, no C/D, no `## G)` section). They have decided the stub deserves the full Opus eval. Produce a complete Block A-G report that OVERWRITES the existing file in place.

## Inputs (substituted by the orchestrator)
- **Report path (must overwrite):** {{REPORT_PATH}}
- **JD URL:** {{URL}}
- **Company slug:** {{SLUG}}
- **Date (YYYY-MM-DD):** {{DATE}}
- **Report number:** {{REPORT_NUM}}

## Authoritative recipes
- Load `CLAUDE.md`, `CLAUDE.local.md`, `modes/_profile.md`, and `modes/_shared.md` for scoring, archetype priorities, and Block-G legitimacy guidance.
- Read `cv.md` and (if present) `article-digest.md` for proof points. NEVER fabricate experience or metrics.
- Read the existing stub at `{{REPORT_PATH}}` for context — Block A + Block B carry useful signal that you may refine but should not contradict without good cause. The stub's Score is the triage-pass guess; you are producing the canonical refined Score.

## Required output
Rewrite `{{REPORT_PATH}}` with a complete Block A-G report. Header must be (one field per line, exactly this order):

- `# Evaluation: {Company} — {Role}`
- `**Date:** {{DATE}}` · `**Archetype:** {archetype}` · `**Score:** {refined X.X}/5`.
- `**Legitimacy:** {refined tier} — {1-line reason}`.
- `**URL:** {{URL}}` · `**PDF:** ❌ (on-demand via /career-ops pdf)`.
- `**Personalization & Interview Plan:** ❌ (on-demand via /career-ops personalize and /career-ops interview-prep)`.
- `**Promoted from stub:** true` (replaces any prior `**Batch ID:** N` line — leave the line in place if absent).

Body sections (≤900 words excluding tables):
- `## A) Role Summary` (≤150 words; refine the stub's A if needed)
- `## B) CV Match` (gaps and proof points; refine the stub's B if needed)
- `## C) Level & Strategy` (≤150 words; level detected, "sell senior" plan, downlevel plan)
- `## D) Comp & Demand` (≤150 words; **WebSearch budget ≤1 query** — if the JD publishes a range, skip the WebSearch entirely; comp table ≤3 rows: posting / external / landing estimate)
- `## Score Global (refined)` table with dimensions: CV match, North Star alignment, Comp, Cultural signals, Red flags (negative), **Global**.

Block G (Posting Legitimacy) is encoded in the `**Legitimacy:** {tier} — {reason}` header line ONLY. Do NOT add a `## G)` body section.

End with:
- `## Keywords` — 15-20 JD keywords, comma-separated.

After the file is written, on its OWN final stdout line print exactly:
`FULL_REPORT_DONE: {{REPORT_PATH}}`

## Hard rules
- Make EXACTLY ONE `Write` call to `{{REPORT_PATH}}`, at the very end, after all analysis (Blocks A-G + refined Score) is complete in your context. No intermediate edits — if the orchestrator cancels mid-job (SIGTERM), the existing stub must remain untouched. Do NOT use `Edit` for partial updates.
- The filename and `{{REPORT_NUM}}` MUST stay the same.
- DO NOT mutate `data/applications.md`, `batch/batch-state.tsv`, `batch/batch-input.tsv`, or `batch/tracker-additions/`. The server reconciles applications.md's score column itself after you exit 0.
- DO NOT generate a PDF or invoke `generate-pdf.mjs`.
- DO NOT submit anything, contact anyone, or open browser windows.
- If the JD URL is closed/expired, abort: print `FULL_REPORT_FAILED: <one-line reason>` and exit non-zero. Leave the stub untouched.
- Phone number stays out of any drafted outbound text per `modes/_profile.md` rule 5.

## Engagement style
Run silently. Stream concise progress so the JobLogPanel viewer can follow. No clarifying questions. If the JD URL is a Greenhouse `boards-api.greenhouse.io` or Ashby `api.ashbyhq.com/posting-api` endpoint, hit the API directly per the project's ATS conventions; otherwise WebFetch the page.
PROMPT

# Substitute placeholders. Match batch-runner.sh's escape pattern: backslashes
# and the sed delimiter (|) need backslash-escaping; & means "matched text" in
# sed replacements so it must be escaped too.
esc()  { local v="$1"; v="${v//\\/\\\\}"; v="${v//|/\\|}"; v="${v//&/\\&}"; printf '%s' "$v"; }
esc_url=$(esc "$URL")
esc_slug=$(esc "$SLUG")
esc_date=$(esc "$DATE")
esc_num=$(esc "$REPORT_NUM")
esc_path=$(esc "$REPORT_PATH")

sed -i.bak \
  -e "s|{{URL}}|$esc_url|g" \
  -e "s|{{SLUG}}|$esc_slug|g" \
  -e "s|{{DATE}}|$esc_date|g" \
  -e "s|{{REPORT_NUM}}|$esc_num|g" \
  -e "s|{{REPORT_PATH}}|$esc_path|g" \
  "$SYS_PROMPT"
rm -f "$SYS_PROMPT.bak"

USER_PROMPT="Promote stub report #$REPORT_NUM (slug: $SLUG, date: $DATE, URL: $URL) to a full Block A-G evaluation. Overwrite $REPORT_PATH in place per the system prompt. Print 'FULL_REPORT_DONE: $REPORT_PATH' as the final stdout line."

cd "$PROJECT_DIR"
exec claude -p --dangerously-skip-permissions --model claude-opus-4-5 --append-system-prompt-file "$SYS_PROMPT" "$USER_PROMPT"
