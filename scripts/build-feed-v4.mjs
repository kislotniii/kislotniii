import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const CHANNEL_URL = 'https://dzen.ru/kodistori1';
const FEED_URL = 'https://raw.githubusercontent.com/kislotniii/kislotniii/main/feed.xml';
const STATE_PATH = new URL('../state.json', import.meta.url);
const FEED_PATH = new URL('../feed.xml', import.meta.url);
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, CHANNEL_URL);
    url.hash = '';
    if (/^(?:www\.)?dzen\.ru$/i.test(url.hostname) && /^\/a\//i.test(url.pathname)) {
      return `${url.protocol}//${url.hostname}${url.pathname}`;
    }
    return url.toString();
  } catch {
    return String(value || '');
  }
}

function xmlEscape(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(text = '') {
  return `<![CDATA[${String(text).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

async function findChrome() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error('Chrome/Chromium not found');
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(3500);
  return page;
}

async function listArticlesFromChannel(browser) {
  const page = await openPage(browser, CHANNEL_URL);
  try {
    for (let i = 0; i < 7; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), i * 1000);
      await sleep(300);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    const rows = await page.evaluate(() => {
      const result = [];
      const anchors = [...document.querySelectorAll('a[href*="/a/"]')];
      for (const a of anchors) {
        const href = a.href || a.getAttribute('href') || '';
        const card = a.closest('article, [class*="card-article"], [class*="card"], [class*="publication"]');
        const title = (a.textContent || card?.querySelector('h1,h2,h3')?.textContent || '').replace(/\s+/g, ' ').trim();
        const img = card?.querySelector('img');
        const image = img ? (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
        result.push({ href, title, image });
      }
      return result;
    });

    const dedup = new Map();
    for (const row of rows) {
      const url = normalizeUrl(row.href);
      if (!/^https?:\/\/(?:www\.)?dzen\.ru\/a\//i.test(url)) continue;
      if (!dedup.has(url)) dedup.set(url, { url, title: row.title || 'Статья', image: row.image || '' });
    }

    const items = [...dedup.values()];
    console.log(`Channel page: found ${items.length} article(s)`);
    if (!items.length) throw new Error('No article links found on channel page');
    return items;
  } finally {
    await page.close();
  }
}

async function scrapeArticle(browser, item) {
  const page = await openPage(browser, item.url);
  const selectors = ['article [class*="article-render"]', '[class*="article__content"]', '[class*="article-render"]', 'article', 'main'];
  try {
    await page.waitForSelector(selectors.join(', '), { timeout: 35_000 });

    const publicationMeta = await page.evaluate(() => {
      const meta = document.querySelector('meta[property="article:published_time"], meta[name="article:published_time"], meta[itemprop="datePublished"]');
      const time = document.querySelector('time[datetime]');
      let jsonDate = '';
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent || '{}');
          const values = Array.isArray(data) ? data : [data];
          for (const value of values) {
            if (value?.datePublished) { jsonDate = value.datePublished; break; }
            if (Array.isArray(value?.['@graph'])) {
              const node = value['@graph'].find((x) => x?.datePublished);
              if (node?.datePublished) { jsonDate = node.datePublished; break; }
            }
          }
        } catch {}
        if (jsonDate) break;
      }
      return meta?.getAttribute('content') || time?.getAttribute('datetime') || jsonDate || '';
    });

    const rootInfo = await page.evaluate((contentSelectors) => {
      const root = contentSelectors.map((s) => document.querySelector(s)).find(Boolean);
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      return { top: Math.max(0, rect.top + scrollY), height: Math.max(rect.height, root.scrollHeight || 0) };
    }, selectors);

    if (rootInfo) {
      const end = Math.min(rootInfo.top + rootInfo.height + 1500, rootInfo.top + 45000);
      for (let y = rootInfo.top; y < end; y += 1000) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await sleep(130);
      }
      await sleep(900);
    }

    const extracted = await page.evaluate((contentSelectors) => {
      const root = contentSelectors.map((s) => document.querySelector(s)).find(Boolean);
      if (!root) return null;
      const clone = root.cloneNode(true);

      for (const selector of ['script','style','button','svg','iframe','nav','aside','form','[class*="reaction"]','[class*="share"]','[class*="subscribe"]','[class*="comment"]','[class*="recommend"]','[class*="related"]','[class*="footer"]','[class*="controls"]']) {
        for (const node of clone.querySelectorAll(selector)) node.remove();
      }

      for (const img of clone.querySelectorAll('img')) {
        const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
        if (!src || src.startsWith('data:')) { img.remove(); continue; }
        try { img.setAttribute('src', new URL(src, location.href).href); } catch { img.remove(); continue; }
        const alt = img.getAttribute('alt') || '';
        for (const attr of [...img.attributes]) if (!['src','alt','title'].includes(attr.name)) img.removeAttribute(attr.name);
        img.setAttribute('alt', alt);
      }

      for (const link of clone.querySelectorAll('a')) {
        const href = link.getAttribute('href') || '';
        try { link.setAttribute('href', new URL(href, location.href).href); } catch { link.removeAttribute('href'); }
        for (const attr of [...link.attributes]) if (!['href','title'].includes(attr.name)) link.removeAttribute(attr.name);
      }

      for (const node of clone.querySelectorAll('*')) {
        if (node.tagName === 'IMG' || node.tagName === 'A') continue;
        for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      }

      const title = document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() || document.title || '';
      const html = clone.innerHTML.trim();
      const text = clone.textContent?.replace(/\s+/g, ' ').trim() || '';
      const firstImage = clone.querySelector('img')?.getAttribute('src') || '';
      return { title, html, text, firstImage };
    }, selectors);

    if (!extracted?.html || extracted.text.length < 500) throw new Error(`Article extraction incomplete: ${extracted?.text?.length || 0} chars`);

    const image = extracted.firstImage || item.image || '';
    let fullHtml = extracted.html;
    if (image && !/^\s*<(?:figure|img)/i.test(fullHtml)) {
      fullHtml = `<figure><img src="${xmlEscape(image)}" alt=""></figure>\n${fullHtml}`;
    }

    let publishedAt = new Date().toISOString();
    if (publicationMeta && !Number.isNaN(Date.parse(publicationMeta))) publishedAt = new Date(publicationMeta).toISOString();

    return {
      url: normalizeUrl(item.url),
      title: extracted.title && extracted.title.length < 300 ? extracted.title : item.title,
      publishedAt,
      image,
      html: fullHtml,
    };
  } finally {
    await page.close();
  }
}

function buildFeed(item) {
  const itemXml = item ? (() => {
    const date = Number.isNaN(Date.parse(item.publishedAt)) ? new Date() : new Date(item.publishedAt);
    const image = item.image ? xmlEscape(item.image) : '';
    const media = image ? `\n      <media:content url="${image}" medium="image" type="image/jpeg" />\n      <media:thumbnail url="${image}" />\n      <enclosure url="${image}" length="0" type="image/jpeg" />` : '';
    return `    <item>\n      <title>${xmlEscape(item.title)}</title>\n      <link>${xmlEscape(item.url)}</link>\n      <guid isPermaLink="true">${xmlEscape(item.url)}</guid>\n      <pubDate>${date.toUTCString()}</pubDate>\n      <description>${cdata(item.html)}</description>\n      <content:encoded>${cdata(item.html)}</content:encoded>${media}\n    </item>`;
  })() : '';

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>КОНТРАСТЫ ЭПОХ — Дзен</title>\n    <link>${xmlEscape(CHANNEL_URL)}</link>\n    <description>Новая статья канала «КОНТРАСТЫ ЭПОХ» для импорта в VK.</description>\n    <language>ru</language>\n    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n    <atom:link href="${xmlEscape(FEED_URL)}" rel="self" type="application/rss+xml" />\n${itemXml}\n  </channel>\n</rss>\n`;
}

async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    return {
      initialized: Boolean(state.initialized),
      seen: Array.isArray(state.seen) ? [...new Set(state.seen.map(normalizeUrl).filter(Boolean))] : [],
      items: Array.isArray(state.items) ? state.items : [],
    };
  } catch {
    return { initialized: false, seen: [], items: [] };
  }
}

