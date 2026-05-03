import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";

import type { DraftFile } from "@job-seeker/shared";

import { draftOrchestratorPlugin } from "../api/draftOrchestrator.js";
import { applySchema } from "../index/db.js";
import { rebuildIndex } from "../index/rebuild.js";
import { JobRegistry } from "../jobs/registry.js";
import { spawnJob } from "../jobs/runner.js";
import {
  draftsPathFor,
  extractDoneCount,
  extractFailureReason,
  parseDraftLines,
  readDraftsFile,
  redactPhoneFromAnswer,
  registerDraftReconcileHook,
  writeDraftsFile,
} from "../scraper/draftReconcile.js";

// ── Pure helpers ────────────────────────────────────────────────────────────

test("parseDraftLines: extracts well-formed DRAFT: lines and ignores noise", () => {
  const lines = [
    "Reading cv.md...",
    'DRAFT: {"fieldId":"q1","answer":"hello","charCount":5,"warnings":[]}',
    "progress: drafting q2",
    'DRAFT: {"fieldId":"q2","answer":"world","charCount":5,"warnings":["truncated to fit maxLen"]}',
    "DRAFT_ANSWERS_DONE: 2",
  ];
  const drafts = parseDraftLines(lines);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0]?.fieldId, "q1");
  assert.equal(drafts[0]?.answer, "hello");
  assert.equal(drafts[0]?.charCount, 5);
  assert.deepEqual(drafts[0]?.warnings, []);
  assert.equal(drafts[1]?.fieldId, "q2");
  assert.deepEqual(drafts[1]?.warnings, ["truncated to fit maxLen"]);
});

test("parseDraftLines: skips malformed JSON", () => {
  const lines = [
    "DRAFT: not-json",
    'DRAFT: {"fieldId":"q1"}', // missing answer
    'DRAFT: {"answer":"x"}', // missing fieldId
    'DRAFT: {"fieldId":"ok","answer":"yes"}',
  ];
  const drafts = parseDraftLines(lines);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.fieldId, "ok");
  // Defaulted charCount when missing.
  assert.equal(drafts[0]?.charCount, 3);
});

test("parseDraftLines: defaults warnings to empty when missing or wrong type", () => {
  const lines = [
    'DRAFT: {"fieldId":"q1","answer":"hi","warnings":"oops"}',
    'DRAFT: {"fieldId":"q2","answer":"hi"}',
  ];
  const drafts = parseDraftLines(lines);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0]?.warnings, []);
  assert.deepEqual(drafts[1]?.warnings, []);
});

test("extractDoneCount and extractFailureReason find the LAST matching marker", () => {
  const lines = [
    "DRAFT_ANSWERS_DONE: 1",
    "DRAFT_ANSWERS_DONE: 5",
    "trailing noise",
  ];
  assert.equal(extractDoneCount(lines), 5);
  assert.equal(extractFailureReason(lines), null);

  const failed = [
    "DRAFT_ANSWERS_FAILED: malformed fields",
    "DRAFT_ANSWERS_FAILED: actually no proof points",
  ];
  assert.equal(extractFailureReason(failed), "actually no proof points");
});

test("redactPhoneFromAnswer: replaces XXX-XXX-XXXX, adds warning", () => {
  const d = redactPhoneFromAnswer({
    fieldId: "q1",
    answer: "Reach me at 786-300-9961 anytime.",
    charCount: 32,
    warnings: [],
  });
  assert.match(d.answer, /\[PHONE REDACTED\]/);
  assert.doesNotMatch(d.answer, /\d{3}-\d{3}-\d{4}/);
  assert.ok(d.warnings.includes("phone-number-detected; redacted"));
  assert.equal(d.charCount, d.answer.length);
});

test("redactPhoneFromAnswer: leaves clean answers untouched and adds no warning", () => {
  const original = {
    fieldId: "q1",
    answer: "Built clinical NLP for Prior-Auth at ZS — 42k matches in production.",
    charCount: 70,
    warnings: ["existing"],
  };
  const d = redactPhoneFromAnswer(original);
  assert.equal(d.answer, original.answer);
  assert.deepEqual(d.warnings, ["existing"]);
});

