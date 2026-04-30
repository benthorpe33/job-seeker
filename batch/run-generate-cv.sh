#!/usr/bin/env bash
set -euo pipefail

# run-generate-cv.sh — orchestrate a per-report tailored CV PDF.
#
# Usage: run-generate-cv.sh <reportNum> <slug> <date> <url>
#
# Mirrors batch/batch-runner.sh: shells `claude -p` headlessly with a system
# prompt that points at modes/pdf.md (the canonical recipe). Claude does the
# JD fetch, tailoring, HTML render, and final `node generate-pdf.mjs` call.
# When done, Claude prints `GENERATE_CV_DONE: <pdf-path>` on its own line so
# the server can reconcile the applications.md PDF column.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"

if [[ $# -lt 4 ]]; then
  echo "Usage: run-generate-cv.sh <reportNum> <slug> <date> <url>" >&2
  exit 2
fi

REPORT_NUM="$1"
SLUG="$2"
DATE="$3"
URL="$4"

# --- prerequisites ----------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not found in PATH. Install Claude Code to use generate-cv." >&2
  exit 127
fi
if [[ ! -f "$PROJECT_DIR/cv.md" ]]; then
  echo "ERROR: $PROJECT_DIR/cv.md not found." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/modes/pdf.md" ]]; then
  echo "ERROR: $PROJECT_DIR/modes/pdf.md not found." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/config/profile.yml" ]]; then
  echo "ERROR: $PROJECT_DIR/config/profile.yml not found." >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/output" "$LOGS_DIR"

# --- build resolved system prompt ------------------------------------------
SYS_PROMPT="$(mktemp -t generate-cv-sys.XXXXXX)"
cleanup() {
  rm -f "$SYS_PROMPT" "$SYS_PROMPT.bak"
}
trap cleanup EXIT

cat > "$SYS_PROMPT" <<'PROMPT'
# Generate CV — Server Orchestrator Brief

You are a NON-INTERACTIVE worker invoked by the job_seeker server. Produce a tailored, ATS-optimized CV PDF for the job offer below. Do not ask questions; execute end-to-end.

## Authoritative recipe
Follow `modes/pdf.md` exactly (the "Full pipeline" section, steps 1-15). It is the single source of truth for what to read, how to tailor, what HTML to write, and how to invoke `generate-pdf.mjs`. Also load and respect `CLAUDE.md`, `CLAUDE.local.md`, and `modes/_profile.md`.

## Inputs (substituted by the orchestrator)
- **JD URL:** {{URL}}
- **Company slug:** {{SLUG}}
- **Date (YYYY-MM-DD):** {{DATE}}
- **Report number:** {{REPORT_NUM}}

## Required output
- The PDF MUST land at `output/cv-{candidate}-{{SLUG}}-{{DATE}}.pdf`, where `{candidate}` is `config/profile.yml`'s `candidate.full_name` normalized to kebab-case lowercase per `modes/pdf.md` step 13.
- After the PDF is written, on its OWN final stdout line print exactly:
  `GENERATE_CV_DONE: <absolute-path-to-pdf>`

## Hard rules
- DO NOT mutate `data/applications.md`, the tracker, or any data file. Only write the tailored HTML to `/tmp/` and the PDF to `output/`.
- DO NOT submit anything, contact anyone, or open browser windows.
- If the JD page is closed/expired, abort: print `GENERATE_CV_FAILED: <one-line reason>` on its own line and exit non-zero.
- If `cv.md` or `config/profile.yml` is missing, abort with `GENERATE_CV_FAILED: <reason>`.
- Phone number stays out of the rendered CV per `modes/_profile.md` rule 5 (profile.yml may have it for reference but the renderer must drop it).

## Engagement style
Run silently. Stream concise progress so the JobLogPanel viewer can follow. No clarifying questions. If the JD URL is a Greenhouse `boards-api.greenhouse.io` or Ashby `api.ashbyhq.com/posting-api` endpoint, hit the API directly per the project's ATS conventions; otherwise WebFetch the page.
PROMPT

# Substitute placeholders. Match batch-runner.sh's escape pattern: backslashes
# and the sed delimiter (|) need backslash-escaping; & means "matched text" in
# sed replacements so it must be escaped too. URL chars per RFC 3986 won't
# include backticks or unescaped $, but backslashes can show up in path-like
# slugs from upstream tools.
esc()  { local v="$1"; v="${v//\\/\\\\}"; v="${v//|/\\|}"; v="${v//&/\\&}"; printf '%s' "$v"; }
esc_url=$(esc "$URL")
esc_slug=$(esc "$SLUG")
esc_date=$(esc "$DATE")
esc_num=$(esc "$REPORT_NUM")

sed -i.bak \
  -e "s|{{URL}}|$esc_url|g" \
  -e "s|{{SLUG}}|$esc_slug|g" \
  -e "s|{{DATE}}|$esc_date|g" \
  -e "s|{{REPORT_NUM}}|$esc_num|g" \
  "$SYS_PROMPT"
rm -f "$SYS_PROMPT.bak"

USER_PROMPT="Generate a tailored CV PDF for report #$REPORT_NUM (slug: $SLUG, date: $DATE, URL: $URL). Follow the system prompt brief and modes/pdf.md exactly. Print 'GENERATE_CV_DONE: <pdf-path>' as the final stdout line."

cd "$PROJECT_DIR"
exec claude -p --dangerously-skip-permissions --append-system-prompt-file "$SYS_PROMPT" "$USER_PROMPT"
