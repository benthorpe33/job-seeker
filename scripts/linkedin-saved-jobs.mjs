#!/usr/bin/env node
// Pull saved-jobs list from LinkedIn using a persisted auth session.
//
// First run (interactive):
//   node scripts/linkedin-saved-jobs.mjs --login
//   → opens visible browser, you log in (incl. 2FA), script saves storage state to data/.linkedin-auth.json
//
// Subsequent runs:
//   node scripts/linkedin-saved-jobs.mjs
//   → headless, reuses saved auth, scrolls all saved jobs, writes data/linkedin-saved-jobs.json
//
// If LinkedIn challenges the session (login wall reappears), re-run with --login.

import { chromium } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AUTH_FILE = resolve(REPO_ROOT, 'data', '.linkedin-auth.json');
const OUTPUT_FILE = resolve(REPO_ROOT, 'data', 'linkedin-saved-jobs.json');
const SAVED_URL = 'https://www.linkedin.com/my-items/saved-jobs/';

const args = new Set(process.argv.slice(2));
const LOGIN_MODE = args.has('--login');
const AUTO_MODE = args.has('--auto');
const HEADFUL = args.has('--headful') || LOGIN_MODE;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loginAndSave() {
  console.log('[login] launching visible browser — log in to LinkedIn, then come back to terminal');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/login');
  console.log('[login] waiting up to 5 minutes for you to reach the LinkedIn feed...');
  // Wait for any URL that indicates a logged-in state
  await page.waitForURL(/linkedin\.com\/(feed|in|my-items|jobs)/, { timeout: 5 * 60 * 1000 });
  console.log('[login] detected logged-in state — saving session');
  if (!existsSync(dirname(AUTH_FILE))) mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  console.log(`[login] saved → ${AUTH_FILE}`);
  await browser.close();
}

async function scrapeSavedJobs(autoLoginAttempts = 0) {
  if (!existsSync(AUTH_FILE)) {
    if (AUTO_MODE) {
      if (autoLoginAttempts >= 1) {
        console.error('[auto] login flow ran but auth file is still missing — bailing');
        process.exit(3);
      }
      console.log('[auto] no auth file — opening visible browser for login');
      await loginAndSave();
      return scrapeSavedJobs(autoLoginAttempts + 1);
    } else {
      console.error(`[scrape] no auth file at ${AUTH_FILE} — run with --login first`);
      process.exit(1);
    }
  }
  console.log(`[scrape] launching ${HEADFUL ? 'visible' : 'headless'} browser`);
  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();
  await page.goto(SAVED_URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // If we got bounced to login, either prompt re-login (auto mode) or bail.
  if (/\/login|\/checkpoint/.test(page.url())) {
    await browser.close();
    if (AUTO_MODE && autoLoginAttempts < 1) {
      console.log('[auto] session expired — opening visible browser for re-login');
      await loginAndSave();
      return scrapeSavedJobs(autoLoginAttempts + 1);
    }
    if (AUTO_MODE) {
      console.error('[auto] still bounced to login after re-auth attempt — bailing');
      process.exit(3);
    }
    console.error('[scrape] session expired — re-run with --login');
    process.exit(2);
  }

  console.log(`[scrape] on ${page.url()} — scrolling to load all saved jobs`);

  // Scroll-and-collect loop. LinkedIn paginates the saved-jobs view; each page has ~10 cards
  // and a numbered pager at the bottom. We'll iterate pages explicitly rather than infinite-scroll.
  const allJobs = new Map(); // jobId -> {jobId, title, company, location, savedAt, listUrl}
  let pageNum = 1;
  let safety = 20; // hard cap

  while (safety-- > 0) {
    // Let cards render
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(1200 + Math.floor(Math.random() * 800));

    // Scroll to bottom slowly to trigger any lazy-render
    await page.evaluate(async () => {
      const distance = 400;
      const delay = 80;
      let lastScroll = -1;
      while (window.scrollY !== lastScroll) {
        lastScroll = window.scrollY;
        window.scrollBy(0, distance);
        await new Promise((r) => setTimeout(r, delay));
      }
    });
    await sleep(800);

    const pageJobs = await page.evaluate(() => {
      const out = [];
      // Job cards on the saved-jobs view are anchors to /jobs/view/{id}
      const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
      for (const a of anchors) {
        const m = a.href.match(/\/jobs\/view\/(\d+)/);
        if (!m) continue;
        const jobId = m[1];
        // Climb up to the card container to find sibling text
        let card = a.closest('li') || a.closest('[data-occludable-job-id]') || a.parentElement;
        for (let i = 0; i < 4 && card && card.parentElement && !card.querySelector('img'); i++) {
          card = card.parentElement;
        }
        const text = (card?.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        // Heuristic: title is often the anchor's own visible text (or aria-label); company/location follow
        const title = (a.getAttribute('aria-label') || a.innerText || '').trim();
        out.push({
          jobId,
          listUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
          title,
          cardText: text.slice(0, 8), // keep raw, parse companies/locations downstream
        });
      }
      return out;
    });

    let added = 0;
    for (const j of pageJobs) {
      if (!allJobs.has(j.jobId)) {
        allJobs.set(j.jobId, j);
        added++;
      }
    }
    console.log(`[scrape] page ${pageNum}: found ${pageJobs.length} card refs, ${added} new (total: ${allJobs.size})`);

    // Try to advance to next page via the artdeco pager (aria-label="Next").
    const nextBtn = page.locator('button.artdeco-pagination__button--next, button[aria-label="Next"]').first();
    const nextCount = await nextBtn.count();
    if (nextCount === 0) {
      console.log('[scrape] no Next button — done');
      break;
    }
    const disabled = await nextBtn.isDisabled().catch(() => true);
    if (disabled) {
      console.log('[scrape] Next button disabled — done');
      break;
    }
    await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
    await nextBtn.click();
    pageNum++;
    await sleep(1800 + Math.floor(Math.random() * 1200));
  }

  const result = {
    scrapedAt: new Date().toISOString(),
    sourceUrl: SAVED_URL,
    count: allJobs.size,
    jobs: Array.from(allJobs.values()),
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`[scrape] wrote ${result.count} jobs → ${OUTPUT_FILE}`);
  await browser.close();
}

(async () => {
  if (LOGIN_MODE) {
    await loginAndSave();
  } else {
    await scrapeSavedJobs();
  }
})().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
