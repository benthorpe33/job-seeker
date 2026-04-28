# Mode: personalize — On-demand Block E (CV + LinkedIn personalization plan)

When Ben decides to apply to an offer evaluated in batch, run this mode to generate the Personalization Plan that batch reports omit. Mirror of the on-demand PDF pattern: re-read fresh sources at invocation time, produce a standalone artifact.

## Inputs

1. **Report path or company+role** (required) — typically `reports/{NUM}-{slug}-{DATE}.md`.
2. **JD** — read from the report header `**URL:**` line; if missing or stale, ask the user for the URL or pasted JD text.
3. **CV** at `cv.md` — re-read fresh (do NOT trust any quoted lines from the report).
4. **Profile** at `config/profile.yml` + `modes/_profile.md` — for archetype-aware framing and stylistic rules.
5. **Article digest** at `article-digest.md` — for proof-point metrics. Treated as authoritative over `cv.md` when numbers conflict.

## Step 1 — Re-extract context

- Open the existing report. Read: archetype, score, gaps, JD URL.
- WebFetch (or Playwright if needed) the JD from the URL. If the posting is closed, fall back to the report's quoted JD content and warn the user.
- Re-read `cv.md` and `article-digest.md` fresh — never reuse quoted lines from the report.

## Step 2 — Generate Block E

Output a markdown table with **Top 5 CV changes + Top 5 LinkedIn changes**:

| # | Section | Current state | Proposed change | Why |
|---|---------|---------------|------------------|-----|

Rules:
- Each row cites a specific cv.md line or LinkedIn section.
- Proposed changes must be **truthful rephrasings** — do NOT invent skills or metrics.
- "Why" links the change to a specific JD requirement or archetype lever (FDE → delivery speed; SA → integrations; PM → discovery; LLMOps → evals; Agentic → orchestration; Transformation → adoption).
- Adapt to detected archetype from the report header.

## Step 3 — Save artifact

Write the output to:

```
reports/{NUM}-{slug}-{DATE}-personalize.md
```

Header:

```markdown
# Personalization Plan: {Company} — {Role}

**Source report:** [{NUM}](./{NUM}-{slug}-{DATE}.md)
**Generated:** {YYYY-MM-DD}
**Archetype:** {from source report}
```

Then the Block E table.

## Step 4 — Update tracker (optional)

If the user confirms they're moving forward to apply, update the `Personalization & Interview Plan:` line in the source report from `❌` to `✅ (see {personalize-file-name})`.

## Rules

- Never modify `cv.md`. The plan is a separate artifact.
- Never fabricate experience or metrics — read from cv.md + article-digest.md at invocation time.
- Be direct, action-oriented; no fluff. 5+5 changes max — quality over quantity.
- Generate in JD language (EN default).
