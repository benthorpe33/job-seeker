# career-ops Batch Worker — Full Pass (Phase 2)

You evaluate ONE job offer per invocation, **Phase 2 only**: Blocks C, D, G + refined Score Global. The triage pass already produced Phase 1 (Block A + B + initial Score Global) and saved it to `{{PHASE1_FILE}}`. You will splice Phase 1 verbatim into the final report and append Phase 2. Outputs: final full report .md + tracker line + stdout JSON. PDFs are not generated here. This prompt is self-contained; do not invoke other skills/modes.

## Sources of truth

The candidate's `cv.md`, `article-digest.md` and `modes/_profile.md` (scoring overlay) are inlined in the **Facts Pack** below. **Do NOT Read them again**. **When `modes/_profile.md` is present, its "Scoring rubric v2" (weights, capped comp table, timeline and location rubrics) overrides every default in this prompt.** `article-digest.md` is authoritative over `cv.md` when article metrics conflict. Never write to `cv.md` or `i18n.ts`. Never fabricate experience or metrics.

## Facts Pack

<<<FACTS_PACK_BEGIN>>>
{{FACTS_PACK_MARKER}}
<<<FACTS_PACK_END>>>

## Placeholders

`{{URL}}` posting URL · `{{JD_FILE}}` JD path · `{{REPORT_NUM}}` 3-digit · `{{DATE}}` YYYY-MM-DD · `{{ID}}` batch-input id · `{{PHASE1_FILE}}` Phase 1 fragment path · `{{REPORTS_DIR}}` absolute path to the canonical reports directory.

## Step 1 — Read inputs

Read `{{PHASE1_FILE}}` for the `<!-- PHASE1_META: {...} -->` comment plus Block A + Block B + initial Score Global. Pull `company`, `company_slug`, `role`, `archetype`, `score` (initial Global), `cv_match`, `north_star`, `comp_prelim`, `cultural`, `timeline`, `location`, `red_flags`, `legitimacy_hint` from the meta JSON. If `timeline` or `location` is missing (a pre-v2 fragment), score them yourself from the JD using the overlay's rubric.

Read the JD from `{{JD_FILE}}` (or WebFetch `{{URL}}` if missing) for Block C/D/G analysis.

## Step 2 — Phase 2 evaluation

**Block C — Level & Strategy** *(≤150 words)*: detected level vs candidate's natural level; "sell senior without lying" plan (specific phrases, concrete wins, founder leverage); "if downleveled" plan (accept only with fair comp + 6-month review + clear criteria).

**Block D — Comp & Demand** *(≤150 words)*: **WebSearch budget ≤1 query.** If the posting publishes a comp range, use it and skip WebSearch. Otherwise issue ONE query (e.g. `"{role} {company} salary {YYYY}"` on levels.fyi/Glassdoor/Blind). Comp table: **≤3 rows** — posting range, one external source, likely landing base (lower third of the band). Score with the overlay's **capped** comp table (Rubric v2: landing ≥$180K = 5, with no extra credit above target; $165–179K = 4; $150–164K = 3.5; $140–149K = 2.5; $125–139K = 1.5, or 3.5 on the sports lane with equity). One sentence of rationale. No data → score 3 with a one-line caveat. Note any hiring-speed evidence you find (loop length, recent funding, hiring freeze) for the timeline refinement.

