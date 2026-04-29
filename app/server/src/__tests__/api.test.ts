import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";

import { applySchema } from "../index/db.js";
import { rebuildIndex } from "../index/rebuild.js";
import { apiPlugin } from "../api/routes.js";

function setupRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "js-api-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "career-ops" }));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(
    join(root, "templates", "states.yml"),
    `states:\n  - id: evaluated\n    label: Evaluated\n  - id: applied\n    label: Applied\n  - id: interview\n    label: Interview\n  - id: discarded\n    label: Discarded\n  - id: rejected\n    label: Rejected\n  - id: offer\n    label: Offer\n  - id: responded\n    label: Responded\n  - id: skip\n    label: SKIP\n`,
  );
  writeFileSync(
    join(root, "data", "applications.md"),
    `# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-04-29 | Anthropic | AI Engineer | 4.5/5 | Evaluated | ❌ | [001](reports/001-anthropic-2026-04-29.md) | top match |\n| 2 | 2026-04-29 | Generic | DS | 3.0/5 | SKIP | ❌ | [002](reports/002-generic-2026-04-29.md) | low |\n`,
  );
  writeFileSync(join(root, "data", "scan-history.tsv"), "url\tfirst_seen\n");
  writeFileSync(join(root, "data", "pipeline.md"), "# Pipeline\n");
  writeFileSync(
    join(root, "reports", "001-anthropic-2026-04-29.md"),
    `# Evaluation: Anthropic — AI Engineer\n**Score:** 4.5/5\n**URL:** https://example.com\n**Legitimacy:** High Confidence\n\n## A) Role Summary\nbody about anthropic\n## B) CV Match\nfit\n## G) Posting Legitimacy\nverified\n`,
  );
  writeFileSync(
    join(root, "reports", "002-generic-2026-04-29.md"),
    `# Evaluation: Generic — DS\n**Score:** 3.0/5\n**URL:** https://example.com/2\n**Legitimacy:** Low\n\n## A) Role Summary\nstub\n## B) CV Match\nshallow\n`,
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function buildApp(root: string): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const db = new Database(":memory:");
  applySchema(db);
  rebuildIndex(db, root);
  const app = Fastify({ logger: false });
  // Patch REPO_ROOT for the test by stubbing process.cwd? Instead, construct
  // applications.md path in test repo via overriding. The api expects
  // REPO_ROOT to come from env.ts. For the smoke tests below we only call
  // GETs which don't write to applications.md, so REPO_ROOT mismatch is fine.
  await app.register(apiPlugin({ db }));
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

test("GET /api/applications returns rows sorted by score desc", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({ method: "GET", url: "/api/applications" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { rows: Array<{ id: number; score: number | null }>; total: number };
      assert.equal(body.total, 2);
      assert.equal(body.rows[0]?.id, 1);
      assert.equal(body.rows[0]?.score, 4.5);
      assert.equal(body.rows[1]?.id, 2);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("GET /api/applications?status=Evaluated filters", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({ method: "GET", url: "/api/applications?status=Evaluated" });
      const body = res.json() as { total: number; rows: Array<{ status: string }> };
      assert.equal(body.total, 1);
      assert.equal(body.rows[0]?.status, "Evaluated");
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("GET /api/applications?q=anthropic matches via substring", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({ method: "GET", url: "/api/applications?q=anthropic" });
      const body = res.json() as { total: number; rows: Array<{ company: string }> };
      assert.equal(body.total, 1);
      assert.equal(body.rows[0]?.company, "Anthropic");
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("GET /api/reports/:id returns blocks + body", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({ method: "GET", url: "/api/reports/001-anthropic-2026-04-29" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        id: string;
        header: { score: number | null; legitimacy: string | null };
        blocks: Record<string, string>;
        bodyMd: string;
      };
      assert.equal(body.id, "001-anthropic-2026-04-29");
      assert.equal(body.header.score, 4.5);
      assert.equal(body.header.legitimacy, "High Confidence");
      assert.ok(body.blocks["A"]);
      assert.ok(body.blocks["B"]);
      assert.ok(body.blocks["G"]);
      assert.ok(body.bodyMd.includes("anthropic"));
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("GET /api/reports/:id 404 for missing", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({ method: "GET", url: "/api/reports/999-missing-2026-01-01" });
      assert.equal(res.statusCode, 404);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("GET /api/reports/:id/raw returns text body", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({ method: "GET", url: "/api/reports/001-anthropic-2026-04-29/raw" });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] as string, /text\/plain/);
      assert.match(res.body, /Evaluation: Anthropic/);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("PATCH /api/applications/:id rejects non-canonical status", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/applications/1",
        payload: { status: "Bogus" },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("PATCH /api/applications/:id rejects Discarded without reason", async () => {
  const { root, cleanup } = setupRepo();
  try {
    const { app, close } = await buildApp(root);
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/applications/1",
        payload: { status: "Discarded" },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

void readFileSync;
