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
  if (!response.ok || !data.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(data)}`);
  return data.result;
}

if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing');

const me = await call('getMe');
const member = await call('getChatMember', { chat_id: CHAT_ID, user_id: me.id });
const canPost = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
if (!canPost) throw new Error(`Bot cannot post to ${CHAT_ID}: status=${member.status}, can_post_messages=${member.can_post_messages}`);

const result = {
  checkedAt: new Date().toISOString(),
  bot: `@${me.username || me.id}`,
  channel: CHAT_ID,
  status: member.status,
  canPost: true
};
await fs.writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`Telegram verified: ${result.bot} -> ${CHAT_ID}`);
