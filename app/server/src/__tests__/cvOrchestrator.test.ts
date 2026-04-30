import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  extractSentinelPath,
  findGeneratedPdf,
  registerPdfReconcileHook,
} from "../api/cvOrchestrator.js";
import { applySchema } from "../index/db.js";
import { rebuildIndex } from "../index/rebuild.js";
import { JobRegistry } from "../jobs/registry.js";
import { spawnJob } from "../jobs/runner.js";

const APPLICATIONS_FIXTURE = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-04-29 | Anthropic | AI Engineer | 4.5/5 | Evaluated | ❌ | [001](reports/001-anthropic-2026-04-29.md) | top match |
| 2 | 2026-04-29 | Generic | DS | 3.0/5 | SKIP | ❌ | [002](reports/002-generic-2026-04-29.md) | low |
`;

function setupRepo(): { root: string; applicationsPath: string; outputDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "js-cvorch-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "output"), { recursive: true });
  const applicationsPath = join(root, "data", "applications.md");
  writeFileSync(applicationsPath, APPLICATIONS_FIXTURE);
  return {
    root,
    applicationsPath,
    outputDir: join(root, "output"),
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

test("extractSentinelPath finds the last GENERATE_CV_DONE line", () => {
  const lines = [
    "starting…",
    "tailoring summary",
    "GENERATE_CV_DONE: /tmp/should-not-win.pdf",
    "writing PDF",
    "GENERATE_CV_DONE: /abs/path/cv-foo-2026-04-29.pdf",
  ];
  assert.equal(
    extractSentinelPath(lines),
    "/abs/path/cv-foo-2026-04-29.pdf",
  );
});

test("extractSentinelPath returns null when no sentinel present", () => {
  assert.equal(extractSentinelPath(["a", "b", "c"]), null);
  assert.equal(extractSentinelPath([]), null);
});

test("findGeneratedPdf matches slug + date and returns newest", () => {
  const { outputDir, cleanup } = setupRepo();
  try {
    writeFileSync(join(outputDir, "cv-ben-thorpe-anthropic-2026-04-29.pdf"), "x");
    // Different slug — must NOT match.
    writeFileSync(join(outputDir, "cv-ben-thorpe-perplexity-2026-04-29.pdf"), "x");
    // Different date — must NOT match.
    writeFileSync(join(outputDir, "cv-ben-thorpe-anthropic-2026-04-22.pdf"), "x");
    const found = findGeneratedPdf(outputDir, "anthropic", "2026-04-29");
    assert.ok(found, "expected a match");
    assert.match(found!, /cv-ben-thorpe-anthropic-2026-04-29\.pdf$/);
  } finally {
    cleanup();
  }
});

test("findGeneratedPdf respects sinceMs filter", () => {
  const { outputDir, cleanup } = setupRepo();
  try {
    const f = join(outputDir, "cv-x-foo-2026-04-29.pdf");
    writeFileSync(f, "x");
    // Pretend the file was written before the job started.
    const future = Date.now() + 60_000;
    assert.equal(findGeneratedPdf(outputDir, "foo", "2026-04-29", future), null);
    assert.match(
      findGeneratedPdf(outputDir, "foo", "2026-04-29", 0)!,
      /cv-x-foo-2026-04-29\.pdf$/,
    );
  } finally {
    cleanup();
  }
});

test("findGeneratedPdf escapes regex metachars in slug/date", () => {
  const { outputDir, cleanup } = setupRepo();
  try {
    // A slug-like string with a dot: it must match literally, not as regex `.`.
    writeFileSync(join(outputDir, "cv-x-foo.bar-2026-04-29.pdf"), "x");
    writeFileSync(join(outputDir, "cv-x-fooXbar-2026-04-29.pdf"), "x");
    const found = findGeneratedPdf(outputDir, "foo.bar", "2026-04-29");
    assert.ok(found);
    assert.match(found!, /cv-x-foo\.bar-2026-04-29\.pdf$/);
  } finally {
    cleanup();
  }
});

test("registerPdfReconcileHook flips PDF column on completed job with sentinel", async () => {
  const { applicationsPath, outputDir, cleanup } = setupRepo();
  const registry = new JobRegistry();
  const expectedPdf = join(outputDir, "cv-ben-thorpe-anthropic-2026-04-29.pdf");
  try {
    // Synthetic worker: write a fake PDF, print the sentinel, exit 0.
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(expectedPdf)}, 'pdf');
console.log('progress: tailoring');
console.log('GENERATE_CV_DONE: ' + ${JSON.stringify(expectedPdf)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "generate-cv",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerPdfReconcileHook({
      job,
      reportNum: 1,
      slug: "anthropic",
      date: "2026-04-29",
      applicationsMdPath: applicationsPath,
      outputDir,
      jobStartedMs: job.startedAtMs,
    });
    await waitForDone(job);
    // Hook fires synchronously inside the 'done' listener — wait one tick for I/O.
    await new Promise((r) => setImmediate(r));

    const after = readFileSync(applicationsPath, "utf-8");
    const row1 = after.split(/\r?\n/).find((l) => l.startsWith("| 1 |")) ?? "";
    assert.match(row1, /\| ✅ \|/, `row 1 PDF column should be ✅: ${row1}`);
    // Row 2 untouched.
    const row2 = after.split(/\r?\n/).find((l) => l.startsWith("| 2 |")) ?? "";
    assert.match(row2, /\| ❌ \|/, `row 2 PDF column should remain ❌: ${row2}`);
  } finally {
    cleanup();
  }
});

test("registerPdfReconcileHook falls back to filesystem glob when no sentinel", async () => {
  const { applicationsPath, outputDir, cleanup } = setupRepo();
  const registry = new JobRegistry();
  try {
    const expectedPdf = join(outputDir, "cv-x-anthropic-2026-04-29.pdf");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(expectedPdf)}, 'pdf');
console.log('done without sentinel');
process.exit(0);
`;
    const job = spawnJob({
      kind: "generate-cv",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerPdfReconcileHook({
      job,
      reportNum: 1,
      slug: "anthropic",
      date: "2026-04-29",
      applicationsMdPath: applicationsPath,
      outputDir,
      jobStartedMs: job.startedAtMs,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const row1 = readFileSync(applicationsPath, "utf-8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("| 1 |")) ?? "";
    assert.match(row1, /\| ✅ \|/);
  } finally {
    cleanup();
  }
});

test("registerPdfReconcileHook does NOT mutate on cancelled/failed jobs", async () => {
  const { applicationsPath, outputDir, cleanup } = setupRepo();
  const registry = new JobRegistry();
  try {
    const job = spawnJob({
      kind: "generate-cv",
      cmd: process.execPath,
      args: ["-e", "console.error('boom'); process.exit(2)"],
      cwd: process.cwd(),
      registry,
    });
    registerPdfReconcileHook({
      job,
      reportNum: 1,
      slug: "anthropic",
      date: "2026-04-29",
      applicationsMdPath: applicationsPath,
      outputDir,
      jobStartedMs: job.startedAtMs,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const after = readFileSync(applicationsPath, "utf-8");
    assert.equal(after, APPLICATIONS_FIXTURE, "applications.md must be untouched on failure");
  } finally {
    cleanup();
  }
});

test("registerPdfReconcileHook optimistically updates in-process DB row", async () => {
  // Mirrors PATCH endpoint behavior in api/applications.ts: after the markdown
  // mutation we directly UPDATE the in-process DB so SSE-driven refetches see
  // the new ✅ before the watcher's debounced re-index fires.
  const root = mkdtempSync(join(tmpdir(), "js-cvorch-db-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "career-ops" }));
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "output"), { recursive: true });
    mkdirSync(join(root, "reports"), { recursive: true });
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(
      join(root, "templates", "states.yml"),
      `states:\n  - id: evaluated\n    label: Evaluated\n  - id: skip\n    label: SKIP\n`,
    );
    writeFileSync(join(root, "data", "applications.md"), APPLICATIONS_FIXTURE);
    writeFileSync(join(root, "data", "scan-history.tsv"), "url\tfirst_seen\n");
    writeFileSync(join(root, "data", "pipeline.md"), "# Pipeline\n");
    writeFileSync(
      join(root, "reports", "001-anthropic-2026-04-29.md"),
      `# Evaluation\n**Score:** 4.5/5\n**URL:** https://example.com\n\n## A) Role Summary\nx\n`,
    );

    const db = new Database(":memory:");
    applySchema(db);
    rebuildIndex(db, root);

    // Sanity: row 1 starts with has_pdf=0.
    const before = db
      .prepare(`SELECT has_pdf FROM applications WHERE num = ?`)
      .get(1) as { has_pdf: number };
    assert.equal(before.has_pdf, 0);

    const registry = new JobRegistry();
    const expectedPdf = join(root, "output", "cv-x-anthropic-2026-04-29.pdf");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(expectedPdf)}, 'pdf');
console.log('GENERATE_CV_DONE: ' + ${JSON.stringify(expectedPdf)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "generate-cv",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerPdfReconcileHook({
      job,
      reportNum: 1,
      slug: "anthropic",
      date: "2026-04-29",
      applicationsMdPath: join(root, "data", "applications.md"),
      outputDir: join(root, "output"),
      jobStartedMs: job.startedAtMs,
      db,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const after = db
      .prepare(`SELECT has_pdf, raw_line FROM applications WHERE num = ?`)
      .get(1) as { has_pdf: number; raw_line: string };
    assert.equal(after.has_pdf, 1, "in-process DB should report has_pdf=1");
    assert.match(after.raw_line, /\| ✅ \|/);

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerPdfReconcileHook silently warns when applications row is missing", async () => {
  const { applicationsPath, outputDir, cleanup } = setupRepo();
  const registry = new JobRegistry();
  const warnings: string[] = [];
  try {
    const expectedPdf = join(outputDir, "cv-x-newrole-2026-04-29.pdf");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(expectedPdf)}, 'pdf');
console.log('GENERATE_CV_DONE: ' + ${JSON.stringify(expectedPdf)});
process.exit(0);
`;
    const job = spawnJob({
      kind: "generate-cv",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerPdfReconcileHook({
      job,
      // 999 doesn't exist in fixture.
      reportNum: 999,
      slug: "newrole",
      date: "2026-04-29",
      applicationsMdPath: applicationsPath,
      outputDir,
      jobStartedMs: job.startedAtMs,
      log: {
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const after = readFileSync(applicationsPath, "utf-8");
    assert.equal(after, APPLICATIONS_FIXTURE);
    assert.ok(
      warnings.some((m) => m.includes("#999")),
      `expected a warning mentioning #999, got: ${warnings.join(" | ")}`,
    );
  } finally {
    cleanup();
  }
});
