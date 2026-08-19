import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const CHANNEL_URL = 'https://dzen.ru/kodistori1';
const FEED_URL = 'https://raw.githubusercontent.com/kislotniii/kislotniii/main/feed.xml';
const STATE_PATH = new URL('../state.json', import.meta.url);
const FEED_PATH = new URL('../feed.xml', import.meta.url);
const MAX_FEED_ITEMS = 20;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, CHANNEL_URL);
    url.hash = '';

    // A Dzen article has a stable identity in its /a/<id> pathname.
    // The query string contains volatile feed/session parameters (rid, secdata,
    // integration, place, etc.) that must not make the same article look new.
    if (/^(?:www\.)?dzen\.ru$/i.test(url.hostname) && /^\/a\//i.test(url.pathname)) {
      return `${url.protocol}//${url.hostname}${url.pathname}`;
    }

    const keep = new URLSearchParams();
    for (const [key, val] of url.searchParams) {
      if (!/^utm_/i.test(key) && !/^share_/i.test(key)) keep.append(key, val);
    }
    url.search = keep.toString();
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
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`Chrome/Chromium not found. Checked: ${candidates.join(', ')}`);
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
      await page.evaluate((y) => window.scrollTo(0, y), i * 1100);
      await sleep(350);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    const rows = await page.evaluate(() => {
      const articleCards = [
        ...document.querySelectorAll('[class*="channel--card-article__cardWrapper"]'),
        ...document.querySelectorAll('[class*="card-article"]'),
      ];

      const result = [];
      const addFromCard = (card) => {
        const anchors = [...card.querySelectorAll('a[href]')];
        const anchor = anchors.find((a) => /\/a\//.test(a.getAttribute('href') || ''))
          || anchors.find((a) => /titleLink/i.test(a.className || ''))
          || anchors.find((a) => (a.textContent || '').trim().length > 20)
          || anchors[0];
        if (!anchor) return;
        let href = anchor.href || anchor.getAttribute('href') || '';
        if (!href) return;
        try { href = new URL(href, location.href).href; } catch {}
        const title = (anchor.textContent || card.querySelector('h1,h2,h3')?.textContent || '').replace(/\s+/g, ' ').trim();
        const img = card.querySelector('img');
        const image = img ? (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
        const meta = [...card.querySelectorAll('span, time')].map((n) => (n.textContent || '').trim()).filter(Boolean).join(' · ');
        result.push({ href, title, image, meta });
      };

      for (const card of articleCards) addFromCard(card);

      if (!result.length) {
        for (const a of document.querySelectorAll('a[href*="/a/"]')) {
          const href = a.href || a.getAttribute('href') || '';
          const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
          const card = a.closest('article, [class*="card"], [class*="publication"]');
          const img = card?.querySelector('img');
          const image = img ? (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
          result.push({ href, title, image, meta: '' });
        }
      }
      return result;
    });

    const dedup = new Map();
    for (const row of rows) {
      const url = normalizeUrl(row.href);
      if (!url || !/^https?:\/\/(?:www\.)?dzen\.ru\/a\//i.test(url)) continue;
      if (!dedup.has(url)) {
        dedup.set(url, {
          url,
          title: row.title || 'Статья',
          image: normalizeUrl(row.image),
          publishedAt: new Date().toISOString(),
          meta: row.meta || '',
        });
      }
    }

    const items = [...dedup.values()];
    console.log(`Channel page: found ${items.length} candidate article link(s)`);
    if (!items.length) {
      const debug = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        anchors: document.querySelectorAll('a[href]').length,
        articleCards: document.querySelectorAll('[class*="article"]').length,
        bodyText: document.body?.innerText?.slice(0, 1200) || '',
      }));
      console.log('Channel debug:', JSON.stringify(debug));
      throw new Error('No article links found on channel page');
    }
    return items;
  } finally {
    await page.close();
  }
}

