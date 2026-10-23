/* CDP 拉取导出测试结果：读取 window.__out 与产物字节 */
import fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8124/spike/export_test.html';
const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9222') + '/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
// 等待执行完成
let title = '';
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  title = (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.result.value;
  if (title === 'done' || title === 'FAIL') break;
}
console.log('title:', title);
const q = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__out)', returnByValue: true });
const rows = JSON.parse(q.result.result.value || '[]');
for (const [k, v] of rows) console.log(k.padEnd(12), v);
if (title === 'done') {
  const pull = async (key, file) => {
    const r2 = await send('Runtime.evaluate', {
      expression: `(() => { const b = window.${key}; let s=''; const CH=0x8000; for (let i=0;i<b.length;i+=CH) s += String.fromCharCode.apply(null, b.subarray(i,i+CH)); return btoa(s); })()`,
      returnByValue: true
    });
    fs.writeFileSync(file, Buffer.from(r2.result.result.value, 'base64'));
    console.log('saved', file, fs.statSync(file).size, 'bytes');
  };
  await pull('__pdf', 'D:/tmp/export_test.pdf');
  await pull('__zip', 'D:/tmp/export_test.zip');
  await pull('__png', 'D:/tmp/export_test_p1.png');
}
ws.close();
process.exit(0);