**Block G — Posting Legitimacy (HEADER LINE ONLY)**: refine the Phase 1 `legitimacy_hint` in light of Block D evidence. Final tier + 1-line reason: `{High Confidence | Proceed with Caution | Suspicious} — {reason combining JD quality + reposting check (data/scan-history.tsv if relevant) + hiring signals from Block D}`. Default Proceed with Caution. Suspicious only for clear red flags (extreme boilerplate, contradictory comp, recent layoffs at the hiring team's level, repeat reposting >2x). High Confidence requires concrete team detail + transparent comp + no concerning signals. Do NOT write a `## G)` section — the `**Legitimacy:**` header carries the full signal.

> Blocks E (CV+LinkedIn personalization) and F (interview-prep STAR stories) are NOT in batch — on-demand via `/career-ops personalize` and `/career-ops interview-prep`.

## Step 3 — Refine Score Global

Update the **Comp** dimension based on Block D, and **Hiring timeline** if Block D surfaced process-speed evidence. Other dimensions may shift only if new evidence emerged (e.g., red flags surfaced in Block D). Produce the refined table:

| Dimension | Weight | Score |
|-----------|--------|-------|
| North Star alignment | 35% | X/5 |
| CV match | 25% | X/5 |
| Cultural signals | 12% | X/5 |
| Hiring timeline | 10% | X/5 |
| Comp | 10% | X/5 |
| Location & travel | 8% | X/5 |
| Red flags | subtract | -X (if any) |
| **Global** | | **X.X/5** |

Under the table, one line of arithmetic: `0.35×NS + 0.25×CV + 0.12×Cult + 0.10×Time + 0.10×Comp + 0.08×Loc − RF = X.X`. Global is computed by this formula, not by judgment.

The refined **Global** is the canonical score for this report and the tracker line.

## Step 4 — Assemble the final report

**Write path (absolute, MANDATORY):** `{{REPORTS_DIR}}/{{REPORT_NUM}}-{company-slug}-{{DATE}}.md`. Use this exact prefix — do NOT prepend `batch/`, `./`, or any other directory. The orchestrator checks for the file at `{{REPORTS_DIR}}` and will fail the offer if it's written anywhere else.

Header (one field per line; order exactly as listed):
- `# Evaluation: {Company} — {Role}`
- `**Date:** {{DATE}}` · `**Archetype:** {archetype from Phase 1}` · `**Score:** {refined X.X}/5` · `**Rubric:** v2`.
- `**Legitimacy:** {refined tier} — {1-line reason}`.
- `**URL:** {{URL}}` · `**PDF:** ❌ (batch — on-demand via /career-ops pdf)`.
- `**Personalization & Interview Plan:** ❌ (on-demand via /career-ops personalize and /career-ops interview-prep)`.
- `**Batch ID:** {{ID}}`.

Body (≤800 words excluding tables):

```
---

## A) Role Summary

{Block A — VERBATIM from {{PHASE1_FILE}}, do NOT regenerate}

## B) CV Match

{Block B — VERBATIM from {{PHASE1_FILE}}}

## C) Level & Strategy

{Block C content from Phase 2}

## D) Comp & Demand

{Block D content from Phase 2 incl. comp table}

## Score Global (refined)

{refined Score Global table}

---

## Keywords

{15-20 JD keywords for ATS, comma-separated}
```

NO `## G)` section.

## Step 5 — Tracker line

Write ONE TSV line to `batch/tracker-additions/{{ID}}.tsv` (no header, 9 tab-separated columns):

```
{next_num}\t{{DATE}}\t{company}\t{role}\t{status}\t{refined_score}/5\t❌\t[{{REPORT_NUM}}](reports/{{REPORT_NUM}}-{company-slug}-{{DATE}}.md)\t{1-sentence note}
```

`next_num` = max+1 from `data/applications.md` last line. `status` = `Evaluated` (default) unless the JD is closed/expired (then `Discarded`). Score is the refined Global. TSV order has status BEFORE score; `applications.md` swaps them — `merge-tracker.mjs` handles it. The markdown link inside the TSV stays as the project-relative `reports/...` form — only the **Write** call in Step 4 uses the absolute `{{REPORTS_DIR}}/...` path.

### Step 5.5 — Self-verify the final report was actually written (MANDATORY)

Before emitting the Step 6 JSON, invoke **Read** on `{{REPORTS_DIR}}/{{REPORT_NUM}}-{company-slug}-{{DATE}}.md` and confirm:
1. The file exists and is non-empty.
2. Line 1 starts with `# Evaluation: `.

If either check fails, narration like "Report written" does NOT count — re-invoke **Write** with the absolute path above and re-Read to confirm. Same failure mode as the triage worker's Step 3.5; same recovery.

## Step 6 — Final stdout JSON

Emit ONE JSON line as the LAST line of stdout:

```json
{"phase":"full","status":"completed","id":"{{ID}}","report_num":"{{REPORT_NUM}}","company":"{company}","role":"{role}","score":{refined_score_num},"legitimacy":"{tier}","stub":false,"pdf":null,"report":"{report_path}","error":null}
```

On failure: same shape with `"status":"failed"`, `"score":null`, `"error":"{description}"`.

## Global rules

**Length budget (HARD):** full ≤800 words excluding tables · Block C/D ≤150 words each. Tables don't count.

**NEVER:** fabricate experience/metrics · WebSearch >1 query · regenerate Block A/B (use Phase 1 verbatim — copy the exact text from `{{PHASE1_FILE}}`) · generate a PDF · write to cv.md/i18n.ts · include a phone in drafted outbound text · use corporate-speak ("passionate about", "leveraged", "cutting-edge").

**ALWAYS:** read `{{PHASE1_FILE}}` first · refine the Comp dimension based on Block D evidence (capped at target) · compute Global with the Rubric v2 formula and show the arithmetic · keep Block A + B verbatim from Phase 1 · write in the JD's language (English default) · emit the JSON line as the LAST line of stdout · short sentences, action verbs.
