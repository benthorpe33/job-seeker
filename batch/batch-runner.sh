#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for claude -p workers
# Reads batch-input.tsv, delegates each offer to a claude -p worker,
# tracks state in batch-state.tsv for resumability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
TRIAGE_PROMPT_FILE="$BATCH_DIR/batch-prompt-triage.md"
FULL_PROMPT_FILE="$BATCH_DIR/batch-prompt-full.md"
LOGS_DIR="$BATCH_DIR/logs"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
TRIAGE_THRESHOLD=3.5
# Two-pass split (js-ah3): triage call (cheap) decides whether to pay for the full pass.
TRIAGE_MODEL="claude-haiku-4-5-20251001"
FULL_MODEL="claude-opus-4-5"

usage() {
  cat <<'USAGE'
career-ops batch runner — process job offers in batch via claude -p workers

Two-pass architecture (js-ah3):
  1. Triage pass — cheap model emits Phase 1 (Block A + B + Score Global). If
     Score < --triage-threshold, the triage worker writes a stub report and
     tracker line itself; the full pass is skipped.
  2. Full pass — strong model reads the Phase 1 fragment, runs Blocks C/D/G,
     refines the score, and writes the final report + tracker line.

Default models: triage=claude-haiku-4-5-20251001, full=claude-opus-4-5.

Usage: batch-runner.sh [OPTIONS]

Options:
  --parallel N           Number of parallel workers (default: 1)
  --dry-run              Show what would be processed, don't execute
  --retry-failed         Only retry offers marked as "failed" in state
  --start-from N         Start from offer ID N (skip earlier IDs)
  --max-retries N        Max retry attempts per offer (default: 2)
  --min-score N          Skip tracker for offers scoring below N (default: 0 = off)
  --triage-threshold N   Score threshold for full-vs-stub report (default: 3.5;
                         0 disables the gate and forces the full pass on every offer)
  --triage-model MODEL   Claude model for the triage pass (default: claude-haiku-4-5-20251001)
  --full-model MODEL     Claude model for the full pass (default: claude-opus-4-5)
  -h, --help             Show this help

Files:
  batch-input.tsv          Input offers (id, url, source, notes)
  batch-state.tsv          Processing state (auto-managed)
  batch-prompt-triage.md   Phase 1 prompt template
  batch-prompt-full.md     Phase 2 prompt template
  logs/                    Per-offer logs (.triage.log + .full.log per offer)
  tracker-additions/       Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./batch-runner.sh --dry-run

  # Process all pending with default split (Haiku triage, Opus full)
  ./batch-runner.sh

  # Force the full pass on every offer (no triage gate)
  ./batch-runner.sh --triage-threshold 0

  # Override the full-pass model (e.g. cheaper Opus or Sonnet)
  ./batch-runner.sh --full-model claude-sonnet-4-6

  # Retry only failed offers
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10
  ./batch-runner.sh --parallel 2 --start-from 10
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --triage-threshold) TRIAGE_THRESHOLD="$2"; shift 2 ;;
    --triage-model) TRIAGE_MODEL="$2"; shift 2 ;;
    --full-model) FULL_MODEL="$2"; shift 2 ;;
    --model)
      echo "ERROR: --model was removed in js-ah3. Use --triage-model and/or --full-model." >&2
      echo "       Triage default: $TRIAGE_MODEL · Full default: $FULL_MODEL" >&2
      exit 1
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$TRIAGE_PROMPT_FILE" ]]; then
    echo "ERROR: $TRIAGE_PROMPT_FILE not found."
    exit 1
  fi

  if [[ ! -f "$FULL_PROMPT_FILE" ]]; then
    echo "ERROR: $FULL_PROMPT_FILE not found."
    exit 1
  fi

  if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    # Don't bail on a transient mkdir failure where the dir doesn't exist
    # afterward — on Windows/MSYS this fires when a peer briefly held+released
    # the lock between our mkdir attempt and this check, or for filesystem
    # hiccups. Fall through to the wait loop; the timeout bounded by
    # STATE_LOCK_TIMEOUT_SECONDS is the real fail-safe.

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# Get status of an offer from state file
get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

