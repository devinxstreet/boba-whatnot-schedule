import { chromium } from '@playwright/test';
import fs from 'fs/promises';

/** === CONFIG === */
const QUERIES = ['Bo Jackson Battle Arena', 'BoBA', 'Bo Battle Arena'];
const buildSearchUrl = (q) =>
  `https://www.whatnot.com/search?query=${encodeURIComponent(q)}&referringSource=typed&searchVertical=LIVESTREAM`;

/** Prefer these phrases in titles (still keeps others if none match) */
const TITLE_REGEX = /\b(bo\s*jackson\s*battle\s*arena|boba|bo\s*battle\s*arena|tuesday\s*night\s*throwdown)\b/i;

/** === HELPERS === */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function ensurePublic() { await fs.mkdir('public', { recursive: true }); }

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
  while (y < max) {
    await page.evaluate(s => window.scrollBy(0, s), step);
    await page.waitForTimeout(pause);
    y += step;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Extract candidate show cards from search page */
async function extractFromSearch(page) {
  const items = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/live/"]'));
    const out = links.map(a => {
      const url = a.getAttribute('href');
      const abs = url ? new URL(url, location.origin).href : null;

      const title =
        a.getAttribute('aria-label')?.trim() ||
        a.querySelector('h1,h2,h3')?.textContent?.trim() ||
        a.textContent.trim() || '';

      const container = a.closest('article, [data-test*="card"], div, section');

      const t = container?.querySelector?.('time[datetime], [data-start-time]');
      const startISO = t?.getAttribute?.('datetime') || t?.getAttribute?.('data-start-time') || null;

      const host =
        (container?.querySelector?.('a[href*="/user/"]')?.textContent?.trim()) ||
        (container?.querySelector?.('[data-test*="seller"]')?.textContent?.trim()) || '';

      const imgEl = container?.querySelector?.('img');
      const thumb =
        imgEl?.getAttribute?.('src') ||
        imgEl?.getAttribute?.('data-src') ||
        (imgEl?.getAttribute?.('srcset')?.split(' ')?.[0]) ||
        null;

      return { title, url: abs, startISO, host, thumb };
    }).filter(x => x.url);

    const seen = new Set();
    return out.filter(i => !seen.has(i.url) && seen.add(i.url));
  });

  return items.map(s => ({ ...s, start: s.startISO ? Date.parse(s.startISO) : null }));
}

/** Open each show page to enrich title/host/thumbnail/time via OG tags */
async function enrich(browser, items, max = 30) {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Anti-bot evasions on every page
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
      window.chrome = window.chrome || { runtime: {} };
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) => (
          parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)
        );
      }
      const gp = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param){
        if (param === 37445) return 'Intel Inc.';              // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'Intel Iris OpenGL Engine';// UNMASKED_RENDERER_WEBGL
        return gp.call(this, param);
      };
      Object.defineProperty(screen, 'availTop', { get: () => 0 });
    } catch (e) {}
  });

  const page = await ctx.newPage();
  const out = [];

  for (let i = 0; i < items.length && i < max; i++) {
    const it = items[i];
    try {
      await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1200);
      await dismissOverlays(page);

      const meta = await page.evaluate(() => {
        const pick = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
        const ogTitle = pick('meta[property="og:title"]') || pick('meta[name="og:title"]') || pick('meta[name="twitter:title"]');
        const ogImg   = pick('meta[property="og:image"]') || pick('meta[name="og:image"]') || pick('meta[name="twitter:image"]');
        const pageH1  = document.querySelector('h1')?.textContent?.trim() || null;

        const hostEl =
          document.querySelector('a[href*="/user/"]') ||
          document.querySelector('[data-test*="seller"]') ||
          document.querySelector('[data-testid*="seller"]');
        const host = hostEl?.textContent?.trim() || null;

        const tEl = document.querySelector('time[datetime], [data-start-time]');
        const startISO = tEl?.getAttribute?.('datetime') || tEl?.getAttribute?.('data-start-time') || null;

        const imgEl = document.querySelector('img');
        const fallImg = imgEl?.getAttribute('src') || imgEl?.getAttribute('data-src') || null;

        return { title: ogTitle || pageH1 || '', image: ogImg || fallImg || '', host: host || '', startISO: startISO || '' };
      });

      const title = (meta.title || it.title || '').trim();
      const host  = (meta.host  || it.host  || '').trim();
      const thumb = (meta.image || it.thumb || '').trim();
      const start = meta.startISO ? Date.parse(meta.startISO) : it.start || null;

      out.push({ title, url: it.url, host, thumb, start });
    } catch (e) {
      // ignore single-page failures so the run keeps going
    }
  }

  await ctx.close();
  return out;
}

