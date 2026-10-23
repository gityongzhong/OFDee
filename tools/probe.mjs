// 诊断探针：连上已运行的 headless Chrome，打开应用页，抓控制台错误与 __ofdee 状态
const url = process.argv[2] || 'http://127.0.0.1:8765/ui/index.html';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('没有可用的页面 target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const errs = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = m.params.type;
    if (t === 'error' || t === 'warning') {
      logs.push(`[console.${t}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errs.push('[exception] ' + (d?.exception?.description || d?.text) + '\n' +
      (d?.stackTrace?.callFrames || []).slice(0, 6)
        .map((f) => `    at ${f.functionName || '(anon)'} ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`).join('\n'));
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error') logs.push(`[log.${e.level}] ${e.text} ${e.url || ''}:${e.lineNumber}`);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails;
    return { __err: (d.exception?.description || d.text) + '\n' +
      (d.stackTrace?.callFrames || []).slice(0, 6)
        .map((f) => `    at ${f.functionName || '(anon)'} ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`).join('\n') };
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 880, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(4000);

console.log('=== 页面地址 ===');
console.log(await js('location.href'));
console.log('\n=== document.readyState ===');
console.log(await js('document.readyState'));
console.log('\n=== window.__ofdee 是否存在 ===');
console.log(await js('typeof window.__ofdee'));
console.log('\n=== __ofdee 的键 ===');
console.log(await js('JSON.stringify(Object.keys(window.__ofdee || {}))'));

console.log('\n=== 控制台错误 ===');
console.log(logs.length ? logs.join('\n') : '(无)');
console.log('\n=== 未捕获异常 ===');
console.log(errs.length ? errs.join('\n') : '(无)');

process.exit(0);
