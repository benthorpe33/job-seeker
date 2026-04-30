import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  extractFullReportSentinelPath,
  registerFullReportReconcileHook,
} from "../api/fullReportOrchestrator.js";
import { applySchema } from "../index/db.js";
import { rebuildIndex } from "../index/rebuild.js";
import { JobRegistry } from "../jobs/registry.js";
import { spawnJob } from "../jobs/runner.js";

const APPLICATIONS_FIXTURE = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-04-29 | Acme | DS | 3.0/5 | SKIP | ❌ | [001](reports/001-acme-2026-04-29.md) | stub — below triage threshold |
| 2 | 2026-04-29 | Other | DS | 4.0/5 | Evaluated | ❌ | [002](reports/002-other-2026-04-29.md) | full |
`;

const STUB_REPORT = `# Evaluation: Acme — Data Scientist

**Date:** 2026-04-29 · **Archetype:** Applied ML · **Score:** 3.0/5 (below triage threshold 3.5 — stub report).
**Legitimacy:** Proceed with Caution — some hint.
**URL:** https://example.com/jobs/1 · **PDF:** ❌ (batch — on-demand).
**Batch ID:** 99.

## A) Role Summary

Stub A.

## B) CV Match (gaps)

Stub B.
`;

const FULL_REPORT_AFTER_PROMOTE = `# Evaluation: Acme — Data Scientist

**Date:** 2026-04-29 · **Archetype:** Applied ML · **Score:** 4.2/5
**Legitimacy:** High Confidence — clear team detail and transparent comp.
**URL:** https://example.com/jobs/1 · **PDF:** ❌ (on-demand via /career-ops pdf).
**Personalization & Interview Plan:** ❌ (on-demand).
**Promoted from stub:** true.

## A) Role Summary

Refined A.

## B) CV Match

Refined B.

## C) Level & Strategy

Senior with downlevel option.

## D) Comp & Demand

Above market.

## Score Global (refined)

| Dimension | Score |
|-----------|-------|
| Global    | 4.2/5 |

## Keywords

