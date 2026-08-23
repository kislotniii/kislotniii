import fs from 'node:fs/promises';

const BRIDGE_URL = 'https://rss.mabinsight.co.uk/?action=display&bridge=YandexZenBridge&channelURL=https%3A%2F%2Fdzen.ru%2Fkodistori1&limit=30&format=Atom';
const OUT = new URL('../dzen-discovery-check.json', import.meta.url);
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const result = { checkedAt: new Date().toISOString(), ok: false, source: 'YandexZenBridge', urls: [], error: '' };
try {
  const response = await fetch(BRIDGE_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(45000),
  });
  result.httpStatus = response.status;
  const xml = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const seen = new Set();
  const regex = /https?:\/\/(?:www\.)?dzen\.ru\/a\/[A-Za-z0-9_-]+/g;
  for (const match of xml.matchAll(regex)) {
    const url = match[0];
    if (!seen.has(url)) { seen.add(url); result.urls.push(url); }
  }
  result.ok = result.urls.length > 0;
  if (!result.ok) result.error = 'No article URLs found in bridge response';
} catch (error) {
  result.error = String(error?.message || error);
}
await fs.writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result));
