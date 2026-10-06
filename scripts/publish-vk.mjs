import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = process.env.VK_ACCESS_TOKEN || '';
const PHOTO_TOKEN = process.env.VK_USER_ACCESS_TOKEN || '';
const GROUP_ID = String(process.env.VK_GROUP_ID || '240532552').replace(/^-/,'');
const API_VERSION = process.env.VK_API_VERSION || '5.199';
const FEED_PATH = new URL('../feed.xml', import.meta.url);
const STATE_PATH = new URL('../vk-state.json', import.meta.url);
const MAX_POST_CHARS = 14000;
const MAX_PHOTOS = 10;
const BODY_CHUNK_CHARS = 13200;

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

function extractTag(itemXml, tag) {
  const cdata = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return cdata[1];
  const plain = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return plain ? decodeXml(plain[1].trim()) : '';
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
    || '';

  const images = [];
  if (media) images.push(decodeXml(media));
  for (const match of description.matchAll(/<img[^>]*src="([^"]+)"/gi)) {
    const url = decodeXml(match[1]);
    if (url && !images.includes(url)) images.push(url);
  }

  return { title, link, description, images };
}

function stripDzenRecommendations(html = '') {
  return String(html).replace(
    /<a\b[^>]*href="https:\/\/dzen\.ru\/a\/[^"]+"[^>]*>[\s\S]*?<\/a>/gi,
    ''
  );
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

function splitBody(body, maxLen = BODY_CHUNK_CHARS) {
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
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

function buildMessages(article) {
  const body = cleanArticleBody(article);
  const chunks = splitBody(body);

  return chunks.map((chunk, index) => {
    const continuation = index === 0 ? '' : `Продолжение ${index + 1}/${chunks.length}\n\n`;
    const message = `${article.title}\n\n${continuation}${chunk}`.trim();
    if (message.length > MAX_POST_CHARS) {
      throw new Error(`VK message chunk is too long: ${message.length} chars`);
    }
    return message;
  });
}

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_PATH, 'utf8')); }
  catch { return { lastPublishedUrl: '' }; }
}

async function saveState(url, postIds = []) {
  await fs.writeFile(
    STATE_PATH,
    `${JSON.stringify({ lastPublishedUrl: url, lastPostIds: postIds }, null, 2)}\n`,
    'utf8'
  );
}

async function vk(method, params = {}, accessToken = TOKEN) {
  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k,v]) => [k, String(v)])),
    access_token: accessToken,
    v: API_VERSION,
  });

  const response = await fetch(`https://api.vk.com/method/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error(`${method} failed: ${response.status} ${JSON.stringify(data.error || data)}`);
    error.vkError = data.error || null;
    throw error;
  }
  return data.response;
}

async function imageBytes(imageUrl) {
  const rawPrefix = 'https://raw.githubusercontent.com/kislotniii/kislotniii/main/';
  if (imageUrl.startsWith(rawPrefix)) {
    const relative = imageUrl.slice(rawPrefix.length);
    try {
      const bytes = await fs.readFile(new URL(`../${relative}`, import.meta.url));
      const ext = path.extname(relative).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      return { bytes, type, name: path.basename(relative) || 'image.jpg' };
    } catch {}
  }

  const response = await fetch(imageUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') || 'image/jpeg';
  const ext = /png/i.test(type) ? '.png' : /webp/i.test(type) ? '.webp' : /gif/i.test(type) ? '.gif' : '.jpg';
  return { bytes, type, name: `image${ext}` };
}

async function uploadToServer(uploadUrl, imageUrl) {
  const image = await imageBytes(imageUrl);
  const form = new FormData();
  form.append('photo', new Blob([image.bytes], { type: image.type }), image.name);

  const response = await fetch(uploadUrl, { method: 'POST', body: form });
  const uploaded = await response.json().catch(() => ({}));

  if (!response.ok || !uploaded.server || !uploaded.photo || !uploaded.hash) {
    throw new Error(`VK image upload failed: ${response.status} ${JSON.stringify(uploaded)}`);
  }
  return uploaded;
}

function photoAttachment(photo) {
  if (!photo?.owner_id || !photo?.id) {
    throw new Error(`VK did not return a saved photo: ${JSON.stringify(photo)}`);
  }
  return `photo${photo.owner_id}_${photo.id}${photo.access_key ? `_${photo.access_key}` : ''}`;
}

async function uploadWallPhoto(imageUrl) {
  const upload = await vk('photos.getWallUploadServer', { group_id: GROUP_ID }, PHOTO_TOKEN);
  if (!upload?.upload_url) throw new Error('VK did not return wall upload URL');

  const uploaded = await uploadToServer(upload.upload_url, imageUrl);
  const saved = await vk('photos.saveWallPhoto', {
    group_id: GROUP_ID,
    server: uploaded.server,
    photo: uploaded.photo,
    hash: uploaded.hash,
  }, PHOTO_TOKEN);

  return photoAttachment(Array.isArray(saved) ? saved[0] : null);
}

async function imageAttachment(imageUrl) {
  if (!PHOTO_TOKEN) {
    throw new Error('VK_USER_ACCESS_TOKEN is not configured; refusing to publish VK without visible wall photos.');
  }
  const attachment = await uploadWallPhoto(imageUrl);
  console.log('VK image attached via wall photo upload using user token.');
  return attachment;
}

async function uploadArticleImages(urls) {
  if (!urls.length) throw new Error('No images found in the article; refusing to publish VK post without photo.');

  const attachments = [];
  for (const [index, url] of urls.slice(0, MAX_PHOTOS).entries()) {
    try {
      attachments.push(await imageAttachment(url));
    } catch (error) {
      if (index === 0) throw error;
      console.warn(`Skipping additional VK image ${index + 1}: ${error.message}`);
    }
  }

  if (!attachments.length) throw new Error('Could not upload the article cover to VK.');
  return attachments;
}

async function main() {
  if (!TOKEN) {
    console.log('VK_ACCESS_TOKEN is not configured; VK direct publishing skipped.');
    return;
  }
  if (!PHOTO_TOKEN) {
    throw new Error('VK_USER_ACCESS_TOKEN is not configured; refusing to publish VK without visible photos.');
  }

  const xml = await fs.readFile(FEED_PATH, 'utf8');
  const article = parseFeed(xml);
  if (!article?.link) {
    console.log('No RSS item available for VK direct publishing.');
    return;
  }

  const state = await loadState();
  if (state.lastPublishedUrl === article.link) {
    console.log(`VK already published: ${article.link}`);
    return;
  }

  const messages = buildMessages(article);
  const attachments = await uploadArticleImages(article.images);
  const postIds = [];

  for (let index = 0; index < messages.length; index++) {
    const guid = crypto
      .createHash('sha256')
      .update(`dzen-vk-full:${article.link}:${index}`)
      .digest('hex')
      .slice(0, 32);

    const result = await vk('wall.post', {
      owner_id: `-${GROUP_ID}`,
      from_group: 1,
      message: messages[index],
      attachments: index === 0 ? attachments.join(',') : '',
      guid,
    });

    postIds.push(result?.post_id ?? null);
    console.log(`Published VK full post part ${index + 1}/${messages.length}: ${article.title}`);
  }

  await saveState(article.link, postIds);
  console.log(`Published full Dzen article to VK in ${messages.length} post(s), with ${attachments.length} image(s).`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
