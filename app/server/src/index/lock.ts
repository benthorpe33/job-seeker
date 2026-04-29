import { resolve } from "node:path";

const LOCK_TTL_MS = 2_000;

const locks: Map<string, number> = new Map();

function key(path: string): string {
  return resolve(path);
}

function purgeExpired(now: number): void {
  for (const [p, until] of locks) {
    if (until <= now) locks.delete(p);
  }
}

export function acquire(path: string, ttlMs: number = LOCK_TTL_MS): void {
  const now = Date.now();
  purgeExpired(now);
  locks.set(key(path), now + ttlMs);
}

export function release(path: string): void {
  locks.delete(key(path));
}

export function isLocked(path: string): boolean {
  const now = Date.now();
  const until = locks.get(key(path));
  if (until === undefined) return false;
  if (until <= now) {
    locks.delete(key(path));
    return false;
  }
  return true;
}

export function _clearAll(): void {
  locks.clear();
}
