import { chromium } from '@playwright/test';
import fs from 'fs/promises';

/** === CONFIG === */
const SHOWS_URL = 'https://www.whatnot.com/user/bazookavault/shows';

/** === HELPERS === */
async function ensurePublic(){ await fs.mkdir('public', { recursive: true }); }

async function dismissOverlays(page){
  const sels = [
    'button:has-text("Accept")','button:has-text("Got it")','button:has-text("Close")',
    '[data-test="close-button"]','[aria-label="Close"]','[data-testid="banner-close"]','[data-testid="modal-close"]'
  ];
  for (const sel of sels){
    try { const el = await page.$(sel); if (el) await el.click({ timeout: 400 }); } catch {}
  }
}

async function autoScroll(page, { step=700, pause=220, max=12000 }={}){
  let y=0;
  while (y < max){ await page.evaluate(s => window.scrollBy(0, s), step); await page.waitForTimeout(pause); y+=step; }
  await page.evaluate(() => window.scrollTo(0,0));
}

/** Extract cards from the user's shows page */
async function extractFromShows(page){
  await page.waitForTimeout(2000);
  await dismissOverlays(page);
  await autoScroll(page);

  const items = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/live/"]'));
    const out = links.map(a => {
      const href = a.getAttribute('href');
      const url = href ? new URL(href, location.origin).href : null;

      const title =
        a.getAttribute('aria-label')?.trim() ||
        a.querySelector('h1,h2,h3')?.textContent?.trim() ||
        a.textContent.trim() || '';

      const card = a.closest('article, [data-test*="card"], [data-testid*="card"], section, div');

      // time if present on card
      const t = card?.querySelector?.('time[datetime], [data-start-time], meta[itemprop="startDate"]');
      const startISO = t?.getAttribute?.('datetime') ||
                       t?.getAttribute?.('data-start-time') ||
                       t?.getAttribute?.('content') || null;

      // thumbnail on card
      const imgEl = card?.querySelector?.('img');
      const thumb = imgEl?.getAttribute('src') ||
                    imgEl?.getAttribute('data-src') ||
                    (imgEl?.getAttribute('srcset')?.split(' ')?.[0]) ||
                    null;

      return { url, title, startISO, thumb };
    }).filter(x => x.url);

    // de-dupe by URL
    const seen = new Set();
    return out.filter(i => !seen.has(i.url) && seen.add(i.url));
  });

  // Normalize time (may still be null; we enrich later)
  return items.map(s => ({ ...s, start: s.startISO ? Date.parse(s.startISO) : null }));
}

/** Open each show page and pull title/thumb/start time (super-robust extraction) */
async function enrich(browser, items, max = 80) {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Anti-bot evasions
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
      window.chrome = window.chrome || { runtime: {} };
      const orig = navigator.permissions?.query;
      if (orig) {
        navigator.permissions.query = (p) => (p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p));
      }
      const gp = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param){
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return gp.call(this, param);
      };
      Object.defineProperty(screen, 'availTop', { get: () => 0 });
    } catch(e){}
  });

  const page = await ctx.newPage();
  const out = [];

  for (let i = 0; i < items.length && i < max; i++) {
    const it = items[i];
    try {
      await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1400);

      const meta = await page.evaluate(() => {
        const pick = (sel) => document.querySelector(sel)?.getAttribute('content') || null;

        // 1) standard metas / visible h1
        const ogTitle = pick('meta[property="og:title"]') || pick('meta[name="og:title"]') || pick('meta[name="twitter:title"]');
        const ogImg   = pick('meta[property="og:image"]') || pick('meta[name="og:image"]') || pick('meta[name="twitter:image"]');
        const pageH1  = document.querySelector('h1')?.textContent?.trim() || null;

        // 2) obvious DOM attributes for start time
        let startISO =
          document.querySelector('time[datetime]')?.getAttribute('datetime') ||
          document.querySelector('[data-start-time]')?.getAttribute('data-start-time') ||
          document.querySelector('meta[itemprop="startDate"]')?.getAttribute('content') ||
          null;

        // helper: robust ISO + epoch regexes
        const grabFirstIso = (text) => {
          if (!text) return null;
          const m = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
          return m ? m[0] : null;
        };
        const grabFirstEpochMs = (text) => {
          if (!text) return null;
          const m = text.match(/(?<!\d)(1[6-9]\d{11})(?!\d)/); // 13-digit epoch ms
          return m ? new Date(Number(m[1])).toISOString() : null;
        };

        // 3) JSON blobs: __NEXT_DATA__, application/json, application/ld+json
        if (!startISO) {
          const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__'));
          for (const s of scripts) {
            const txt = s.textContent || '';
            try {
              const json = JSON.parse(txt);
              const arr = Array.isArray(json) ? json : [json];

              const search = (o, depth=0) => {
                if (!o || typeof o !== 'object' || depth > 6) return null;
                for (const [k,v] of Object.entries(o)) {
                  if (v == null) continue;
                  if (typeof v === 'string') {
                    if (/start(date|_date|time|_time)?/i.test(k)) {
                      const p = Date.parse(v);
                      if (!Number.isNaN(p)) return v;
                    }
                  } else if (typeof v === 'number') {
                    if (String(v).length === 13 && v > 1e12 && v < 2e12) return new Date(v).toISOString();
                  } else if (typeof v === 'object') {
                    const n = search(v, depth+1);
                    if (n) return n;
                  }
                }
                return null;
              };

              for (const obj of arr) {
                if ((obj['@type']==='Event' || obj['@type']==='LiveEvent') && obj.startDate) { startISO = obj.startDate; break; }
                if (obj['@graph']) {
                  for (const g of obj['@graph']) {
                    if ((g['@type']==='Event' || g['@type']==='LiveEvent') && g.startDate) { startISO = g.startDate; break; }
                  }
                  if (startISO) break;
                }
                const found = search(obj, 0);
                if (found) { startISO = found; break; }
              }
            } catch {
              const iso = grabFirstIso(txt) || grabFirstEpochMs(txt);
              if (iso) { startISO = iso; }
            }
            if (startISO) break;
          }
        }

        // 4) last resort: scan whole HTML
        if (!startISO) {
          const html = document.documentElement.innerHTML || '';
          startISO = grabFirstIso(html) || grabFirstEpochMs(html);
        }

        const fallImg = document.querySelector('img')?.getAttribute('src') || null;

        return {
          title: ogTitle || pageH1 || '',
          image: ogImg || fallImg || '',
          startISO: startISO || ''
        };
      });

      const title = (meta.title || it.title || '').trim();
      const thumb = (meta.image || it.thumb || '').trim();

      let start = null;
      if (meta.startISO) {
        const p = Date.parse(meta.startISO);
        if (!Number.isNaN(p)) start = p;
      } else if (it.start) {
        start = it.start;
      }

      out.push({ title, url: it.url, thumb, start });
    } catch {
      // keep the shallow item if enrichment failed
      out.push({ title: it.title || '', url: it.url, thumb: it.thumb || '', start: it.start || null });
    }
  }

  await ctx.close();
  return out;
}