async function scrapeArticle(browser, item) {
  const page = await openPage(browser, item.url);
  const selectors = [
    'article [class*="article-render"]',
    '[class*="article__content"]',
    '[class*="article-render"]',
    'article',
    'main',
  ];

  try {
    await page.waitForSelector(selectors.join(', '), { timeout: 35_000 });
    const rootInfo = await page.evaluate((contentSelectors) => {
      const root = contentSelectors.map((s) => document.querySelector(s)).find(Boolean);
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      return { top: Math.max(0, rect.top + scrollY), height: Math.max(rect.height, root.scrollHeight || 0) };
    }, selectors);

    if (rootInfo) {
      const end = Math.min(rootInfo.top + rootInfo.height + 1500, rootInfo.top + 45_000);
      for (let y = rootInfo.top; y < end; y += 1000) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await sleep(140);
      }
      await sleep(900);
    }

    const extracted = await page.evaluate((contentSelectors) => {
      const root = contentSelectors.map((s) => document.querySelector(s)).find(Boolean);
      if (!root) return null;

      const clone = root.cloneNode(true);
      for (const selector of [
        'script','style','button','svg','iframe','nav','aside','form',
        '[class*="reaction"]','[class*="share"]','[class*="subscribe"]',
        '[class*="comment"]','[class*="recommend"]','[class*="related"]',
        '[class*="footer"]','[class*="controls"]'
      ]) {
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

    if (!extracted?.html || extracted.text.length < 500) {
      throw new Error(`Article extraction incomplete: ${extracted?.text?.length || 0} chars`);
    }

    return {
      url: normalizeUrl(item.url),
      title: extracted.title && extracted.title.length < 300 ? extracted.title : item.title,
      publishedAt: item.publishedAt || new Date().toISOString(),
      image: normalizeUrl(extracted.firstImage || item.image || ''),
      html: extracted.html,
    };
  } finally {
    await page.close();
  }
}

function buildFeed(items) {
  const itemXml = items
    .slice()
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .map((item) => {
      const date = Number.isNaN(Date.parse(item.publishedAt)) ? new Date() : new Date(item.publishedAt);
      const media = item.image ? `\n      <media:content url="${xmlEscape(item.image)}" medium="image" />` : '';
      return `    <item>\n      <title>${xmlEscape(item.title)}</title>\n      <link>${xmlEscape(item.url)}</link>\n      <guid isPermaLink="true">${xmlEscape(item.url)}</guid>\n      <pubDate>${date.toUTCString()}</pubDate>\n      <description>${cdata(item.html)}</description>\n      <content:encoded>${cdata(item.html)}</content:encoded>${media}\n    </item>`;
    }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>КОНТРАСТЫ ЭПОХ — Дзен</title>\n    <link>${xmlEscape(CHANNEL_URL)}</link>\n    <description>Полные статьи канала «КОНТРАСТЫ ЭПОХ» для импорта в VK.</description>\n    <language>ru</language>\n    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n    <atom:link href="${xmlEscape(FEED_URL)}" rel="self" type="application/rss+xml" />\n${itemXml}\n  </channel>\n</rss>\n`;
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    return {
      initialized: Boolean(state.initialized),
      seen: Array.isArray(state.seen) ? state.seen.map(normalizeUrl) : [],
      items: Array.isArray(state.items) ? state.items : [],
    };
  } catch {
    return { initialized: false, seen: [], items: [] };
  }
}

async function save(state) {
  state.seen = [...new Set(state.seen.map(normalizeUrl).filter(Boolean))].slice(-500);
  state.items = state.items
    .filter((item, index, all) => all.findIndex((x) => normalizeUrl(x.url) === normalizeUrl(item.url)) === index)
    .slice(0, MAX_FEED_ITEMS);
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.writeFile(FEED_PATH, buildFeed(state.items), 'utf8');
}

async function main() {
  const executablePath = await findChrome();
  console.log(`Using browser: ${executablePath}`);
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  try {
    const state = await loadState();
    const current = await listArticlesFromChannel(browser);
    const currentUrls = current.map((x) => normalizeUrl(x.url));

    if (!state.initialized) {
      state.initialized = true;
      state.seen = currentUrls;
      state.items = [];
      await save(state);
      console.log(`Bootstrap complete: seeded ${currentUrls.length} existing article(s).`);
      return;
    }

    const seen = new Set(state.seen.map(normalizeUrl));
    const fresh = current.filter((item) => !seen.has(normalizeUrl(item.url)));
    console.log(`New article(s): ${fresh.length}`);

    for (const item of fresh.reverse()) {
      try {
        const full = await scrapeArticle(browser, item);
        state.items.unshift(full);
        state.seen.push(normalizeUrl(item.url));
        console.log(`Added: ${full.title}`);
      } catch (error) {
        console.error(`Failed to scrape ${item.url}: ${error.message}`);
      }
    }

    for (const url of currentUrls) if (!state.seen.includes(url)) state.seen.push(url);
    await save(state);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});