# js-tt0: Get the last error message recorded for an offer in state. Used to
# detect the "phase-1 fragment missing or empty" pattern so the next retry can
# auto-upgrade the triage model away from Haiku (which silently skips the Write
# tool ~30% of the time on certain archetypes — see js-ivp).
get_last_error() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo ""
    return
  fi
  awk -F'\t' -v id="$id" '$1 == id { print $8 }' "$STATE_FILE"
}

# Calculate next report number.
# Caller must hold STATE_LOCK_DIR while this runs.
next_report_num_unlocked() {
  local max_num=0
  if [[ -d "$REPORTS_DIR" ]]; then
    for f in "$REPORTS_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      local basename
      basename=$(basename "$f")
      local num="${basename%%-*}"
      num=$((10#$num)) # Remove leading zeros for arithmetic
      if (( num > max_num )); then
        max_num=$num
      fi
    done
  fi
  # Also check state file for assigned report numbers
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" == "report_num" || "$rnum" == "-" || -z "$rnum" ]] && continue
      local n=$((10#$rnum))
      if (( n > max_num )); then
        max_num=$n
      fi
    done < "$STATE_FILE"
  fi
  printf '%03d' $((max_num + 1))
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  # Write header
  head -1 "$STATE_FILE" > "$tmp"

  # Process existing lines
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue  # skip header
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  if report_num=$(next_report_num_unlocked); then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

# Build a fully-resolved system-prompt file by substituting placeholders + facts pack.
# Args: prompt_template_path output_path facts_pack_path url jd_file report_num date id threshold phase1_file
build_resolved_prompt() {
  local template="$1" out="$2" facts="$3"
  local url="$4" jd_file="$5" report_num="$6" date="$7" id="$8" threshold="$9" phase1_file="${10}"

  local pre="${out}.pre"

  local esc_url esc_jd_file esc_report_num esc_date esc_id esc_threshold esc_phase1
  esc_url="${url//\\/\\\\}";              esc_url="${esc_url//|/\\|}"
  esc_jd_file="${jd_file//\\/\\\\}";      esc_jd_file="${esc_jd_file//|/\\|}"
  esc_report_num="${report_num//|/\\|}"
  esc_date="${date//|/\\|}"
  esc_id="${id//|/\\|}"
  esc_threshold="${threshold//|/\\|}"
  esc_phase1="${phase1_file//\\/\\\\}";   esc_phase1="${esc_phase1//|/\\|}"

  sed \
    -e "s|{{URL}}|${esc_url}|g" \
    -e "s|{{JD_FILE}}|${esc_jd_file}|g" \
    -e "s|{{REPORT_NUM}}|${esc_report_num}|g" \
    -e "s|{{DATE}}|${esc_date}|g" \
    -e "s|{{ID}}|${esc_id}|g" \
    -e "s|{{TRIAGE_THRESHOLD}}|${esc_threshold}|g" \
    -e "s|{{PHASE1_FILE}}|${esc_phase1}|g" \
    "$template" > "$pre"

  # Splice Facts Pack: replace the {{FACTS_PACK_MARKER}} line with the file contents.
  # awk avoids sed's pain with multi-line content + special chars.
  awk -v facts="$facts" '
    /^\{\{FACTS_PACK_MARKER\}\}$/ {
      while ((getline line < facts) > 0) print line
      close(facts)
      next
    }
    { print }
  ' "$pre" > "$out"
  rm -f "$pre"
}

# Extract the LAST JSON status line emitted by a worker. Worker JSON is
# identified by `"phase":"triage"` or `"phase":"full"` on the same line.
# `tail -1` grabs the actual emitted JSON (last) rather than an earlier echo
# of the prompt template.
extract_last_status_json() {
  local log_file="$1"
  grep -E '"phase":[[:space:]]*"(triage|full)"' "$log_file" 2>/dev/null | tail -1 || true
}

extract_score_from_json() {
  local json="$1"
  echo "$json" | sed -nE 's/.*"score":[[:space:]]*([0-9.]+).*/\1/p' | head -1
}

extract_stub_from_json() {
  local json="$1"
  echo "$json" | sed -nE 's/.*"stub":[[:space:]]*(true|false).*/\1/p' | head -1
}

extract_status_from_json() {
  local json="$1"
  echo "$json" | sed -nE 's/.*"status":[[:space:]]*"([a-z]+)".*/\1/p' | head -1
}

extract_error_from_json() {
  local json="$1"
  echo "$json" | sed -nE 's/.*"error":[[:space:]]*"([^"]+)".*/\1/p' | head -1
}

# js-hjz: A worker can exit 0 (and even claim status=completed) without ever
# writing the report file. Verify the report exists on disk before trusting
# the worker's self-report. Caller iterates report_num glob.
report_file_exists() {
  local report_num="$1"
  local f
  for f in "$REPORTS_DIR/${report_num}-"*.md; do
    [[ -f "$f" ]] && return 0
  done
  return 1
}

# js-vfb: Worker hallucination guard. The triage worker (Haiku 4.5 reliably,
# Opus 4.5 occasionally — observed 2026-05-04) sometimes writes a "completed"
# report whose body claims the JD was unavailable, then assigns a fabricated
# low score against no data. Symptom: report contains phrases like "JD content
# unavailable" / "JD fetch returned only title" while /tmp/batch-jd-{id}.txt
# is sitting on disk at full size. Catch and fail-with-retry rather than
# accept the bogus score.
#
# Threshold: only fires if the prefetched JD file is ≥1000 chars (some genuine
# postings have very short bodies; we don't want to false-fail on those).
report_claims_jd_missing() {
  local report_num="$1"
  local jd_file="$2"

  # JD must actually be substantial — short JDs can legitimately produce
  # "incomplete data" complaints.
  [[ -f "$jd_file" ]] || return 1
  local jd_size
  jd_size=$(wc -c < "$jd_file" 2>/dev/null || echo 0)
  (( jd_size >= 1000 )) || return 1

  local f
  for f in "$REPORTS_DIR/${report_num}-"*.md; do
    [[ -f "$f" ]] || continue
    # Two-step match:
    #   1. sed-strip "..."-quoted spans so meta-commentary that quotes a prior
    #      hallucination doesn't false-positive (e.g. a re-eval report saying
    #      `worker hallucinated "JD content unavailable" but ...`).
    #   2. Require ≥2 hits across the stripped body. A real hallucination
    #      repeats the complaint across Block A summary, Block B gaps, and
    #      the "Why skip" rationale. A legit report mentions JD-availability
    #      in passing at most once (Block G legitimacy note).
    # grep -c always prints the count, but exits non-zero on zero matches.
    # `|| echo 0` would append a second "0" line — producing hits="0\n0" which
    # `(( ... ))` cannot evaluate. Use `|| true` to swallow the exit code, then
    # strip any newlines and default to 0.
    local hits
    hits=$(sed 's/"[^"]*"//g' "$f" 2>/dev/null \
      | grep -ciE 'jd (content|fetch|page|file)[^.]{0,40}(unavailable|missing|not accessible|not available|incomplete|returned only)|incomplete jd fetch|jd fetch (was )?(incomplete|limited)|jd content not accessible|cannot map requirements|unable to fetch (full|the) job description|cannot evaluate without (the )?(full )?job (posting|description) content|only (company )?(name and )?title (available|visible)' \
      || true)
    hits="${hits//$'\n'/}"
    hits="${hits:-0}"
    if (( hits >= 2 )); then
      return 0  # hallucination detected
    fi
  done
  return 1
}

# Process a single offer — two sequential claude -p calls (triage, then full if score ≥ threshold).
process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  # js-je6: capture prev_error BEFORE reserve_report_num overwrites the state
  # row's error column with "-". The auto-upgrade-on-retry check below relies
  # on the previous attempt's error pattern; reading after reserve_report_num
  # would always see "-" and never fire the upgrade.
  local prev_error=""
  if (( retries > 0 )); then
    prev_error=$(get_last_error "$id")
  fi
  local report_num
  report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries")
  local date
  date=$(date +%Y-%m-%d)
  local jd_file="/tmp/batch-jd-${id}.txt"
  # js-f5d: phase-1 fragment uses a unique-per-invocation path instead of
  # /tmp/batch-phase1-${id}.md so that a previous batch run's content for the
  # same id (stage-5 renumbering reuses ids across pipeline runs) cannot leak
  # into this run's full pass. Cleanup paths below remove the file.
  # PID + RANDOM avoids collisions between parallel workers; .md suffix is
  # preserved so the worker's prompt-parsing regexes still match the path.
  # Use hyphens (not dots) inside the unique stem so the only `.` in the path
  # is the .md extension — keeps prompt-parser regexes like `([^.]+\.md)`
  # matching the full path.
  local phase1_file="/tmp/batch-phase1-${id}-${BASHPID:-$$}-${RANDOM}.md"
  rm -f "$phase1_file" 2>/dev/null || true
  # Start empty so the `! -s` check after triage detects worker hallucination
  # (worker claims "wrote phase-1 fragment" but never invoked Write).
  : > "$phase1_file"

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"

  # js-oe9: reject stale prefetched JDs from prior runs whose URL no longer
  # matches batch-input.tsv at this id. Without this, a re-keyed id silently
  # feeds the worker the old company's JD while {{URL}} substitutes the new
  # URL — producing a report with mismatched company/URL.
  if [[ -f "$jd_file" ]]; then
    local jd_url_file="${jd_file%.txt}.url"
    local prefetched_url=""
    if [[ -f "$jd_url_file" ]]; then
      prefetched_url=$(cat "$jd_url_file" 2>/dev/null || true)
    fi
    if [[ "$prefetched_url" != "$url" ]]; then
      echo "    ↻ Discarding stale JD for #$id (prefetched URL: ${prefetched_url:-<none>} ≠ current: $url)"
      rm -f "$jd_file" "$jd_url_file"
    fi
  fi

  # Build facts pack from cv.md + article-digest.md (shared across both passes)
  local facts_pack_file="$BATCH_DIR/.facts-pack-${id}.md"

  # js-dnp: RETURN trap closes the cleanup gap on every explicit `return` path
  # below — defense-in-depth against future edits that add a return without a
  # paired `rm -f`. The 8 existing explicit `rm -f` lines stay as redundancy.
  # Does NOT fire on `set -e` aborts or signal kills (verified empirically);
  # those are handled by the startup sweep in main() which clears any
  # prior-run leftovers.
  #
  # Defensive expansion (${var:-}) is required because (a) phase1_file is
  # mktemp'd later in this function, so an early-return triage failure can
  # fire the trap before phase1_file is set, and (b) bash RETURN traps set
  # inside a function persist globally without `set -T`, so this trap also
  # fires on main()'s return when both vars are out of scope.
  trap 'rm -f "${facts_pack_file:-}" "${phase1_file:-}" 2>/dev/null || true' RETURN

  : > "$facts_pack_file"
  if [[ -f "$PROJECT_DIR/cv.md" ]]; then
    {
      printf '## cv.md\n\n'
      cat "$PROJECT_DIR/cv.md"
      printf '\n'
    } >> "$facts_pack_file"
  fi
  if [[ -f "$PROJECT_DIR/article-digest.md" ]]; then
    {
      printf '\n---\n\n## article-digest.md\n\n'
      cat "$PROJECT_DIR/article-digest.md"
      printf '\n'
    } >> "$facts_pack_file"
  fi

  # phase1_file is mktemp'd above (js-f5d) — already unique per invocation, no
  # stale-content risk. The empty-file truncate above stays so the `! -s` check
  # after triage flags worker hallucination.

  # User-prompt skeleton — same shape for both passes; the worker's role is
  # set by the system prompt (triage vs full).
  local user_prompt_base
  user_prompt_base="Process this job offer per the system prompt."
  user_prompt_base="$user_prompt_base URL: $url"
  user_prompt_base="$user_prompt_base JD file: $jd_file"
  user_prompt_base="$user_prompt_base Report number: $report_num"
  user_prompt_base="$user_prompt_base Date: $date"
  user_prompt_base="$user_prompt_base Batch ID: $id"

  # ============================================================
  # PASS 1 — TRIAGE
  # ============================================================
  local triage_log="$LOGS_DIR/${report_num}-${id}.triage.log"
  local resolved_triage="$BATCH_DIR/.resolved-prompt-${id}.triage.md"

  build_resolved_prompt \
    "$TRIAGE_PROMPT_FILE" "$resolved_triage" "$facts_pack_file" \
    "$url" "$jd_file" "$report_num" "$date" "$id" "$TRIAGE_THRESHOLD" "$phase1_file"

  local triage_user_prompt="$user_prompt_base Phase: triage. Phase-1 fragment path: $phase1_file."

  # js-tt0: if the previous attempt failed with "phase-1 fragment missing or
  # empty" and the configured triage model is Haiku-flavored, auto-upgrade this
  # retry's triage pass to FULL_MODEL. Haiku 4.5 silently skips the Write tool
  # on a non-trivial fraction of offers (see js-ivp); the Step 3.5 self-verify
  # in the prompt sometimes catches it but not always (id=70 Decagon, 2026-05-04
  # — worker even narrated "Fragment verified ✓" without invoking Read or
  # Write). Scoping the upgrade to this specific error pattern avoids paying
  # the Sonnet/Opus premium on unrelated retry causes (network errors, etc.).
  local effective_triage_model="$TRIAGE_MODEL"
  # js-tt0 + js-vfb: auto-upgrade Haiku → FULL_MODEL on retry for two
  # tool-skip patterns: (a) phase-1 fragment never written despite the
  # worker narrating "Fragment verified", and (b) report body claims JD
  # missing while the prefetched JD is on disk. Both are Haiku 4.5 tool-use
  # bugs that flip ~30% of runs on certain archetypes; upgrading the retry
  # converts most of them.
  # js-je6: prev_error is captured at the top of process_offer (before
  # reserve_report_num overwrites the state row's error column). Re-fetching
  # here via get_last_error would always return "-".
  if (( retries > 0 )) \
     && [[ ( "$prev_error" == *"phase-1 fragment missing or empty"* || "$prev_error" == *"hallucinated JD missing"* ) \
        && "$TRIAGE_MODEL" == *haiku* && -n "$FULL_MODEL" ]]; then
    effective_triage_model="$FULL_MODEL"
    echo "    ↑ Triage auto-upgraded $TRIAGE_MODEL → $FULL_MODEL (prior hallucination/fragment failure, js-tt0+js-vfb)"
  fi

  local triage_exit=0
  local -a triage_args=( -p --dangerously-skip-permissions --append-system-prompt-file "$resolved_triage" )
  if [[ -n "$effective_triage_model" ]]; then
    triage_args+=( --model "$effective_triage_model" )
  fi
  echo "    → triage pass (model: ${effective_triage_model:-default})"
  claude "${triage_args[@]}" "$triage_user_prompt" > "$triage_log" 2>&1 || triage_exit=$?
  rm -f "$resolved_triage"

  if [[ $triage_exit -ne 0 ]]; then
    local completed_at error_msg
    completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    error_msg=$(tail -5 "$triage_log" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "triage exit $triage_exit")
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "triage: $error_msg" "$retries"
    echo "    ❌ Triage failed (attempt $retries, exit $triage_exit)"
    rm -f "$facts_pack_file" "$phase1_file"
    return
  fi

  local triage_json triage_score triage_stub triage_status
  triage_json=$(extract_last_status_json "$triage_log")
  triage_score=$(extract_score_from_json "$triage_json")
  triage_stub=$(extract_stub_from_json "$triage_json")
  triage_status=$(extract_status_from_json "$triage_json")
  triage_score="${triage_score:--}"

  # js-hjz: worker can exit 0 yet self-report status=failed in JSON. Trust the
  # JSON over the exit code.
  if [[ "$triage_status" == "failed" ]]; then
    local completed_at err
    completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    err=$(extract_error_from_json "$triage_json")
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$triage_score" "triage(self): ${err:-no detail}" "$retries"
    echo "    ❌ Triage worker self-reported failure: ${err:-(no detail)}"
    rm -f "$facts_pack_file" "$phase1_file"
    return
  fi

  # If the triage worker decided this is a stub (score < threshold), it has
  # already written the report + tracker line. We're done.
  if [[ "$triage_stub" == "true" ]]; then
    local completed_at
    completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # js-hjz: stub=true must be backed by a real report file on disk. Without
    # this guard, a worker that emits stub-completed JSON but fails to write
    # the file leaves state=completed pointing at nothing.
    if ! report_file_exists "$report_num"; then
      retries=$((retries + 1))
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$triage_score" "triage: stub=true exit 0 but report file missing" "$retries"
      echo "    ❌ Triage stub claimed completed but report file missing for $report_num"
      rm -f "$facts_pack_file" "$phase1_file"
      return
    fi

    # js-vfb: stub claims completed, but check the report body — workers
    # sometimes hallucinate "JD unavailable" while the JD file is on disk,
    # producing a fabricated low score. Fail-with-retry so the operator
    # doesn't propagate a bogus stub into applications.md.
    if report_claims_jd_missing "$report_num" "$jd_file"; then
      retries=$((retries + 1))
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$triage_score" "triage: hallucinated JD missing (body claims JD unavailable while $jd_file is on disk, js-vfb)" "$retries"
      echo "    ❌ Triage stub claims JD unavailable, but $jd_file has content — hallucination, retrying"
      rm -f "$facts_pack_file" "$phase1_file"
      return
    fi

    # Min-score gate — if set, mark sub-min-score stubs as "skipped" so they
    # don't count as completed evaluations.
    if [[ "$triage_score" != "-" && -n "$triage_score" ]] && awk "BEGIN{exit!($MIN_SCORE>0)}"; then
      if awk "BEGIN{exit!($triage_score+0 < $MIN_SCORE+0)}"; then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$triage_score" "below-min-score" "$retries"
        echo "    ⏭️  Skipped (score: $triage_score < min-score: $MIN_SCORE)"
        rm -f "$facts_pack_file" "$phase1_file"
        return
      fi
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$triage_score" "-" "$retries"
    echo "    ✅ Stub (score: $triage_score, report: $report_num) — full pass skipped"
    rm -f "$facts_pack_file" "$phase1_file"
    return
  fi

  # Triage said keep — phase-1 fragment must exist AND be non-empty for the
  # full pass to splice in. js-f5d: -s instead of -f catches the case where the
  # mktemp'd file exists but the worker hallucinated writing (common pattern:
  # worker emits "Phase-1 fragment written to {path}" prose without invoking
  # the Write tool).
  if [[ ! -s "$phase1_file" ]]; then
    local completed_at
    completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$triage_score" "triage: phase-1 fragment missing or empty" "$retries"
    echo "    ❌ Triage produced no phase-1 fragment at $phase1_file"
    rm -f "$facts_pack_file" "$phase1_file"
    return
  fi

  # js-f5d: defensive content check — confirm the phase-1 fragment's
  # PHASE1_META company_slug matches the URL's ATS slug (Ashby/Greenhouse).
  # Catches worker confusion where the JD path led to a different company than
  # the URL. Best-effort only — skip the check for URLs whose slug we don't
  # recognize so we don't false-fail Lever/Workday/etc.
  local url_slug=""
  if [[ "$url" =~ jobs\.ashbyhq\.com/([^/?#]+)/ ]]; then
    url_slug="${BASH_REMATCH[1],,}"
  elif [[ "$url" =~ (job-boards|boards)\.greenhouse\.io/([^/?#]+)/jobs/ ]]; then
    url_slug="${BASH_REMATCH[2],,}"
  fi
  if [[ -n "$url_slug" ]]; then
    local phase1_meta
    phase1_meta=$(head -1 "$phase1_file")
    local phase1_slug
    phase1_slug=$(printf '%s' "$phase1_meta" | sed -nE 's/.*"company_slug"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | tr '[:upper:]' '[:lower:]')
    # Loose compare: tolerate "ramp" vs "ramp-com" by checking either contains the other.
    # Empty phase1_slug → skip (don't break on prompt-shape changes).
    if [[ -n "$phase1_slug" && "$phase1_slug" != *"$url_slug"* && "$url_slug" != *"$phase1_slug"* ]]; then
      local completed_at
      completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      retries=$((retries + 1))
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$triage_score" "triage: phase-1 slug '$phase1_slug' does not match URL slug '$url_slug'" "$retries"
      echo "    ❌ Phase-1 slug mismatch (phase1: $phase1_slug, url: $url_slug) — likely cross-company contamination"
      rm -f "$facts_pack_file" "$phase1_file"
      return
    fi
  fi

  # ============================================================
  # PASS 2 — FULL
  # ============================================================
  local full_log="$LOGS_DIR/${report_num}-${id}.full.log"
  local resolved_full="$BATCH_DIR/.resolved-prompt-${id}.full.md"

  build_resolved_prompt \
    "$FULL_PROMPT_FILE" "$resolved_full" "$facts_pack_file" \
    "$url" "$jd_file" "$report_num" "$date" "$id" "$TRIAGE_THRESHOLD" "$phase1_file"

  local full_user_prompt="$user_prompt_base Phase: full. Phase-1 fragment path: $phase1_file."

  local full_exit=0
  local -a full_args=( -p --dangerously-skip-permissions --append-system-prompt-file "$resolved_full" )
  if [[ -n "$FULL_MODEL" ]]; then
    full_args+=( --model "$FULL_MODEL" )
  fi
  echo "    → full pass (model: ${FULL_MODEL:-default}, triage score: $triage_score)"
  claude "${full_args[@]}" "$full_user_prompt" > "$full_log" 2>&1 || full_exit=$?
  rm -f "$resolved_full" "$facts_pack_file" "$phase1_file"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $full_exit -ne 0 ]]; then
    local error_msg
    error_msg=$(tail -5 "$full_log" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "full exit $full_exit")
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$triage_score" "full: $error_msg" "$retries"
    echo "    ❌ Full pass failed (attempt $retries, exit $full_exit)"
    return
  fi

  local full_json full_score full_status
  full_json=$(extract_last_status_json "$full_log")
  full_score=$(extract_score_from_json "$full_json")
  full_status=$(extract_status_from_json "$full_json")
  full_score="${full_score:-$triage_score}"

  # js-hjz: full worker can exit 0 yet self-report status=failed (e.g. Phase-1
  # metadata mismatch). Honor the worker's verdict.
  if [[ "$full_status" == "failed" ]]; then
    local err
    err=$(extract_error_from_json "$full_json")
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$full_score" "full(self): ${err:-no detail}" "$retries"
    echo "    ❌ Full worker self-reported failure: ${err:-(no detail)}"
    return
  fi

  # js-hjz: a successful full pass must produce a report file on disk.
  if ! report_file_exists "$report_num"; then
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$full_score" "full: exit 0 but report file missing" "$retries"
    echo "    ❌ Full pass exit 0 but report file missing for $report_num"
    return
  fi

  # js-vfb: full pass body-validity check. Same hallucination pattern as the
  # triage path: worker self-reports completed but the report body claims the
  # JD was unavailable. Fail-with-retry rather than accept a bogus refined
  # score.
  if report_claims_jd_missing "$report_num" "$jd_file"; then
    retries=$((retries + 1))
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$full_score" "full: hallucinated JD missing (body claims JD unavailable while $jd_file is on disk, js-vfb)" "$retries"
    echo "    ❌ Full pass claims JD unavailable, but $jd_file has content — hallucination, retrying"
    return
  fi

  # Min-score gate on the refined score
  if [[ "$full_score" != "-" && -n "$full_score" ]] && awk "BEGIN{exit!($MIN_SCORE>0)}"; then
    if awk "BEGIN{exit!($full_score+0 < $MIN_SCORE+0)}"; then
      update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$full_score" "below-min-score" "$retries"
      echo "    ⏭️  Skipped (refined score: $full_score < min-score: $MIN_SCORE)"
      return
    fi
  fi

  update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$full_score" "-" "$retries"
  echo "    ✅ Completed (refined score: $full_score, report: $report_num)"
}

# Merge tracker additions into applications.md
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if [[ "$sscore" != "-" && -n "$sscore" ]]; then
          score_sum=$(echo "$score_sum + $sscore" | bc 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(echo "scale=1; $score_sum / $score_count" | bc 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
}

# Main
main() {
  check_prerequisites

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock

    # js-dnp: sweep .facts-pack-*.md leftovers from any prior worker that died
    # before its RETURN trap could fire (SIGKILL, OS reboot, parent timeout,
    # Ctrl+C reaching a parallel worker). Safe because acquire_lock above
    # guarantees we are the only batch-runner on this directory right now.
    rm -f "$BATCH_DIR"/.facts-pack-*.md 2>/dev/null || true
  fi

  init_state

  # js-0zl: preemptively prefetch JDs for ATSes WebFetch can't read. Ashby's
  # React shell and Greenhouse's job-boards subdomain return header-only
  # content via WebFetch; without a populated /tmp/batch-jd-{id}.txt the
  # triage worker self-fails on first encounter. prefetch-jds.mjs hits the
  # official ATS APIs and writes via os.tmpdir() (which Git Bash's /tmp maps
  # to — see js-6d4 and the test-all.mjs invariant probe).
  if [[ "$DRY_RUN" == "false" ]]; then
    local -a prefetch_ids=()
    while IFS=$'\t' read -r p_id p_url _; do
      [[ -z "$p_id" || "$p_id" == "id" ]] && continue
      [[ "$p_id" =~ ^[0-9]+$ ]] || continue
      if [[ "$p_url" =~ jobs\.ashbyhq\.com|boards\.greenhouse\.io|job-boards(\.eu)?\.greenhouse\.io|grnh\.se ]]; then
        [[ ! -f "/tmp/batch-jd-${p_id}.txt" ]] && prefetch_ids+=("$p_id")
      fi
    done < "$INPUT_FILE"
    if (( ${#prefetch_ids[@]} > 0 )); then
      local ids_csv
      ids_csv=$(IFS=,; echo "${prefetch_ids[*]}")
      echo "=== Prefetching JDs for ${#prefetch_ids[@]} ATS URLs ==="
      node scripts/prefetch-jds.mjs --ids="$ids_csv" || \
        echo "  (some prefetches failed — continuing; degraded URLs will fall back to WebFetch)"
    fi
  fi

  # Count input offers (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  echo "Triage model: $TRIAGE_MODEL | Full model: $FULL_MODEL | Triage threshold: $TRIAGE_THRESHOLD"
  echo "Input: $total_input offers"
  echo ""

  # Build list of offers to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed offers
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      # Skip completed offers
      if [[ "$status" == "completed" ]]; then
        continue
      fi
      # Skip failed offers that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  # Process offers
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")
        sleep 1
      done

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary
}

main "$@"
