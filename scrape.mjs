import { chromium } from '@playwright/test';
import fs from 'fs/promises';

/** 🔎 Only the queries you want */
const SEARCH_URLS = [
  'https://www.whatnot.com/live?query=Bo%20Jackson%20Battle%20Arena',
  'https://www.whatnot.com/live?query=BoBA',
  'https://www.whatnot.com/live?query=Bo%20Battle%20Arena'
];

/** Smooth scroll to load more shows */
async function autoScroll(page, { step = 400, pause = 250, max = 5000 } = {}) {
  let scrolled = 0;
  while (scrolled < max) {
    await page.evaluate(y => window.scrollBy(0, y), step);
    await page.waitForTimeout(pause);
    scrolled += step;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function extractShows(page) {
  await page.waitForTimeout(3500);
  await autoScroll(page, { step: 600, pause: 250, max: 6000 });

  const shows = await page.evaluate(() => {
    const selList = [
      '[data-test*="show-card"]',
      'a[href*="/live/"] div:has(h3), a[href*="/live/"] div:has(h2)',
      'article:has(a[href*="/live/"])'
    ].join(',');

    const nodes = Array.from(document.querySelectorAll(selList))
      .map(n => n.closest('[data-test*="card"], article, div') || n);

    const uniq = Array.from(new Set(nodes));
    return uniq.map(c => {
      const title = c.querySelector('[data-test*="title"], h3, h2')?.textContent?.trim() || '';
      const linkEl = c.querySelector('a[href*="/live/"]');
      const url = linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : null;
      const t = c.querySelector('time[datetime]') || c.querySelector('[data-start-time]');
      const startISO = t?.getAttribute('datetime') || t?.getAttribute('data-start-time') || null;
      const host =
        c.querySelector('a[href*="/user/"]')?.textContent?.trim() ||
        c.querySelector('[data-test*="seller"]')?.textContent?.trim() || '';
      const tags = Array.from(c.querySelectorAll('[data-test*="tag"], .chip, .badge'))
        .map(el => el.textContent.trim())
        .filter(Boolean);
      return { title, url, startISO, host, tags };
    }).filter(s => s.title && s.url);
  });

  const now = Date.now();
  return shows
    .map(s => ({ ...s, start: s.startISO ? Date.parse(s.startISO) : null }))
    .filter(s => s.start && s.start >= now)
    .sort((a, b) => a.start - b.start);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  let all = [];
  for (const url of SEARCH_URLS) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const items = await extractShows(page);
      all = all.concat(items);
    } catch (e) {
      console.log('Failed on', url, e.message);
    }
  }

  // dedupe
  const seen = new Set();
  const deduped = all.filter(e => {
    const key = `${e.url}|${e.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await fs.mkdir('public', { recursive: true });
  await fs.writeFile('public/schedule.json', JSON.stringify(deduped, null, 2), 'utf8');
  await browser.close();
})();
