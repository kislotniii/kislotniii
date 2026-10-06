import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '@kontrastyepox';
const CHANNEL_URL = process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/kontrastyepox';
const FEED_PATH = new URL('../feed.xml', import.meta.url);
const STATE_PATH = new URL('../telegram-state.json', import.meta.url);
const MAX_MESSAGE_CHARS = 3900;

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
    .replace(/<\/(p|div|h1|h2|h3|blockquote|figure|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
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

function stripDzenRecommendations(html = '') {
  return String(html).replace(
    /<a\b[^>]*href="https:\/\/dzen\.ru\/a\/[^"]+"[^>]*>[\s\S]*?<\/a>/gi,
    ''
  );
}

function extractTag(itemXml, tag) {
  const cdata = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return cdata[1];
  const plain = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return plain ? decodeXml(plain[1].trim()) : '';
}

async function telegram(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function verifyTelegramAccess() {
  const me = await telegram('getMe');
  const member = await telegram('getChatMember', { chat_id: CHAT_ID, user_id: me.id });
  const allowedStatus = member?.status === 'administrator' || member?.status === 'creator';
  const canPost = member?.status === 'creator' || member?.can_post_messages !== false;
  if (!allowedStatus || !canPost) {
    throw new Error(`Bot @${me.username || me.id} cannot publish to ${CHAT_ID}. Status: ${member?.status || 'unknown'}, can_post_messages: ${member?.can_post_messages}`);
  }
  console.log(`Telegram access verified: @${me.username || me.id} -> ${CHAT_ID} (${member.status})`);
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
  const image = item.match(/<media:content[^>]*url="([^"]+)"/i)?.[1]
    || item.match(/<media:thumbnail[^>]*url="([^"]+)"/i)?.[1]
    || item.match(/<enclosure[^>]*url="([^"]+)"/i)?.[1]
    || description.match(/<img[^>]*src="([^"]+)"/i)?.[1]
    || '';

  return { title, link, description, image: decodeXml(image) };
}

function cleanArticleBody(article) {
  let body = decodeHtml(stripDzenRecommendations(article.description)).trim();
  if (body.startsWith(article.title)) {
    body = body.slice(article.title.length).trim();
  }
  return body;
}

function splitLongParagraph(text, maxLen) {
  const pieces = [];
  let rest = text.trim();
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut < Math.floor(maxLen * 0.65)) cut = maxLen;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function splitText(text, maxLen = MAX_MESSAGE_CHARS) {
  const paragraphs = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > maxLen ? splitLongParagraph(paragraph, maxLen) : [paragraph];
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (candidate.length <= maxLen) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function buildTextMessages(article) {
  const body = cleanArticleBody(article);
  const ctaPlain = 'Подписывайтесь, чтобы не потерять КОНТРАСТЫ ЭПОХ';
  const chunks = splitText(body, MAX_MESSAGE_CHARS - 250);

  return chunks.map((chunk, index) => {
    const continuation = index === 0 ? '' : `Продолжение ${index + 1}/${chunks.length}\n\n`;
    const cta = index === chunks.length - 1
      ? `\n\nПодписывайтесь, чтобы не потерять <a href="${CHANNEL_URL}">КОНТРАСТЫ ЭПОХ</a>`
      : '';
    const plainLength = continuation.length + chunk.length + (index === chunks.length - 1 ? ctaPlain.length + 2 : 0);
    if (plainLength > 4096) throw new Error(`Telegram message is too long: ${plainLength}`);
    return `${escapeHtml(continuation)}${escapeHtml(chunk)}${cta}`;
  });
}

async function sendCover(article) {
  const endpoint = `https://api.telegram.org/bot${TOKEN}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', `<b>${escapeHtml(article.title)}</b>`);
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

async function sendFullArticle(article) {
  if (article.image) {
    await sendCover(article);
  } else {
    await telegram('sendMessage', {
      chat_id: CHAT_ID,
      text: `<b>${escapeHtml(article.title)}</b>`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  const messages = buildTextMessages(article);
  for (const message of messages) {
    await telegram('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  console.log(`Telegram full article sent in ${messages.length + 1} message(s).`);
}

async function main() {
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured in GitHub Actions secrets.');

  await verifyTelegramAccess();

  const xml = await fs.readFile(FEED_PATH, 'utf8');
  const article = parseFeed(xml);
  if (!article?.link) {
    console.log('No RSS item available for Telegram.');
    return;
  }

  const state = await loadTelegramState();
  if (state.lastPublishedUrl === article.link) {
    console.log(`Telegram already published/seeded: ${article.link}`);
    return;
  }

  await sendFullArticle(article);

  await saveTelegramState(article.link);
  console.log(`Published full article to Telegram ${CHAT_ID}: ${article.title}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
