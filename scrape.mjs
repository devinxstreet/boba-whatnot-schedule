import { chromium } from '@playwright/test';
import fs from 'fs/promises';

const QUERIES = ['Bo Jackson Battle Arena', 'BoBA', 'Bo Battle Arena'];
const buildSearchUrl = (q) =>
  `https://www.whatnot.com/search?query=${encodeURIComponent(q)}&referringSource=typed&searchVertical=LIVESTREAM`;

async function ensurePublic() { await fs.mkdir('public', { recursive: true }); }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function dismissOverlays(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    '[data-test="close-button"]',
    '[aria-label="Close"]',
    '[data-testid="banner-close"]',
    '[data-testid="modal-close"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) { try { await el.click({ timeout: 500 }); } catch {} }
  }
}

async function autoScroll(page, { step = 700, pause = 250, max = 7000 } = {}) {
  let scrolled = 0;
  while (scrolled < max) {
    await page.evaluate(y => window.scrollBy(0, y), step);
    await page.waitForTimeout(pause);
    scrolled += step;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function extractFromSearch(page) {
  // Grab broad candidate links first
  const items = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="/live/"]'));
    return as.map(a => {
      const url = a.getAttribute('href');
      const abs = url ? new URL(url, location.origin).href : null;
      // Try to find a title near the link
      const title =
        a.getAttribute('aria-label')?.trim() ||
        a.querySelector('h1,h2,h3')?.textContent?.trim() ||
        a.textContent.trim() ||
        '';

      // Look up time in closest container
      const container = a.closest('article, [data-test*="card"], div');
      const t = container?.querySelector?.('time[datetime], [data-start-time]');
      const startISO = t?.getAttribute?.('datetime') || t?.getAttribute?.('data-start-time') || null;

      const host =
        (container?.querySelector?.('a[href*="/user/"]')?.textContent?.trim()) ||
        (container?.querySelector?.('[data-test*="seller"]')?.textContent?.trim()) ||
        '';

      return { title, url: abs, startISO, host };
    }).filter(x => x.url);
  });

  // Normalize & dedupe
  const now = Date.now();
  const normalized = items.map(s => ({ ...s, start: s.startISO ? Date.parse(s.startISO) : null }))
    .filter(s => !s.start || s.start >= now);

  const seen = new Set();
  const deduped = normalized.filter(e => {
    const key = `${e.url}|${e.start || 'nostart'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped;
}

(async () => {
  await ensurePublic();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
  });
  const page = await context.newPage();

  let all = [];

  for (const q of QUERIES) {
    const url = buildSearchUrl(q);
    try {
      console.log('Searching:', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      await dismissOverlays(page);
      await autoScroll(page, { step: 600, pause: 220, max: 6000 });

      // Save debug artifacts so we can tune selectors if needed
      const s = slug(q);
      await fs.writeFile(`public/debug-${s}.html`, await page.content(), 'utf8').catch(() => {});
      await page.screenshot({ path: `public/debug-${s}.png`, fullPage: true }).catch(() => {});

      const items = await extractFromSearch(page);
      await fs.writeFile(`public/raw-${s}.json`, JSON.stringify(items, null, 2), 'utf8').catch(() => {});

      console.log(`Found ${items.length} items for "${q}"`);
      all = all.concat(items);
    } catch (e) {
      console.log('Failed on', url, e.message);
    }
  }

  // Final dedupe
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
