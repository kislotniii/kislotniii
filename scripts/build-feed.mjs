import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const CHANNEL_NAME = 'kodistori1';
const CHANNEL_URL = `https://dzen.ru/${CHANNEL_NAME}`;
const FEED_URL = 'https://raw.githubusercontent.com/kislotniii/kislotniii/main/feed.xml';
const API_URL = `https://dzen.ru/api/v3/launcher/more?channel_name=${encodeURIComponent(CHANNEL_NAME)}`;
const BRIDGE_URL = `https://rss.mabinsight.co.uk/?action=display&bridge=YandexZenBridge&channelURL=${encodeURIComponent(CHANNEL_URL)}&limit=20&format=Atom`;
const STATE_PATH = new URL('../state.json', import.meta.url);
const FEED_PATH = new URL('../feed.xml', import.meta.url);
const MAX_FEED_ITEMS = 20;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    const keep = new URLSearchParams();
    for (const [key, val] of url.searchParams) {
      if (!/^utm_/i.test(key) && !/^share_/i.test(key)) keep.append(key, val);
    }
    url.search = keep.toString();
    return url.toString();
  } catch {
    return value;
  }
}

function isArticleUrl(url) {
  return /^https?:\/\/(?:www\.)?dzen\.ru\/a\//i.test(url || '');
}

