import { test } from "node:test";
import { strict as assert } from "node:assert";

import Fastify, { type FastifyInstance } from "fastify";

import { detectAts, scrapeForm } from "../scraper/scrapeForm.js";
import { parseGreenhouseHandle } from "../scraper/ats/greenhouse.js";
import { parseAshbyHandle } from "../scraper/ats/ashby.js";
import { isPiiLabel, normalizeLabel } from "../scraper/pii.js";
import { scraperPlugin } from "../scraper/routes.js";

test("detectAts recognizes Greenhouse hosts", () => {
  assert.equal(detectAts("https://boards.greenhouse.io/foo/jobs/123"), "greenhouse");
  assert.equal(detectAts("https://job-boards.greenhouse.io/foo/jobs/123"), "greenhouse");
  assert.equal(detectAts("https://acme.greenhouse.io/jobs/123"), "greenhouse");
});

test("detectAts recognizes Ashby hosts", () => {
  assert.equal(detectAts("https://jobs.ashbyhq.com/Foo/abc-123"), "ashby");
});

test("detectAts labels Lever / Workday / unknown", () => {
  assert.equal(detectAts("https://jobs.lever.co/foo/123"), "lever");
  assert.equal(detectAts("https://acme.wd1.myworkdayjobs.com/External/job/123"), "workday");
  assert.equal(detectAts("https://example.com/careers"), "unknown");
  assert.equal(detectAts("not-a-url"), "unknown");
});

test("parseGreenhouseHandle handles standard board URLs", () => {
  assert.deepEqual(
    parseGreenhouseHandle("https://boards.greenhouse.io/openai/jobs/4789012"),
    { slug: "openai", jobId: "4789012" },
  );
  assert.deepEqual(
    parseGreenhouseHandle("https://job-boards.greenhouse.io/anthropic/jobs/4321"),
    { slug: "anthropic", jobId: "4321" },
  );
});

test("parseGreenhouseHandle returns null for unparseable URLs", () => {
  assert.equal(parseGreenhouseHandle("https://example.com/jobs/1"), null);
  assert.equal(parseGreenhouseHandle("https://boards.greenhouse.io/"), null);
});

test("parseAshbyHandle preserves slug case", () => {
  assert.deepEqual(
    parseAshbyHandle("https://jobs.ashbyhq.com/Hebbia/abc-123-def/application"),
    { slug: "Hebbia", jobId: "abc-123-def" },
  );
});

test("normalizeLabel strips trailing asterisks and (required)", () => {
  assert.equal(normalizeLabel("First Name *"), "first name");
  assert.equal(normalizeLabel("Email Address (required)"), "email address");
  assert.equal(normalizeLabel("  GitHub URL  "), "github url");
});

test("isPiiLabel matches common PII fields", () => {
  assert.equal(isPiiLabel("First Name"), true);
  assert.equal(isPiiLabel("Email *"), true);
  assert.equal(isPiiLabel("LinkedIn URL"), true);
  assert.equal(isPiiLabel("Resume/CV"), true);
  assert.equal(isPiiLabel("Why are you interested in this role?"), false);
});

test("scrapeForm fallthrough for unknown ATS skips browser launch", async () => {
  const result = await scrapeForm("https://example.com/careers/123");
  assert.equal(result.ats, "unknown");
  assert.equal(result.source, "api");
  assert.deepEqual(result.fields, []);
  assert.match(result.message ?? "", /manual paste/i);
});

test("scrapeForm fallthrough for Lever skips browser launch", async () => {
  const result = await scrapeForm("https://jobs.lever.co/foo/123");
  assert.equal(result.ats, "lever");
  assert.deepEqual(result.fields, []);
});

async function buildScraperApp(): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  const app = Fastify({ logger: false });
  await app.register(scraperPlugin);
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
    },
  };
}

test("POST /api/scraper/scan rejects missing applyUrl", async () => {
  const { app, close } = await buildScraperApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/scan",
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await close();
  }
});

test("POST /api/scraper/scan returns unknown for non-ATS host", async () => {
  const { app, close } = await buildScraperApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/scraper/scan",
      payload: { applyUrl: "https://example.com/careers" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ats: string; fields: unknown[] };
    assert.equal(body.ats, "unknown");
    assert.deepEqual(body.fields, []);
  } finally {
    await close();
  }
});
