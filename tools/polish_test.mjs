// 界面打磨 e2e：页面阴影/间距、工具栏悬停提示、窗口拖动区、无文档置灰
import { writeFileSync } from 'node:fs';

const [base, outPng] = process.argv.slice(2);
const url = base + '/ui/index.html';

const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9226') + '/json/list')).json();
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
  if (r.result?.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`;
  results.push(line);
  console.log(line);
};
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, clickCount: 0, ...extra });

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(3000);

/* ---------- 1) 无文档：工具栏置灰 ---------- */
let s = JSON.parse(await js(`JSON.stringify({
  disabled: ['btnPrev','btnNext','btnZoomIn','btnZoomOut','zoomLabel','btnFitWidth','btnFitPage','btnCopy','btnExport']
    .filter((k) => document.getElementById(k).disabled),
  pageInputDisabled: document.getElementById('pageInput').disabled,
  offCount: ['btnSpread','btnOutline','btnSide'].filter((k) => document.getElementById(k).classList.contains('off')).length,
  spreadStillClickable: !document.getElementById('btnSpread').disabled
})`));
check('无文档时 9 个依赖按钮禁用', s.disabled.length === 9, `disabled=${s.disabled.length}`);
check('无文档时页码输入框禁用', s.pageInputDisabled === true);
check('单双页/目录/缩略图仅淡化', s.offCount === 3 && s.spreadStillClickable === true, `off=${s.offCount} clickable=${s.spreadStillClickable}`);

const cursor = await js(`getComputedStyle(document.getElementById('btnPrev')).cursor`);
check('禁用按钮 cursor 为 default', cursor === 'default', `cursor=${cursor}`);

/* ---------- 2) 工具提示：悬停原生命中，气泡延时出现 ---------- */
const box = JSON.parse(await js(`(function(){
  const r = document.getElementById('btnSettings').getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2, title: document.getElementById('btnSettings').getAttribute('title')});
})()`));
await mouse('mouseMoved', box.x, box.y);
await sleep(120);
let tip = JSON.parse(await js(`JSON.stringify({ on: window.__ofdee_tip.on(), text: window.__ofdee_tip.text() })`));
check('刚悬停不立刻弹（避免拖过一串按钮时闪）', tip.on === false, `on=${tip.on}`);
await sleep(760);
tip = JSON.parse(await js(`JSON.stringify({
  on: window.__ofdee_tip.on(),
  text: window.__ofdee_tip.text(),
  rect: (function(){ const t = document.querySelector('.tip').getBoundingClientRect(); return {x: Math.round(t.left), y: Math.round(t.top), w: Math.round(t.width), h: Math.round(t.height)}; })(),
  opaque: getComputedStyle(document.querySelector('.tip')).opacity
})`));
check('悬停后气泡出现', tip.on === true && tip.rect.w > 0, `w=${tip.rect.w}`);
check('气泡文案与 title 一致', tip.text === box.title && tip.rect.w > 10, `text=${tip.text}`);
check('气泡在按钮下方且居中', Math.abs((tip.rect.x + tip.rect.w / 2) - box.x) < 3 && tip.rect.y > box.y, `cx=${tip.rect.x + tip.rect.w / 2} btnx=${box.x} ty=${tip.rect.y} by=${box.y}`);
check('气泡不拦截鼠标事件', (await js(`getComputedStyle(document.querySelector('.tip')).pointerEvents`)) === 'none');

await mouse('mouseMoved', box.x, box.y - 300);
await sleep(260);
tip = JSON.parse(await js(`JSON.stringify({ on: window.__ofdee_tip.on() })`));
check('移开后气泡收起', tip.on === false, `on=${tip.on}`);

// 右侧按钮的气泡不越界
const rightBox = JSON.parse(await js(`(function(){
  const r = document.getElementById('btnSettings').getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
})()`));
await mouse('mouseMoved', rightBox.x, rightBox.y);
await sleep(820);
const guard = JSON.parse(await js(`(function(){
  const t = document.querySelector('.tip').getBoundingClientRect();
  return JSON.stringify({ right: Math.round(t.right), vw: innerWidth, on: window.__ofdee_tip.on() });
})()`));
check('贴右边时不溢出窗口', guard.right <= guard.vw - 4, `right=${guard.right} vw=${guard.vw}`);

// 禁用的按钮不弹气泡（避免「无文档时提示某个操作」误导）
const prevBox = JSON.parse(await js(`(function(){
  const r = document.getElementById('btnPrev').getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
})()`));
await mouse('mouseMoved', prevBox.x, prevBox.y);
await sleep(820);
const disTip = await js(`window.__ofdee_tip.on()`);
check('禁用按钮不弹提示', disTip === false, `on=${disTip}`);

/* ---------- 3) 拖动区 ---------- */
const drag0 = JSON.parse(await js(`JSON.stringify({
  bar: document.getElementById('bar').querySelectorAll('[data-tauri-drag-region]').length,
  tabs: document.getElementById('tabs').hasAttribute('data-tauri-drag-region'),
  fill: !!document.querySelector('.tab-fill[data-tauri-drag-region]'),
  buttonInBarDrag: [...document.querySelectorAll('#bar [data-tauri-drag-region]')].filter((el) => el.querySelector('button')).length,
  tabDragRegionIsTabs: document.getElementById('tabs').getAttribute('data-tauri-drag-region') === ''
})`));
check('工具栏有可拖区（文档名 + 空白）', drag0.bar === 2, `count=${drag0.bar}`);
check('标签条整体可拖', drag0.tabs === true);
check('标签条尾部填充块存在且可拖', drag0.fill === true);
check('工具栏可拖区内没有按钮（避免误触拖窗）', drag0.buttonInBarDrag === 0, `buttons=${drag0.buttonInBarDrag}`);

/* ---------- 4) 页面阴影与间距（空 → 打开文档后量） ---------- */
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(6500);
const geom = JSON.parse(await js(`(function(){
  const pages = document.getElementById('pages');
  const ps = [...document.querySelectorAll('.page')];
  const cs = getComputedStyle(pages);
  const c0 = getComputedStyle(ps[0]);
  const r0 = ps[0].getBoundingClientRect(), r1 = ps[1].getBoundingClientRect();
  return JSON.stringify({
    gap: Math.round(r1.top - r0.bottom),
    padTop: cs.paddingTop,
    padBottom: cs.paddingBottom,
    shadow: c0.boxShadow,
    radius: c0.borderRadius,
    disabled: ['btnPrev','btnNext','btnCopy','btnExport'].filter((k) => document.getElementById(k).disabled).length,
    piDisabled: document.getElementById('pageInput').disabled
  });
})()`));
check('页间距 ≥ 28px（原 22）', geom.gap >= 28, `gap=${geom.gap}px`);
check('上下留白加大', parseFloat(geom.padTop) >= 30 && parseFloat(geom.padBottom) >= 70, `top=${geom.padTop} bottom=${geom.padBottom}`);
check('页面有纸张投影（多层）', (geom.shadow.match(/rgba|rgb/g) || []).length >= 3, `shadow=${geom.shadow.slice(0, 60)}`);
check('页面有圆角', parseFloat(geom.radius) >= 3, `radius=${geom.radius}`);
check('打开文档后按钮恢复可点', geom.disabled === 0 && geom.piDisabled === false, `disabled=${geom.disabled} pi=${geom.piDisabled}`);

// 标签条已显示：量填充块实际宽度（隐藏时整条高度为 0，量不到）
const fillW = await js(`Math.round(document.querySelector('.tab-fill').getBoundingClientRect().width)`);
check('标签条填充块占满剩余空间', fillW > 100, `w=${fillW}`);

// 双页模式：横向间距小于纵向
await js(`document.getElementById('btnSpread').click()`);
await sleep(1600);
const spread = JSON.parse(await js(`(function(){
  const ps = [...document.querySelectorAll('.page')];
  const r0 = ps[0].getBoundingClientRect(), r1 = ps[1].getBoundingClientRect();
  return JSON.stringify({ colGap: Math.round(r1.left - r0.right), rowGap: Math.round(ps[2].getBoundingClientRect().top - r0.bottom) });
})()`));
check('双页横向间距 18px', spread.colGap === 18, `col=${spread.colGap}`);
check('双页纵向间距大于横向', spread.rowGap > spread.colGap, `row=${spread.rowGap} col=${spread.colGap}`);

/* ---------- 5) 截图 ---------- */
if (outPng) {
  await js(`document.getElementById('btnSpread').click()`);
  await sleep(1400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (logs.length) console.log('LOGS:\n' + logs.join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
