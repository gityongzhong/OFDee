// 界面图批量截取：用真实渲染管线产出用于 README / 产品页的截图
// 用法：node tools/shots.mjs <base> <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';

const [base, outDir] = process.argv.slice(2);
if (!base || !outDir) throw new Error('用法: node tools/shots.mjs <base> <outDir>');
mkdirSync(outDir, { recursive: true });

const W = 1560, H = 980;

const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9222') + '/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('没有可用的页面 target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
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

const shot = async (name) => {
  // 先发一次视口模拟（等效 resize）触发整帧重绘，再截两张取后一张
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  await send('Page.captureScreenshot', { format: 'png' });
  await sleep(900);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = `${outDir}/${name}.png`;
  writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  console.log(`  → ${p}`);
};
// 深色场景专用：GPU 合成下主题重绘严重滞后，连拍候选帧，事后按亮度选帧
const burst = async (prefix, n = 8) => {
  const paths = [];
  for (let i = 0; i < n; i++) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = `${outDir}/${prefix}_${i}.png`;
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    paths.push(p);
    await sleep(600);
  }
  return paths;
};

const open = async (p, wait = 9000) => { await js(`window.__ofdee.open('${p}')`); await sleep(wait); };

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: base + '/ui/index.html' });
await sleep(2500);
await js(`try { localStorage.clear(); } catch (e) {}`);
await send('Page.navigate', { url: base + '/ui/index.html' });
await sleep(2500);

/* ---------- 1. 主界面：OFD 文档 + 缩略图侧栏 ---------- */
console.log('[1/6] 主界面（OFD 浅色）');
await js(`try { localStorage.clear(); } catch (e) {}`);
await send('Page.navigate', { url: base + '/ui/index.html' });
await sleep(2500);
await open(base + '/tools/demo.ofd');
await js(`document.getElementById('stage').scrollTo(0, 0)`);
await sleep(1200);
await shot('main');

/* ---------- 2. 目录侧栏 ---------- */
console.log('[2/6] 目录侧栏');
await js(`document.getElementById('btnOutline').click()`);
await sleep(2500);
await shot('outline');

/* ---------- 3. 旋转菜单（浅色） ---------- */
console.log('[3/6] 旋转菜单');
await js(`(function(){
  const w = document.getElementById('rotateWrap') || document.querySelector('.menu-wrap');
  if (!w) return 'no-wrap';
  const b = w.querySelector('button') || w;
  b.click();
  return 'ok';
})()`);
await sleep(1200);
await shot('rotate');
// 关掉菜单（点空白处）
await js(`document.getElementById('stage').click()`);
await sleep(600);

/* 注意：PDF 场景暂不截取 —— headless Chrome 155 下 pdf.js 的 canvas 绘制
   产出全白位图（独立最小页面复现同样结果，与 app 逻辑无关），而真实
   WebView2 环境未见此现象。界面图因此以 OFD 通道为主。 */

/* ---------- 4. 深色模式 ---------- */
console.log('[4/5] 深色模式');
// 先关掉目录面板（制造一次可见的布局变化），再切深色
await js(`(function(){
  const p = document.getElementById('outline');
  if (p && p.classList.contains('on')) document.getElementById('btnOutline').click();
  return 'ok';
})()`);
await sleep(800);
await js(`window.__ofdee.theme.set('dark')`);
await sleep(2500);
console.log('   theme after set:', await js(`document.documentElement.getAttribute('data-theme')`));
await burst('dark_cand');

/* ---------- 5. 空状态（浅色） ---------- */
console.log('[5/5] 空状态');
await js(`window.__ofdee.theme.set('light')`);
await sleep(1200);
console.log('[6/6] 空状态');
await js(`(async function(){
  const ids = window.__ofdee.tabs ? (window.__ofdee.tabs().map(t => t.id)) : [];
  for (const tid of ids) { try { window.__ofdee.close(tid); } catch(e){} }
  return ids.length;
})()`);
await sleep(1800);
await shot('empty');

console.log('\n--- 未捕获异常 ---');
console.log(errs.length ? errs.join('\n') : '(无)');
console.log('\n完成');
process.exit(0);
