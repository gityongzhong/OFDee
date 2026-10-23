// 目录侧栏端到端验证：打开 PDF/OFD → 点目录按钮 → 校验大纲/降级网格 → 点击跳页 → 高亮同步
// 用法：node tools/outline_test.mjs <url> <outPng>
import { writeFileSync } from 'node:fs';

const [url, outPng] = process.argv.slice(2);

const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9222') + '/json/list')).json();
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
    logs.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const evalJson = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 840, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 9000)); // 等解析+渲染

// 1) 打开目录侧栏
const clickRes = await evalJson(`(() => { const b = document.getElementById('btnOutline'); b.click(); return 'clicked'; })()`);
await new Promise((r) => setTimeout(r, 3000)); // 等大纲解析

const diag1 = await evalJson(`JSON.stringify((() => {
  const panel = document.getElementById('outline');
  const items = [...panel.querySelectorAll('.ol-item')].map(b => ({
    text: b.querySelector('.ol-text')?.textContent,
    pg: b.querySelector('.ol-pg')?.textContent
  }));
  return {
    outlineOn: panel.classList.contains('on'),
    btnActive: document.getElementById('btnOutline').classList.contains('active'),
    items, empty: !!panel.querySelector('.ol-empty'),
    gridCount: panel.querySelectorAll('.ol-pgbtn').length
  };
})())`);
console.log('STEP1 打开目录:', clickRes);
console.log('DIAG1:', diag1);

const d1 = JSON.parse(diag1);

// 2) 点击一个目录条目（PDF 有大纲时点「第三章」，否则点页面网格第 8 格）
if (d1.items.length) {
  const r = await evalJson(`(() => {
    const items = [...document.querySelectorAll('#outline .ol-item')];
    const target = items.find(b => (b.querySelector('.ol-text')||{}).textContent === '第三章 审核与决定') || items[0];
    target.click();
    return target.querySelector('.ol-pg')?.textContent;
  })()`);
  console.log('STEP2 点击条目，目标页:', r);
} else {
  const r = await evalJson(`(() => {
    const btns = [...document.querySelectorAll('#outline .ol-pgbtn')];
    const target = btns[7];
    if (!target) return 'none';
    target.click();
    return target.textContent;
  })()`);
  console.log('STEP2 点击页面网格第 8 格:', r);
}
await new Promise((r) => setTimeout(r, 2500)); // 等平滑滚动

const diag2 = await evalJson(`JSON.stringify((() => {
  const panel = document.getElementById('outline');
  return {
    pageInput: document.getElementById('pageInput').value,
    curItem: panel.querySelector('.ol-item.cur .ol-text')?.textContent || null,
    curPg: panel.querySelector('.ol-item.cur .ol-pg')?.textContent || null,
    curGrid: panel.querySelector('.ol-pgbtn.cur')?.textContent || null,
    firstPageTop: (() => { const p = document.querySelector('.page'); return p ? p.getBoundingClientRect().top : null; })()
  };
})())`);
console.log('DIAG2 跳页与高亮:', diag2);

// 3) 翻到别页，验证高亮跟随
await evalJson(`(() => { document.getElementById('btnNext').click(); return 1; })()`);
await new Promise((r) => setTimeout(r, 1500));
const diag3 = await evalJson(`JSON.stringify({
  pageInput: document.getElementById('pageInput').value,
  curPg: document.querySelector('#outline .ol-item.cur .ol-pg')?.textContent || null,
  curGrid: document.querySelector('#outline .ol-pgbtn.cur')?.textContent || null
})`);
console.log('DIAG3 翻页后高亮:', diag3);

if (outPng) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
    console.log('SHOT:', outPng);
  }
}
if (logs.length) console.log('LOGS:\n' + logs.join('\n'));
ws.close();
process.exit(0);
