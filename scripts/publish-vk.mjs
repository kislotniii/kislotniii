import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = process.env.VK_ACCESS_TOKEN || '';
const GROUP_ID = String(process.env.VK_GROUP_ID || '240532552').replace(/^-/,'');
const API_VERSION = process.env.VK_API_VERSION || '5.199';
const FEED_PATH = new URL('../feed.xml', import.meta.url);
const STATE_PATH = new URL('../vk-state.json', import.meta.url);

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
  const image = item.match(/<media:content[^>]*url="([^"]+)"/i)?.[1]
    || item.match(/<media:thumbnail[^>]*url="([^"]+)"/i)?.[1]
    || item.match(/<enclosure[^>]*url="([^"]+)"/i)?.[1]
    || description.match(/<img[^>]*src="([^"]+)"/i)?.[1]
    || '';
  return { title, link, description, image: decodeXml(image) };
}

function buildMessage(article) {
  const text = decodeHtml(article.description).replace(article.title, '').trim();
  const excerpt = text.length > 700 ? `${text.slice(0, 697).trimEnd()}…` : text;
  return `${article.title}\n\n${excerpt}\n\nЧитать полностью в Дзене:\n${article.link}`;
}

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_PATH, 'utf8')); }
  catch { return { lastPublishedUrl: '' }; }
}

async function saveState(url, postId = null) {
  await fs.writeFile(STATE_PATH, `${JSON.stringify({ lastPublishedUrl: url, lastPostId: postId }, null, 2)}\n`, 'utf8');
}

async function vk(method, params = {}) {
  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k,v]) => [k, String(v)])),
    access_token: TOKEN,
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
      return { bytes, type, name: path.basename(relative) || 'cover.jpg' };
    } catch {}
  }

  const response = await fetch(imageUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') || 'image/jpeg';
  const ext = /png/i.test(type) ? '.png' : /webp/i.test(type) ? '.webp' : /gif/i.test(type) ? '.gif' : '.jpg';
  return { bytes, type, name: `cover${ext}` };
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
  if (!photo?.owner_id || !photo?.id) throw new Error(`VK did not return a saved photo: ${JSON.stringify(photo)}`);
  return `photo${photo.owner_id}_${photo.id}${photo.access_key ? `_${photo.access_key}` : ''}`;
}

async function uploadWallPhoto(imageUrl) {
  const upload = await vk('photos.getWallUploadServer', { group_id: GROUP_ID });
  if (!upload?.upload_url) throw new Error('VK did not return wall upload URL');
  const uploaded = await uploadToServer(upload.upload_url, imageUrl);
  const saved = await vk('photos.saveWallPhoto', {
    group_id: GROUP_ID,
    server: uploaded.server,
    photo: uploaded.photo,
    hash: uploaded.hash,
  });
  return photoAttachment(Array.isArray(saved) ? saved[0] : null);
}

async function uploadMessagesPhoto(imageUrl) {
  const upload = await vk('photos.getMessagesUploadServer', {});
  if (!upload?.upload_url) throw new Error('VK did not return messages upload URL');
  const uploaded = await uploadToServer(upload.upload_url, imageUrl);
  const saved = await vk('photos.saveMessagesPhoto', {
    server: uploaded.server,
    photo: uploaded.photo,
    hash: uploaded.hash,
  });
  return photoAttachment(Array.isArray(saved) ? saved[0] : null);
}

async function imageAttachment(imageUrl) {
  let wallError;
  try {
    const attachment = await uploadWallPhoto(imageUrl);
    console.log('VK image attached via wall photo upload.');
    return attachment;
  } catch (error) {
    wallError = error;
    console.warn(`Wall photo upload unavailable: ${error.message}`);
  }

  try {
    const attachment = await uploadMessagesPhoto(imageUrl);
    console.log('VK image attached via messages photo upload fallback.');
    return attachment;
  } catch (messagesError) {
    throw new Error(`VK photo attachment failed. Wall: ${wallError?.message || 'unknown'}; Messages: ${messagesError.message}`);
  }
}

async function main() {
  if (!TOKEN) {
    console.log('VK_ACCESS_TOKEN is not configured; VK direct publishing skipped.');
    return;
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

  if (!article.image) throw new Error(`No cover image found for ${article.link}; refusing to publish VK post without photo.`);
  const attachment = await imageAttachment(article.image);

  const guid = crypto.createHash('sha256').update(`dzen-vk:${article.link}`).digest('hex').slice(0, 32);
  const result = await vk('wall.post', {
    owner_id: `-${GROUP_ID}`,
    from_group: 1,
    message: buildMessage(article),
    attachments: attachment,
    guid,
  });

  await saveState(article.link, result?.post_id ?? null);
  console.log(`Published to VK club${GROUP_ID} with photo: ${article.title}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
