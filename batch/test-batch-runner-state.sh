#!/usr/bin/env bash
# js-hjz regression test — verify batch-runner.sh does NOT mark state=completed
# when a worker exits 0 but fails to write the report file or self-reports
# status=failed in its emitted JSON.
#
# Run from anywhere; sets up its own tmp scaffolding and a stubbed `claude`
# binary that simulates each failure mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$SCRIPT_DIR/batch-runner.sh"

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

PASS=0
FAIL=0

note() { echo "    $*"; }
ok()   { PASS=$((PASS+1)); echo "  ✅ $*"; }
ko()   { FAIL=$((FAIL+1)); echo "  ❌ $*"; }

# Build an isolated career-ops scaffold for one scenario.
# Args: scenario_name mock_claude_script
setup_scaffold() {
  local name="$1"
  local mock_script="$2"
  local root="$TEST_TMP/$name"

  rm -rf "$root"
  mkdir -p "$root/batch" "$root/reports" "$root/data" "$root/bin"

  # Copy runner + prompts (prompts can be stubs — the mock claude ignores them)
  cp "$RUNNER" "$root/batch/batch-runner.sh"
  printf '%%FACTS_PACK_MARKER%%\nstub triage prompt\n' \
    | sed 's/%FACTS_PACK_MARKER%/{{FACTS_PACK_MARKER}}/g' > "$root/batch/batch-prompt-triage.md"
  printf '%%FACTS_PACK_MARKER%%\nstub full prompt\n' \
    | sed 's/%FACTS_PACK_MARKER%/{{FACTS_PACK_MARKER}}/g' > "$root/batch/batch-prompt-full.md"

  # Minimal cv.md so facts-pack assembly works
  echo "# stub cv" > "$root/cv.md"

  # Single-row batch input
  printf 'id\turl\tsource\tnotes\n' > "$root/batch/batch-input.tsv"
  printf '99\thttps://example.com/job/99\tlinkedin\ttest\n' >> "$root/batch/batch-input.tsv"

  # Mock claude binary — script content varies per scenario
  printf '%s\n' "$mock_script" > "$root/bin/claude"
  chmod +x "$root/bin/claude"

  echo "$root"
}

# Run batch-runner.sh with PATH pointing to mocked claude. Returns 0 always —
# tests assert on state, not exit code (parallel branch swallows worker rc).
run_runner() {
  local root="$1"
  (
    export PATH="$root/bin:$PATH"
    cd "$root/batch"
    bash batch-runner.sh --triage-threshold 3.5 --max-retries 5 \
      > "$root/runner.log" 2>&1 || true
  )
}

read_state_field() {
  # Args: root, id, column-1based
  local root="$1" id="$2" col="$3"
  awk -F'\t' -v id="$id" -v col="$col" '$1 == id { print $col }' "$root/batch/batch-state.tsv"
}

# ---------------------------------------------------------------------------
# Scenario 1: triage worker emits stub=true completed JSON, but writes no file.
# Pre-fix behavior: state=completed (state lies). Post-fix: state=failed.
# ---------------------------------------------------------------------------
echo ""
echo "Scenario 1: stub=true exit 0, no report file written"
MOCK_STUB_NO_FILE='#!/usr/bin/env bash
# Echo a stub-completed triage JSON line; do NOT write any report file.
echo "{\"phase\":\"triage\",\"status\":\"completed\",\"id\":\"99\",\"report_num\":\"001\",\"company\":\"Acme\",\"role\":\"X\",\"score\":3.0,\"stub\":true,\"pdf\":null,\"error\":null}"
exit 0
'
ROOT1=$(setup_scaffold "stub-no-file" "$MOCK_STUB_NO_FILE")
run_runner "$ROOT1"

S1_STATUS=$(read_state_field "$ROOT1" 99 3)
S1_ERROR=$(read_state_field "$ROOT1" 99 8)
note "state.status='$S1_STATUS' state.error='$S1_ERROR'"
if [[ "$S1_STATUS" == "failed" ]] && [[ "$S1_ERROR" == *"report file missing"* ]]; then
  ok "state=failed with file-missing reason"
else
  ko "expected state=failed with file-missing reason"
  cat "$ROOT1/runner.log"
fi

