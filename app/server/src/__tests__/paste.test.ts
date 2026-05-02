import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";

import type { ScrapeResult } from "@job-seeker/shared";

import { extractFromPaste } from "../scraper/paste.js";
import { pastePlugin } from "../scraper/pasteRoutes.js";

function findFixturesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "test", "fixtures", "paste");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("paste fixtures directory not found");
}

const FIXTURES = findFixturesDir();

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

async function buildPasteApp(): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  const app = Fastify({ logger: false });
  await app.register(pastePlugin);
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
    },
  };
}

test("extractFromPaste returns paste/paste markers", () => {
  const result = extractFromPaste({ plainText: "Why are you interested?\n\nProject?" });
  assert.equal(result.ats, "paste");
  assert.equal(result.source, "paste");
});

test("plaintext: two blank-line-separated questions yield exactly 2 fields", () => {
  const result = extractFromPaste({
    plainText: "Why are you interested in this role?\n\nTell us about a relevant project.",
  });
  assert.equal(result.fields.length, 2);
  assert.equal(result.fields[0]?.label, "Why are you interested in this role?");
  assert.equal(result.fields[1]?.label, "Tell us about a relevant project.");
  assert.equal(result.fields[0]?.type, "textarea");
});

test("plaintext: list markers and numbering are stripped", () => {
  const result = extractFromPaste({
    plainText: "1. First question?\n\n- Second question?\n\n* Third question?",
  });
  assert.equal(result.fields.length, 3);
  assert.equal(result.fields[0]?.label, "First question?");
  assert.equal(result.fields[1]?.label, "Second question?");
  assert.equal(result.fields[2]?.label, "Third question?");
});

test("plaintext: PII-only blocks are dropped", () => {
  const result = extractFromPaste({
    plainText: "First Name\n\nEmail Address\n\nPhone Number",
  });
  assert.deepEqual(result.fields, []);
});

test("HTML: PII-only form returns no fields", () => {
  const html = `
    <form>
      <label for="fn">First Name</label><input id="fn" name="firstName" type="text">
      <label for="em">Email</label><input id="em" name="email" type="text">
      <label for="ph">Phone</label><input id="ph" name="phone" type="text">
    </form>
  `;
  const result = extractFromPaste({ html });
  assert.deepEqual(result.fields, []);
});

test("HTML: skips hidden inputs", () => {
  const html = `
    <form>
      <input type="hidden" name="csrf" value="x">
      <label for="q1">What attracts you to this role?</label>
      <textarea id="q1" name="q1"></textarea>
    </form>
  `;
  const result = extractFromPaste({ html });
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0]?.label, "What attracts you to this role?");
});

test("HTML: aria-labelledby resolves label text", () => {
  const html = `
    <span id="lbl">Describe a recent leadership moment.</span>
    <textarea id="t1" aria-labelledby="lbl"></textarea>
  `;
  const result = extractFromPaste({ html });
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0]?.label, "Describe a recent leadership moment.");
});

test("HTML: aria-label is honored when no label present", () => {
  const html = `<textarea aria-label="Why this team specifically?"></textarea>`;
  const result = extractFromPaste({ html });
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0]?.label, "Why this team specifically?");
});

test("HTML: ancestor label wraps the input", () => {
  const html = `
    <label>
      <span class="text">Tell us about your favorite open-source contribution.</span>
      <textarea name="q"></textarea>
    </label>
  `;
  const result = extractFromPaste({ html });
  assert.equal(result.fields.length, 1);
  assert.match(result.fields[0]?.label ?? "", /favorite open-source/);
});

test("HTML: script and style content does not leak into labels", () => {
  const html = `
    <script>var label = "Email";</script>
    <style>label { color: red; }</style>
    <label for="q">Why this role?</label>
    <textarea id="q"></textarea>
  `;
  const result = extractFromPaste({ html });
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0]?.label, "Why this role?");
});

test("HTML: respects 50-field cap", () => {
  const items: string[] = [];
  for (let i = 0; i < 75; i++) {
    items.push(
      `<label for="q${i}">Question number ${i} about your background?</label><textarea id="q${i}"></textarea>`,
    );
  }
  const html = `<form>${items.join("\n")}</form>`;
  const result = extractFromPaste({ html });
  assert.equal(result.fields.length, 50);
});

test("HTML: long labels are truncated to 1000 chars + ellipsis", () => {
  const longLabel = "X".repeat(1500);
  const html = `<label for="q">${longLabel}</label><textarea id="q"></textarea>`;
  const result = extractFromPaste({ html });
  assert.equal(result.fields.length, 1);
  const label = result.fields[0]?.label ?? "";
  assert.equal(label.length, 1001);
  assert.ok(label.endsWith("…"));
});

test("Lever fixture: extracts >=80% of the 5 freeform questions", () => {
  const html = readFixture("lever-sample.html");
  const result = extractFromPaste({ html });
  // 5 freeform questions in the fixture; we expect >=4 (80%).
  assert.ok(
    result.fields.length >= 4,
    `expected >=4 freeform fields, got ${result.fields.length}`,
  );
  const labels = result.fields.map((f) => f.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes("interested in working at acme")));
  assert.ok(labels.some((l) => l.includes("recent project")));
  // PII fields must not appear.
  assert.ok(!labels.some((l) => l === "email" || l === "phone" || l === "full name"));
});

test("Workday fixture: extracts >=80% of the 5 freeform questions", () => {
  const html = readFixture("workday-sample.html");
  const result = extractFromPaste({ html });
  assert.ok(
    result.fields.length >= 4,
    `expected >=4 freeform fields, got ${result.fields.length}`,
  );
  const labels = result.fields.map((f) => f.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes("how did you hear about")));
  assert.ok(labels.some((l) => l.includes("salary expectation")));
  assert.ok(!labels.some((l) => l === "first name" || l === "last name" || l === "email address"));
});

test("plaintext fixture: returns 3 fields", () => {
  const text = readFixture("plain-text-questions.txt");
  const result = extractFromPaste({ plainText: text });
  assert.equal(result.fields.length, 3);
});

test("POST /api/scraper/paste rejects body with both html and plainText", async () => {
  const { app, close } = await buildPasteApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/paste",
      payload: { html: "<p>x</p>", plainText: "x" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await close();
  }
});

test("POST /api/scraper/paste rejects body with neither field", async () => {
  const { app, close } = await buildPasteApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/paste",
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await close();
  }
});

test("POST /api/scraper/paste rejects empty-string fields", async () => {
  const { app, close } = await buildPasteApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/paste",
      payload: { html: "   ", plainText: "" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await close();
  }
});

test("POST /api/scraper/paste returns 413 for body over 1 MB", async () => {
  const { app, close } = await buildPasteApp();
  try {
    const big = "a".repeat(1_500_000);
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/paste",
      payload: { plainText: big },
    });
    assert.equal(res.statusCode, 413);
  } finally {
    await close();
  }
});

test("POST /api/scraper/paste returns ScrapeResult for plaintext payload", async () => {
  const { app, close } = await buildPasteApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/paste",
      payload: {
        plainText: "Why are you interested in this role?\n\nTell us about a relevant project.",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as ScrapeResult;
    assert.equal(body.ats, "paste");
    assert.equal(body.source, "paste");
    assert.equal(body.fields.length, 2);
  } finally {
    await close();
  }
});
