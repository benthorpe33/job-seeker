import type { Browser } from "playwright";

import { isPiiLabel } from "../pii.js";
import type { ParsedHandle, ScrapeResult, ScrapedField } from "../types.js";

export function parseAshbyHandle(applyUrl: string): ParsedHandle | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  if (!host.endsWith("ashbyhq.com")) return null;

  // jobs.ashbyhq.com/{slug}/{id}/application?
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) return null;
  const slug = segments[0]!;
  const jobId = segments[1]!;
  if (!slug || !jobId) return null;
  return { slug, jobId };
}

type DomField = {
  id: string;
  label: string;
  type: "text" | "textarea";
  required: boolean;
  maxLen: number | null;
};

function toApplicationUrl(applyUrl: string): string {
  try {
    const url = new URL(applyUrl);
    // /{slug}/{id}[/application] — append /application when missing so the
    // form fields render. The Overview tab does not load the form.
    const segs = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (segs.length >= 2 && segs[2] !== "application") {
      url.pathname = `/${segs[0]}/${segs[1]}/application`;
    }
    return url.toString();
  } catch {
    return applyUrl;
  }
}

export async function scrapeAshbyDom(
  applyUrl: string,
  browser: Browser,
): Promise<ScrapedField[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(toApplicationUrl(applyUrl), {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(2500);

    const raw = await page.evaluate(() => {
      const out: DomField[] = [];
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input[type='text'], input:not([type]), textarea",
      );
      inputs.forEach((el, idx) => {
        const id = el.id || el.name || "";
        // Skip recaptcha hidden textarea and Ashby system PII fields.
        if (/recaptcha/i.test(id)) return;
        if (id.startsWith("_systemfield_")) return;

        let labelText = "";
        let parent: Element | null = el.parentElement;
        for (let depth = 0; parent && depth < 6 && !labelText; depth++) {
          const lab = parent.querySelector(
            "[class*='_label_'], [class*='Label'], label",
          );
          if (lab && lab.textContent && !lab.contains(el)) {
            labelText = lab.textContent.trim();
          }
          parent = parent.parentElement;
        }
        const required = labelText.endsWith("*") || el.required;
        const maxLenAttr = el.getAttribute("maxlength");
        const maxLen = maxLenAttr ? Number.parseInt(maxLenAttr, 10) : null;
        out.push({
          id: id || `ashby-dom-${idx}`,
          label: labelText,
          type: el.tagName.toLowerCase() === "textarea" ? "textarea" : "text",
          required,
          maxLen: Number.isFinite(maxLen) ? maxLen : null,
        });
      });
      return out;
    });

    const fields: ScrapedField[] = [];
    for (const f of raw) {
      const cleanLabel = f.label.replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
      if (!cleanLabel || isPiiLabel(cleanLabel)) continue;
      const out: ScrapedField = {
        id: f.id,
        label: cleanLabel,
        type: f.type,
        required: f.required,
      };
      if (f.maxLen !== null) out.maxLen = f.maxLen;
      fields.push(out);
    }
    return fields;
  } finally {
    await context.close();
  }
}

export async function scrapeAshby(
  applyUrl: string,
  browser: Browser,
): Promise<ScrapeResult> {
  const handle = parseAshbyHandle(applyUrl);
  if (!handle) {
    return { ats: "ashby", source: "dom", fields: [], error: "could not parse Ashby URL" };
  }
  // Ashby's public posting-api (api.ashbyhq.com/posting-api/job-board/{slug})
  // exposes job metadata + descriptionHtml + compensation but NOT the
  // application form definition under any flag combo we've tried
  // (includeCompensation, includeApplicationForm). The individual job
  // endpoint /job-board/{slug}/{id} returns 401. So Ashby is DOM-only.
  const domFields = await scrapeAshbyDom(applyUrl, browser);
  return { ats: "ashby", source: "dom", fields: domFields };
}
