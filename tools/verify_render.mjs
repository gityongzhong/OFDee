// 真实文件渲染验证：打开 bug248.ofd，检查逐字 x 坐标是否正常
// 关注：NaN 坐标、相邻间距异常（<3mm 即为旧版 g 语法解析错误的典型表现）、是否递增
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
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error('eval error: ' + JSON.stringify(d).slice(0, 400));
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, cond, extra = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`;
  results.push(line);
  console.log(line);
};

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(2500);
await js(`try { localStorage.clear(); } catch (e) {}`);
await send('Page.navigate', { url });
await sleep(2500);

/* ---------------- 打开真实文件 ---------------- */
await js(`window.__ofdee.open('${base}/tools/bug248.ofd')`);
await sleep(9000);

const info = await js(`JSON.stringify((function(){
  return {
    pages: document.querySelectorAll('.page').length,
    tabs: (window.__ofdee.tabsApi.order ? window.__ofdee.tabsApi.order() : [])
  };
})())`).then((s) => JSON.parse(s));
check('文档已打开', info.pages === 6, `pages=${info.pages} tabs=${JSON.stringify(info.tabs)}`);

/* ---------------- 等所有页渲染完 ---------------- */
await js(`(async () => {
  const n = document.querySelectorAll('.page').length;
  for (let i = 0; i < n; i++) {
    // 触发懒渲染：滚动到每页
    const el = document.querySelector('.page[data-index="' + i + '"]');
    if (el) el.scrollIntoView();
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 2500));
  return true;
})()`);
await sleep(4000);

/* ---------------- 采集逐字 x 坐标 ---------------- */
const stats = await js(`JSON.stringify((function(){
  const texts = [...document.querySelectorAll('.page svg text')];
  let nan = 0, nonMono = 0, sampled = 0;
  // 按「前一个字符」的类型分组：汉字 vs 西文/数字
  const byKind = { cjk: [], ascii: [] };
  const outliers = [];
  for (const t of texts) {
    const xsAttr = t.getAttribute('x');
    if (!xsAttr) continue;
    const xs = xsAttr.trim().split(/\\s+/).map(Number);
    const chars = [...(t.textContent || '')];
    if (xs.some(v => !isFinite(v))) { nan++; continue; }
    const gaps = [];
    for (let i = 1; i < xs.length; i++) {
      const g = xs[i] - xs[i-1];
      sampled++;
      if (g <= 0) { nonMono++; continue; }
      gaps.push({ g, i });
      const ch = chars[i-1] || '';
      byKind[/[\\u0020-\\u007e]/.test(ch) ? 'ascii' : 'cjk'].push(g);
    }
    // 同一行（同一 TextCode）内字号一致，间距应基本均匀。
    // 旧版把 g 的「重复次数」当间距，会在一串 5.8 里突然插入 2.0 —— 正是这种离群。
    if (gaps.length < 4) continue;
    const ms = gaps.map(o => o.g).sort((a,b) => a-b);
    const m = ms[Math.floor(ms.length / 2)];
    if (!m) continue;
    for (const o of gaps) {
      if (o.g < m * 0.6 || o.g > m * 1.6) {
        if (outliers.length < 8) {
          outliers.push({ text: (t.textContent||'').slice(0,24), gap: +o.g.toFixed(3), median: +m.toFixed(3) });
        }
      }
    }
  }
  const stat = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a,b)=>a-b);
    const q = (p) => +s[Math.floor(s.length*p)].toFixed(3);
    return { n: arr.length, min: q(0), p05: q(0.05), median: q(0.5), p95: q(0.95), max: q(0.999) };
  };
  return { textEls: texts.length, sampled, nan, nonMono,
           cjk: stat(byKind.cjk), ascii: stat(byKind.ascii),
           outlierCount: outliers.length, outliers };
})())`).then((s) => JSON.parse(s));

console.log('\n--- 逐字间距统计（单位 mm，按字符类型分组）---');
console.log(JSON.stringify(stats, null, 2));
console.log('');

check('无 NaN 坐标', stats.nan === 0, `nan=${stats.nan}`);
check('字符坐标单调递增（无重叠/回退）', stats.nonMono === 0, `nonMono=${stats.nonMono}/${stats.sampled}`);
check('汉字间距稳定在正文字号区间', stats.cjk && stats.cjk.median > 5.5 && stats.cjk.median < 6.0,
  `median=${stats.cjk?.median} p05=${stats.cjk?.p05} p95=${stats.cjk?.p95}`);
check('行内字距均匀（无突变离群）', stats.outlierCount === 0,
  `outliers=${stats.outlierCount}${stats.outliers.length ? ' 例:' + JSON.stringify(stats.outliers[0]) : ''}`);
check('西文/数字间距合理', stats.ascii && stats.ascii.median > 2.5 && stats.ascii.median < 4.5,
  `median=${stats.ascii?.median}`);

/* ---------------- 截图 ---------------- */
if (outPng) {
  await js(`document.getElementById('stage').scrollTo(0, 0)`);
  await sleep(1200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
  console.log(`\n截图已保存: ${outPng}`);
}

console.log('\n--- 未捕获异常 ---');
console.log(errs.length ? errs.join('\n') : '(无)');

const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过');
process.exit(failed.length ? 1 : 0);