# ---------------------------------------------------------------------------
# Scenario 2: triage exit 0, JSON status=failed (worker self-report).
# Pre-fix: state=completed (since runner only checked exit code). Post-fix: failed.
# ---------------------------------------------------------------------------
echo ""
echo "Scenario 2: triage self-reports status=failed (exit 0)"
MOCK_TRIAGE_SELFFAIL='#!/usr/bin/env bash
echo "{\"phase\":\"triage\",\"status\":\"failed\",\"id\":\"99\",\"report_num\":\"001\",\"company\":\"Acme\",\"role\":\"X\",\"score\":null,\"stub\":false,\"pdf\":null,\"error\":\"jd-fetch-failed\"}"
exit 0
'
ROOT2=$(setup_scaffold "triage-selffail" "$MOCK_TRIAGE_SELFFAIL")
run_runner "$ROOT2"

S2_STATUS=$(read_state_field "$ROOT2" 99 3)
S2_ERROR=$(read_state_field "$ROOT2" 99 8)
note "state.status='$S2_STATUS' state.error='$S2_ERROR'"
if [[ "$S2_STATUS" == "failed" ]] && [[ "$S2_ERROR" == *"jd-fetch-failed"* ]]; then
  ok "state=failed with self-reported error surfaced"
else
  ko "expected state=failed with self-reported error"
  cat "$ROOT2/runner.log"
fi

# ---------------------------------------------------------------------------
# Scenario 3: full path — triage keeps, writes phase1; full exits 0 with
# JSON status=failed (e.g. Phase-1 metadata mismatch). Pre-fix: completed. Post: failed.
# ---------------------------------------------------------------------------
echo ""
echo "Scenario 3: full pass self-reports status=failed (exit 0)"
MOCK_FULL_SELFFAIL='#!/usr/bin/env bash
# The runner invokes claude twice: once with phase=triage user prompt, once with phase=full.
# We dispatch on the user prompt arg (the last positional argument).
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *"Phase: triage"*)
    # Write phase1 fragment so runner proceeds to full pass.
    phase1=$(echo "$last" | sed -nE "s/.*Phase-1 fragment path: ([^.]+\.md).*/\1/p")
    if [[ -n "$phase1" ]]; then echo "## Phase 1 fragment" > "$phase1"; fi
    echo "{\"phase\":\"triage\",\"status\":\"completed\",\"id\":\"99\",\"report_num\":\"001\",\"company\":\"Acme\",\"role\":\"X\",\"score\":4.1,\"stub\":false,\"pdf\":null,\"error\":null}"
    ;;
  *"Phase: full"*)
    echo "{\"phase\":\"full\",\"status\":\"failed\",\"id\":\"99\",\"report_num\":\"001\",\"company\":\"Acme\",\"role\":\"X\",\"score\":null,\"stub\":false,\"pdf\":null,\"error\":\"phase-1-metadata-mismatch\"}"
    ;;
esac
exit 0
'
ROOT3=$(setup_scaffold "full-selffail" "$MOCK_FULL_SELFFAIL")
run_runner "$ROOT3"

S3_STATUS=$(read_state_field "$ROOT3" 99 3)
S3_ERROR=$(read_state_field "$ROOT3" 99 8)
note "state.status='$S3_STATUS' state.error='$S3_ERROR'"
if [[ "$S3_STATUS" == "failed" ]] && [[ "$S3_ERROR" == *"phase-1-metadata-mismatch"* ]]; then
  ok "state=failed with full-pass self-reported error surfaced"
else
  ko "expected state=failed with full-pass self-reported error"
  cat "$ROOT3/runner.log"
fi

# ---------------------------------------------------------------------------
# Scenario 4: full path — triage keeps, full exits 0, JSON says completed,
# but no report file on disk. Post-fix: state=failed.
# ---------------------------------------------------------------------------
echo ""
echo "Scenario 4: full pass exit 0, status=completed, but no report file"
MOCK_FULL_NO_FILE='#!/usr/bin/env bash
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *"Phase: triage"*)
    phase1=$(echo "$last" | sed -nE "s/.*Phase-1 fragment path: ([^.]+\.md).*/\1/p")
    if [[ -n "$phase1" ]]; then echo "## Phase 1 fragment" > "$phase1"; fi
    echo "{\"phase\":\"triage\",\"status\":\"completed\",\"id\":\"99\",\"report_num\":\"001\",\"company\":\"Acme\",\"role\":\"X\",\"score\":4.1,\"stub\":false,\"pdf\":null,\"error\":null}"
    ;;
  *"Phase: full"*)
    echo "{\"phase\":\"full\",\"status\":\"completed\",\"id\":\"99\",\"report_num\":\"001\",\"company\":\"Acme\",\"role\":\"X\",\"score\":4.3,\"stub\":false,\"pdf\":null,\"error\":null}"
    # ...but never writes the report file.
    ;;
