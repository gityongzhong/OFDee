// 用 CDP 驱动无头 Chrome：真实等待异步（含 Web Worker），取回 title / 控制台错误 / 截图。
// 用法：node tools/cdp.mjs <url> <waitMs> <outPng> [width] [height]
import { writeFileSync } from 'node:fs';

const [url, waitMsArg, outPng, wArg, hArg, clickSel] = process.argv.slice(2);
const waitMs = Number(waitMsArg || 6000);
const width = Number(wArg || 1240);
const height = Number(hArg || 840);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('没有可用的页面 target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push('[console.' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description || d.text));
  } else if (msg.method === 'Log.entryAdded') {
    logs.push('[log.' + msg.params.entry.level + '] ' + msg.params.entry.text);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await new Promise((res) => ws.addEventListener('open', res, { once: true }));

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

await new Promise((r) => setTimeout(r, waitMs));

if (clickSel) {
  for (const sel of clickSel.split(',')) {
    await send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) { el.click(); return 'clicked ' + ${JSON.stringify(sel)}; } return 'no ' + ${JSON.stringify(sel)}; })()`,
      returnByValue: true
    });
  }
  await new Promise((r) => setTimeout(r, 2500));
}

const titleRes = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
const diagRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    docName: (document.getElementById('docName')||{}).textContent,
    status: (document.getElementById('status')||{}).textContent,
    busy: (document.getElementById('busy')||{}).className,
    toasts: [...document.querySelectorAll('.toast')].map(t=>t.textContent),
    pages: document.querySelectorAll('.page').length,
    canvas: document.querySelectorAll('canvas').length,
    svg: document.querySelectorAll('#pages svg').length,
    firstPage: (()=>{const p=document.querySelector('.page');return p?{w:p.style.width,h:p.style.height,inner:p.innerHTML.slice(0,120)}:null})(),
    thumbs: document.querySelectorAll('.thumb canvas, .thumb svg').length
  })`,
  returnByValue: true
});

console.log('TITLE:', titleRes.result?.result?.value);
console.log('DIAG:', diagRes.result?.result?.value);
if (logs.length) console.log('LOGS:\n' + logs.join('\n'));

if (outPng) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
    console.log('SHOT:', outPng);
  }
}
ws.close();
process.exit(0);
