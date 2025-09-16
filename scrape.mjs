import { chromium } from '@playwright/test';
import fs from 'fs/promises';

/** Queries */
const QUERIES = ['Bo Jackson Battle Arena', 'BoBA', 'Bo Battle Arena'];
const buildSearchUrl = (q) =>
  `https://www.whatnot.com/search?query=${encodeURIComponent(q)}&referringSource=typed&searchVertical=LIVESTREAM`;

/** Phrases we care about (keeps false positives out) */
const TITLE_REGEX = /\b(bo\s*jackson\s*battle\s*arena|boba|bo\s*battle\s*arena|tuesday\s*night\s*throwdown)\b/i;

/** helpers */
async function dismissOverlays(page) {
  const sels = [
    'button:has-text("Accept")','button:has-text("Got it")','button:has-text("Close")',
    '[data-test="close-button"]','[aria-label="Close"]','[data-testid="banner-close"]','[data-testid="modal-close"]'
  ];
  for (const sel of sels) {
    const el = await page.$(sel).catch(()=>null);
    if (el) { try { await el.click({ timeout: 400 }); } catch {} }
  }
}
async function autoScroll(page, { step = 700, pause = 220, max = 7000 } = {}) {
  let y = 0;
  while (y < max) { await page.evaluate(s => window.scrollBy(0, s), step); await page.waitForTimeout(pause); y+=step; }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Extract shallow items from search results */
async function extractFromSearch(page) {
  await page.waitForTimeout(2500);
  await dismissOverlays(page);
  await autoScroll(page);

  const items = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/live/"]'));
    const out = links.map(a => {
      const url = a.getAttribute('href');
      const abs = url ? new URL(url, location.origin).href : null;

      // try basic title found on the card
      const title =
        a.getAttribute('aria-label')?.trim() ||
        a.querySelector('h1,h2,h3')?.textContent?.trim() ||
        a.textContent.trim() || '';

      // container for meta
      const container = a.closest('article, [data-test*="card"], div, section');

      // time (if present on card)
      const t = container?.querySelector?.('time[datetime], [data-start-time]');
      const startISO = t?.getAttribute?.('datetime') || t?.getAttribute?.('data-start-time') || null;

      // host on card (best-effort)
      const host =
        (container?.querySelector?.('a[href*="/user/"]')?.textContent?.trim()) ||
        (container?.querySelector?.('[data-test*="seller"]')?.textContent?.trim()) || '';

      // thumbnail (sometimes available right on the card)
      const imgEl = container?.querySelector?.('img');
      const thumb =
        imgEl?.getAttribute?.('src') ||
        imgEl?.getAttribute?.('data-src') ||
        imgEl?.getAttribute?.('srcset')?.split(' ')?.[0] ||
        null;

      return { title, url: abs, startISO, host, thumb };
    }).filter(x => x.url);

    // dedupe by URL
    const seen = new Set();
    return out.filter(i => !seen.has(i.url) && seen.add(i.url));
  });

  // filter to our phrases
  const filtered = items.filter(s => TITLE_REGEX.test((s.title || '').toLowerCase()));

  return filtered.map(s => ({
    ...s,
    start: s.startISO ? Date.parse(s.startISO) : null
  }));
}

/** Enrich by opening the live page and pulling OG metadata */
async function enrichItems(browser, items, max = 25) {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
  });
  const page = await ctx.newPage();

  const out = [];
  for (let i = 0; i < items.length && i < max; i++) {
    const it = items[i];
    try {
      await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
      await dismissOverlays(page);

      const meta = await page.evaluate(() => {
        const pick = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
        const ogTitle = pick('meta[property="og:title"]') || pick('meta[name="og:title"]');
        const twTitle = pick('meta[name="twitter:title"]');
        const ogImg   = pick('meta[property="og:image"]') || pick('meta[name="og:image"]') || pick('meta[name="twitter:image"]');
        const pageH1  = document.querySelector('h1')?.textContent?.trim() || null;

        // host: try visible seller name on the page
        const hostEl =
          document.querySelector('a[href*="/user/"]') ||
          document.querySelector('[data-test*="seller"]') ||
          document.querySelector('[data-testid*="seller"]');

        const host = hostEl?.textContent?.trim() || null;

        // time on detail page
        const tEl = document.querySelector('time[datetime], [data-start-time]');
        const startISO = tEl?.getAttribute?.('datetime') || tEl?.getAttribute?.('data-start-time') || null;

        // fallback image in content
        const imgEl = document.querySelector('img');
        const fallImg = imgEl?.getAttribute('src') || imgEl?.getAttribute('data-src') || null;

        return {
          title: ogTitle || twTitle || pageH1 || '',
          image: ogImg || fallImg || '',
          host: host || '',
          startISO: startISO || ''
        };
      });

      const title = meta.title?.trim() || it.title || '';
      const host  = meta.host?.trim()  || it.host || '';
      const thumb = meta.image?.trim() || it.thumb || '';
      const start = meta.startISO ? Date.parse(meta.startISO) : it.start || null;

      // keep only titles that match our phrases
      if (!TITLE_REGEX.test(title.toLowerCase())) continue;

      out.push({ title, url: it.url, host, thumb, start });
    } catch (e) {
      // ignore individual failures
    }
  }

  await ctx.close();
  return out;
}

(async () => {
  await fs.mkdir('public', { recursive: true });

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  // 1) collect shallow items from search pages
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  let base = [];
  for (const q of QUERIES) {
    try {
      const url = buildSearchUrl(q);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const items = await extractFromSearch(page);
      base = base.concat(items);
    } catch {}
  }
  await page.close();

  // dedupe by URL (before enriching)
  const seen = new Set();
  base = base.filter(e => !seen.has(e.url) && seen.add(e.url));

  // 2) enrich a reasonable number per run (tune max if you like)
  const enriched = await enrichItems(browser, base, 30);

  // 3) final dedupe/sort & save
  const seen2 = new Set();
  const final = enriched.filter(e => {
    const key = `${e.url}|${e.start || 'nostart'}`;
    if (seen2.has(key)) return false;
    seen2.add(key);
    return true;
  }).sort((a,b) => {
    if (a.start && b.start) return a.start - b.start;
    if (a.start && !b.start) return -1;
    if (!a.start && b.start) return 1;
    return (a.title || '').localeCompare(b.title || '');
  });

  await fs.writeFile('public/schedule.json', JSON.stringify(final, null, 2), 'utf8');
  await browser.close();
})();
