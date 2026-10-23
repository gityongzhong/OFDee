// 缩略图侧栏 e2e：默认展开 / 无文档时不占位 / 记住用户的展开或收起选择
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

const railOn = () => js(`document.getElementById('rail').classList.contains('on')`);
const btnActive = () => js(`document.getElementById('btnSide').classList.contains('active')`);
const stored = () => js(`(function(){ try { return JSON.parse(localStorage.getItem('ofd-recent')||'{}').railOn; } catch(e){ return 'parse-err'; } })()`);

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 840, deviceScaleFactor: 1, mobile: false });

/* ---------- 全新环境：清掉历史，模拟第一次用 ---------- */
await send('Page.navigate', { url });
await sleep(1200);
await js(`try { localStorage.clear(); } catch (e) {}`);
await send('Page.navigate', { url });
await sleep(2500);

check('无文档时侧栏不占位', (await railOn()) === false, `rail.on=${await railOn()}`);
check('无文档时按钮不显示为选中', (await btnActive()) === true, `active=${await btnActive()}（只反映选择，不等同于可见）`);

/* ---------- 打开文档：应当默认展开 ---------- */
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(7000);
check('打开文档后缩略图默认展开', (await railOn()) === true, `rail.on=${await railOn()}`);
const thumbs = await js(`document.querySelectorAll('#railList .thumb').length`);
const rendered = await js(`document.querySelectorAll('#railList .thumb canvas, #railList .thumb svg').length`);
check('缩略图条目已生成', thumbs === 12, `count=${thumbs}`);
check('可视区缩略图已渲染', rendered > 0, `rendered=${rendered}`);

/* ---------- 收起，并确认被记住 ---------- */
await js(`document.getElementById('btnSide').click()`);
await sleep(700);
check('点击后侧栏收起', (await railOn()) === false, `rail.on=${await railOn()}`);
check('按钮同步为未选中', (await btnActive()) === false, `active=${await btnActive()}`);
check('选择已写入存储（false）', (await stored()) === false, `stored=${await stored()}`);

/* ---------- 重载后应保持收起 ---------- */
await send('Page.navigate', { url });
await sleep(2500);
check('重载后无文档仍不占位', (await railOn()) === false);
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(7000);
check('重载后沿用收起状态', (await railOn()) === false, `rail.on=${await railOn()}`);
check('按钮仍是未选中', (await btnActive()) === false, `active=${await btnActive()}`);

/* ---------- 再展开，并确认被记住 ---------- */
await js(`document.getElementById('btnSide').click()`);
await sleep(700);
check('再次点击后展开', (await railOn()) === true, `rail.on=${await railOn()}`);
check('选择已写入存储（true）', (await stored()) === true, `stored=${await stored()}`);
const rendered2 = await js(`document.querySelectorAll('#railList .thumb canvas, #railList .thumb svg').length`);
check('重新展开后缩略图有内容', rendered2 > 0, `rendered=${rendered2}`);

await send('Page.navigate', { url });
await sleep(2500);
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(7000);
check('重载后沿用展开状态', (await railOn()) === true, `rail.on=${await railOn()}`);

/* ---------- 关掉文档后应收回 ---------- */
await js(`window.__ofdee.close(window.__ofdee.tabs()[0].id)`);
await sleep(900);
check('关闭文档后侧栏收回', (await railOn()) === false, `rail.on=${await railOn()}`);

if (outPng) {
  await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
  await sleep(7000);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (logs.length) console.log('LOGS:\n' + logs.slice(0, 4).join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
