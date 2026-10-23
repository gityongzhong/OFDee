// 主题三档 e2e：跟随系统 / 深色 / 浅色 + 设置面板联动 + 持久化 + 浅色无残留暗色
import { writeFileSync } from 'node:fs';

const [base, outDir] = process.argv.slice(2);
const url = base + '/ui/index.html';

const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9230') + '/json/list')).json();
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

// 模拟系统主题：Emulation.setEmulatedMedia
const setSystemDark = (dark) =>
  send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]
  });

await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
await setSystemDark(true);
await js(`localStorage.clear()`).catch(() => {});
await send('Page.navigate', { url });
await sleep(3000);
await js(`localStorage.clear()`);
await send('Page.navigate', { url });
await sleep(2600);

/* ---------- 1) 设置面板里的三档控件 ---------- */
const seg = JSON.parse(await js(`JSON.stringify({
  exists: !!document.getElementById('segTheme'),
  labels: [...document.querySelectorAll('#segTheme .seg-btn span')].map((s) => s.textContent),
  values: [...document.querySelectorAll('#segTheme .seg-btn')].map((b) => b.dataset.themeVal),
  pressed: [...document.querySelectorAll('#segTheme .seg-btn')].map((b) => b.getAttribute('aria-pressed')),
  inSettings: !!document.querySelector('#settings .set-body #segTheme'),
  hasIcons: document.querySelectorAll('#segTheme .seg-btn svg').length,
  title: (document.querySelector('#segTheme') || {}).getAttribute ? document.querySelector('#segTheme').getAttribute('aria-label') : ''
})`));
check('设置面板内有外观分组', seg.inSettings === true);
check('三档标签为 跟随系统/深色/浅色', JSON.stringify(seg.labels) === JSON.stringify(['跟随系统', '深色', '浅色']), `labels=${seg.labels.join(',')}`);
check('三档取值为 system/dark/light', JSON.stringify(seg.values) === JSON.stringify(['system', 'dark', 'light']), `values=${seg.values.join(',')}`);
check('每档都有图标', seg.hasIcons === 3, `icons=${seg.hasIcons}`);
check('默认「跟随系统」选中', seg.pressed[0] === 'true' && seg.pressed[1] === 'false' && seg.pressed[2] === 'false', `pressed=${seg.pressed.join(',')}`);

/* ---------- 2) 深色下各区块实际颜色 ---------- */
const probe = () => js(`(function(){
  const g = (sel, prop) => {
    const el = document.querySelector(sel);
    if (!el) return 'MISSING';
    const cs = getComputedStyle(el);
    return prop === 'bg' ? cs.backgroundColor : cs.color;
  };
  return JSON.stringify({
    theme: document.documentElement.getAttribute('data-theme'),
    bar: g('#bar', 'bg'),
    stage: g('#stage', 'bg'),
    status: g('#status', 'bg'),
    text: g('#bar', 'color'),
    paper: g('.page', 'bg'),
    lineSchema: getComputedStyle(document.documentElement).getPropertyValue('--line').trim()
  });
})()`);

// 打开一份文档，才有 .page 可量
await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
await sleep(6000);

await js(`window.__ofdee.theme.set('dark')`);
await sleep(400);
let d = JSON.parse(await probe());
check('深色：html[data-theme=dark]', d.theme === 'dark', `theme=${d.theme}`);
check('深色：工具栏为深底', d.bar === 'rgb(23, 26, 32)', `bar=${d.bar}`);
check('深色：阅读区为深底', d.stage === 'rgb(15, 17, 21)', `stage=${d.stage}`);
check('深色：文字为浅色', d.text === 'rgb(231, 233, 238)', `text=${d.text}`);
check('深色：纸张仍为白色', d.paper === 'rgb(255, 255, 255)', `paper=${d.paper}`);

/* ---------- 3) 切到浅色 ---------- */
await js(`window.__ofdee.theme.set('light')`);
await sleep(500);
let l = JSON.parse(await probe());
check('浅色：html[data-theme=light]', l.theme === 'light', `theme=${l.theme}`);
check('浅色：工具栏为浅底', l.bar === 'rgb(247, 248, 250)', `bar=${l.bar}`);
check('浅色：阅读区为浅灰底', l.stage === 'rgb(233, 235, 238)', `stage=${l.stage}`);
check('浅色：文字为深色', l.text === 'rgb(34, 38, 45)', `text=${l.text}`);
check('浅色：纸张仍为白色', l.paper === 'rgb(255, 255, 255)', `paper=${l.paper}`);
check('浅色：分组线与深色不同', l.lineSchema !== d.lineSchema, `light=${l.lineSchema} dark=${d.lineSchema}`);
check('浅色：color-scheme 同步为 light', (await js(`getComputedStyle(document.documentElement).colorScheme`)) === 'light');
check('浅色：分段控件选中「浅色」', (await js(`document.querySelector('#segTheme .seg-btn[data-theme-val="light"]').getAttribute('aria-pressed')`)) === 'true');

