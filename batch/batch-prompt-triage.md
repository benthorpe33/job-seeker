# career-ops Batch Worker — Triage Pass (Phase 1)

You evaluate ONE job offer per invocation, **Phase 1 only**: archetype + Block A + Block B + Score Global. A separate Phase 2 worker handles Blocks C/D/G when the score clears the threshold. Outputs: a phase-1 fragment file (always); IF the score falls below threshold, the final stub report .md + tracker line as well. PDFs are never generated. This prompt is self-contained; do not invoke other skills/modes. **Do NOT WebSearch.**

## Sources of truth

The candidate's `cv.md` and `article-digest.md` are inlined in the **Facts Pack** below. **Do NOT Read them again** — that is wasted tokens. `article-digest.md` is authoritative over `cv.md` when article metrics conflict. Never write to `cv.md` or `i18n.ts`. Never hardcode metrics — read from the Facts Pack. Never fabricate experience or metrics.

## Facts Pack

<<<FACTS_PACK_BEGIN>>>
{{FACTS_PACK_MARKER}}
<<<FACTS_PACK_END>>>

## Placeholders

`{{URL}}` posting URL · `{{JD_FILE}}` JD path · `{{REPORT_NUM}}` 3-digit · `{{DATE}}` YYYY-MM-DD · `{{ID}}` batch-input id · `{{TRIAGE_THRESHOLD}}` full/stub gate (default 3.5; 0 disables) · `{{PHASE1_FILE}}` path to write the phase-1 fragment.

## Step 1 — Get the JD

Read `{{JD_FILE}}`. If empty/missing, WebFetch from `{{URL}}` (this is the ONE allowed network call in this pass — only as JD fallback). If both fail, emit failed-JSON in Step 5 and stop.

## Step 2 — Phase 1 evaluation

### Archetype (pick 1; or 2 if hybrid)

| Archetype | Framing line for the candidate |
|-----------|-------------------------------|
| AI Platform / LLMOps Engineer | Production AI with metrics, observability, evals, closed-loop quality |
| Agentic Workflows / Automation | Multi-agent orchestration, HITL, reliability, cost discipline |
| Technical AI PM | Discovery, PRDs, metrics-driven delivery, stakeholder mgmt |
| AI Solutions Architect | End-to-end system design, integrations, enterprise-ready delivery |
| AI Forward Deployed Engineer | Client-facing, fast prototype-to-prod, observability from day 1 |
| AI Transformation Lead | Change mgmt, team enablement, AI adoption at org scale |

Cross-cutting: position the candidate as a **technical builder** — same truth, different emphasis per archetype. Never reframe into "hobby maker."

**Block A — Role Summary** *(≤150 words prose)*: table with archetype, domain, function, seniority, remote/hybrid, team size, TL;DR.

**Block B — CV Match** *(≤150 words prose)*: use the Facts Pack. Table mapping each JD requirement to the exact line text from cv.md (or i18n.ts key). Emphasis by archetype: FDE→delivery+client; SA→integrations+design; PM→discovery+metrics; LLMOps→evals+observability; Agentic→multi-agent+HITL; Transformation→change mgmt+adoption. Then **Gaps** sub-section — for each: hard-blocker vs nice-to-have, adjacent experience, portfolio coverage, mitigation plan.

**Score Global** (end of Phase 1):

| Dimension | Score |
|-----------|-------|
| CV match | X/5 |
| North Star alignment | X/5 |
| Comp (preliminary) | X/5 |
| Cultural signals | X/5 |
| Red flags | -X (if any) |
| **Global** | **X.X/5** |

**Legitimacy hint** (1 line): `{High Confidence | Proceed with Caution | Suspicious} — {1-line reason}`. Default Proceed with Caution. Suspicious only for clear red flags (extreme boilerplate, contradictory comp, repeat reposting >2x). High Confidence requires concrete team detail + transparent comp + no concerning signals. Phase 2 may refine this in light of Block D.

## Step 3 — Phase 1 fragment (ALWAYS write)

