# Ashby first-time prefetch gap

**Filed:** 2026-05-04 alongside beads task (see end of doc).
**Surfaced by:** Real batch run on 2026-05-04 (id=70 Decagon AI Engineer, Ashby).

## Symptom

First-time Ashby URLs from `scan` silently fail their first batch evaluation. Triage worker reports:

```
JD retrieval failed: local file /tmp/batch-jd-{id}.txt missing,
WebFetch returned insufficient content (header only, no description)
```

The worker has no description to evaluate so it self-fails. `merge-tracker` then ignores the row, the user sees `failed` in `batch-state.tsv`, and the URL stays unevaluated until manual intervention. Will recur on every scan-discovered Ashby URL because Ashby is the most common ATS in the portal config.

## Root cause — architectural, not a bug

`scripts/prefetch-jds.mjs` is documented in its header as "Pre-fetch JDs for **failed** batch ids" — it's a recovery tool, not a primary path. It reads `batch-state.tsv` and only acts on rows where `status=='failed'`. So:

- First run of a fresh Ashby id N: `/tmp/batch-jd-N.txt` doesn't exist → triage tries WebFetch → degraded content → fails.
- Recovery: user runs `prefetch-jds.mjs` manually → file lands → re-run with `--retry-failed` → succeeds.

This works but is a recurring papercut. Every fresh Ashby URL costs the user one failed-batch-then-manual-prefetch cycle.

## Why Ashby specifically

Per the `phase4-ats-apis` memory: Ashby's job-board API does not expose individual job descriptions inline — extraction requires Playwright DOM scraping at `jobs.ashbyhq.com/{slug}/{id}/application`. WebFetch returns the React app shell only (title + company, no description body).

Greenhouse has the same gap when WebFetch hits the React-rendered `job-boards.greenhouse.io` (the API at `boards-api.greenhouse.io/v1/...` returns full content but is what `prefetch-jds.mjs` calls — not WebFetch).

Lever's API exposes full descriptions inline, so WebFetch usually works for Lever URLs. Lever does not need this fix.

## Three implementation approaches

### Approach A — Preemptive prefetch in batch-runner.sh (RECOMMENDED)

Smallest blast radius, single new flag in `prefetch-jds.mjs`, single new block in `main()`. Leaves the existing failed-recovery path intact (the new flag is additive).

**Step 1.** Modify `scripts/prefetch-jds.mjs` to accept a `--ids id1,id2,...` flag. When given an explicit id list, fetch those instead of filtering for `status=='failed'`.

Currently lines 20-25 filter for failed:

```js
for (const line of STATE.slice(1)) {
  const cols = line.split('\t');
  if (cols[0] && cols[2] === 'failed') failedIds.push(cols[0]);
}
```

Replace with:

```js
const idsArg = process.argv.find(a => a.startsWith('--ids='));
let targetIds;
if (idsArg) {
  targetIds = idsArg.slice('--ids='.length).split(',').map(s => s.trim()).filter(Boolean);
} else {
  // Existing behavior: filter batch-state for status=='failed'
  targetIds = [];
  for (const line of STATE.slice(1)) {
    const cols = line.split('\t');
    if (cols[0] && cols[2] === 'failed') targetIds.push(cols[0]);
  }
}
```

Rest of the script (the for loop, fetchAshby/fetchGreenhouse, write logic) remains unchanged.

**Step 2.** In `batch/batch-runner.sh main()`, after `init_state` (line 774):

```bash
# js-XXX: preemptively prefetch JDs for ATSes that WebFetch can't read.
# Ashby's React shell and Greenhouse's job-boards subdomain return
# header-only content via WebFetch; the workers need a populated
# /tmp/batch-jd-{id}.txt to avoid degraded triage. prefetch-jds.mjs
# uses the official ATS APIs and writes the file via os.tmpdir().
if [[ "$DRY_RUN" == "false" ]]; then
  local prefetch_ids=()
  while IFS=$'\t' read -r id url _; do
    [[ -z "$id" || "$id" == "id" ]] && continue
    if [[ "$url" =~ jobs\.ashbyhq\.com|boards\.greenhouse\.io|job-boards(\.eu)?\.greenhouse\.io|grnh\.se ]]; then
      [[ ! -f "/tmp/batch-jd-${id}.txt" ]] && prefetch_ids+=("$id")
    fi
  done < "$INPUT_FILE"
  if (( ${#prefetch_ids[@]} > 0 )); then
    local ids_csv
    ids_csv=$(IFS=,; echo "${prefetch_ids[*]}")
    echo "=== Prefetching JDs for ${#prefetch_ids[@]} ATS URLs ==="
    node scripts/prefetch-jds.mjs --ids="$ids_csv" || echo "  (some prefetches failed — continuing; degraded URLs will fall back to WebFetch)"
  fi
fi
```

