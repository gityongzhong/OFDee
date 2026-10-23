// PDF 截图合成探针：对比普通截图与 captureBeyondViewport
import { writeFileSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:8766';
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
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1560, height: 980, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: base + '/ui/index.html' });
await sleep(2500);
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(10000);
console.log('canvas:', await js(`(function(){
  const cv = document.querySelector('.page[data-index="0"] canvas');
  return cv ? cv.width + 'x' + cv.height : 'none';
})()`));

const a = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('tools/pdf_normal.png', Buffer.from(a.result.data, 'base64'));
const b = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync('tools/pdf_cbv.png', Buffer.from(b.result.data, 'base64'));
console.log('saved: pdf_normal.png / pdf_cbv.png');
process.exit(0);