test("redactPhoneFromAnswer: handles MULTIPLE phone numbers in one answer", () => {
  // Acceptance criterion (4): \d{3}-\d{3}-\d{4} must not appear in any
  // drafted answer. Even if the worker leaks the phone in multiple places we
  // redact every occurrence, not just the first.
  const d = redactPhoneFromAnswer({
    fieldId: "q1",
    answer: "Call 786-300-9961 or 555-555-5555 if needed.",
    charCount: 40,
    warnings: [],
  });
  assert.doesNotMatch(d.answer, /\d{3}-\d{3}-\d{4}/);
  // One warning per redaction PASS, not per match.
  assert.equal(
    d.warnings.filter((w) => w === "phone-number-detected; redacted").length,
    1,
  );
});

// ── writeDraftsFile + readDraftsFile round-trip ─────────────────────────────

test("writeDraftsFile and readDraftsFile round-trip preserves the DraftFile shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "js-draft-rw-"));
  try {
    const path = join(dir, "drafts.json");
    const drafts = [
      { fieldId: "q1", answer: "alpha", charCount: 5, warnings: [] },
      { fieldId: "q2", answer: "beta", charCount: 4, warnings: ["w1"] },
    ];
    const written = writeDraftsFile(path, "report-x", "https://example.com/apply", drafts);
    assert.equal(written.reportId, "report-x");
    assert.equal(written.drafts.length, 2);

    const loaded = readDraftsFile(path);
    assert.ok(loaded);
    assert.equal(loaded?.reportId, "report-x");
    assert.equal(loaded?.applyUrl, "https://example.com/apply");
    assert.equal(loaded?.drafts.length, 2);
    assert.equal(loaded?.drafts[0]?.fieldId, "q1");
    assert.deepEqual(loaded?.drafts[1]?.warnings, ["w1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDraftsFile returns null for missing or malformed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "js-draft-rd-"));
  try {
    assert.equal(readDraftsFile(join(dir, "missing.json")), null);
    writeFileSync(join(dir, "bad.json"), "{not json");
    assert.equal(readDraftsFile(join(dir, "bad.json")), null);
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ foo: "bar" }));
    assert.equal(readDraftsFile(join(dir, "wrong.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Reconcile hook with synthetic claude worker (node -e) ──────────────────

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

test("registerDraftReconcileHook writes drafts.json on a successful synthetic worker run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "js-draft-hook-"));
  try {
    const draftsPath = join(dir, "drafts.json");
    const fieldsFilePath = join(dir, ".draft-fields.json");
    writeFileSync(fieldsFilePath, "{}"); // placeholder; hook should clean it up
    const registry = new JobRegistry();

    const drafts = [
      {
        fieldId: "q1",
        answer:
          "Built a PA-policy NLP pipeline at ZS that processes 42k matches across 20 leagues.",
        charCount: 84,
        warnings: [],
      },
      {
        fieldId: "q2",
        answer:
          "Shipped Cloudflare R2 storage and Lambda/Go pipelines end-to-end.",
        charCount: 65,
        warnings: [],
      },
    ];
    const lines = drafts
      .map((d) => "DRAFT: " + JSON.stringify(d))
      .concat([`DRAFT_ANSWERS_DONE: ${drafts.length}`]);

    const script = `
const out = ${JSON.stringify(lines)};
for (const l of out) console.log(l);
process.exit(0);
`;
    const job = spawnJob({
      kind: "draft-answers",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerDraftReconcileHook({
      job,
      reportId: "001-acme-2026-04-29",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
      draftsPath,
      fieldsFilePath,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const file = readDraftsFile(draftsPath);
    assert.ok(file, "drafts.json should exist after a successful run");
    assert.equal(file?.reportId, "001-acme-2026-04-29");
    assert.equal(file?.applyUrl, "https://boards.greenhouse.io/acme/jobs/1");
    assert.equal(file?.drafts.length, 2);
    assert.equal(file?.drafts[0]?.fieldId, "q1");

    // Acceptance (5): proof points propagate from the worker into drafts.json
    // unchanged. We synthesized 3 specific cv.md anchors ("PA-policy NLP",
    // "42k matches", "Cloudflare R2") across the two answers — verify they
    // round-trip.
    const allText = file!.drafts.map((d) => d.answer).join(" ");
    assert.match(allText, /PA-policy NLP/);
    assert.match(allText, /42k matches/);
    assert.match(allText, /Cloudflare R2/);

    // Hook cleaned up the temp fields file.
    assert.equal(existsSync(fieldsFilePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerDraftReconcileHook redacts phone numbers leaked by the worker", async () => {
  // Acceptance (4): the regex \d{3}-\d{3}-\d{4} must not appear in any
  // drafted answer in drafts.json. Even if the worker disobeys the prompt,
  // the server's defense-in-depth pass strips the phone and warns.
  const dir = mkdtempSync(join(tmpdir(), "js-draft-phone-"));
  try {
    const draftsPath = join(dir, "drafts.json");
    const registry = new JobRegistry();

    // 5 sample questions per the acceptance criteria.
    const drafts = [
      { fieldId: "q1", answer: "Reach me at 786-300-9961.", charCount: 26, warnings: [] },
      { fieldId: "q2", answer: "Clean — no phone here.", charCount: 22, warnings: [] },
      { fieldId: "q3", answer: "Call 555-123-4567 anytime.", charCount: 26, warnings: [] },
      { fieldId: "q4", answer: "Phone: 786-300-9961 · email omitted.", charCount: 36, warnings: [] },
      { fieldId: "q5", answer: "All good.", charCount: 9, warnings: [] },
    ];
    const lines = drafts
      .map((d) => "DRAFT: " + JSON.stringify(d))
      .concat(["DRAFT_ANSWERS_DONE: 5"]);

    const script = `
const out = ${JSON.stringify(lines)};
for (const l of out) console.log(l);
process.exit(0);
`;
    const job = spawnJob({
      kind: "draft-answers",
      cmd: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      registry,
    });
    registerDraftReconcileHook({
      job,
      reportId: "099-phone-test-2026-05-02",
      applyUrl: null,
      draftsPath,
      fieldsFilePath: null,
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    const file = readDraftsFile(draftsPath);
    assert.ok(file);
    // The exact acceptance check from js-eog (4): no phone-shaped string
    // anywhere across all drafted answers.
    for (const d of file!.drafts) {
      assert.doesNotMatch(d.answer, /\d{3}-\d{3}-\d{4}/, `field ${d.fieldId} still has a phone: ${d.answer}`);
    }
    // Three answers contained a phone, two didn't.
    const redacted = file!.drafts.filter((d) =>
      d.warnings.includes("phone-number-detected; redacted"),
    );
    assert.equal(redacted.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerDraftReconcileHook does NOT write drafts.json when worker exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "js-draft-fail-"));
  try {
    const draftsPath = join(dir, "drafts.json");
    const registry = new JobRegistry();
    const warnings: string[] = [];

    const job = spawnJob({
      kind: "draft-answers",
      cmd: process.execPath,
      args: ["-e", "console.log('DRAFT_ANSWERS_FAILED: bad inputs'); process.exit(2);"],
      cwd: process.cwd(),
      registry,
    });
    registerDraftReconcileHook({
      job,
      reportId: "abc",
      applyUrl: null,
      draftsPath,
      fieldsFilePath: null,
      log: {
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    assert.equal(existsSync(draftsPath), false);
    assert.ok(
      warnings.some((m) => m.includes("bad inputs")),
      `expected a warning citing the failure reason, got: ${warnings.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerDraftReconcileHook warns and skips when worker emits zero DRAFT: lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "js-draft-empty-"));
  try {
    const draftsPath = join(dir, "drafts.json");
    const registry = new JobRegistry();
    const warnings: string[] = [];

    const job = spawnJob({
      kind: "draft-answers",
      cmd: process.execPath,
      args: ["-e", "console.log('starting'); console.log('DRAFT_ANSWERS_DONE: 0'); process.exit(0);"],
      cwd: process.cwd(),
      registry,
    });
    registerDraftReconcileHook({
      job,
      reportId: "empty",
      applyUrl: null,
      draftsPath,
      fieldsFilePath: null,
      log: {
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    await waitForDone(job);
    await new Promise((r) => setImmediate(r));

    assert.equal(existsSync(draftsPath), false);
    assert.ok(warnings.some((m) => /no DRAFT:/.test(m)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Endpoint tests with full Fastify + DB stack ────────────────────────────

const APPLICATIONS_FIXTURE = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-04-29 | Acme | DS | 4.0/5 | Evaluated | ❌ | [001](reports/001-acme-2026-04-29.md) | full |
`;

const REPORT_FIXTURE = `# Evaluation: Acme — Data Scientist

**Date:** 2026-04-29 · **Archetype:** Applied ML · **Score:** 4.0/5
**Legitimacy:** High Confidence
**URL:** https://boards.greenhouse.io/acme/jobs/1
**PDF:** ❌

## A) Role Summary

x

## B) CV Match

y
`;

async function buildAppWithDb(): Promise<{
  app: FastifyInstance;
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), "js-draft-api-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "career-ops" }));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(
    join(root, "templates", "states.yml"),
    `states:\n  - id: evaluated\n    label: Evaluated\n`,
  );
  writeFileSync(join(root, "data", "applications.md"), APPLICATIONS_FIXTURE);
  writeFileSync(join(root, "data", "scan-history.tsv"), "url\tfirst_seen\n");
  writeFileSync(join(root, "data", "pipeline.md"), "# Pipeline\n");
  writeFileSync(
    join(root, "reports", "001-acme-2026-04-29.md"),
    REPORT_FIXTURE,
  );

  const db = new Database(":memory:");
  applySchema(db);
  rebuildIndex(db, root);

  const app = Fastify({ logger: false });
  const registry = new JobRegistry();
  app.decorate("jobs", registry);
  app.decorate("jobsBashPath", null); // bash gating tested separately
  app.decorate("indexDb", db);
  await app.register(draftOrchestratorPlugin);
  await app.ready();

  return {
    app,
    root,
    cleanup: async () => {
      await app.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("POST /api/scraper/draft 400 when reportId is missing", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/draft",
      payload: { fields: [{ id: "q1", label: "Why us?", type: "textarea", required: false }] },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /reportId is required/);
  } finally {
    await cleanup();
  }
});

test("POST /api/scraper/draft 400 when fields are empty", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/draft",
      payload: { reportId: "001-acme-2026-04-29", fields: [] },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup();
  }
});

test("POST /api/scraper/draft 400 when a field label is on the PII blocklist", async () => {
  // Acceptance criterion (6): PII fields are rejected at the endpoint
  // boundary as a defense-in-depth check.
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/draft",
      payload: {
        reportId: "001-acme-2026-04-29",
        fields: [
          { id: "q1", label: "Email Address", type: "text", required: true },
        ],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /PII blocklist/);
  } finally {
    await cleanup();
  }
});

test("POST /api/scraper/draft 400 when a field label looks like a phone-input field", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/draft",
      payload: {
        reportId: "001-acme-2026-04-29",
        fields: [
          {
            id: "q1",
            label: "Confirm your phone is 786-300-9961",
            type: "text",
            required: true,
          },
        ],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /phone-input/);
  } finally {
    await cleanup();
  }
});

test("POST /api/scraper/draft 404 when reportId is not in the index", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/draft",
      payload: {
        reportId: "999-nope-2026-04-29",
        fields: [{ id: "q1", label: "Why us?", type: "textarea", required: false }],
      },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("POST /api/scraper/draft 503 when bash is unavailable (kind needs bash)", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    // jobsBashPath was stubbed null in buildAppWithDb — kinds.ts gates the
    // draft-answers kind behind bash, so we should get a 503.
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/draft",
      payload: {
        reportId: "001-acme-2026-04-29",
        fields: [{ id: "q1", label: "Tell us about a recent project.", type: "textarea", required: true }],
      },
    });
    assert.equal(res.statusCode, 503);
  } finally {
    await cleanup();
  }
});

test("GET /api/scraper/drafts/:reportId 404 when no drafts.json exists", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/scraper/drafts/some-report",
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("GET /api/scraper/drafts/:reportId 200 returns the persisted DraftFile after restart", async () => {
  // Acceptance criterion (3): reading the same reportId after restart returns
  // the persisted drafts. The orchestrator resolves the drafts path against
  // REPO_ROOT (not the per-test temp dir), so we write to the actual location
  // under a unique test-only reportId, then GET through the endpoint, then
  // clean up.
  const { app, cleanup } = await buildAppWithDb();
  const { REPO_ROOT } = await import("../env.js");
  const reportId = `__test_draft_${process.pid}_${Date.now()}`;
  const path = draftsPathFor(REPO_ROOT, reportId);
  try {
    writeDraftsFile(path, reportId, "https://example.com/apply", [
      { fieldId: "q1", answer: "alpha", charCount: 5, warnings: [] },
      { fieldId: "q2", answer: "beta", charCount: 4, warnings: ["truncated to fit maxLen"] },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/scraper/drafts/${reportId}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as DraftFile;
    assert.equal(body.reportId, reportId);
    assert.equal(body.applyUrl, "https://example.com/apply");
    assert.equal(body.drafts.length, 2);
    assert.equal(body.drafts[0]?.fieldId, "q1");
    assert.deepEqual(body.drafts[1]?.warnings, ["truncated to fit maxLen"]);
  } finally {
    rmSync(join(REPO_ROOT, "data", "applications", reportId), {
      recursive: true,
      force: true,
    });
    await cleanup();
  }
});

test("PATCH /api/scraper/drafts/:reportId 200 updates persisted drafts (T9d edits)", async () => {
  // Acceptance criterion (8) of T9d: edits made in the UI persist across reload.
  // The PATCH endpoint rewrites the drafts.json with the user's edited answers
  // while preserving the applyUrl from the existing file.
  const { app, cleanup } = await buildAppWithDb();
  const { REPO_ROOT } = await import("../env.js");
  const reportId = `__test_patch_${process.pid}_${Date.now()}`;
  const path = draftsPathFor(REPO_ROOT, reportId);
  try {
    writeDraftsFile(path, reportId, "https://example.com/apply", [
      { fieldId: "q1", answer: "original alpha", charCount: 14, warnings: [] },
      { fieldId: "q2", answer: "original beta", charCount: 13, warnings: [] },
    ]);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/scraper/drafts/${reportId}`,
      payload: {
        drafts: [
          { fieldId: "q1", answer: "edited alpha", charCount: 12, warnings: [] },
          { fieldId: "q2", answer: "edited beta", charCount: 11, warnings: [] },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as DraftFile;
    assert.equal(body.reportId, reportId);
    assert.equal(body.applyUrl, "https://example.com/apply");
    assert.equal(body.drafts[0]?.answer, "edited alpha");
    assert.equal(body.drafts[1]?.answer, "edited beta");

    // And reading it back via GET returns the edited content (full reload).
    const getRes = await app.inject({
      method: "GET",
      url: `/api/scraper/drafts/${reportId}`,
    });
    assert.equal(getRes.statusCode, 200);
    const file = getRes.json() as DraftFile;
    assert.equal(file.drafts[0]?.answer, "edited alpha");
  } finally {
    rmSync(join(REPO_ROOT, "data", "applications", reportId), {
      recursive: true,
      force: true,
    });
    await cleanup();
  }
});

test("PATCH /api/scraper/drafts/:reportId redacts phone numbers from edited answers", async () => {
  // Defense-in-depth: even if the user (or some pasted content) puts a phone
  // number into an edited answer, the PATCH endpoint redacts it before
  // writing to disk. Mirrors the behavior of the post-job reconcile hook.
  const { app, cleanup } = await buildAppWithDb();
  const { REPO_ROOT } = await import("../env.js");
  const reportId = `__test_patch_phone_${process.pid}_${Date.now()}`;
  const path = draftsPathFor(REPO_ROOT, reportId);
  try {
    writeDraftsFile(path, reportId, null, [
      { fieldId: "q1", answer: "ok", charCount: 2, warnings: [] },
    ]);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/scraper/drafts/${reportId}`,
      payload: {
        drafts: [
          { fieldId: "q1", answer: "Reach me at 786-300-9961.", charCount: 25, warnings: [] },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as DraftFile;
    assert.doesNotMatch(body.drafts[0]?.answer ?? "", /\d{3}-\d{3}-\d{4}/);
    assert.ok(body.drafts[0]?.warnings.includes("phone-number-detected; redacted"));
  } finally {
    rmSync(join(REPO_ROOT, "data", "applications", reportId), {
      recursive: true,
      force: true,
    });
    await cleanup();
  }
});

test("PATCH /api/scraper/drafts/:reportId 404 when no existing drafts file", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/scraper/drafts/__missing_report__",
      payload: { drafts: [{ fieldId: "q1", answer: "hi" }] },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("PATCH /api/scraper/drafts/:reportId 400 when body.drafts is not an array", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/scraper/drafts/whatever",
      payload: { drafts: "nope" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup();
  }
});

test("GET /api/scraper/drafts/:reportId 400 on path traversal attempts", async () => {
  const { app, cleanup } = await buildAppWithDb();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/scraper/drafts/..%2Fetc",
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup();
  }
});
