# Decision: Duplicate Logic in System-Tracked Scripts — Defer Consolidation

**Date:** 2026-05-04
**Bead:** js-b9n
**Audit refs:** [docs/audit-2026-05.md](../audit-2026-05.md) Section 2.B / 2.C / 2.D, recommendations #6, #7, #8
**Status:** Accepted — Option C (skip), revisit 2026-Q3

## Context

The 2026-05 cleanup audit flagged three clusters of duplicated logic across upstream-tracked scripts:

- `applications.md` parser duplicated across 7 scripts (5 in `update-system.mjs:SYSTEM_PATHS`).
- `normalizeCompany` / `normalizeRole` — 3 variants with subtly different behavior.
- `ROLE_STOPWORDS` — 4 distinct lists.

Three candidate strategies were considered:

- **A — Upstream PR to santifer/career-ops:** lib/ extraction lives upstream, fork stays lean.
- **B — Fork the system scripts in user layer:** drop them from `SYSTEM_PATHS`, manage independently.
- **C — Skip consolidation:** live with the duplication; trust merge-tracker.mjs (the post-incident fix) as the canonical implementation.

## Decision

**Option C.** Defer consolidation. Re-evaluate in the 2026-Q3 audit (~August 2026) or sooner if a concrete bug surfaces in any non-merge-tracker caller of the duplicated logic.

## Rationale

Three observable facts make C the lowest-cost option with acceptable risk:

1. **No PR channel with santifer.** `git log` shows zero contributions to `upstream/main` — the only merge in history is the initial fork import (`210221e Merge upstream santifer/career-ops main`). Option A's multi-week review cycle has no track record to lean on; assuming acceptance is speculative.

2. **`npm run update` is effectively dormant.** Since the initial fork merge, no upstream sync has happened. The premise behind Option A's "future updates pull lib/ alongside the callers" depends on regular updates that are not occurring. The premise behind Option B's "you'll have to port future santifer fixes manually" also doesn't materialize at the current update cadence.

3. **Correctness risk is bounded.** Per the `merge-tracker-mjs-gotcha-the-tsv-s-first` memory, the April 2026 incident (TSV num column being misread as a tracker sequence number, clobbering rows #1, #52, #54) was caused by `merge-tracker.mjs` specifically — and it is fixed there. The other parsers (`dedup-tracker.mjs`, `verify-pipeline.mjs`, `normalize-statuses.mjs`, `followup-cadence.mjs`, `analyze-patterns.mjs`) are either:
   - Read-only diagnostics (verify-pipeline, analyze-patterns, followup-cadence) — they cannot clobber tracker rows.
   - Rarely run as manual cleanup tools (dedup-tracker, normalize-statuses) — they could in theory mishandle a row, but Ben can review their output before accepting.

   The drift risk identified by the audit is real but theoretical at this date.

## Trigger to revisit

Reopen this decision if either of these is true:

- A concrete bug surfaces in `dedup-tracker.mjs`, `verify-pipeline.mjs`, `normalize-statuses.mjs`, `followup-cadence.mjs`, or `analyze-patterns.mjs` that would have been prevented by sharing `merge-tracker.mjs`'s parser, normalizer, or stopword list.
- The 2026-Q3 audit (≈August 2026) finds the duplication is causing a maintenance drag (e.g., a fix to one parser had to be hand-ported to others).

## If reopened — choose B, not A

If a trigger fires:

- **Option A is not viable** absent a santifer PR relationship. Don't open a PR cold.
- **Option B is the path:** add the affected files to a `USER_LAYER_OVERRIDES` exclusion in `update-system.mjs`, extract the shared module to `lib/`, and own the divergence. The "ongoing manual port cost" concern is small at the observed update cadence.

## What was *not* decided

This decision is scoped to audit recommendations #6 (parser), #7 (normalizers), #8 (stopwords). It does **not** address:

- Audit #1–#5 (gitignore, /tmp/ literals, orphan deletes, JD-fetch consolidation) — those have their own beads and are not blocked by this decision.
- The `.facts-pack-*.md` worker leak (js-dnp) — independent.
- Anything in `scripts/` (user-layer-owned files like `resolve-ats-urls.mjs`, `preview-pipeline-append.mjs`) — those can be refactored at any time without this decision.