/* ---------- 4) 全页面扫描：浅色下不该再有深色底块 ---------- */
const scan = JSON.parse(await js(`(function(){
  const bad = [];
  const els = document.querySelectorAll('body *');
  els.forEach((el) => {
    if (el.closest('#pages')) return;          // 文档纸张本身就是白色，跳过
    if (el.closest('.page')) return;
    if (el.closest('.tip')) return;            // 气泡是浮层，深底白字在两种主题下都成立
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const m = bg.match(/rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/);
    if (!m) return;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a < 0.5) return;                        // 半透明遮罩不算
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 90) {
      const tag = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
      bad.push({ el: tag, bg, lum: Math.round(lum) });
    }
  });
  // 同样扫一遍文字色：深底已排除，这里只看浅白文字
  return JSON.stringify({ bad: bad.slice(0, 12), total: bad.length });
})()`));
check('浅色：无残留深色底块', scan.total === 0, scan.total ? JSON.stringify(scan.bad) : 'clean');

/* ---------- 5) 跟随系统 ---------- */
await setSystemDark(false);
await sleep(200);
await js(`window.__ofdee.theme.set('system')`);
await sleep(500);
let sys = JSON.parse(await probe());
check('跟随系统：系统浅色 → 界面浅色', sys.theme === 'light', `theme=${sys.theme}`);
const note = await js(`document.getElementById('themeNote').textContent`);
check('提示文案说明当前系统取色', /跟随系统/.test(note) && /浅色/.test(note), `note=${note}`);

await setSystemDark(true);
await sleep(700);
sys = JSON.parse(await probe());
check('系统切深色 → 界面自动跟随变深', sys.theme === 'dark', `theme=${sys.theme}`);
const note2 = await js(`document.getElementById('themeNote').textContent`);
check('提示文案随之更新', /深色/.test(note2), `note=${note2}`);

// 非 system 档位时，系统切换不应影响
await js(`window.__ofdee.theme.set('light')`);
await sleep(300);
await setSystemDark(false);
await sleep(200);
await setSystemDark(true);
await sleep(600);
check('固定浅色时不受系统变化影响', (await js(`document.documentElement.getAttribute('data-theme')`)) === 'light');

/* ---------- 6) 持久化 ---------- */
await js(`window.__ofdee.theme.set('light')`);
await sleep(300);
await sleep(700);
await send('Page.navigate', { url });
await sleep(2800);
const persisted = JSON.parse(await js(`JSON.stringify({
  theme: window.__ofdee.theme.get(),
  eff: document.documentElement.getAttribute('data-theme'),
  pressed: [...document.querySelectorAll('#segTheme .seg-btn')].map((b) => b.getAttribute('aria-pressed')),
  ls: localStorage.getItem('ofdee-theme')
})`));
check('重载后仍是浅色', persisted.theme === 'light' && persisted.eff === 'light', `theme=${persisted.theme} eff=${persisted.eff}`);
check('重载后分段控件回显选中', persisted.pressed[2] === 'true', `pressed=${persisted.pressed.join(',')}`);
check('选择已写入本地存储', persisted.ls === 'light', `ls=${persisted.ls}`);

/* ---------- 7) 首屏防闪：导航后立刻读主题 ---------- */
const raw = await send('Page.navigate', { url });
await sleep(120);
const early = await js(`document.documentElement.getAttribute('data-theme')`);
check('首屏 120ms 内已是正确主题（无闪白）', early === 'light', `early=${early}`);

/* ---------- 8) 键盘方向键切换 ---------- */
await sleep(2200);
await js(`window.__ofdee.settings.open()`);
await sleep(400);
await js(`document.querySelector('#segTheme .seg-btn[data-theme-val="light"]').focus()`);
const focusOk = await js(`document.activeElement && document.activeElement.dataset.themeVal`);
check('分段按钮可获得焦点', focusOk === 'light', `active=${focusOk}`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
await sleep(500);
const afterLeft = await js(`window.__ofdee.theme.get()`);
check('← 键从浅色切到深色', afterLeft === 'dark', `theme=${afterLeft}`);

/* ---------- 9) 截图：浅色 / 深色各一张 ---------- */
if (outDir) {
  await js(`window.__ofdee.open('${base}/tools/test_outline.pdf')`);
  await sleep(5000);
  await js(`document.getElementById('pageInput').value='3';document.getElementById('pageInput').dispatchEvent(new Event('change'))`);
  await sleep(1800);
  await js(`window.__ofdee.theme.set('light')`);
  await sleep(700);
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outDir + '/_theme_light.png', Buffer.from(shot.result.data, 'base64'));

  await js(`window.__ofdee.settings.open()`);
  await sleep(800);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outDir + '/_theme_settings.png', Buffer.from(shot.result.data, 'base64'));
  await js(`window.__ofdee.settings.close()`);

  await js(`window.__ofdee.theme.set('dark')`);
  await sleep(700);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(outDir + '/_theme_dark.png', Buffer.from(shot.result.data, 'base64'));
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
if (logs.length) console.log('LOGS:\n' + logs.slice(0, 5).join('\n'));
ws.close();
process.exit(failed ? 1 : 0);
