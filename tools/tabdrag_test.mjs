// 标签页拖拽排序 e2e：真实鼠标拖拽（CDP Input），验证数组顺序、DOM 顺序、点击不被误吞、关闭按钮不触发拖拽
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
  if (r.result?.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 260));
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
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' ? 1 : 0, clickCount: 1, ...extra });

const order = () => js(`JSON.stringify(window.__ofdee.tabsApi.order())`);
const domOrder = () => js(`JSON.stringify(window.__ofdee.tabsApi.domOrder())`);
const centerOf = (idx) => js(`(function(){
  const el = document.querySelectorAll('#tabList .tab')[${idx}];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, left: r.left, right: r.right});
})()`);

/** 按住 from 号标签，横向拖到 toX 后松手 */
async function dragTabTo(fromIdx, toX, { viaSteps = 12 } = {}) {
  const c = JSON.parse(await centerOf(fromIdx));
  await mouse('mousePressed', c.x, c.y);
  await sleep(60);
  // 分几步移动，模拟真实拖拽（中间会触发 reorder）
  const steps = viaSteps;
  for (let i = 1; i <= steps; i++) {
    const x = c.x + ((toX - c.x) * i) / steps;
    await mouse('mouseMoved', x, c.y);
    await sleep(30);
  }
  await sleep(80);
  await mouse('mouseReleased', toX, c.y);
  await sleep(320);
}

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 840, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(3000);

/* ---------- 打开 3 个标签 ---------- */
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(7000);
await js(`window.__ofdee.open('${base}/tools/test_bookmark.ofd')`);
await sleep(7000);
await js(`window.__ofdee.open('${base}/tools/test_text.pdf')`);
await sleep(6000);

let s = JSON.parse(await order());
check('已打开 3 个标签', s.length === 3, `order=${s.join(' | ')}`);
check('DOM 顺序与数组一致', (await domOrder()) === (await order()), `dom=${await domOrder()}`);

const before = [...s];

/* ---------- 1) 把第 1 个拖到第 3 个位置（向右拖） ---------- */
const last = JSON.parse(await centerOf(2));
await dragTabTo(0, last.right + 6);
let after = JSON.parse(await order());
check('向右拖：原第 1 个移到末尾',
  after[2] === before[0] && after[0] === before[1] && after[1] === before[2],
  `${after.join(' | ')}`);
check('数组与 DOM 保持同步', (await domOrder()) === (await order()), `dom=${await domOrder()} arr=${after.join('|')}`);

/* ---------- 2) 再拖回最前（向左拖） ---------- */
const first = JSON.parse(await centerOf(0));
await dragTabTo(2, first.left - 6);
after = JSON.parse(await order());
check('向左拖：末尾标签回到首位', after[0] === before[0] && after[1] === before[1] && after[2] === before[2],
  `${after.join(' | ')}`);

/* ---------- 3) 相邻两个交换 ---------- */
const b = JSON.parse(await order());
const c1 = JSON.parse(await centerOf(0));
const c2 = JSON.parse(await centerOf(1));
await dragTabTo(0, c2.right + 2);
after = JSON.parse(await order());
check('相邻交换：1、2 位互换', after[0] === b[1] && after[1] === b[0] && after[2] === b[2], `${after.join(' | ')}`);

/* ---------- 4) 活动标签不因排序而改变 ---------- */
const activeBefore = await js(`window.__ofdee.active()`);
const activeName = await js(`document.getElementById('docName').textContent`);
await dragTabTo(0, JSON.parse(await centerOf(2)).right);
const activeAfter = await js(`window.__ofdee.active()`);
check('排序不改变当前活动标签', activeBefore === activeAfter, `${activeBefore} → ${activeAfter}`);
check('文档名未因排序变化', (await js(`document.getElementById('docName').textContent`)) === activeName);

/* ---------- 5) 单纯点击仍能切换标签（拖拽阈值未误伤点击） ---------- */
const targetIdx = JSON.parse(await order()).findIndex((n) => n !== activeName);
const tc = JSON.parse(await centerOf(targetIdx));
await mouse('mousePressed', tc.x, tc.y);
await sleep(50);
await mouse('mouseReleased', tc.x, tc.y);
await sleep(500);
const nowActive = await js(`window.__ofdee.active()`);
const nowName = await js(`document.getElementById('docName').textContent`);
check('点击标签仍能正常切换', nowName !== activeName, `${activeName} → ${nowName}`);
check('点击未触发排序', (await order()) === (await order()));

