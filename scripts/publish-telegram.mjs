import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '@kontrastyepox';
const FEED_PATH = new URL('../feed.xml', import.meta.url);
const STATE_PATH = new URL('../telegram-state.json', import.meta.url);

function decodeXml(text = '') {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function decodeHtml(text = '') {
  return String(text)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|blockquote|figure)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractTag(itemXml, tag) {
  const cdata = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return cdata[1];
  const plain = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return plain ? decodeXml(plain[1].trim()) : '';
}

async function loadTelegramState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    return { lastPublishedUrl: '' };
  }
}

async function saveTelegramState(url) {
  await fs.writeFile(STATE_PATH, `${JSON.stringify({ lastPublishedUrl: url }, null, 2)}\n`, 'utf8');
}

function parseFeed(xml) {
  const item = xml.match(/<item>([\s\S]*?)<\/item>/i)?.[1] || '';
  if (!item) return null;
  const title = extractTag(item, 'title');
  const link = extractTag(item, 'link');
  const description = extractTag(item, 'description') || extractTag(item, 'content:encoded');
  const media = item.match(/<media:content[^>]*url="([^"]+)"/i)?.[1]
    || item.match(/<media:thumbnail[^>]*url="([^"]+)"/i)?.[1]
    || item.match(/<enclosure[^>]*url="([^"]+)"/i)?.[1]
    || description.match(/<img[^>]*src="([^"]+)"/i)?.[1]
    || '';
  return { title, link, description, image: decodeXml(media) };
}

function buildCaption(title, description, link) {
  const text = decodeHtml(description)
    .replace(title, '')
    .trim();
  const excerpt = text.length > 620 ? `${text.slice(0, 617).trimEnd()}…` : text;
  return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(excerpt)}\n\n<a href="${escapeHtml(link)}">Читать полностью в Дзене</a>`;
}

async function sendPhotoPost(article) {
  const caption = buildCaption(article.title, article.description, article.link);
  const endpoint = `https://api.telegram.org/bot${TOKEN}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');

  const rawPrefix = 'https://raw.githubusercontent.com/kislotniii/kislotniii/main/';
  if (article.image.startsWith(rawPrefix)) {
    const relative = article.image.slice(rawPrefix.length);
    try {
      const bytes = await fs.readFile(new URL(`../${relative}`, import.meta.url));
      const ext = path.extname(relative).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      form.append('photo', new Blob([bytes], { type }), path.basename(relative));
    } catch {
      form.append('photo', article.image);
    }
  } else {
    form.append('photo', article.image);
  }

  const response = await fetch(endpoint, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto failed: ${response.status} ${JSON.stringify(data)}`);
  }
}

async function sendTextPost(article) {
  const endpoint = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: buildCaption(article.title, article.description, article.link),
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${JSON.stringify(data)}`);
  }
}

async function main() {
  if (!TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN is not configured; Telegram publishing skipped.');
    return;
  }

  const xml = await fs.readFile(FEED_PATH, 'utf8');
  const article = parseFeed(xml);
  if (!article?.link) {
    console.log('No RSS item available for Telegram.');
    return;
  }

  const state = await loadTelegramState();
  if (state.lastPublishedUrl === article.link) {
    console.log(`Telegram already published: ${article.link}`);
    return;
  }

  if (article.image) await sendPhotoPost(article);
  else await sendTextPost(article);

  await saveTelegramState(article.link);
  console.log(`Published to Telegram ${CHAT_ID}: ${article.title}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
