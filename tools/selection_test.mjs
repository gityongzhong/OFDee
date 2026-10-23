// PDF 划选复制 e2e：文字层生成 → 真实鼠标拖拽选择 → Ctrl+C 复制 → 右键菜单 → Ctrl+A
import { writeFileSync } from 'node:fs';

const [base, outPng] = process.argv.slice(2);
const url = base + '/ui/index.html';

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

const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('evaluate error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, cond, extra = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`;
  results.push(line);
  console.log(line);
};

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(3000);

// 拦截 clipboard.writeText，便于断言（无头环境读剪贴板受焦点限制）
await js(`(function(){
  window.__clip = '';
  const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (t) => { window.__clip = String(t); return Promise.resolve(); };
  return 1;
})()`);

// 1) 打开带文字的 PDF
await js(`window.__ofdee.open('${base}/tools/test_text.pdf')`);
await sleep(9000);

let s = JSON.parse(await js(`JSON.stringify({
  layers: document.querySelectorAll('.textLayer').length,
  spans: document.querySelectorAll('.textLayer span').length,
  canvas: document.querySelectorAll('canvas.pdf-canvas').length,
  layerText: (document.querySelector('.textLayer') || {}).innerText || '',
  selUser: (document.querySelector('.textLayer') || {}).style ? getComputedStyle(document.querySelector('.textLayer')).userSelect : ''
})`));
check('生成了文字层', s.layers >= 1, `layers=${s.layers}`);
check('文字层含文字片段', s.spans >= 4, `spans=${s.spans}`);
check('canvas 仍在', s.canvas >= 1, `canvas=${s.canvas}`);
check('文字层文字内容正确', /OFDee Text Selection Test/.test(s.layerText.replace(/\s+/g, ' ')), `text=${s.layerText.slice(0, 50).replace(/\n/g, '|')}`);
check('文字层允许选中（user-select:text）', s.selUser === 'text', `userSelect=${s.selUser}`);

// 2) 文字层与 canvas 尺寸对齐
s = JSON.parse(await js(`(function(){
  const page = document.querySelector('.page');
  const tl = page.querySelector('.textLayer');
  const cv = page.querySelector('canvas.pdf-canvas');
  const tr = tl.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  return JSON.stringify({tlW: tr.width, cvW: cr.width, tlH: tr.height, cvH: cr.height});
})()`));
check('文字层宽度与画布对齐', Math.abs(s.tlW - s.cvW) / s.cvW < 0.02, `tl=${s.tlW.toFixed(1)} cv=${s.cvW.toFixed(1)}`);
check('文字层高度与画布对齐', Math.abs(s.tlH - s.cvH) / s.cvH < 0.02, `tlH=${s.tlH.toFixed(1)} cvH=${s.cvH.toFixed(1)}`);

// 3) 真实鼠标拖拽选择第一行
let box = JSON.parse(await js(`(function(){
  const s = document.querySelector('.textLayer span');
  const r = s.getBoundingClientRect();
  return JSON.stringify({x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width - 2, y2: r.top + r.height / 2});
})()`));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x1, y: box.y1, button: 'left', clickCount: 1 });
await sleep(60);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (box.x1 + box.x2) / 2, y: box.y1, button: 'left' });
await sleep(60);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x2, y: box.y2, button: 'left' });
await sleep(60);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x2, y: box.y2, button: 'left', clickCount: 1 });
await sleep(300);
s = await js(`window.getSelection().toString()`);
check('鼠标拖拽可选中文字', /OFDee/.test(s), `sel=${JSON.stringify((s || '').slice(0, 50))}`);

// 4) Ctrl+C 复制选中
await js(`window.__clip = ''`);
await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'c', ctrlKey:true, bubbles:true}))`);
await sleep(500);
s = await js(`window.__clip`);
check('Ctrl+C 复制选中内容', /OFDee Text Selection/.test(s || ''), `clip=${JSON.stringify((s || '').slice(0, 50))}`);
s = await js(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join('|')`);
check('有复制成功提示', /已复制选中内容/.test(s || ''), `toast=${s}`);

// 5) 右键菜单（选中状态下）
await js(`(function(){
  const pg = document.querySelector('.page');
  const rect = pg.getBoundingClientRect();
  const el = pg.querySelector('.textLayer') || pg;
  el.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: rect.left + 80, clientY: rect.top + 80, button: 2}));
  return 1;
})()`);
await sleep(400);
s = JSON.parse(await js(`JSON.stringify({menu: !!document.getElementById('ctxMenu'), items: [...document.querySelectorAll('#ctxMenu .ctx-item')].map(b => b.textContent)})`));
check('右键弹出菜单', s.menu === true, `menu=${s.menu}`);
check('菜单含「复制选中内容」', (s.items || []).some((t) => t.includes('复制选中内容')), `items=${JSON.stringify(s.items).slice(0, 160)}`);
check('菜单含「复制本页全部文字」', (s.items || []).some((t) => t.includes('复制本页全部文字')), '');
check('菜单含缩放操作', (s.items || []).some((t) => t.includes('适应宽度')), '');

// 6) 点菜单「复制选中内容」
await js(`window.__clip = ''`);
await js(`document.querySelector('#ctxMenu .ctx-item').click()`);
await sleep(600);
s = await js(`window.__clip`);
check('菜单复制生效', /OFDee/.test(s || ''), `clip=${JSON.stringify((s || '').slice(0, 40))}`);
s = await js(`!!document.getElementById('ctxMenu')`);
check('点击后菜单关闭', s === false, `menu=${s}`);

// 7) Ctrl+A 全选当前页
await js(`window.getSelection().removeAllRanges()`);
await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'a', ctrlKey:true, bubbles:true}))`);
await sleep(300);
s = await js(`window.getSelection().toString()`);
check('Ctrl+A 全选当前页文字', (s || '').length > 50, `len=${(s || '').length}`);

// 8) 扫描件（无文字层）不应挂空文字层
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(9000);
s = JSON.parse(await js(`JSON.stringify({
  tabs: window.__ofdee.tabs().length,
  layers: document.querySelectorAll('.textLayer').length,
  pages: document.querySelectorAll('.page').length
})`));
check('空白页 PDF 不挂文字层', s.layers === 0, `layers=${s.layers}`);
check('多标签切换后视图正常', s.pages === 12, `pages=${s.pages}`);

// 9) 回第 1 个标签，文字层还在
await js(`window.__ofdee.switch(1)`);
await sleep(1500);
s = JSON.parse(await js(`JSON.stringify({layers: document.querySelectorAll('.textLayer').length, spans: document.querySelectorAll('.textLayer span').length})`));
check('切回标签文字层保留', s.layers >= 1 && s.spans >= 4, `layers=${s.layers} spans=${s.spans}`);

// 截图：选中一段的效果
await js(`(function(){
  const spans = document.querySelectorAll('.textLayer span');
  const el = [...spans].find(x => /quick brown/i.test(x.textContent)) || spans[2];
  if (!el) return 0;
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  return sel.toString();
})()`);
await sleep(400);

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (outPng) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
}
if (logs.length) console.log('LOGS:\n' + logs.join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