/** === MAIN === */
(async () => {
  await ensurePublic();

  const browser = await chromium.launch({
    headless: false, // use Xvfb in GitHub Actions
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage','--window-size=1366,900','--lang=en-US,en','--disable-gpu'
    ],
  });

  // 1) Open your shows page and extract cards
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36',
  });

  let base = [];
  try{
    await page.goto(SHOWS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await dismissOverlays(page);
    await autoScroll(page);

    // debug artifacts
    await fs.writeFile('public/debug-shows.html', await page.content(), 'utf8').catch(()=>{});
    await page.screenshot({ path: 'public/debug-shows.png', fullPage: true }).catch(()=>{});

    base = await extractFromShows(page);
    await fs.writeFile('public/raw-shows.json', JSON.stringify(base, null, 2), 'utf8').catch(()=>{});
  }catch(e){
    await fs.writeFile('public/raw-shows.json', JSON.stringify({ error: e.message }, null, 2), 'utf8').catch(()=>{});
  }
  await page.close();

  // 2) Enrich each show page for clean title/thumb/start
  const enriched = await enrich(browser, base, 80);

  // 3) Dedupe + sort (soonest first; undated after)
  const seen = new Set();
  const final = enriched.filter(e => {
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

  // 4) Write feed + tiny debug index
  await fs.writeFile('public/schedule.json', JSON.stringify(final, null, 2), 'utf8');
  await fs.writeFile('public/index.html',
    `<!doctype html><meta charset="utf-8">
     <body style="background:#0b0b0b;color:#fff;font:16px/1.5 system-ui;padding:24px">
     <h1>BazookaVault Shows (${final.length} items)</h1>
     <p><a style="color:#ED67A1" href="schedule.json">schedule.json</a></p>
     <ul>
       <li><a style="color:#ED67A1" href="debug-shows.html">debug shows html</a> |
           <a style="color:#ED67A1" href="raw-shows.json">raw shows json</a> |
           <a style="color:#ED67A1" href="debug-shows.png">shows screenshot</a></li>
     </ul>`,
    'utf8');

  await browser.close();
})().catch(async (err) => {
  console.error('SCRAPER ERROR:', err && err.stack ? err.stack : err);
  try{
    await fs.mkdir('public', { recursive: true });
    await fs.writeFile('public/schedule.json', '[]', 'utf8');
    await fs.writeFile('public/index.html',
      '<!doctype html><meta charset="utf-8"><body style="background:#0b0b0b;color:#fff;font:16px system-ui;padding:24px"><h1>Scraper error</h1><p>See Actions logs for details.</p>',
      'utf8');
  }catch{}
});
