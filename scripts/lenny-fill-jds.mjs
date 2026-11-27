// Write batch/.jds/{id}.txt + .url for batch rows whose URLs prefetch-jds.mjs can't fetch
// (Rippling ATS, Whatnot careers pages, Webflow-hosted JD PDFs).
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os'; import { join } from 'path';
import { chromium } from 'playwright';
const rows = readFileSync('batch/batch-input.tsv', 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'));
const strip = h => h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|div)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
let browser;
const write = (id, url, text) => { writeFileSync(`batch/.jds/${id}.txt`, text); writeFileSync(`batch/.jds/${id}.url`, url); if (existsSync(`batch/.jds/${id}.skipped`)) unlinkSync(`batch/.jds/${id}.skipped`); console.log(`  ${id} → ${text.length} chars (${url.slice(0, 70)})`); };
for (const [id, url, , notes] of rows) {
  if (existsSync(`batch/.jds/${id}.txt`)) continue;
  try {
    let m;
    if ((m = url.match(/ats\.rippling\.com\/([^/]+)\/jobs\/([0-9a-f-]{36})/))) {
      const j = await (await fetch(`https://api.rippling.com/platform/api/ats/v1/board/${m[1]}/jobs/${m[2]}`)).json();
      const desc = typeof j.description === 'object' ? Object.values(j.description).join('\n') : (j.description || '');
      const loc = (j.workLocations || []).map(w => w.label || w).join(' | ') || (j.workLocation?.label ?? '');
      const pay = (j.payRangeDetails || []).map(p => `${p.currency || ''} ${p.rangeStart}-${p.rangeEnd} ${p.frequency || ''}`).join('; ');
      write(id, url, `Title: ${j.name?.trim()}\nCompany: Rippling\nLocation: ${loc}\nCompensation: ${pay || 'not posted'}\nDepartment: ${j.department?.name || ''}\n\n${strip(desc)}`);
    } else if (/\.pdf($|\?)/i.test(url)) {
      const dir = mkdtempSync(join(tmpdir(), 'jdpdf-')); const pdf = join(dir, 'jd.pdf');
      writeFileSync(pdf, Buffer.from(await (await fetch(url)).arrayBuffer()));
      const txt = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
      write(id, url, `Source: ${notes}\n\n${txt.trim()}`);
    } else if (/whatnot\.com\/careers\/roles\//.test(url)) {
      browser ??= await chromium.launch({ headless: true });
      const p = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' })).newPage(); await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(8000);
      const txt = await p.evaluate(() => document.querySelector('main')?.innerText || document.body.innerText); await p.close();
      write(id, url, `Source: ${notes}\n\n${txt.trim()}`);
    }
  } catch (e) { console.log(`  ${id} FAILED: ${e.message}`); }
}
await browser?.close();