Place this between line 774 (`init_state`) and line 776 (`local total_input=...`). Note the `${#...}` array length syntax requires bash, which the script already uses.

### Approach B — Triage-worker-side fallback

Have the triage prompt's JD-retrieval step detect Ashby URLs and call `prefetch-jds.mjs` as a fallback when WebFetch returns insufficient content. Requires modifying `batch/batch-prompt-triage.md` and giving the worker shell-exec capability for the prefetch step.

Drawback: shell-exec inside a Claude worker is noisy and the prefetch logic is currently Node-only. Per the `js-ivp` memory, Haiku's tool-call reliability is already shaky — adding a second tool call inside the triage path is the wrong direction.

### Approach C — Refactor prefetch into a library

Extract the Ashby/Greenhouse fetcher functions from `prefetch-jds.mjs` into `lib/ats-fetchers.mjs` and import them from both `prefetch-jds.mjs` (post-failure recovery) and a new pre-batch hook.

Cleanest long-term but most code churn. Touches the same lib/ extraction question js-b9n deferred (Option C — skip consolidation). Skip unless we're already doing the lib/ refactor for other reasons.

## Recommendation

**Approach A.**

## Caveats

1. `prefetch-jds.mjs` writes to `os.tmpdir()` (per js-6d4) — the existing batch-runner.sh code reads from `/tmp/...` literal. On Git Bash this resolves to the same `%LOCALAPPDATA%\Temp` directory. The existing `test-all.mjs` probe ("4b. Prefetch tmpdir invariant") confirms this. Don't accidentally regress that invariant.

2. The Lever ATS is in `scan.mjs` but NOT in `prefetch-jds.mjs`. Lever's API exposes full descriptions inline so WebFetch usually works. Confirm before adding Lever to the regex; otherwise the prefetch step will skip Lever as a no-op anyway.

3. The two ids currently stuck in `processing` status (per the most recent `batch-state.tsv`) are pre-existing — unrelated to this fix. Don't bundle a state-cleanup pass.

4. This change touches `batch-runner.sh` which is upstream-tracked. Per the js-b9n decision (Option C — accept fork divergence), this is fine. The change is fork-specific — don't try to upstream it without first confirming with santifer that the Ashby-prefetch dependency exists in upstream's batch flow too.

## Acceptance criteria

- `node scripts/prefetch-jds.mjs --ids=70,71,72` works on a fresh shell (no batch-state dependency).
- A real `bash batch/batch-runner.sh` run on a fresh Ashby id produces a populated `/tmp/batch-jd-{id}.txt` BEFORE the triage worker starts.
- Triage on that fresh id succeeds (i.e., emits a Block A summary, not a JD-retrieval-failed error).
- `bash -n batch/batch-runner.sh` passes.
- `node test-all.mjs` 66+ checks pass.
- No regression in the existing `prefetch-jds.mjs` failed-recovery path: `node scripts/prefetch-jds.mjs` (no flags) still scans batch-state.tsv for failed ids and prefetches them.

## Estimated effort

1.5-2 hours including a verification batch run on a fresh Ashby id (cost: ~$0.50 in tokens for one full triage+full pass).

## Files in scope

- `scripts/prefetch-jds.mjs` (modify — add --ids flag)
- `batch/batch-runner.sh` (modify — add prefetch hook in main())
- Possibly `batch/README.md` (document the new automatic prefetch step)

## References

- `docs/audit-2026-05.md` (surrounding audit context)
- js-6d4 (closed) — the `os.tmpdir()` fix this builds on
- js-pf1 (closed) — the trap regression the test surfaced alongside this finding
- `phase4-ats-apis` memory — explains why Ashby/Greenhouse need API-based prefetch
- `batch/batch-state.tsv` id=70 row — canonical reproducer left in place 2026-05-04
