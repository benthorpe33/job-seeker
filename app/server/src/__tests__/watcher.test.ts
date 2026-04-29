import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { applySchema } from "../index/db.js";
import { rebuildIndex } from "../index/rebuild.js";
import { startWatcher } from "../index/watcher.js";
import { indexBus, type IndexUpdateEvent } from "../index/bus.js";
import { acquire, release, _clearAll } from "../index/lock.js";

function setupRepo(): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "js-watcher-"));
  // Minimal package.json so env-style root resolution doesn't matter; we
  // pass the root explicitly to startWatcher.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "career-ops" }),
  );
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    join(root, "data", "applications.md"),
    `# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-04-29 | Foo | DS | 4.0/5 | Evaluated | ❌ | [001](reports/001-foo-2026-04-29.md) | n |\n`,
  );
  writeFileSync(
    join(root, "data", "scan-history.tsv"),
    "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\nhttps://x\t2026-04-29\tgreenhouse-api\tDS\tFoo\tadded\n",
  );
  writeFileSync(join(root, "data", "pipeline.md"), "# Pipeline\n");
  writeFileSync(
    join(root, "reports", "001-foo-2026-04-29.md"),
    `# Evaluation: Foo — DS\n**Score:** 4.0/5\n**URL:** https://x\n\n## A) Role Summary\nbody\n`,
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function withWatcher<T>(
  root: string,
  fn: (deps: {
    db: Database.Database;
    events: IndexUpdateEvent[];
    close: () => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const db = new Database(":memory:");
  applySchema(db);
  rebuildIndex(db, root);
  const events: IndexUpdateEvent[] = [];
  const onUpdate = (ev: IndexUpdateEvent) => events.push(ev);
  indexBus.on("index:updated", onUpdate);
  const w = startWatcher({ db, repoRoot: root });
  await new Promise<void>((r) => {
    if ((w.watcher as { _readyEmitted?: boolean })._readyEmitted) return r();
    w.watcher.once("ready", () => r());
    setTimeout(() => r(), 1500);
  });
  return fn({
    db,
    events,
    close: async () => {
      await w.close();
      indexBus.off("index:updated", onUpdate);
      db.close();
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  pred: () => T | undefined,
  timeoutMs = 4000,
): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = pred();
    if (v !== undefined) return v;
    await sleep(50);
  }
  throw new Error("waitFor timed out");
}

test("watcher reindexes a touched report file", async () => {
  const { root, cleanup } = setupRepo();
  try {
    // Wait for chokidar to settle its initial scan.
    await sleep(300);
    await withWatcher(root, async ({ db, events, close }) => {
      try {
        const reportPath = join(root, "reports", "001-foo-2026-04-29.md");
        await sleep(200);
        writeFileSync(
          reportPath,
          `# Evaluation: Foo — DS\n**Score:** 4.5/5\n**URL:** https://x\n\n## A) Role Summary\nupdated\n`,
        );
        const updated = await waitFor(() => {
          const row = db
            .prepare(`SELECT score FROM reports WHERE id = ?`)
            .get("001-foo-2026-04-29") as { score: number } | undefined;
          return row?.score === 4.5 ? row : undefined;
        });
        assert.equal(updated.score, 4.5);
        assert.ok(events.some((e) => e.kind === "reports" && e.op === "upsert"));
      } finally {
        await close();
      }
    });
  } finally {
    cleanup();
  }
});

test("watcher deletes report row on unlink", async () => {
  const { root, cleanup } = setupRepo();
  try {
    await sleep(300);
    await withWatcher(root, async ({ db, close }) => {
      try {
        const reportPath = join(root, "reports", "001-foo-2026-04-29.md");
        await sleep(300);
        rmSync(reportPath);
        await waitFor(() => {
          const row = db
            .prepare(`SELECT id FROM reports WHERE id = ?`)
            .get("001-foo-2026-04-29");
          return row === undefined ? true : undefined;
        });
        const row = db
          .prepare(`SELECT id FROM reports WHERE id = ?`)
          .get("001-foo-2026-04-29");
        assert.equal(row, undefined);
      } finally {
        await close();
      }
    });
  } finally {
    cleanup();
  }
});

test("watcher rebuilds applications on append", async () => {
  const { root, cleanup } = setupRepo();
  try {
    await sleep(300);
    await withWatcher(root, async ({ db, close }) => {
      try {
        appendFileSync(
          join(root, "data", "applications.md"),
          `| 2 | 2026-04-29 | Bar | Eng | 3.5/5 | Applied | ✅ | [002](reports/002-bar-2026-04-29.md) | x |\n`,
        );
        await waitFor(() => {
          const row = db
            .prepare(`SELECT num FROM applications WHERE company = 'Bar'`)
            .get() as { num: number } | undefined;
          return row?.num === 2 ? row : undefined;
        });
        const count = (db
          .prepare(`SELECT COUNT(*) as n FROM applications`)
          .get() as { n: number }).n;
        assert.equal(count, 2);
      } finally {
        await close();
      }
    });
  } finally {
    cleanup();
  }
});

test("locked path is skipped (no echo loop)", async () => {
  const { root, cleanup } = setupRepo();
  try {
    _clearAll();
    await sleep(300);
    await withWatcher(root, async ({ events, close }) => {
      try {
        const reportPath = join(root, "reports", "001-foo-2026-04-29.md");
        const baseline = events.length;
        acquire(reportPath, 3000);
        writeFileSync(
          reportPath,
          `# Evaluation: Foo — DS\n**Score:** 3.3/5\n**URL:** https://x\n\n## A) Role Summary\nlocked write\n`,
        );
        // Wait long enough for debounce + dispatch to have fired if it were going to.
        await sleep(1200);
        release(reportPath);
        const newEvents = events.length - baseline;
        assert.equal(
          newEvents,
          0,
          `expected 0 events while locked, got ${newEvents}`,
        );
      } finally {
        await close();
      }
    });
  } finally {
    cleanup();
  }
});
