import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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

// On Windows, System32\bash.exe is the WSL launcher (fails with
// `execvpe(/bin/bash) failed: No such file or directory` when no WSL distro
// is installed) and the WindowsApps shim is similarly useless for bash
// scripts. Common real bash installs live under Git for Windows.
const WIN_BASH_DECOYS = [/\\System32\\bash\.exe$/i, /\\WindowsApps\\bash\.exe$/i];
const WIN_BASH_FALLBACKS = [
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

export function detectBash(): string | null {
  // Honor an explicit override first — the operator can pin a known-good bash
  // via env var if PATH detection is unreliable in their environment.
  const override = process.env.JOB_SEEKER_BASH_PATH;
  if (override && existsSync(override)) return override;

  const lookup = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(lookup, ["bash"], { encoding: "utf-8" });
  const candidates = res.status === 0
    ? (res.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  if (process.platform !== "win32") {
    return candidates[0] ?? null;
  }

  // Filter out the WSL launcher / Store shim, then try PATH candidates first.
  const real = candidates.find((c) => !WIN_BASH_DECOYS.some((rx) => rx.test(c)));
  if (real) return real;

  // PATH had nothing real (typical Task Scheduler / service context). Fall
  // back to a direct filesystem scan of common Git Bash install paths.
  for (const p of WIN_BASH_FALLBACKS) {
    if (existsSync(p)) return p;
  }
  return null;
}
