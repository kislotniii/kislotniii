import fs from 'node:fs/promises';

const TOKEN = process.env.VK_ACCESS_TOKEN || '';
const GROUP_ID = String(process.env.VK_GROUP_ID || '240532552').replace(/^-/,'');
const API_VERSION = process.env.VK_API_VERSION || '5.199';
const OUT = new URL('../vk-check.json', import.meta.url);

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
    const error = new Error(`${method}: ${response.status} ${JSON.stringify(data.error || data)}`);
    error.vk = data.error || null;
    throw error;
  }
  return data.response;
}

const result = {
  checkedAt: new Date().toISOString(),
  groupId: GROUP_ID,
  tokenConfigured: Boolean(TOKEN),
  apiReachable: false,
  groupReadable: false,
  wallPhotoUploadAvailable: false,
  messagesPhotoUploadAvailable: false,
  photoUploadAvailable: false,
  errors: [],
};

if (!TOKEN) {
  result.errors.push('VK_ACCESS_TOKEN is missing');
} else {
  try {
    await vk('groups.getById', { group_id: GROUP_ID });
    result.apiReachable = true;
    result.groupReadable = true;
  } catch (error) {
    result.errors.push(`groups.getById: ${error?.vk?.error_msg || error?.message || String(error)}`);
  }

  try {
    const upload = await vk('photos.getWallUploadServer', { group_id: GROUP_ID });
    result.wallPhotoUploadAvailable = Boolean(upload?.upload_url);
  } catch (error) {
    result.errors.push(`wall photo upload: ${error?.vk?.error_msg || error?.message || String(error)}`);
  }

  try {
    const upload = await vk('photos.getMessagesUploadServer', {});
    result.messagesPhotoUploadAvailable = Boolean(upload?.upload_url);
  } catch (error) {
    result.errors.push(`messages photo upload: ${error?.vk?.error_msg || error?.message || String(error)}`);
  }

  result.photoUploadAvailable = result.wallPhotoUploadAvailable || result.messagesPhotoUploadAvailable;
}

await fs.writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`VK verification saved: token=${result.tokenConfigured}, photoUpload=${result.photoUploadAvailable}`);
