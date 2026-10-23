// 设置面板 UI 逻辑 e2e（注册表副作用已由 CLI 路径验证，这里只验证前端交互与桩桥接）
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

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
// 注入 mock __TAURI__（页面加载前）
const mock = `
  window.__assocState = { on: false, calls: [] };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        window.__assocState.calls.push(cmd + ':' + JSON.stringify(args || {}));
        if (cmd === 'assoc_status') return window.__assocState.on ? 'ofd' : '';
        if (cmd === 'assoc_set') {
          window.__assocState.on = !!(args && args.enable);
          return window.__assocState.on ? '已关联 .ofd 文件' : '已取消 .ofd 关联';
        }
        if (cmd === 'app_dir') return 'E:\\\\桌面文件';
        if (cmd === 'load_state') return '{}';
        if (cmd === 'startup_file') return null;
        return null;
      }
    }
  };
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: mock });
await send('Page.navigate', { url });
await sleep(2600);

// 1) 设置按钮 → 打开面板
let s = await js(`!!document.getElementById('btnSettings')`);
check('工具栏有设置按钮', s === true);
await js(`document.getElementById('btnSettings').click()`);
await sleep(800);
s = JSON.parse(await js(`JSON.stringify({
  on: document.getElementById('settings').classList.contains('on'),
  mask: document.getElementById('settingsMask').classList.contains('on'),
  checked: document.getElementById('swAssoc').getAttribute('aria-checked'),
  ver: document.getElementById('setVer').textContent,
  dir: document.getElementById('setExePath').textContent
})`));
check('面板与遮罩打开', s.on && s.mask, `on=${s.on} mask=${s.mask}`);
check('初始未关联', s.checked === 'false', `checked=${s.checked}`);
check('版本号正确', /^v\d+\.\d+\.\d+$/.test(s.ver), `ver=${s.ver}`);
check('显示程序目录', s.dir.includes('桌面文件') || s.dir.length > 2, `dir=${s.dir}`);

// 2) 点开关 → 开启
await js(`document.getElementById('swAssoc').click()`);
await sleep(900);
s = JSON.parse(await js(`JSON.stringify({
  checked: document.getElementById('swAssoc').getAttribute('aria-checked'),
  note: document.getElementById('assocNote').textContent,
  cls: document.getElementById('assocNote').className,
  calls: window.__assocState.calls
})`));
check('开关开启', s.checked === 'true', `checked=${s.checked}`);
check('提示关联成功', /已关联/.test(s.note), `note=${s.note}`);
check('成功样式', s.cls.includes('ok'), `cls=${s.cls}`);
check('调用 assoc_set(enable=true)', s.calls.some((c) => /assoc_set:.*"enable":true/.test(c)), `calls=${JSON.stringify(s.calls)}`);

// 3) 点行本身也能切换（整行可点）
await js(`document.getElementById('rowAssoc').click()`);
await sleep(900);
s = await js(`document.getElementById('swAssoc').getAttribute('aria-checked')`);
check('点击整行可关闭', s === 'false', `checked=${s}`);

// 4) 点开关内部的圆点不重复触发
await js(`document.querySelector('#swAssoc i').click()`);
await sleep(900);
s = JSON.parse(await js(`JSON.stringify({checked: document.getElementById('swAssoc').getAttribute('aria-checked'), n: window.__assocState.calls.filter(c=>c.startsWith('assoc_set')).length})`));
check('点圆点只触发一次切换', s.checked === 'true', `checked=${s.checked}`);

// 5) 遮罩点击关闭
await js(`document.getElementById('settingsMask').click()`);
await sleep(400);
s = await js(`document.getElementById('settings').classList.contains('on')`);
check('点遮罩关闭面板', s === false);

// 6) 重新打开读回状态（mock 内存里仍是 on）
await js(`document.getElementById('btnSettings').click()`);
await sleep(800);
s = await js(`document.getElementById('swAssoc').getAttribute('aria-checked')`);
check('重开读回已关联状态', s === 'true', `checked=${s}`);

// 7) Esc 关闭
await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
await sleep(400);
s = await js(`document.getElementById('settings').classList.contains('on')`);
check('Esc 关闭面板', s === false);

// 8) 关闭按钮
await js(`document.getElementById('btnSettings').click()`);
await sleep(600);
await js(`document.getElementById('btnSetClose').click()`);
await sleep(400);
s = await js(`document.getElementById('settings').classList.contains('on')`);
check('关闭按钮生效', s === false);

// 9) 无 Tauri 环境（浏览器直接打开）→ 开关禁用并有提示
// invoke 在 app.js 加载时已绑定（const invoke = TAURI ? ... : null），
// 因此只能新开一个干净的 page target（不带 mock 脚本）来复现浏览器环境。
const clean = await send('Target.createTarget', { url: 'about:blank' });
const cleanId = clean.result.targetId;
await send('Target.activateTarget', { targetId: cleanId });
const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep2(600);
// 找到新 target 的 ws，临时切过去
const list2 = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9222') + '/json/list')).json();
const p2 = list2.find((t) => t.id === cleanId);
const ws2 = new WebSocket(p2.webSocketDebuggerUrl);
let id2 = 0;
const pend2 = new Map();
ws2.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend2.has(m.id)) { pend2.get(m.id)(m); pend2.delete(m.id); }
});
const send2 = (method, params = {}) => new Promise((res) => { const mid = ++id2; pend2.set(mid, res); ws2.send(JSON.stringify({ id: mid, method, params })); });
const js2 = async (expr) => {
  const r = await send2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await new Promise((res) => ws2.addEventListener('open', res, { once: true }));
await send2('Page.enable');
await send2('Runtime.enable');
await send2('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
await send2('Page.navigate', { url });
await sleep2(2600);
s = JSON.parse(await js2(`(async () => {
  await new Promise((r) => setTimeout(r, 200));
  window.__ofdee && window.__ofdee.settings && window.__ofdee.settings.open();
  await new Promise((r) => setTimeout(r, 400));
  return JSON.stringify({
    hasTauri: !!window.__TAURI__,
    checked: document.getElementById('swAssoc').getAttribute('aria-checked'),
    busy: document.getElementById('swAssoc').classList.contains('busy'),
    note: (document.getElementById('assocNote') || {}).textContent || '',
    noteCls: (document.getElementById('assocNote') || {}).className || '',
    rowOp: (document.getElementById('rowAssoc') || {}).style ? document.getElementById('rowAssoc').style.opacity : ''
  });
})()`));
check('浏览器环境开关禁用', s.hasTauri === false && s.busy === true, `tauri=${s.hasTauri} busy=${s.busy}`);
check('浏览器环境提示文案', /仅在桌面程序/.test(s.note) && /err/.test(s.noteCls), `note=${s.note}`);
check('浏览器环境整行置灰', s.rowOp === '0.55', `op=${s.rowOp}`);
ws2.close();
await send('Target.closeTarget', { targetId: cleanId });
await send('Target.activateTarget', { targetId: page.id });

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (outPng) {
  await send('Page.navigate', { url });
  await sleep(2200);
  await js(`window.__ofdee && window.__ofdee.settings && window.__ofdee.settings.open()`);
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
}
if (logs.length) console.log('LOGS:\n' + logs.join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