function decodeXml(text = '') {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(text = '') {
  return decodeXml(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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

function absoluteUrl(value, base) {
  if (!value) return '';
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7',
      referer: CHANNEL_URL,
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function listFromDzenApi() {
  const payload = await fetchJson(API_URL);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map((post) => ({
      url: normalizeUrl(post?.share_link),
      title: String(post?.title || '').trim(),
      publishedAt: post?.publication_date ? new Date(Number(post.publication_date) * 1000).toISOString() : new Date().toISOString(),
      image: absoluteUrl(post?.image || '', CHANNEL_URL),
      summary: String(post?.text || '').trim(),
    }))
    .filter((item) => isArticleUrl(item.url));
}

async function listFromRssBridge() {
  const response = await fetch(BRIDGE_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml,application/xml,text/xml,*/*' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for RSS-Bridge`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const getTag = (entry, name) => {
    const match = entry.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return match ? decodeXml(match[1]).trim() : '';
  };

  return entries
    .map((entry) => {
      const linkMatch = entry.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)
        || entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
      const content = getTag(entry, 'content');
      const imageMatch = content.match(/<img\b[^>]*src=["']([^"']+)["']/i);
      return {
        url: normalizeUrl(decodeXml(linkMatch?.[1] || '')),
        title: stripTags(getTag(entry, 'title')),
        publishedAt: getTag(entry, 'published') || getTag(entry, 'updated') || new Date().toISOString(),
        image: absoluteUrl(decodeXml(imageMatch?.[1] || ''), CHANNEL_URL),
        summary: stripTags(content),
      };
    })
    .filter((item) => isArticleUrl(item.url));
}

async function listArticles() {
  try {
    const items = await listFromDzenApi();
    if (items.length) {
      console.log(`Dzen API: ${items.length} article(s)`);
      return items;
    }
    throw new Error('Dzen API returned no article links');
  } catch (error) {
    console.warn(`Dzen API failed: ${error.message}. Falling back to RSS-Bridge.`);
    const items = await listFromRssBridge();
    if (!items.length) throw new Error('RSS-Bridge returned no article links');
    console.log(`RSS-Bridge: ${items.length} article(s)`);
    return items;
  }
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

async function scrapeArticle(browser, item) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7' });
  const selectors = [
    'article [class*="article-render"]',
    '[class*="article__content"]',
    '[class*="article-render"]',
    'article',
    'main',
  ];

  try {
    console.log(`Scraping: ${item.url}`);
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(selectors.join(', '), { timeout: 35_000 });
    await sleep(2_000);

    const rootInfo = await page.evaluate((contentSelectors) => {
      const root = contentSelectors.map((selector) => document.querySelector(selector)).find(Boolean);
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      return { top: Math.max(0, rect.top + window.scrollY), height: Math.max(rect.height, root.scrollHeight || 0) };
    }, selectors);

    if (rootInfo) {
      const end = Math.min(rootInfo.top + rootInfo.height + 1200, rootInfo.top + 40_000);
      for (let y = rootInfo.top; y < end; y += 1100) {
        await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
        await sleep(120);
      }
      await sleep(700);
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    const extracted = await page.evaluate((contentSelectors) => {
      const root = contentSelectors.map((selector) => document.querySelector(selector)).find(Boolean);
      if (!root) return null;

      for (const img of root.querySelectorAll('img')) {
        const lazy = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
        const src = img.currentSrc || img.getAttribute('src') || lazy || '';
        if (src) {
          try { img.setAttribute('src', new URL(src, location.href).href); } catch {}
        }
      }

      const clone = root.cloneNode(true);
      const removeSelectors = [
        'script', 'style', 'button', 'svg', 'iframe', 'nav', 'aside', 'form',
        '[class*="reaction"]', '[class*="share"]', '[class*="subscribe"]',
        '[class*="comment"]', '[class*="recommend"]', '[class*="related"]',
        '[class*="footer"]', '[class*="controls"]', '[data-testid*="reaction"]',
      ];
      for (const selector of removeSelectors) {
        for (const node of clone.querySelectorAll(selector)) node.remove();
      }

      for (const img of clone.querySelectorAll('img')) {
        const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
        if (!src || src.startsWith('data:')) {
          img.remove();
          continue;
        }
        try { img.setAttribute('src', new URL(src, location.href).href); } catch { img.remove(); continue; }
        const alt = img.getAttribute('alt') || '';
        for (const attr of [...img.attributes]) {
          if (!['src', 'alt', 'title'].includes(attr.name)) img.removeAttribute(attr.name);
        }
        img.setAttribute('alt', alt);
      }

      for (const link of clone.querySelectorAll('a')) {
        const href = link.getAttribute('href') || '';
        try { link.setAttribute('href', new URL(href, location.href).href); } catch { link.removeAttribute('href'); }
        for (const attr of [...link.attributes]) {
          if (!['href', 'title'].includes(attr.name)) link.removeAttribute(attr.name);
        }
      }

      for (const node of clone.querySelectorAll('*')) {
        if (node.tagName === 'IMG' || node.tagName === 'A') continue;
        for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      }

      for (const node of [...clone.querySelectorAll('div, span')]) {
        if (!node.textContent?.trim() && !node.querySelector('img, br')) node.remove();
      }

      const title = document.querySelector('h1')?.textContent?.trim() || document.title?.trim() || '';
      const html = clone.innerHTML.trim();
      const text = clone.textContent?.replace(/\s+/g, ' ').trim() || '';
      return { title, html, text, imageCount: clone.querySelectorAll('img').length };
    }, selectors);

    if (!extracted?.html || extracted.text.length < 500) {
      throw new Error(`Article extraction looks incomplete (${extracted?.text?.length || 0} text chars)`);
    }

    let html = extracted.html;
    if (extracted.imageCount === 0 && item.image) {
      html = `<figure><img src="${xmlEscape(item.image)}" alt=""></figure>\n${html}`;
    }

    return {
      url: item.url,
      title: extracted.title && extracted.title.length < 300 ? extracted.title : item.title,
      publishedAt: item.publishedAt,
      image: item.image,
      html,
      excerpt: extracted.text.slice(0, 600),
    };
  } finally {
    await page.close();
  }
}

function buildFeed(items) {
  const lastBuild = new Date().toUTCString();
  const itemXml = items
    .slice()
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .map((item) => {
      const date = Number.isNaN(Date.parse(item.publishedAt)) ? new Date() : new Date(item.publishedAt);
      const media = item.image ? `\n      <media:content url="${xmlEscape(item.image)}" medium="image" />` : '';
      return `    <item>\n      <title>${xmlEscape(item.title)}</title>\n      <link>${xmlEscape(item.url)}</link>\n      <guid isPermaLink="true">${xmlEscape(item.url)}</guid>\n      <pubDate>${date.toUTCString()}</pubDate>\n      <description>${cdata(item.html)}</description>\n      <content:encoded>${cdata(item.html)}</content:encoded>${media}\n    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"\n  xmlns:content="http://purl.org/rss/1.0/modules/content/"\n  xmlns:media="http://search.yahoo.com/mrss/"\n  xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>КОНТРАСТЫ ЭПОХ — Дзен</title>\n    <link>${xmlEscape(CHANNEL_URL)}</link>\n    <description>Полные статьи канала «КОНТРАСТЫ ЭПОХ» для импорта в VK.</description>\n    <language>ru</language>\n    <lastBuildDate>${lastBuild}</lastBuildDate>\n    <atom:link href="${xmlEscape(FEED_URL)}" rel="self" type="application/rss+xml" />\n${itemXml}\n  </channel>\n</rss>\n`;
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
  state.seen = [...new Set(state.seen.map(normalizeUrl))].slice(-500);
  state.items = state.items
    .filter((item, index, array) => array.findIndex((candidate) => candidate.url === item.url) === index)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MAX_FEED_ITEMS);
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.writeFile(FEED_PATH, buildFeed(state.items), 'utf8');
}

async function main() {
  const state = await loadState();
  const current = await listArticles();
  const currentUrls = current.map((item) => item.url);

  if (!state.initialized) {
    state.initialized = true;
    state.seen = currentUrls;
    state.items = [];
    await save(state);
    console.log(`Bootstrap complete. Seeded ${currentUrls.length} existing article(s); feed stays empty until the next new article.`);
    return;
  }

  const seen = new Set(state.seen);
  const newItems = current
    .filter((item) => !seen.has(item.url))
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  if (!newItems.length) {
    console.log('No new Dzen articles.');
    return;
  }

  const executablePath = await findChrome();
  console.log(`Using browser: ${executablePath}`);
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=ru-RU',
    ],
  });

  const successful = [];
  try {
    for (const item of newItems) {
      try {
        successful.push(await scrapeArticle(browser, item));
      } catch (error) {
        console.error(`Could not extract ${item.url}: ${error.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  if (!successful.length) {
    throw new Error(`Detected ${newItems.length} new article(s), but none could be extracted. Nothing was marked as seen.`);
  }

  state.items = [...successful, ...state.items];
  state.seen.push(...successful.map((item) => item.url));
  const failedNew = new Set(newItems.filter((item) => !successful.some((ok) => ok.url === item.url)).map((item) => item.url));
  for (const url of currentUrls) if (!failedNew.has(url)) state.seen.push(url);
  await save(state);
  console.log(`Added ${successful.length} new article(s) to feed.xml.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
