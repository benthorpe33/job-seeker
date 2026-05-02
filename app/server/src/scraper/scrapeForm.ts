import type { AtsKind, ScrapeResult } from "./types.js";
import { scrapeAshby } from "./ats/ashby.js";
import { scrapeGreenhouse } from "./ats/greenhouse.js";
import { withBrowserSlot } from "./browser.js";

export function detectAts(applyUrl: string): AtsKind {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return "unknown";
  }
  const host = url.host.toLowerCase();
  if (host.endsWith("greenhouse.io")) return "greenhouse";
  if (host.endsWith("ashbyhq.com")) return "ashby";
  if (host.endsWith("lever.co")) return "lever";
  if (host.endsWith("myworkdayjobs.com") || host.endsWith("workday.com")) return "workday";
  return "unknown";
}

const UNSUPPORTED_MESSAGE = "ATS not auto-supported; use manual paste";

export async function scrapeForm(applyUrl: string): Promise<ScrapeResult> {
  const ats = detectAts(applyUrl.trim());
  if (ats === "greenhouse") {
    return withBrowserSlot((browser) => scrapeGreenhouse(applyUrl, browser));
  }
  if (ats === "ashby") {
    return withBrowserSlot((browser) => scrapeAshby(applyUrl, browser));
  }
  return {
    ats,
    source: "api",
    fields: [],
    message: UNSUPPORTED_MESSAGE,
  };
}
