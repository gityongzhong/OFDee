// 页面旋转 e2e：PDF/OFD 两条通道、占位尺寸互换、缩略图跟随、双页对开、
// 适应宽度重算、切标签保留、复位。用法：node tools/rotate_test.mjs <base> [outPng]
import { writeFileSync } from 'node:fs';

const [base, outPng] = process.argv.slice(2);
const url = base + '/ui/index.html';

const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9222') + '/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('没有可用的页面 target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') {
    errs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`;
  results.push(line);
  console.log(line);
};

/** 某页在屏幕上的占位尺寸（px），用于验证宽高是否互换 */
const pageBox = (i) => js(`JSON.stringify((function(){
  const el = document.querySelector('.page[data-index="${i}"]');
  if (!el) return null;
  return { w: Math.round(parseFloat(el.style.width)), h: Math.round(parseFloat(el.style.height)) };
})())`).then((s) => JSON.parse(s));

const rotAll = () => js(`JSON.stringify(window.__ofdee.rotate.all())`).then((s) => JSON.parse(s));
const rotAt = (i) => js(`window.__ofdee.rotate.get(${i})`);
const open = async (p) => { await js(`window.__ofdee.open('${p}')`); await sleep(9000); };

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(2500);
await js(`try { localStorage.clear(); } catch (e) {}`);
await send('Page.navigate', { url });
await sleep(2500);

/* ================= PDF 通道 ================= */
await open(base + '/tools/test_outline.pdf');
check('PDF 初始无旋转', (await rotAll()).every((r) => r === 0), `rot=${JSON.stringify(await rotAll())}`);
const pdfBefore = await pageBox(0);
check('PDF 竖版占位（高>宽）', pdfBefore.h > pdfBefore.w, `${pdfBefore.w}x${pdfBefore.h}`);

await js(`window.__ofdee.rotate.page(0)`);
await sleep(1500);
check('PDF 单页旋转到 90°', (await rotAt(0)) === 90, `rot=${await rotAt(0)}`);
const pdfAfter = await pageBox(0);
// 适应宽度模式下旋转会重新缩放，所以宽度不等于原高度，要看的是「变成了横版」
check('PDF 旋转后变横版', pdfAfter.w > pdfAfter.h, `before=${pdfBefore.w}x${pdfBefore.h} after=${pdfAfter.w}x${pdfAfter.h}`);
check('PDF 旋转后比例与原文一致',
  Math.abs(pdfAfter.w / pdfAfter.h - pdfBefore.h / pdfBefore.w) < 0.02,
  `afterRatio=${(pdfAfter.w / pdfAfter.h).toFixed(3)} wantRatio=${(pdfBefore.h / pdfBefore.w).toFixed(3)}`);
check('PDF 其余页不受影响', (await rotAt(1)) === 0 && (await rotAt(2)) === 0);

// 画布真的按新朝向重画了（dataset.rotation 记录了绝对角度）
const cvRot = await js(`(function(){ const c = document.querySelector('.page[data-index="0"] canvas.pdf-canvas'); return c ? c.dataset.rotation : null; })()`);
check('PDF 画布按旋转角重画', cvRot === '90', `dataset.rotation=${cvRot}`);

// 第 0 页已手动转过一次（90），再 all90 应到 180；先复位再从干净状态验证
await js(`window.__ofdee.rotate.reset()`);
await sleep(1500);
await js(`window.__ofdee.rotate.all90()`);
await sleep(2500);
check('PDF 全部页旋转到 90°', (await rotAll()).every((r) => r === 90), `rot=${JSON.stringify(await rotAll())}`);

/* 双页对开：旋转后行高应取两页的较大者，且不能溢出 */
await js(`document.getElementById('btnSpread').click()`);
await sleep(1500);
const overflow = await js(`JSON.stringify((function(){
  const st = document.getElementById('stage');
  return { scrollW: st.scrollWidth, clientW: st.clientWidth };
})())`).then((s) => JSON.parse(s));
check('双页对开下未横向溢出', overflow.scrollW <= overflow.clientW + 1,
  `scrollW=${overflow.scrollW} clientW=${overflow.clientW}`);

/* 适应宽度：旋转后重新 fit，页面应仍完整可见 */
await js(`document.getElementById('btnSpread').click()`);
await sleep(1200);
await js(`document.getElementById('btnFitWidth').click()`);
await sleep(1200);
const fit = await js(`JSON.stringify((function(){
  const st = document.getElementById('stage');
  const el = document.querySelector('.page[data-index="0"]');
  return { scrollW: st.scrollWidth, clientW: st.clientWidth, pw: Math.round(parseFloat(el.style.width)) };
})())`).then((s) => JSON.parse(s));
check('适应宽度后仍不横向溢出', fit.scrollW <= fit.clientW + 1, `scrollW=${fit.scrollW} clientW=${fit.clientW}`);

/* 缩略图跟随旋转 */
const thumbRatio = await js(`(function(){ const s = document.querySelector('.thumb[data-index="0"] .thumb-sheet'); return s ? s.style.aspectRatio : null; })()`);
check('缩略图占位比例已互换', /297|11\d\d/.test(String(thumbRatio)) || String(thumbRatio).startsWith('297'),
  `aspect-ratio=${thumbRatio}`);

/* 切标签后再切回，旋转要保留 */
const pdfRotSnapshot = await rotAll();
await open(base + '/sample.ofd');
check('OFD 新标签初始无旋转', (await rotAll()).every((r) => r === 0));
await js(`window.__ofdee.switch(1)`);
await sleep(1500);
check('切回 PDF 标签旋转保留',
  JSON.stringify(await rotAll()) === JSON.stringify(pdfRotSnapshot),
  `before=${JSON.stringify(pdfRotSnapshot)} after=${JSON.stringify(await rotAll())}`);

/* ================= OFD 通道 ================= */
await js(`window.__ofdee.switch(2)`);
await sleep(1500);
const ofdBefore = await pageBox(0);
check('OFD 竖版占位（高>宽）', ofdBefore.h > ofdBefore.w, `${ofdBefore.w}x${ofdBefore.h}`);

await js(`window.__ofdee.rotate.page(0)`);
await sleep(2000);
check('OFD 单页旋转到 90°', (await rotAt(0)) === 90, `rot=${await rotAt(0)}`);
const ofdAfter = await pageBox(0);
check('OFD 旋转后变横版', ofdAfter.w > ofdAfter.h, `before=${ofdBefore.w}x${ofdBefore.h} after=${ofdAfter.w}x${ofdAfter.h}`);
check('OFD 旋转后比例与原文一致',
  Math.abs(ofdAfter.w / ofdAfter.h - ofdBefore.h / ofdBefore.w) < 0.02,
  `afterRatio=${(ofdAfter.w / ofdAfter.h).toFixed(3)} wantRatio=${(ofdBefore.h / ofdBefore.w).toFixed(3)}`);

// SVG 的 viewBox 必须换成旋转后尺寸，且内容要套 g transform
const svgInfo = await js(`JSON.stringify((function(){
  const svg = document.querySelector('.page[data-index="0"] svg');
  if (!svg) return null;
  const g = svg.querySelector('g[transform]');
  return { viewBox: svg.getAttribute('viewBox'), rot: svg.dataset.rotation, gTransform: g ? g.getAttribute('transform') : null };
})())`).then((s) => JSON.parse(s));
check('OFD viewBox 已互换', svgInfo && svgInfo.viewBox.startsWith('0 0 297'), `viewBox=${svgInfo && svgInfo.viewBox}`);
check('OFD 内容套了旋转变换', !!svgInfo && /rotate\(90\)/.test(svgInfo.gTransform || ''), `g=${svgInfo && svgInfo.gTransform}`);

/* 180° 与 270° */
await js(`window.__ofdee.rotate.page(0)`);
await sleep(1200);
check('OFD 连转到 180°', (await rotAt(0)) === 180, `rot=${await rotAt(0)}`);
const ofd180 = await pageBox(0);
check('OFD 180° 宽高恢复原向', Math.abs(ofd180.w - ofdBefore.w) <= 2 && Math.abs(ofd180.h - ofdBefore.h) <= 2,
  `${ofd180.w}x${ofd180.h}`);

await js(`window.__ofdee.rotate.page(0)`);
await sleep(1200);
check('OFD 连转到 270°', (await rotAt(0)) === 270, `rot=${await rotAt(0)}`);

await js(`window.__ofdee.rotate.page(0)`);
await sleep(1200);
check('OFD 转满一圈回到 0°', (await rotAt(0)) === 0, `rot=${await rotAt(0)}`);

/* 复位 */
await js(`window.__ofdee.rotate.all90()`);
await sleep(2000);
await js(`window.__ofdee.rotate.reset()`);
await sleep(2000);
check('复位后全部回到 0°', (await rotAll()).every((r) => r === 0), `rot=${JSON.stringify(await rotAll())}`);

/* 新开文档不受上一个文档的旋转影响 */
await open(base + '/tools/test_text.pdf');
check('新开文档旋转状态干净', (await rotAll()).every((r) => r === 0), `rot=${JSON.stringify(await rotAll())}`);

if (outPng) {
  await js(`window.__ofdee.rotate.page(0)`);
  await sleep(2000);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (errs.length) console.log('页面异常:\n' + errs.slice(0, 5).join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
