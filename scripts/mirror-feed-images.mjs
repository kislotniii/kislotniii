import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FEED_PATH = new URL('../feed.xml', import.meta.url);
const ASSETS_DIR = new URL('../assets/', import.meta.url);
const RAW_BASE = 'https://raw.githubusercontent.com/kislotniii/kislotniii/main/assets';

async function ensureDir() {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
}

function assetName(url, contentType = '') {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
  let ext = '.jpg';
  if (/png/i.test(contentType)) ext = '.png';
  else if (/webp/i.test(contentType)) ext = '.webp';
  else if (/gif/i.test(contentType)) ext = '.gif';
  return `${hash}${ext}`;
}

async function mirror(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      referer: 'https://dzen.ru/',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Image HTTP ${response.status}: ${url}`);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const name = assetName(url, contentType);
  const filePath = path.join(new URL(ASSETS_DIR).pathname, name);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`Image too small (${bytes.length} bytes): ${url}`);
  await fs.writeFile(filePath, bytes);
  return `${RAW_BASE}/${name}`;
}

async function main() {
  await ensureDir();
  let xml = await fs.readFile(FEED_PATH, 'utf8');
  const urls = [...new Set(xml.match(/https:\/\/avatars\.dzeninfra\.ru\/[^\s<>'"&]+/g) || [])];
  if (!urls.length) {
    console.log('No Dzen images to mirror.');
    return;
  }

  let changed = 0;
  for (const url of urls) {
    try {
      const local = await mirror(url);
      xml = xml.split(url).join(local);
      changed++;
      console.log(`Mirrored image: ${local}`);
    } catch (error) {
      console.warn(`Could not mirror ${url}: ${error.message}`);
    }
  }

  if (changed) {
    await fs.writeFile(FEED_PATH, xml, 'utf8');
    console.log(`Rewrote ${changed} Dzen image URL(s) in feed.xml.`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
