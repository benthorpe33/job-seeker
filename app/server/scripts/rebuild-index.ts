import { openDb } from "../src/index/db.js";
import { REPO_ROOT } from "../src/env.js";
import { rebuildIndex } from "../src/index/rebuild.js";

function main(): void {
  const db = openDb();
  try {
    const counts = rebuildIndex(db, REPO_ROOT);
    console.log("Rebuild complete:", counts);

    const fts = db
      .prepare(
        `SELECT id FROM reports_fts WHERE reports_fts MATCH ? ORDER BY rank LIMIT 5`,
      )
      .all("anthropic applied ai") as { id: string }[];
    console.log("FTS sample (anthropic applied ai):", fts.map((r) => r.id));

    const stub = db
      .prepare(
        `SELECT id, score, blocks_json FROM reports
         WHERE id LIKE '138-maple%' LIMIT 1`,
      )
      .get() as { id: string; score: number; blocks_json: string } | undefined;
    if (stub) {
      const keys = Object.keys(JSON.parse(stub.blocks_json)).sort();
      console.log(
        `Stub block check (${stub.id}, score=${stub.score}): keys=[${keys.join(",")}]`,
      );
    }
  } finally {
    db.close();
  }
}

main();