/** === MAIN === */
(async () => {
  await ensurePublic();

  // launch headed (Xvfb will provide display on GitHub Actions)
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1366,900',
      '--lang=en-US,en',
      '--disable-gpu'
    ],
  });

  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36',
  });

  let collected = [];

  for (const q of QUERIES) {
    const url = buildSearchUrl(q);
    const s = slug(q);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      await dismissOverlays(page);
      await autoScroll(page);

      // debug artifacts for verification
      await fs.writeFile(`public/debug-${s}.html`, await page.content(), 'utf8').catch(()=>{});
      await page.screenshot({ path: `public/debug-${s}.png`, fullPage: true }).catch(()=>{});

      const base = await extractFromSearch(page);
      await fs.writeFile(`public/raw-${s}.json`, JSON.stringify(base, null, 2), 'utf8').catch(()=>{});

      // prefer titles with your phrases; if none match, keep what we found
      const preferred = base.filter(i => TITLE_REGEX.test((i.title || '').toLowerCase()));
      const chosen = preferred.length ? preferred : base;

      // enrich (grab real title/host/thumbnail/time)
      const richer = await enrich(browser, chosen, 30);
      collected = collected.concat(richer);
    } catch (e) {
      await fs.writeFile(`public/raw-${s}.json`, JSON.stringify({ error: e.message }, null, 2), 'utf8').catch(()=>{});
    }
  }

  // final dedupe + sort
  const seen = new Set();
  const final = collected.filter(e => {
    const key = `${e.url}|${e.start || 'nostart'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b) => {
    if (a.start && b.start) return a.start - b.start;
    if (a.start && !b.start) return -1;
    if (!a.start && b.start) return 1;
    return (a.title || '').localeCompare(b.title || '');
  });

  await fs.writeFile('public/schedule.json', JSON.stringify(final, null, 2), 'utf8');

  // simple index to help verify deploy contents
  await fs.writeFile(
    'public/index.html',
    `<!doctype html><meta charset="utf-8">
     <body style="background:#0b0b0b;color:#fff;font:16px/1.5 system-ui;padding:24px">
     <h1>BoBA Schedule (${final.length} items)</h1>
     <p><a style="color:#ED67A1" href="schedule.json">schedule.json</a></p>
     <ul>
       ${QUERIES.map(q => `<li>
         <a style="color:#ED67A1" href="debug-${slug(q)}.html">debug ${q}</a> |
         <a style="color:#ED67A1" href="raw-${slug(q)}.json">raw ${q}</a> |
         <a style="color:#ED67A1" href="debug-${slug(q)}.png">screenshot ${q}</a>
       </li>`).join('')}
     </ul>`,
    'utf8'
  );

  await browser.close();
})().catch(async (err) => {
  // Never crash the process: write an empty feed and log the error
  console.error('SCRAPER ERROR:', err && err.stack ? err.stack : err);
  try {
    await fs.mkdir('public', { recursive: true });
    await fs.writeFile('public/schedule.json', '[]', 'utf8');
    await fs.writeFile(
      'public/index.html',
      '<!doctype html><meta charset="utf-8"><body style="background:#0b0b0b;color:#fff;font:16px system-ui;padding:24px"><h1>Scraper error</h1><p>See Actions logs for details.</p>',
      'utf8'
    );
  } catch {}
  // do not rethrow
});
