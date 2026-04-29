import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import type { JobKind } from "@job-seeker/shared";

import { JobRegistry, type Job } from "./registry.js";

const KILL_GRACE_MS = 5000;

export type SpawnOptions = {
  kind: JobKind;
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  registry: JobRegistry;
};

export function spawnJob(opts: SpawnOptions): Job {
  const jobId = randomUUID();
  const job = opts.registry.create(jobId, opts.kind);

  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  job.child = child;

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => opts.registry.pushLine(job, "stdout", line));
  }
  if (child.stderr) {
    const rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
    rl.on("line", (line) => opts.registry.pushLine(job, "stderr", line));
  }

  child.on("error", (err) => {
    opts.registry.pushLine(job, "stderr", `[spawn error] ${err.message}`);
    opts.registry.finish(job, null, null, "failed");
  });

  child.on("close", (code, signal) => {
    opts.registry.finish(job, code, signal ?? null);
  });

  return job;
}

export function cancelJob(job: Job): boolean {
  if (job.status !== "running" || !job.child) return false;
  const child = job.child;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore — child may already be exiting
  }
  if (job.cancelTimer) clearTimeout(job.cancelTimer);
  job.cancelTimer = setTimeout(() => {
    if (job.status === "running") {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, KILL_GRACE_MS);
  job.cancelTimer.unref?.();
  return true;
}

export function detectBash(): string | null {
  const lookup = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(lookup, ["bash"], { encoding: "utf-8" });
  if (res.status !== 0) return null;
  const first = (res.stdout || "").split(/\r?\n/).find((s) => s.trim().length > 0);
  return first ? first.trim() : null;
}