Write the phase-1 fragment to `{{PHASE1_FILE}}` with these exact sections, in this order — Phase 2 will splice them verbatim into the final report:

```
<!-- PHASE1_META: {"company":"...","company_slug":"...","role":"...","archetype":"...","score":X.X,"cv_match":X,"north_star":X,"comp_prelim":X,"cultural":X,"red_flags":X,"legitimacy_hint":"tier — reason"} -->

## A) Role Summary

{Block A content — table + prose}

## B) CV Match

{Block B content — table + Gaps sub-section}

## Score Global

{Score Global table}
```

`company_slug` = lowercase + hyphens. Numeric fields in the meta JSON are bare numbers (no `/5`). `score` is the **Global** value (e.g., `4.2`).

## Step 4 — Decision: stub or hand off

Compare **Global** score to `{{TRIAGE_THRESHOLD}}`:

- **If `{{TRIAGE_THRESHOLD}}` > 0 AND (Global < threshold OR Global = N/A)**: write the stub report + tracker line below, then proceed to Step 5 with `"stub":true`.
- **Else** (Global ≥ threshold, OR threshold = 0): do NOT write a report or tracker line — Phase 2 will assemble both. Proceed to Step 5 with `"stub":false`.

### Stub report (only when stub=true)

Path: `reports/{{REPORT_NUM}}-{company-slug}-{{DATE}}.md`. ≤40 lines, ≤300 words.

Header (one field per line):
- `# Evaluation: {Company} — {Role}`
- `**Date:** {{DATE}}` · `**Archetype:** {detected}` · `**Score:** {X.X}/5 (below triage threshold {{TRIAGE_THRESHOLD}} — stub report)`.
- `**Legitimacy:** {tier} — {1-line reason}`.
- `**URL:** {{URL}}` · `**PDF:** ❌ (batch — on-demand via /career-ops pdf)`.
- `**Batch ID:** {{ID}}`.

Body:
- `## A) Role Summary` (1-paragraph TL;DR).
- `## B) CV Match (gaps)` (3-5 bullets, no cv.md quotes — gaps only).
- `## Why skip` (1 sentence).
- `## Keywords` (15 JD keywords for ATS, comma-separated).

### Stub tracker line (only when stub=true)

Write ONE TSV line to `batch/tracker-additions/{{ID}}.tsv` (no header, 9 tab-separated columns):

```
{next_num}\t{{DATE}}\t{company}\t{role}\tSKIP\t{score}/5\t❌\t[{{REPORT_NUM}}](reports/{{REPORT_NUM}}-{company-slug}-{{DATE}}.md)\t{1-sentence note: below triage threshold}
```

`next_num` = max+1 from `data/applications.md` last line. TSV order has status BEFORE score; `applications.md` swaps them — `merge-tracker.mjs` handles it.

## Step 5 — Final stdout JSON

Emit ONE JSON line as the LAST line of stdout (after any prose narration):

```json
{"phase":"triage","status":"completed","id":"{{ID}}","report_num":"{{REPORT_NUM}}","company":"{company}","role":"{role}","score":{score_num},"stub":{true_if_below_threshold_or_NA},"pdf":null,"error":null}
```

On failure: same shape with `"status":"failed"`, `"score":null`, `"stub":null`, `"error":"{description}"`.

## Global rules

**Length budget (HARD):** stub ≤300 words / ≤40 lines · Phase 1 prose ≤150 words per block. Tables don't count.

**NEVER:** WebSearch (this is the triage pass — comp evidence belongs in Phase 2) · fabricate experience/metrics · write to cv.md/i18n.ts · include a phone in drafted outbound text · use corporate-speak ("passionate about", "leveraged", "cutting-edge") · skip writing `{{PHASE1_FILE}}` even when emitting a stub.

**ALWAYS:** use the Facts Pack (do NOT Read cv.md or article-digest.md) · detect archetype + adapt framing · cite exact CV line text in Block B · write in the JD's language (English default) · emit the JSON line as the LAST line of stdout · short sentences, action verbs, no passive padding.
