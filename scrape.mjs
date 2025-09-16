import { chromium } from '@playwright/test';
import fs from 'fs/promises';

/** The queries you want */
const QUERIES = [
  'Bo Jackson Battle Arena',
  'BoBA',
  'Bo Battle Arena',
];

/** Build the official search URL you shared */
const buildSearchUrl = (q) =>
  `https://www.whatnot.com/search?query=${encodeURIComponent(q)}&referringSource=typed&searchVertical=LIVESTREAM`;

/** Best-effort: close cookie/sign-in overlays */
async function dismissOverlays(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    '[data-test="close-button"]',
    '[aria-label="Close"]',
    '[data-testid="banner-close"], [data-testid="modal-close"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) { try { await el.click({ timeout: 500 }); } catch {} }
  }
}

/** Force lazy content to render by scrolling */
async function autoScroll(page, { step = 700, pause = 250, max = 7000 } = {}) {
  let scrolled = 0;
  while (scrolled < max) {
    await page.evaluate(y => window.scrollBy(0, y), step);
    await page.waitForTimeout(pause);
    scrolled += step;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Pull show cards from the search results page */
async function extractShowsFromSearch(page) {
  // Give the SPA time to hydrate results
  await page.waitForTimeout(2500);
  await dismissOverlays(page);
  await autoScroll(page, { step: 600, pause: 220, max: 6000 });

  const shows = await page.evaluate(() => {
    // Likely containers for livestream cards in search results
    const selList = [
      '[data-test*="show-card"]',
      'a[href*="/live/"] div:has(h3), a[href*="/live/"] div:has(h2)',
      'article:has(a[href*="/live/"])',
      'a[href*="/live/"]:has(h3), a[href*="/live/"]:has(h2)',
    ].join(',');

    const nodes = Array.from(document.querySelectorAll(selList))
      .map(n => n.closest('[data-test*="card"], article, a[href*="/live/"], div') || n);

    const uniq = Array.from(new Set(nodes));

    return uniq.map(c => {
      const title =
        c.querySelector('[data-test*="title"], h3, h2')?.textContent?.trim() || '';
      const linkEl =
        c.matches('a[href*="/live/"]') ? c : c.querySelector('a[href*="/live/"]');
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

  // Keep only relevant titles (defensive: sometimes search returns side content)
  const titleRegex = /\b(bo\s*jackson|boba|battle\s*arena)\b/i;
  const filtered = shows.filter(s => titleRegex.test(s.title));

  // Normalize
  const now = Date.now();
  const normalized = filtered
    .map(s => ({ ...s, start: s.startISO ? Date.parse(s.startISO) : null }))
    // Keep upcoming or undated (some cards omit datetime but are clearly upcoming)
    .filter(s => !s.start || s.start >= now)
    .sort((a, b) => {
      if (a.start && b.start) return a.start - b.start;
      if (a.start && !b.start) return -1;
      if (!a.start && b.start) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });

  return normalized;
}

(async () => {
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
      console.log('Searching URL:', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const items = await extractShowsFromSearch(page);
      console.log(`Found ${items.length} items for "${q}"`);
      all = all.concat(items);
    } catch (e) {
      console.log('Failed on query', q, e.message);
    }
  }

  // Deduplicate (by URL + start time or URL alone)
  const seen = new Set();
  const deduped = all.filter(e => {
    const key = `${e.url}|${e.start || 'nostart'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await fs.mkdir('public', { recursive: true });
  await fs.writeFile('public/schedule.json', JSON.stringify(deduped, null, 2), 'utf8');
  await browser.close();
})();
