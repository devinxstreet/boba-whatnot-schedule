import { chromium } from '@playwright/test';
import fs from 'fs/promises';

const SEARCH_URLS = [
  // General search for Bo Jackson Battle Arena
  'https://www.whatnot.com/live?query=Bo%20Jackson%20Battle%20Arena'
  // You can add specific seller pages if you want:
  // 'https://www.whatnot.com/user/bazookavault',
  // 'https://www.whatnot.com/user/lakecountrycards',
];

async function extractShows(page) {
  // wait a little for shows to render
  await page.waitForTimeout(4000);

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
      const title =
        c.querySelector('[data-test*="title"], h3, h2')?.textContent?.trim() || '';
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

  // Normalize + only keep upcoming
  const now = Date.now();
  const normalized = shows
    .map(s => ({ ...s, start: s.startISO ? Date.parse(s.startISO) : null }))
    .filter(s => s.start && s.start >= now)
    .sort((a, b) => a.start - b.start);

  return normalized;
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let all = [];
  for (const url of SEARCH_URLS) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const items = await extractShows(page).catch(() => []);
    all = all.concat(items);
  }

  // Deduplicate
  const seen = new Set();
  const deduped = all.filter(e => {
    const key = `${e.url}|${e.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Save to public/schedule.json
  await fs.mkdir('public', { recursive: true });
  await fs.writeFile('public/schedule.json', JSON.stringify(deduped, null, 2), 'utf8');

  await browser.close();
})();
