import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "career-ops") {
          return dir;
        }
      } catch {
        // ignore parse errors and keep climbing
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find career-ops repo root climbing up from ${start}`,
      );
    }
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(__dirname);
export const APP_ROOT = resolve(REPO_ROOT, "app");
export const SERVER_DATA_DIR = resolve(APP_ROOT, "server", ".data");

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.JOB_SEEKER_PORT) || 5174;

export const SERVER_VERSION = "0.1.0";
