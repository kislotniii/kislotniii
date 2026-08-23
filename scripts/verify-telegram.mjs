import fs from 'node:fs/promises';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '@kontrastyepox';
const OUT = new URL('../telegram-check.json', import.meta.url);

async function call(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = String(data?.description || `HTTP ${response.status}`)
      .replace(TOKEN, '[redacted]');
    throw new Error(`${method}: ${description}`);
  }
  return data.result;
}

let result;
try {
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const me = await call('getMe');
  const member = await call('getChatMember', { chat_id: CHAT_ID, user_id: me.id });
  const canPost = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
  if (!canPost) throw new Error(`Bot cannot post: status=${member.status}, can_post_messages=${member.can_post_messages}`);
  result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    bot: `@${me.username || me.id}`,
    channel: CHAT_ID,
    status: member.status,
    canPost: true
  };
  console.log(`Telegram verified: ${result.bot} -> ${CHAT_ID}`);
} catch (error) {
  result = {
    ok: false,
    checkedAt: new Date().toISOString(),
    channel: CHAT_ID,
    error: String(error?.message || error).replace(TOKEN, '[redacted]')
  };
  console.error(`Telegram verification failed: ${result.error}`);
}

await fs.writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
