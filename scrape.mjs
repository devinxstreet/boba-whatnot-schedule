import { chromium } from '@playwright/test';
import fs from 'fs/promises';

/** Queries you want */
const QUERIES = [
  'Bo Jackson Battle Arena',
  'BoBA',
  'Bo Battle Arena',
];

/** Build search URL like the one you shared */
const buildSearchUrl = (q) =>
  `https://www.whatnot.com/search?query=${encodeURIComponent(q)}&referringSource=typed&searchVertical=LIVESTREAM`;

/** Title must match one of these (includes your exact example) */
const TITLE_REGEX = /\b(bo\s*jackson\s*battle\s*arena|boba|bo\s*battle\s*arena|tuesday\s*night\s*throwdown)\b/i;

/** Close common overlays that block clicks */
async function dismissOverlays(page) {
  const sels = [
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    '[data-test="close-button"]',
    '[aria-label="Close"]',
    '[data-testid="banner-close"]',
    '[data-testid="modal-close"]',
  ];
  for (const sel of sels) {
    const el = await page.$(sel).catch(() => null);
    if (el) { try { await el.click({ timeout: 500 }); } catch {} }
  }
}

/** Scroll to force lazy lists to render */
async function autoScroll(page, { step = 700, pause = 220, max = 7000 } = {}) {
  let scrolled = 0;
  while (scrolled < max) {
    await page.evaluate(y => window.scrollBy(0, y), step);
    await page.waitForTimeout(pause);
    scrolled += step;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Extract show cards from search results */
async function extractShows(page) {
  await page.waitForTimeout(2500);
  await dismissOverlays(page);
  await autoScroll(page);

  const shows = await page.evaluate(() => {
    // Grab any link that points to a livestream detail
    const links = Array.from(document.querySelectorAll('a[href*="/live/"]'));

    // Normalize each to {title,url,startISO,host}
    const items = links.map(a => {
      const url = a.getAttribute('href');
      const abs = url ? new URL(url, location.origin).href : null;

      // try to get a readable title
      const title =
        a.getAttribute('aria-label')?.trim() ||
        a.querySelector('h1,h2,h3')?.textContent?.trim() ||
        a.textContent.trim() ||
        '';

      // find time & host from a nearby container
      const container = a.closest('article, [data-test*="card"], div, section');
      const t = container?.querySelector?.('time[datetime], [data-start-time]');
      const startISO = t?.getAttribute?.('datetime') || t?.getAttribute?.('data-start-time') || null;

      const host =
        (container?.querySelector?.('a[href*="/user/"]')?.textContent?.trim()) ||
        (container?.querySelector?.('[data-test*="seller"]')?.textContent?.trim()) ||
        '';

      return { title, url: abs, startISO, host };
    }).filter(x => x.url);

    // Deduplicate by URL to avoid repeats in dense grids
    const seen = new Set();
    return items.filter(i => {
      if (seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    });
  });

  // Keep only titles that match our phrases
  const filtered = shows.filter(s => TITLE_REGEX.test(s.title || ''));

  // Normalize time
  const now = Date.now();
  const normalized = filtered
    .map(s => ({ ...s, start: s.startISO ? Date.parse(s.startISO) : null }))
    // keep upcoming or undated
    .filter(s => !s.start || s.start >= now)
    // sort dated first (soonest first), then undated by title
    .sort((a, b) => {
      if (a.start && b.start) return a.start - b.start;
      if (a.start && !b.start) return -1;
      if (!a.start && b.start) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });

  return normalized;
}

(async () => {
  await fs.mkdir('public', { recursive: true });

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
  });
  const page = await context.newPage();

  let all = [];
  for (const q of QUERIES) {
    try {
      const url = buildSearchUrl(q);
      console.log('Searching:', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const items = await extractShows(page);
      console.log(`Found ${items.length} for "${q}"`);
      all = all.concat(items);
    } catch (e) {
      console.log('Failed on query', q, e.message);
    }
  }

  // Final dedupe by URL + start (or URL alone)
  const seen = new Set();
  const deduped = all.filter(e => {
    const key = `${e.url}|${e.start || 'nostart'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await fs.writeFile('public/schedule.json', JSON.stringify(deduped, null, 2), 'utf8');
  await browser.close();
})();