async function saveState(state, feedItem = null) {
  state.seen = [...new Set(state.seen.map(normalizeUrl).filter(Boolean))].slice(-500);
  state.items = feedItem ? [feedItem] : [];
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.writeFile(FEED_PATH, buildFeed(feedItem), 'utf8');
}

async function main() {
  const executablePath = await findChrome();
  console.log(`Using browser: ${executablePath}`);
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] });

  try {
    const state = await loadState();
    const current = await listArticlesFromChannel(browser);
    const currentUrls = current.map((x) => normalizeUrl(x.url));

    if (!state.initialized) {
      state.initialized = true;
      state.seen = currentUrls;
      await saveState(state, null);
      console.log(`Bootstrap complete: seeded ${currentUrls.length} existing article(s).`);
      return;
    }

    const seen = new Set(state.seen);
    const fresh = current.filter((item) => !seen.has(normalizeUrl(item.url)));
    console.log(`New article(s): ${fresh.length}`);

    if (!fresh.length) {
      // Keep only the already-exposed newest item in the feed; do not accumulate history.
      const currentFeedItem = state.items?.[0] || null;
      await saveState(state, currentFeedItem);
      return;
    }

    // The channel DOM is newest-first. If a transient mismatch ever makes several
    // items look new, expose only the newest one and mark the rest as seen. This
    // prevents VK from dumping a backlog all at once.
    const newest = fresh[0];
    const full = await scrapeArticle(browser, newest);
    state.seen.push(...fresh.map((x) => normalizeUrl(x.url)));
    await saveState(state, full);
    console.log(`Exposed exactly one new article: ${full.title} at ${full.publishedAt}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