esac
exit 0
'
ROOT4=$(setup_scaffold "full-no-file" "$MOCK_FULL_NO_FILE")
run_runner "$ROOT4"

S4_STATUS=$(read_state_field "$ROOT4" 99 3)
S4_ERROR=$(read_state_field "$ROOT4" 99 8)
note "state.status='$S4_STATUS' state.error='$S4_ERROR'"
if [[ "$S4_STATUS" == "failed" ]] && [[ "$S4_ERROR" == *"report file missing"* ]]; then
  ok "state=failed with file-missing reason"
else
  ko "expected state=failed with file-missing reason"
  cat "$ROOT4/runner.log"
fi

# ---------------------------------------------------------------------------
# Scenario 5: happy path — full pass exit 0 + status=completed + report file
# written. State should be completed (no false negative from new guards).
# ---------------------------------------------------------------------------
echo ""
echo "Scenario 5: happy path — full pass writes report file (regression guard)"
MOCK_HAPPY='#!/usr/bin/env bash
last=""
for a in "$@"; do last="$a"; done
# Find report_num from user prompt (e.g. "Report number: 001")
rnum=$(echo "$last" | sed -nE "s/.*Report number: ([0-9]+).*/\1/p")
case "$last" in
  *"Phase: triage"*)
    phase1=$(echo "$last" | sed -nE "s/.*Phase-1 fragment path: ([^.]+\.md).*/\1/p")
    if [[ -n "$phase1" ]]; then echo "## Phase 1 fragment" > "$phase1"; fi
    echo "{\"phase\":\"triage\",\"status\":\"completed\",\"id\":\"99\",\"report_num\":\"$rnum\",\"company\":\"Acme\",\"role\":\"X\",\"score\":4.1,\"stub\":false,\"pdf\":null,\"error\":null}"
    ;;
  *"Phase: full"*)
    # Write the report file at reports/{rnum}-acme-{date}.md
    repo_dir="$(cd "$(dirname "$0")"/.. && pwd)"
    if [[ -n "$rnum" ]]; then
      echo "# stub report" > "$repo_dir/reports/${rnum}-acme-2026-04-29.md"
    fi
    echo "{\"phase\":\"full\",\"status\":\"completed\",\"id\":\"99\",\"report_num\":\"$rnum\",\"company\":\"Acme\",\"role\":\"X\",\"score\":4.3,\"stub\":false,\"pdf\":null,\"error\":null}"
    ;;
esac
exit 0
'
ROOT5=$(setup_scaffold "happy" "$MOCK_HAPPY")
run_runner "$ROOT5"

S5_STATUS=$(read_state_field "$ROOT5" 99 3)
S5_SCORE=$(read_state_field "$ROOT5" 99 7)
note "state.status='$S5_STATUS' state.score='$S5_SCORE'"
if [[ "$S5_STATUS" == "completed" ]] && [[ "$S5_SCORE" == "4.3" ]]; then
  ok "happy path stays completed"
else
  ko "happy path should remain completed"
  cat "$ROOT5/runner.log"
fi

# ---------------------------------------------------------------------------
# Scenario 6: legitimate stub — triage stub=true and DOES write the report.
# State should be completed.
# ---------------------------------------------------------------------------
echo ""
echo "Scenario 6: legitimate stub — triage writes the stub report"
MOCK_STUB_HAPPY='#!/usr/bin/env bash
last=""
for a in "$@"; do last="$a"; done
rnum=$(echo "$last" | sed -nE "s/.*Report number: ([0-9]+).*/\1/p")
repo_dir="$(cd "$(dirname "$0")"/.. && pwd)"
if [[ -n "$rnum" ]]; then
  echo "# stub report" > "$repo_dir/reports/${rnum}-acme-2026-04-29.md"
fi
echo "{\"phase\":\"triage\",\"status\":\"completed\",\"id\":\"99\",\"report_num\":\"$rnum\",\"company\":\"Acme\",\"role\":\"X\",\"score\":3.0,\"stub\":true,\"pdf\":null,\"error\":null}"
exit 0
'
ROOT6=$(setup_scaffold "stub-happy" "$MOCK_STUB_HAPPY")
run_runner "$ROOT6"

S6_STATUS=$(read_state_field "$ROOT6" 99 3)
note "state.status='$S6_STATUS'"
if [[ "$S6_STATUS" == "completed" ]]; then
  ok "legitimate stub stays completed"
else
  ko "legitimate stub should remain completed"
  cat "$ROOT6/runner.log"
fi

echo ""
echo "=== Test Summary ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ $FAIL -eq 0 ]] || exit 1
