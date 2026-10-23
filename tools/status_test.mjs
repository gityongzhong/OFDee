// 状态栏增强 e2e：实时区（页码/进度/缩放/模式）与文档信息区
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

const snap = async () => JSON.parse(await js(`JSON.stringify({
  liveHidden: document.getElementById('stLive').classList.contains('hide'),
  page: document.getElementById('stPage').textContent,
  pct: document.getElementById('stPercent').textContent,
  barW: document.getElementById('stProgress').style.width,
  zoom: document.getElementById('stZoom').textContent,
  mode: document.getElementById('stMode').textContent,
  info: document.getElementById('stInfo').innerText.replace(/\\n/g, ' | '),
  statusChildren: document.getElementById('status').children.length
})`));

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(3000);

// 1) 空状态：实时区隐藏
let s = await snap();
check('空状态实时区隐藏', s.liveHidden === true, `hidden=${s.liveHidden}`);
check('空状态显示「就绪」', /就绪/.test(s.info), `info=${s.info}`);
check('状态栏结构完整（实时区+信息区）', s.statusChildren === 2, `children=${s.statusChildren}`);

// 2) 打开 PDF（12 页）
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(9000);
s = await snap();
check('打开文档后实时区显示', s.liveHidden === false, `hidden=${s.liveHidden}`);
check('页码正确', s.page === '第 1 / 12 页', `page=${s.page}`);
check('起始进度 0%', s.pct === '0%', `pct=${s.pct}`);
check('信息区显示文档信息', /12 页/.test(s.info) && /PDF/.test(s.info), `info=${s.info.slice(0, 90)}`);
check('信息区不是被转义的 HTML', !s.info.includes('<span'), `info=${s.info.slice(0, 60)}`);

// 3) 翻页 → 页码跟随，进度增加
await js(`document.getElementById('btnNext').click()`);
await sleep(1200);
s = await snap();
check('翻页后页码跟随', s.page === '第 2 / 12 页', `page=${s.page}`);
check('翻页后进度不为 0', s.pct !== '0%', `pct=${s.pct}`);
const barW = parseFloat(s.barW || '0');
check('进度条宽度同步', barW > 0 && barW <= 100, `barW=${s.barW}`);

// 4) 缩放 → 实时区百分比变化
await js(`document.getElementById('btnZoomIn').click()`);
await sleep(600);
s = await snap();
check('缩放百分比跟随', s.zoom !== '100%', `zoom=${s.zoom}`);

// 5) 双页切换 → 模式文字变化
await js(`document.getElementById('btnSpread').click()`);
await sleep(800);
s = await snap();
check('切到双页显示「双页」', s.mode === '双页', `mode=${s.mode}`);
await js(`document.getElementById('btnSpread').click()`);
await sleep(800);
s = await snap();
check('切回单页显示「单页」', s.mode === '单页', `mode=${s.mode}`);

// 6) 滚到底 → 进度 100%
await js(`(function(){ const st = document.getElementById('stage'); st.scrollTop = st.scrollHeight; return st.scrollTop; })()`);
await sleep(1500);
s = await snap();
check('滚到底进度 100%', s.pct === '100%', `pct=${s.pct}`);
check('滚到底页码为末页', s.page === '第 12 / 12 页', `page=${s.page}`);

// 7) 打开第二个文档 → 信息区更新为 OFD
const pdfZoom = (await snap()).zoom; // 切走前，先记下 PDF 标签自己的缩放
await js(`window.__ofdee.open('${base}/sample.ofd')`);
await sleep(8000);
s = await snap();
check('切到 OFD 信息区更新', /OFD/.test(s.info), `info=${s.info.slice(0, 80)}`);
check('OFD 页码正确', /共/.test(s.page) || /第 1 \//.test(s.page), `page=${s.page}`);

// 8) 切回 PDF 标签 → 信息区恢复 PDF（验证快照没有混入实时区）
await js(`window.__ofdee.switch(2)`);
await sleep(900);
const ofdZoom = (await snap()).zoom;
await js(`window.__ofdee.switch(1)`);
await sleep(1500);
s = await snap();
check('切回标签信息区为 PDF', /PDF/.test(s.info), `info=${s.info.slice(0, 80)}`);
check('信息区未混入实时区文字', !/第 \d+ \/ \d+ 页/.test(s.info), `info=${s.info.slice(0, 80)}`);
check('切回标签缩放还原', Math.abs(parseInt(s.zoom) - parseInt(pdfZoom)) <= 1, `now=${s.zoom} before=${pdfZoom} ofdTab=${ofdZoom}`);

// 9) 关闭全部标签 → 实时区再次隐藏
const ids = JSON.parse(await js(`JSON.stringify(window.__ofdee.tabs().map(t => t.id))`));
for (const tid of ids) {
  await js(`window.__ofdee.close(${tid})`);
  await sleep(900);
}
s = await snap();
check('全关闭后实时区隐藏', s.liveHidden === true, `hidden=${s.liveHidden}`);
check('全关闭后显示「就绪」', /就绪/.test(s.info), `info=${s.info}`);

// 10) 窗口变窄不塌（信息区省略、实时区保留）
await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 700, deviceScaleFactor: 1, mobile: false });
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(8000);
s = JSON.parse(await js(`(function(){
  const live = document.getElementById('stLive').getBoundingClientRect();
  const info = document.getElementById('stInfo').getBoundingClientRect();
  const st = document.getElementById('status');
  return JSON.stringify({liveW: live.width, infoW: info.width, statusW: st.clientWidth, overflow: info.right > st.getBoundingClientRect().right + 1});
})()`));
check('窄窗口实时区可见', s.liveW > 100, `liveW=${s.liveW}`);
check('窄窗口信息区不溢出', s.overflow === false, `infoRight overflow=${s.overflow} w=${s.infoW}`);

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (outPng) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
}
if (logs.length) console.log('LOGS:\n' + logs.join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
