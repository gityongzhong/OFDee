// 截取产品展示页（分段全页）
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8766/docs/index.html';
const outDir = process.argv[3] || 'docs/screenshots';
const W = 1440, H = 1000;

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(4000);

// 等图片全部加载完
console.log('imgs:', await js(`(function(){
  const im = [...document.images];
  return im.length + ' total, ' + im.filter(i=>i.complete && i.naturalWidth>0).length + ' loaded';
})()`));

const total = await js(`document.documentElement.scrollHeight`);
console.log('页面高度:', total);

const segs = Math.ceil(total / H);
for (let i = 0; i < segs; i++) {
  await js(`window.scrollTo(0, ${i * H})`);
  await sleep(500);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = `${outDir}/_page_${i}.png`;
  writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  console.log(`  → ${p}`);
}
console.log('分段数:', segs);
process.exit(0);
