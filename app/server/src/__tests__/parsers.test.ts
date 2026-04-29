import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseApplicationsMd } from "../index/parsers/applicationsMd.js";
import { parsePipelineMd } from "../index/parsers/pipelineMd.js";
import { parseReportMd } from "../index/parsers/reportMd.js";
import { parseScanHistoryTsv } from "../index/parsers/scanHistoryTsv.js";

test("applicationsMd parses a real-shaped row", () => {
  const md = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 113 | 2026-04-29 | Teamworks | Data Scientist II | 3.7/5 | Evaluated | ❌ | [158](reports/158-teamworks-2026-04-29.md) | sample notes |
| 1 | 2026-04-22 | Anthropic | Applied AI Engineer | 4.2/5 | SKIP | ✅ | [005](reports/005-anthropic-2026-04-22.md) | re-eval |
`;
  const rows = parseApplicationsMd(md);
  assert.equal(rows.length, 2);
  const r0 = rows[0];
  assert.ok(r0);
  assert.equal(r0.num, 113);
  assert.equal(r0.company, "Teamworks");
  assert.equal(r0.score, 3.7);
  assert.equal(r0.status, "Evaluated");
  assert.equal(r0.hasPdf, 0);
  assert.equal(r0.reportPath, "reports/158-teamworks-2026-04-29.md");
  assert.ok(r0.rawLine.startsWith("| 113 |"));

  const r1 = rows[1];
  assert.ok(r1);
  assert.equal(r1.hasPdf, 1);
  assert.equal(r1.status, "SKIP");
});

test("reportMd parses full and stub headers", () => {
  const full = `# Evaluation: Foo — Bar
**Date:** 2026-04-22
**Score:** 4.4/5
**Legitimacy:** High Confidence
**URL:** https://example.com/job
**Verification:** unconfirmed (batch mode)

## A) Role Summary
alpha
## B) CV Match
beta
## G) Posting Legitimacy
gamma
`;
  const r = parseReportMd("064-foo-2026-04-22.md", full, 1234567);
  assert.equal(r.id, "064-foo-2026-04-22");
  assert.equal(r.num, 64);
  assert.equal(r.score, 4.4);
  assert.equal(r.url, "https://example.com/job");
  assert.equal(r.legitimacy, "High Confidence");
  assert.equal(r.verification, "unconfirmed (batch mode)");
  assert.deepEqual(Object.keys(r.blocks).sort(), ["A", "B", "G"]);

  const stub = `# Evaluation: Maple — FDE Growth

**Date:** 2026-04-28 · **Archetype:** Growth · **Score:** 2.4/5 (below threshold).
**Legitimacy:** Proceed with Caution
**URL:** https://example.com/x · **PDF:** ❌

## A) Role Summary
text
## B) CV Match (gaps)
text
## Why skip
text
`;
  const s = parseReportMd("138-maple-2026-04-28.md", stub, 1);
  assert.equal(s.score, 2.4);
  assert.equal(s.legitimacy, "Proceed with Caution");
  assert.equal(s.url, "https://example.com/x");
  assert.deepEqual(Object.keys(s.blocks).sort(), ["A", "B"]);
});

test("scanHistoryTsv handles header + one row", () => {
  const tsv =
    "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n" +
    "https://example.com\t2026-04-22\tgreenhouse-api\tApplied AI Engineer\tAnthropic\tadded\n";
  const rows = parseScanHistoryTsv(tsv);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.ok(r);
  assert.equal(r.company, "Anthropic");
  assert.equal(r.status, "added");
});

test("pipelineMd handles both checked states and overflow location", () => {
  const md = `# Pipeline

- [ ] https://a/job1 | Foo | Eng | NYC
- [x] https://a/job2 | Bar | DS | Boston, MA | NYC, NY | SF, CA
- not a row
`;
  const rows = parsePipelineMd(md);
  assert.equal(rows.length, 2);
  const r0 = rows[0];
  const r1 = rows[1];
  assert.ok(r0 && r1);
  assert.equal(r0.checked, 0);
  assert.equal(r1.checked, 1);
  assert.equal(r1.location, "Boston, MA | NYC, NY | SF, CA");
});
