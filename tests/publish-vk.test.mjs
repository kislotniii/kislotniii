import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Fake credentials are used only with the mocked transport below.
process.env.VK_ACCESS_TOKEN = 'test-group-token';
process.env.VK_USER_ACCESS_TOKEN = 'test-photo-token';
const { buildMessage, parseFeed, publishArticle } = await import('../scripts/publish-vk.mjs');
const article = {
  title: 'История',
  link: 'https://dzen.ru/a/example',
  description: '<p>Первый абзац.</p><p>Второй абзац.</p>',
  images: ['https://images.test/1.jpg', 'https://images.test/2.jpg'],
};
const cta = 'Подписывайтесь, чтобы не потерять [club240532552|КОНТРАСТЫ ЭПОХ]';

function mockVK(t, { failImage = false, postId = 123 } = {}) {
  const calls = [];
  let saved = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const params = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : {};
    calls.push({ url, params });
    const json = (data) => Response.json(data);
    if (url.endsWith('/photos.getWallUploadServer')) return json({ response: { upload_url: 'https://upload.test/' } });
    if (url.startsWith('https://images.test/')) {
      return new Response('image', { status: failImage ? 503 : 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === 'https://upload.test/') return json({ server: 1, photo: 'uploaded', hash: 'hash' });
    if (url.endsWith('/photos.saveWallPhoto')) return json({ response: [{ owner_id: -240532552, id: ++saved }] });
    if (url.endsWith('/wall.post')) return json({ response: { post_id: postId } });
    throw new Error(`Unexpected network request: ${url}`);
  });
  return calls;
}

test('formats a standalone article with paragraphs and a single subscription line', () => {
  assert.equal(buildMessage(article), `История\n\nПервый абзац.\n\nВторой абзац.\n\n${cta}`);
});

test('uses the full RSS content instead of an excerpt and deduplicates photos', () => {
  const parsed = parseFeed(`<rss><item><title>История</title><link>${article.link}</link>
    <description><![CDATA[Краткий анонс]]></description>
    <content:encoded><![CDATA[<p>Полная статья.</p><img src="https://images.test/1.jpg"><img src="https://images.test/2.jpg"><img src="https://images.test/1.jpg">]]></content:encoded>
    <media:content url="https://images.test/1.jpg" /></item></rss>`);
  assert.match(buildMessage(parsed), /Полная статья/);
  assert.doesNotMatch(buildMessage(parsed), /Краткий анонс/);
  assert.deepEqual(parsed.images, article.images);
});

test('keeps a text longer than the previous 14000-character threshold in one post', () => {
  const longArticle = { ...article, description: 'Я'.repeat(15000) };
  assert.equal(buildMessage(longArticle), `История\n\n${longArticle.description}\n\n${cta}`);
});

test('accepts the text boundary and rejects an oversized article before network calls', async (t) => {
  const calls = mockVK(t);
  const overhead = buildMessage({ ...article, description: 'Я' }).length - 1;
  assert.equal(buildMessage({ ...article, description: 'Я'.repeat(16384 - overhead) }).length, 16384);
  await assert.rejects(publishArticle({ ...article, description: 'Я'.repeat(16385 - overhead) }), /too long for one post/);
  assert.equal(calls.length, 0);
});

test('sends all unique photos with exactly one wall.post and preserves the retry GUID', async (t) => {
  const calls = mockVK(t);
  const ids = await publishArticle({ ...article, images: [...article.images, article.images[0]] });
  const posts = calls.filter(c => c.url.endsWith('/wall.post'));
  assert.deepEqual(ids, [123]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].params.message, buildMessage(article));
  assert.equal(posts[0].params.attachments, 'photo-240532552_1,photo-240532552_2');
  assert.equal(posts[0].params.from_group, '1');
  assert.equal(posts[0].params.owner_id, '-240532552');
  assert.equal(posts[0].params.guid, crypto.createHash('sha256').update(`dzen-vk-full:${article.link}:0`).digest('hex').slice(0, 32));
});

test('caps the gallery at ten photos without creating continuation posts', async (t) => {
  const calls = mockVK(t);
  await publishArticle({ ...article, images: Array.from({ length: 12 }, (_, i) => `https://images.test/${i}.jpg`) });
  const posts = calls.filter(c => c.url.endsWith('/wall.post'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].params.attachments.split(',').length, 10);
});

test('does not publish an incomplete post if photo loading fails', async (t) => {
  const calls = mockVK(t, { failImage: true });
  await assert.rejects(publishArticle(article), /Image download failed/);
  assert.equal(calls.filter(c => c.url.endsWith('/wall.post')).length, 0);
});

test('does not report success when VK returns no post ID', async (t) => {
  mockVK(t, { postId: null });
  await assert.rejects(publishArticle(article), /did not return a published post ID/);
});

test('a previously published article is skipped and its state is preserved', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-publisher-'));
  try {
    await fs.mkdir(path.join(dir, 'scripts'));
    await fs.copyFile(new URL('../scripts/publish-vk.mjs', import.meta.url), path.join(dir, 'scripts/publish-vk.mjs'));
    await fs.writeFile(path.join(dir, 'feed.xml'), `<rss><item><title>История</title><link>${article.link}</link><description>Текст</description></item></rss>`);
    const state = JSON.stringify({ lastPublishedUrl: article.link, lastPostIds: [124, 125] });
    await fs.writeFile(path.join(dir, 'vk-state.json'), state);
    await fs.writeFile(path.join(dir, 'block-network.mjs'), 'globalThis.fetch = async () => { throw new Error("Unexpected network request"); };');
    const output = execFileSync(process.execPath, ['--import', path.join(dir, 'block-network.mjs'), path.join(dir, 'scripts/publish-vk.mjs')], { encoding: 'utf8', env: process.env });
    assert.match(output, /already published/);
    assert.equal(await fs.readFile(path.join(dir, 'vk-state.json'), 'utf8'), state);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