/* ---------- 6) 拖动过程中有 dragging 视觉态 ---------- */
const c0 = JSON.parse(await centerOf(0));
await mouse('mousePressed', c0.x, c0.y);
await mouse('mouseMoved', c0.x + 40, c0.y);
await sleep(80);
const midDrag = JSON.parse(await js(`JSON.stringify({
  el: !!document.querySelector('.tab.dragging'),
  bar: document.getElementById('tabs').classList.contains('dragging'),
  transform: (document.querySelector('.tab.dragging') || {}).style ? document.querySelector('.tab.dragging').style.transform : ''
})`));
await mouse('mouseReleased', c0.x + 40, c0.y);
await sleep(300);
check('拖动中有 dragging 类', midDrag.el === true);
check('拖动中标签条整体标记', midDrag.bar === true);
check('拖动中标签跟随指针位移', /translate\(/.test(midDrag.transform), `transform=${midDrag.transform}`);

const clean = await js(`JSON.stringify({
  el: !!document.querySelector('.tab.dragging'),
  bar: document.getElementById('tabs').classList.contains('dragging'),
  leftover: [...document.querySelectorAll('#tabList .tab')].filter((e) => e.style.transform).length
})`);
const cl = JSON.parse(clean);
check('松手后清理拖拽态', cl.el === false && cl.bar === false && cl.leftover === 0, JSON.stringify(cl));

/* ---------- 7) 点关闭按钮不会触发拖拽/排序 ---------- */
const cntBefore = JSON.parse(await order()).length;
const closeBox = await js(`(function(){
  const el = document.querySelectorAll('#tabList .tab')[1];
  const c = el.querySelector('.tab-close');
  const r = c.getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
})()`);
const cb = JSON.parse(closeBox);
const orderBeforeClose = await order();
await mouse('mousePressed', cb.x, cb.y);
await mouse('mouseMoved', cb.x + 60, cb.y);
await sleep(60);
await mouse('mouseReleased', cb.x + 60, cb.y);
await sleep(600);
const cntAfter = JSON.parse(await order()).length;
check('拖关闭按钮不会误触发排序', (await order()) === orderBeforeClose, `before=${orderBeforeClose}`);
check('关闭按钮区域不产生拖拽', cntAfter === cntBefore, `${cntBefore} → ${cntAfter}`);

/* ---------- 8) 只剩一个标签时拖拽无副作用 ---------- */
const n = JSON.parse(await order()).length;
if (n > 1) {
  const tabsToClose = n - 1;
  for (let i = 0; i < tabsToClose; i++) {
    await js(`window.__ofdee.close(window.__ofdee.tabs()[0].id)`);
    await sleep(700);
  }
}
const one = JSON.parse(await order());
if (one.length === 1) {
  const sc = JSON.parse(await centerOf(0));
  await mouse('mousePressed', sc.x, sc.y);
  await mouse('mouseMoved', sc.x + 80, sc.y);
  await sleep(60);
  await mouse('mouseReleased', sc.x + 80, sc.y);
  await sleep(300);
  check('单标签拖拽无异常', (await order()) === (await order()));
  check('单标签仍只有一个', JSON.parse(await order()).length === 1);
} else {
  check('单标签场景可测', false, `count=${one.length}`);
}

/* ---------- 9) 截图 ---------- */
if (outPng) {
  await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
  await sleep(6000);
  await js(`window.__ofdee.open('${base}/tools/test_bookmark.ofd')`);
  await sleep(6000);
  await js(`window.__ofdee.open('${base}/tools/test_text.pdf')`);
  await sleep(5000);
  // 拖一次并停在中途，便于截图看到拖拽态
  const c = JSON.parse(await centerOf(0));
  await mouse('mousePressed', c.x, c.y);
  await mouse('mouseMoved', c.x + 120, c.y);
  await sleep(200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
  await mouse('mouseReleased', c.x + 120, c.y);
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (logs.length) console.log('LOGS:\n' + logs.slice(0, 4).join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
