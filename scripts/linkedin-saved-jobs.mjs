#!/usr/bin/env node
// Pull saved-jobs list from LinkedIn using a persisted auth session.
//
// First run (interactive):
//   node scripts/linkedin-saved-jobs.mjs --login
//   → opens visible browser, you log in (incl. 2FA), script saves storage state to data/.linkedin-auth.json
//
// Subsequent runs:
//   node scripts/linkedin-saved-jobs.mjs
//   → headless, reuses saved auth, pages through all saved jobs, writes data/linkedin-saved-jobs.json
//
// If LinkedIn challenges the session (login wall reappears), re-run with --login.

import { chromium } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCardLines } from './lib/linkedin-card.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AUTH_FILE = resolve(REPO_ROOT, 'data', '.linkedin-auth.json');
const OUTPUT_FILE = resolve(REPO_ROOT, 'data', 'linkedin-saved-jobs.json');
// my-items/saved-jobs/ now redirects here (2026-09). Pinning stage=saved keeps
// us off the Applied / In progress / Archive tabs.
const SAVED_URL = 'https://www.linkedin.com/jobs-tracker/?stage=saved';
const MAX_PAGES = 50;

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

  console.log(`[scrape] on ${page.url()} — paging through saved jobs`);

  const hasCards = await page
    .waitForSelector('a[href*="/jobs/view/"]', { state: 'attached', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!hasCards) {
    await browser.close();
    console.error(`[scrape] no job cards found on ${SAVED_URL} — LinkedIn layout may have changed (or there are no saved jobs)`);
    process.exit(4);
  }

  // LinkedIn paginates the saved-jobs view (~10 cards per page) with a numbered
  // pager. Iterate pages explicitly via the Next button.
  const allJobs = new Map(); // jobId -> {jobId, listUrl, title, company, location, workplaceType, postedText, cardText}
  let pageNum = 1;
  let hitPageCap = true;

  while (pageNum <= MAX_PAGES) {
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
      // Each card has several anchors to /jobs/view/{id} (logo, title block).
      // Keep, per jobId, the text lines from the anchor that carries the most.
      // The jobs-tracker layout renders one <p> per line (title, "Company · Location",
      // "Posted 2w ago"); card innerText concatenates them without newlines, so
      // read the <p>s individually and only fall back to innerText lines.
      const byId = new Map();
      for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
        const m = a.href.match(/\/jobs\/view\/(\d+)/);
        if (!m) continue;
        let lines = Array.from(a.querySelectorAll('p'))
          .map((p) => (p.innerText || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        if (lines.length === 0) {
          lines = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        }
        const prev = byId.get(m[1]);
        if (!prev || lines.length > prev.length) byId.set(m[1], lines);
      }
      return Array.from(byId, ([jobId, lines]) => ({ jobId, lines: lines.slice(0, 8) }));
    });

    let added = 0;
    for (const { jobId, lines } of pageJobs) {
      if (allJobs.has(jobId)) continue;
      const { title, company, location, workplaceType, postedText } = parseCardLines(lines);
      allJobs.set(jobId, {
        jobId,
        listUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
        title,
        company,
        location,
        workplaceType,
        postedText,
        cardText: lines,
      });
      added++;
    }
    console.log(`[scrape] page ${pageNum}: found ${pageJobs.length} cards, ${added} new (total: ${allJobs.size})`);

    if (added === 0) {
      // Only reachable after clicking a visible Next: the pager didn't advance.
      console.error(`[scrape] WARNING: page ${pageNum} added no new jobs after clicking Next — stopping; later pages may be missing`);
      pageNum--;
      hitPageCap = false;
      break;
    }

    // Advance via the pager's Next button. On the last page LinkedIn keeps the
    // button in the DOM but hidden (data-testid="pagination-controls-next-button-hidden").
    const nextBtn = page
      .locator('[data-testid^="pagination-controls-next-button"], button.artdeco-pagination__button--next, button[aria-label="Next"]')
      .first();
    const nextTestId = (await nextBtn.count()) ? await nextBtn.getAttribute('data-testid').catch(() => null) : null;
    const usable =
      (await nextBtn.count()) > 0 &&
      !(nextTestId || '').endsWith('-hidden') &&
      (await nextBtn.isVisible().catch(() => false)) &&
      !(await nextBtn.isDisabled().catch(() => true));
    if (!usable) {
      console.log('[scrape] no usable Next button — last page');
      hitPageCap = false;
      break;
    }
    const firstId = pageJobs[0].jobId;
    await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
    await nextBtn.click();
    pageNum++;
    // Wait for the card list to swap before extracting the next page.
    await page
      .waitForFunction(
        (prevId) => {
          const a = document.querySelector('a[href*="/jobs/view/"]');
          return a && !a.href.includes(`/jobs/view/${prevId}`);
        },
        firstId,
        { timeout: 15000 },
      )
      .catch(() => {});
    await sleep(800 + Math.floor(Math.random() * 1200));
  }

  const jobs = Array.from(allJobs.values());
  const pagesRead = Math.min(pageNum, MAX_PAGES);
  const result = {
    scrapedAt: new Date().toISOString(),
    sourceUrl: SAVED_URL,
    count: jobs.length,
    pages: pagesRead,
    jobs,
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`[scrape] wrote ${result.count} jobs from ${pagesRead} page(s) → ${OUTPUT_FILE}`);
  await browser.close();

  if (hitPageCap) {
    console.error(`[scrape] WARNING: stopped at the ${MAX_PAGES}-page cap — saved jobs beyond that were not read`);
  }
  // Downstream stages drop rows without a company or title, so a parse
  // regression here would silently empty the pipeline. Fail loudly instead.
  const unparsed = jobs.filter((j) => !j.company || !j.title);
  if (unparsed.length > 0) {
    for (const j of unparsed.slice(0, 5)) {
      console.error(`[scrape]   unparsed card ${j.jobId}: ${JSON.stringify(j.cardText)}`);
    }
    if (unparsed.length / jobs.length > 0.2) {
      console.error(`[scrape] ${unparsed.length}/${jobs.length} cards missing company or title — card layout likely changed; update scripts/lib/linkedin-card.mjs`);
      process.exit(5);
    }
    console.error(`[scrape] WARNING: ${unparsed.length}/${jobs.length} cards missing company or title (listed above); they will be skipped downstream`);
  }
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
