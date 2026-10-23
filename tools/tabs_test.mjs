// 多标签页端到端：双开文档 → 各自保留页码 → 切换/关闭 → 同路径去重 → 全关回空状态
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

const evalJson = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.result?.type === 'object' && r.result?.result?.subtype === 'error') {
    throw new Error('evaluate error: ' + r.result.result.description);
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 840, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(3000);

const results = [];
const check = (name, cond, extra = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`;
  results.push(line);
  console.log(line);
};

// 1) 打开第一个文档（PDF）
await evalJson(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(9000);
let snap = await evalJson(`JSON.stringify({tabs: window.__ofdee.tabs(), active: window.__ofdee.active(), name: document.getElementById('docName').textContent, pages: document.querySelectorAll('.page').length, viewer: document.getElementById('viewer').classList.contains('on')})`);
let s = JSON.parse(snap);
check('打开 PDF → 1 个标签', s.tabs.length === 1 && s.tabs[0].loaded && s.name.includes('test_outline'), `name=${s.name}`);
check('标签条显示', await evalJson(`document.getElementById('tabs').style.display`) === 'flex');

// 2) 打开第二个文档（OFD）
await evalJson(`window.__ofdee.open('${base}/sample.ofd')`);
await sleep(8000);
s = JSON.parse(await evalJson(`JSON.stringify({tabs: window.__ofdee.tabs(), name: document.getElementById('docName').textContent, pages: document.querySelectorAll('.page').length, svg: document.querySelectorAll('#pages svg').length})`));
check('打开 OFD → 2 个标签', s.tabs.length === 2 && s.tabs.every((t) => t.loaded), `tabs=${JSON.stringify(s.tabs)}`);
check('活动标签是 OFD', s.name.includes('sample.ofd'), `name=${s.name}`);
check('OFD 渲染出 SVG 页面', s.svg >= 1, `svg=${s.svg}`);

// 3) OFD 标签翻到第 3 页
await evalJson(`document.getElementById('btnNext').click()`);
await sleep(600);
await evalJson(`document.getElementById('btnNext').click()`);
await sleep(1500);
s = JSON.parse(await evalJson(`JSON.stringify({page: document.getElementById('pageInput').value})`));
check('OFD 翻到第 3 页', s.page === '3', `page=${s.page}`);

// 4) 切回 PDF 标签 → 页码/文档名应回到 PDF 的
const pdfTabId = JSON.parse(await evalJson('JSON.stringify(window.__ofdee.tabs())'))[0].id;
await evalJson(`window.__ofdee.switch(${pdfTabId})`);
await sleep(1200);
s = JSON.parse(await evalJson(`JSON.stringify({name: document.getElementById('docName').textContent, page: document.getElementById('pageInput').value, canvas: document.querySelectorAll('#pages canvas').length})`));
check('切回 PDF → 文档名正确', s.name.includes('test_outline'), `name=${s.name}`);
check('PDF 页码为 1', s.page === '1', `page=${s.page}`);
check('PDF 画布还在（无重渲染闪烁）', s.canvas >= 1, `canvas=${s.canvas}`);

// 5) 再切回 OFD → 第 3 页应保留
const ofdTabId = JSON.parse(await evalJson('JSON.stringify(window.__ofdee.tabs())'))[1].id;
await evalJson(`window.__ofdee.switch(${ofdTabId})`);
await sleep(1200);
s = JSON.parse(await evalJson(`JSON.stringify({name: document.getElementById('docName').textContent, page: document.getElementById('pageInput').value})`));
check('切回 OFD → 页码仍为 3', s.page === '3', `page=${s.page}`);

// 6) 同路径去重：再次打开 sample.ofd 不应产生第 3 个标签
await evalJson(`window.__ofdee.open('${base}/sample.ofd')`);
await sleep(3000);
s = JSON.parse(await evalJson(`JSON.stringify(window.__ofdee.tabs())`));
check('同路径去重 → 仍 2 个标签', s.length === 2, `n=${s.length}`);

// 7) 关闭 PDF 标签 → 剩 OFD，视图正常
await evalJson(`window.__ofdee.close(${pdfTabId})`);
await sleep(1200);
s = JSON.parse(await evalJson(`JSON.stringify({tabs: window.__ofdee.tabs(), name: document.getElementById('docName').textContent, viewer: document.getElementById('viewer').classList.contains('on')})`));
check('关闭 PDF 标签 → 剩 1 个', s.tabs.length === 1 && s.tabs[0].name.includes('sample'), `tabs=${JSON.stringify(s.tabs)}`);
check('OFD 视图仍在', s.viewer && s.name.includes('sample.ofd'));

// 8) 关闭最后一个 → 回空状态
await evalJson(`window.__ofdee.close(${ofdTabId})`);
await sleep(1200);
s = JSON.parse(await evalJson(`JSON.stringify({tabs: window.__ofdee.tabs(), empty: document.getElementById('empty').style.display !== 'none', tabsBar: document.getElementById('tabs').style.display})`));
check('全关闭 → 空状态', s.tabs.length === 0 && s.empty, `empty=${s.empty}`);
check('标签条隐藏', s.tabsBar === 'none', `display=${s.tabsBar}`);

// 9) 全关后再开 → 正常
await evalJson(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(9000);
s = JSON.parse(await evalJson(`JSON.stringify({tabs: window.__ofdee.tabs(), pages: document.querySelectorAll('.page').length})`));
check('重开文档 → 新标签正常', s.tabs.length === 1 && s.pages === 12, `pages=${s.pages}`);

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
