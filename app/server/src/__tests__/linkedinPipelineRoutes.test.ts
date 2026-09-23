// DO NOT add a test that POSTs to /api/jobs/linkedin/start. That handler
// constructs its own LinkedinPipeline with no commandFactory, so it resolves
// the real kinds and spawns the real scripts against REPO_ROOT — a live
// LinkedIn scrape, a pipeline.md append and a full JD prefetch. Every test here
// either injects a stub factory into a pipeline it built itself, or exercises a
// pure function.
import { test } from "node:test";
import { strict as assert } from "node:assert";

import Fastify, { type FastifyInstance } from "fastify";

import { JobRegistry } from "../jobs/registry.js";
import {
  LinkedinPipeline,
  PipelineStore,
  STAGE_DEFS_BASE,
  type PipelineRunnerOpts,
  type StageCommandFactory,
} from "../jobs/linkedinPipeline.js";
import {
  linkedinPipelinePlugin,
  resolvePrefetchFlag,
} from "../api/linkedinPipelineRoutes.js";

// Every stage is a no-op `node -e` that exits 0 unless asked to fail, so these
// tests exercise the route contract without touching the real scripts.
function makeFactory(failAt?: number): StageCommandFactory {
  return (def) => {
    const code = def.stageNum === failAt ? 7 : 0;
    return {
      ok: true,
      resolved: { cmd: process.execPath, args: ["-e", `process.exit(${code});`] },
    };
  };
}

function buildOpts(registry: JobRegistry, factory: StageCommandFactory): PipelineRunnerOpts {
  return {
    registry,
    cwd: process.cwd(),
    env: process.env,
    bashAvailable: true,
    bashPath: "/bin/bash",
    commandFactory: factory,
  };
}

async function buildApp(): Promise<{
  app: FastifyInstance;
  store: PipelineStore;
  registry: JobRegistry;
  close: () => Promise<void>;
}> {
  const app = Fastify({ logger: false });
  const registry = new JobRegistry();
  const store = new PipelineStore();
  app.decorate("jobs", registry);
  app.decorate("jobsBashPath", "/bin/bash");
  app.decorate("linkedinPipelines", store);
  await app.register(linkedinPipelinePlugin);
  await app.ready();
  return { app, store, registry, close: () => app.close() };
}

test("resume accepts a late stage — the bound tracks STAGE_DEFS_BASE, not a literal 6", async () => {
  const { app, store, registry, close } = await buildApp();
  try {
    const p = new LinkedinPipeline(buildOpts(registry, makeFactory(9)), true);
    store.add(p);
    await p.run(1);
    assert.equal(p.snapshot().failedAtStage, 9);

    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/linkedin/${p.pipelineId}/resume`,
      payload: { fromStage: 9 },
    });
    // Previously 400: "fromStage must be 1..6 (got 9)".
    assert.equal(res.statusCode, 200);
  } finally {
    await close();
  }
});

test("resume still rejects a stage number past the end of the pipeline", async () => {
  const { app, store, registry, close } = await buildApp();
  try {
    const p = new LinkedinPipeline(buildOpts(registry, makeFactory(9)), true);
    store.add(p);
    await p.run(1);

    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/linkedin/${p.pipelineId}/resume`,
      payload: { fromStage: STAGE_DEFS_BASE.length + 1 },
    });
    assert.equal(res.statusCode, 400);
    assert.match(
      (res.json() as { error: string }).error,
      new RegExp(`1\\.\\.${STAGE_DEFS_BASE.length}`),
    );
  } finally {
    await close();
  }
});

test("resolvePrefetchFlag defaults to true when the body omits the field", () => {
  // The UI no longer sends a toggle, so an omitted field must mean prefetch:
  // stage 6's location filter depends on the JSON stage 5 writes.
  assert.equal(resolvePrefetchFlag(undefined), true);
  assert.equal(resolvePrefetchFlag({}), true);
  assert.equal(resolvePrefetchFlag({ prefetchJds: true }), true);
});

test("resolvePrefetchFlag still honours an explicit false", () => {
  assert.equal(resolvePrefetchFlag({ prefetchJds: false }), false);
});
