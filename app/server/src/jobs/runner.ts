import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
    env: withBashUtilsOnPath(opts.cmd, opts.env ?? process.env),
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

const BASH_CMD_RE = /(^|[\\/])bash(\.exe)?$/i;

// Git for Windows ships bash.exe next to (or one level up from) the GNU
// userland — dirname, sed, awk, tr, the lot. Only an interactive Git Bash
// session puts those on PATH: when we spawn bash.exe directly the child
// inherits the plain Windows PATH, where `dirname` does not exist, and every
// script dies on its first `$(dirname ...)` with exit 127. So for bash kinds
// we prepend bash's own toolchain dirs. Prepend rather than append on
// purpose — Windows ships its own incompatible sort.exe/find.exe, and a bash
// script expects the GNU ones to win, exactly as they would in Git Bash.
function bashUtilDirs(bashPath: string): string[] {
  const binDir = dirname(bashPath);
  // Covers both layouts: Git\usr\bin\bash.exe and Git\bin\bash.exe.
  const gitRoots = [resolve(binDir, ".."), resolve(binDir, "..", "..")];
  const candidates = [
    binDir,
    ...gitRoots.map((root) => resolve(root, "usr", "bin")),
    ...gitRoots.map((root) => resolve(root, "mingw64", "bin")),
  ];
  const seen = new Set<string>();
  return candidates.filter((dir) => {
    const key = dir.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return existsSync(dir);
  });
}

export function withBashUtilsOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return env;
  if (!BASH_CMD_RE.test(cmd)) return env;
  // Only an explicit path tells us where the toolchain lives; a bare "bash"
  // would make dirname() yield "." and poison PATH with the cwd.
  if (!/[\\/]/.test(cmd)) return env;
  const dirs = bashUtilDirs(cmd);
  if (dirs.length === 0) return env;

  // A plain object copy of process.env loses Windows' case-insensitive
  // lookup, so find whichever spelling of PATH this env actually uses.
  const pathKey =
    Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = env[pathKey] ?? "";
  const existing = new Set(
    current
      .split(";")
      .map((p) => p.trim().replace(/[\\/]+$/, "").toLowerCase())
      .filter((p) => p.length > 0),
  );
  const missing = dirs.filter(
    (dir) => !existing.has(dir.replace(/[\\/]+$/, "").toLowerCase()),
  );
  if (missing.length === 0) return env;

  return {
    ...env,
    [pathKey]: current ? `${missing.join(";")};${current}` : missing.join(";"),
  };
}

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
