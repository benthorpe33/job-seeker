import type { Browser } from "playwright";

let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

export async function getBrowser(): Promise<Browser> {
  if (browserPromise === null) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise === null) return;
  const current = browserPromise;
  browserPromise = null;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    // ignore: best-effort teardown
  }
}

let inFlight = 0;
const MAX_CONCURRENT = 2;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

export async function withBrowserSlot<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    const browser = await getBrowser();
    return await fn(browser);
  } finally {
    releaseSlot();
  }
}

// Exported only for unit tests that want to ensure the queue is reset.
export function _resetForTests(): void {
  browserPromise = null;
  inFlight = 0;
  waiters.length = 0;
}