a, b, c
`;

function setupRepo(): {
  root: string;
  applicationsPath: string;
  reportsDir: string;
  reportPath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "js-fullorch-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
  const applicationsPath = join(root, "data", "applications.md");
  writeFileSync(applicationsPath, APPLICATIONS_FIXTURE);
  const reportPath = join(root, "reports", "001-acme-2026-04-29.md");
  writeFileSync(reportPath, STUB_REPORT);
  return {
    root,
    applicationsPath,
    reportsDir: join(root, "reports"),
    reportPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function waitForDone(
  job: { emitter: import("node:events").EventEmitter },
  timeoutMs = 5000,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for job done")), timeoutMs);
    job.emitter.once("done", (ev: { code: number | null; signal: string | null }) => {
      clearTimeout(t);
      resolve(ev);
    });
  });
}

test("extractFullReportSentinelPath finds the last FULL_REPORT_DONE line", () => {
  const lines = [
    "starting…",
    "FULL_REPORT_DONE: /tmp/old.md",
    "writing report",
    "FULL_REPORT_DONE: /abs/reports/001-acme-2026-04-29.md",
  ];
  assert.equal(
    extractFullReportSentinelPath(lines),
    "/abs/reports/001-acme-2026-04-29.md",
  );
});

test("extractFullReportSentinelPath returns null when absent", () => {
  assert.equal(extractFullReportSentinelPath(["a", "b"]), null);
});

test("registerFullReportReconcileHook updates score after a successful promote", async () => {
  const { applicationsPath, reportPath, cleanup } = setupRepo();
  const registry = new JobRegistry();
  try {
    // Synthetic worker: overwrite the stub with a full A-G report and emit
    // the FULL_REPORT_DONE sentinel.
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(FULL_REPORT_AFTER_PROMOTE)});
console.log('progress: blocks A-G written');
console.log('FULL_REPORT_DONE: ' + ${JSON.stringify(reportPath)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "full-report",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerFullReportReconcileHook({
      job,
      reportNum: 1,
      reportPath,
      applicationsMdPath: applicationsPath,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const after = readFileSync(applicationsPath, "utf-8");
    const row1 = after.split(/\r?\n/).find((l) => l.startsWith("| 1 |")) ?? "";
    assert.match(row1, /\| 4\.2\/5 \|/, `row 1 score should now be 4.2/5: ${row1}`);
    // Status, PDF, report path untouched.
    assert.match(row1, /\| SKIP \|/);
    assert.match(row1, /\| ❌ \|/);
    assert.match(row1, /001-acme-2026-04-29\.md/);

    // Row 2 untouched.
    const row2 = after.split(/\r?\n/).find((l) => l.startsWith("| 2 |")) ?? "";
    assert.match(row2, /\| 4\.0\/5 \|/, `row 2 should be untouched: ${row2}`);
  } finally {
    cleanup();
  }
});

test("registerFullReportReconcileHook handles downward score revisions", async () => {
  const { applicationsPath, reportPath, cleanup } = setupRepo();
  const registry = new JobRegistry();
  try {
    // Promoted result LOWER than the stub's score — this is the merge-tracker
    // gap T7 explicitly works around. The applications.md row must still
    // reflect the new (lower) score.
    const lowerReport = FULL_REPORT_AFTER_PROMOTE.replace("4.2/5", "2.5/5").replace(
      "| 4.2/5 |",
      "| 2.5/5 |",
    );
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(lowerReport)});
console.log('FULL_REPORT_DONE: ' + ${JSON.stringify(reportPath)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "full-report",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerFullReportReconcileHook({
      job,
      reportNum: 1,
      reportPath,
      applicationsMdPath: applicationsPath,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const row1 = readFileSync(applicationsPath, "utf-8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("| 1 |")) ?? "";
    assert.match(row1, /\| 2\.5\/5 \|/, `score must move down too: ${row1}`);
  } finally {
    cleanup();
  }
});

test("registerFullReportReconcileHook does NOT mutate on failed jobs", async () => {
  const { applicationsPath, reportPath, cleanup } = setupRepo();
  const registry = new JobRegistry();
  try {
    const job = spawnJob({
      kind: "full-report",
      cmd: process.execPath,
      args: ["-e", "console.error('boom'); process.exit(2)"],
      cwd: process.cwd(),
      registry,
    });
    registerFullReportReconcileHook({
      job,
      reportNum: 1,
      reportPath,
      applicationsMdPath: applicationsPath,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const after = readFileSync(applicationsPath, "utf-8");
    assert.equal(
      after,
      APPLICATIONS_FIXTURE,
      "applications.md must be untouched on failure",
    );
    // Stub report file untouched too.
    assert.equal(readFileSync(reportPath, "utf-8"), STUB_REPORT);
  } finally {
    cleanup();
  }
});

test("registerFullReportReconcileHook optimistically updates in-process DB row", async () => {
  // Mirrors PATCH and generate-cv hook: after the markdown mutation, UPDATE
  // the in-process DB so SSE-driven refetches see the new score before the
  // watcher's debounced re-index fires.
  const root = mkdtempSync(join(tmpdir(), "js-fullorch-db-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "career-ops" }));
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "reports"), { recursive: true });
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(
      join(root, "templates", "states.yml"),
      `states:\n  - id: evaluated\n    label: Evaluated\n  - id: skip\n    label: SKIP\n`,
    );
    writeFileSync(join(root, "data", "applications.md"), APPLICATIONS_FIXTURE);
    writeFileSync(join(root, "data", "scan-history.tsv"), "url\tfirst_seen\n");
    writeFileSync(join(root, "data", "pipeline.md"), "# Pipeline\n");
    const reportPath = join(root, "reports", "001-acme-2026-04-29.md");
    writeFileSync(reportPath, STUB_REPORT);

    const db = new Database(":memory:");
    applySchema(db);
    rebuildIndex(db, root);

    const before = db
      .prepare(`SELECT score FROM applications WHERE num = ?`)
      .get(1) as { score: number };
    assert.equal(before.score, 3.0);

    const registry = new JobRegistry();
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(FULL_REPORT_AFTER_PROMOTE)});
console.log('FULL_REPORT_DONE: ' + ${JSON.stringify(reportPath)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "full-report",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerFullReportReconcileHook({
      job,
      reportNum: 1,
      reportPath,
      applicationsMdPath: join(root, "data", "applications.md"),
      db,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const after = db
      .prepare(`SELECT score, raw_line FROM applications WHERE num = ?`)
      .get(1) as { score: number; raw_line: string };
    assert.equal(after.score, 4.2, "in-process DB should report score=4.2");
    assert.match(after.raw_line, /\| 4\.2\/5 \|/);

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerFullReportReconcileHook silently warns when applications row is missing", async () => {
  const { applicationsPath, reportPath, cleanup } = setupRepo();
  const registry = new JobRegistry();
  const warnings: string[] = [];
  try {
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(FULL_REPORT_AFTER_PROMOTE)});
console.log('FULL_REPORT_DONE: ' + ${JSON.stringify(reportPath)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "full-report",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerFullReportReconcileHook({
      job,
      reportNum: 999, // not in fixture
      reportPath,
      applicationsMdPath: applicationsPath,
      log: {
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    // applications.md is unchanged because the row is missing.
    assert.equal(readFileSync(applicationsPath, "utf-8"), APPLICATIONS_FIXTURE);
    assert.ok(
      warnings.some((m) => m.includes("#999")),
      `expected a warning mentioning #999, got: ${warnings.join(" | ")}`,
    );
  } finally {
    cleanup();
  }
});

test("registerFullReportReconcileHook ignores result when the rewritten report has no score", async () => {
  const { applicationsPath, reportPath, cleanup } = setupRepo();
  const registry = new JobRegistry();
  const warnings: string[] = [];
  try {
    // No `**Score:**` line → parseReportMd returns score=null.
    const noScoreReport = `# Evaluation: Acme — Data Scientist

**Date:** 2026-04-29
**URL:** https://example.com/jobs/1

## A) Role Summary

x
`;
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(noScoreReport)});
console.log('FULL_REPORT_DONE: ' + ${JSON.stringify(reportPath)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "full-report",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerFullReportReconcileHook({
      job,
      reportNum: 1,
      reportPath,
      applicationsMdPath: applicationsPath,
      log: {
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    // applications.md untouched (3.0/5 still).
    const row1 = readFileSync(applicationsPath, "utf-8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("| 1 |")) ?? "";
    assert.match(row1, /\| 3\.0\/5 \|/);
    assert.ok(
      warnings.some((m) => m.includes("no Score header")),
      `expected a warning about missing Score, got: ${warnings.join(" | ")}`,
    );
  } finally {
    cleanup();
  }
});
