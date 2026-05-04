# Batch Processing

Process multiple job offers in parallel via `claude -p` workers. Each worker runs the full evaluation pipeline (A-F report + PDF + tracker line) autonomously.

## Quick Start

1. **Add offers** to `batch-input.tsv` (tab-separated: `id`, `url`, `source`, `notes`):

   ```tsv
   id	url	source	notes
   1	https://jobs.example.com/role-a	LinkedIn	
   2	https://greenhouse.io/company/role-b	Greenhouse	priority
   ```

2. **Dry run** to preview what will be processed:

   ```bash
   ./batch/batch-runner.sh --dry-run
   ```

3. **Run the batch**:

   ```bash
   ./batch/batch-runner.sh
   ```

4. **Results** are automatically merged into `data/applications.md` and verified with `verify-pipeline.mjs` at the end of the run.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--parallel N` | `1` | Number of concurrent `claude -p` workers |
| `--dry-run` | off | Preview pending offers without processing |
| `--retry-failed` | off | Only retry offers marked as `failed` in state |
| `--start-from N` | `0` | Skip offers with ID below N |
| `--max-retries N` | `2` | Max retry attempts per offer before giving up |

## Directory Layout

```
batch/
  batch-runner.sh          # Orchestrator script
  batch-prompt.md          # Prompt template sent to each worker
  batch-input.tsv          # Input offers (you create this)
  batch-state.tsv          # Processing state (auto-managed, resumable)
  logs/                    # Per-offer worker logs ({report_num}-{id}.log)
  tracker-additions/       # TSV lines produced by workers
    merged/                # TSVs already merged into applications.md
```

## How It Works

1. **batch-runner.sh** reads `batch-input.tsv` and `batch-state.tsv` to determine which offers need processing.
2. For each pending offer, it assigns a report number and launches a `claude -p` worker with `batch-prompt.md` as the system prompt (placeholders like `{{URL}}`, `{{REPORT_NUM}}` are resolved).
3. Each worker evaluates the offer, writes a report to `reports/`, generates a PDF to `output/`, and writes a tracker TSV to `tracker-additions/`.
4. After all workers finish, batch-runner calls `merge-tracker.mjs` to merge TSVs into `data/applications.md` and runs `verify-pipeline.mjs` to check integrity.

## Tracker Merge

Workers write one TSV per offer to `batch/tracker-additions/`. The merge script (`npm run merge`) handles:

- Deduplication by company + role fuzzy match and report number
- Column order conversion (TSV has status before score; applications.md has score before status)
- In-place updates when a re-evaluation scores higher than the existing entry
- Moving processed TSVs to `tracker-additions/merged/`

Run `npm run merge` manually if you need to merge outside of a batch run.

## Resumability

`batch-state.tsv` tracks the status of every offer (`pending`, `processing`, `completed`, `failed`). If the batch is interrupted, re-running `batch-runner.sh` picks up where it left off -- completed offers are skipped automatically.

A PID-based lock file (`batch-runner.pid`) prevents concurrent batch runs. If a previous run crashed, the stale lock is detected and removed automatically.

## Prerequisites

- `claude` CLI in PATH (Claude Max subscription for default model)
- Node.js >= 18, Playwright chromium installed (`npm run doctor` to verify)
- `batch-input.tsv` with at least one offer

## Windows /tmp gotcha (js-6d4)

`batch-runner.sh` reads pre-fetched JDs from `/tmp/batch-jd-{id}.txt`. On Git Bash for Windows, `/tmp` maps to `%LOCALAPPDATA%\Temp` — not to `C:\tmp`. Any Node script that writes JDs for the worker to consume must use `os.tmpdir()` (which also returns `%LOCALAPPDATA%\Temp` on Windows) rather than a literal `/tmp/...` string. A hardcoded `/tmp/...` in Node resolves to `C:\tmp\...` on Windows, so the worker silently falls back to WebFetch and often produces a degraded report (title/company only).

`scripts/prefetch-jds.mjs` uses `os.tmpdir()` — keep it that way. `test-all.mjs` includes a smoke test (`4b. Prefetch tmpdir invariant`) that asserts Node's tmpdir and bash's `/tmp` point at the same directory.

## Preemptive ATS prefetch (js-0zl)

`batch-runner.sh main()` runs `scripts/prefetch-jds.mjs --ids=...` before any worker spawns. It scans `batch-input.tsv` for Ashby (`jobs.ashbyhq.com`) and Greenhouse (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `grnh.se`) URLs whose `/tmp/batch-jd-{id}.txt` is missing, then fetches them via the official ATS APIs. WebFetch alone returns header-only React shells for these ATSes, which would otherwise force the triage worker to self-fail with `JD retrieval failed`. Lever URLs are skipped — their API exposes full descriptions inline so WebFetch suffices. The new `--ids=a,b,c` flag is additive: running `node scripts/prefetch-jds.mjs` with no flags still scans `batch-state.tsv` for `status=='failed'` rows (the original recovery path).

## Triage model choice — Write-tool reliability tradeoff (js-ivp)

The triage worker (`batch-prompt-triage.md`) MUST invoke the Write tool to persist `{{PHASE1_FILE}}`. Some smaller models (notably Haiku 4.5) have a tendency to "inline" the fragment in their response prose and emit a `status=completed` JSON without ever calling Write — the orchestrator then catches the empty file at `batch-runner.sh:594` and marks the offer failed, burning a retry. Observed ~30% silent-skip rate on FDE/Ops-archetype roles 2026-05-04.

Mitigations layered in:

1. **Step 3.5 self-verify** in `batch-prompt-triage.md` — the worker is told to Read `{{PHASE1_FILE}}` after Step 3 and re-Write if the file is missing/empty before emitting the Step 5 JSON. Cheap, model-agnostic.
2. **Orchestrator guard** at `batch-runner.sh:594` (`-s` test) — last line of defense; failed offer is retried.
3. **Model swap** — when changing `--triage-model`, run a 10-offer sample first and check `batch/logs/*.triage.log` for "Phase 1 fragment written" prose without a corresponding non-empty `{{PHASE1_FILE}}`. If the failure rate is >10%, default that model to the full pass instead of triage, or upgrade to Sonnet for triage and accept the ~5x cost.

Sonnet 4.6 has not exhibited this failure mode in our batches; Haiku 4.5 has. Treat any new triage model as untrusted until verified.
