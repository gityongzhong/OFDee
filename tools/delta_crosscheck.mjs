// 交叉比对：Python 按标准展开 vs JS parseDelta()
// 输入由 tools/dump_delta.py 生成（真实 OFD 全量 TextCode）
import { readFileSync } from 'node:fs';
import { parseDelta } from '../ui/js/ofd.js';

const file = process.argv[2] || 'tools/delta.json';
const rows = JSON.parse(readFileSync(file, 'utf8'));

let total = 0;
let bad = 0;
const badSamples = [];

const near = (a, b) => Math.abs(a - b) < 1e-6;

for (const r of rows) {
  const chars = [...r.text].length;
  for (const axis of ['dx', 'dy']) {
    const raw = r[axis];
    if (!raw) continue;
    total++;
    const want = r[axis + 'Exp'];
    const got = parseDelta(raw, chars);
    const ok =
      got.length === want.length &&
      got.every((v, i) => near(v, want[i]));
    if (!ok) {
      bad++;
      if (badSamples.length < 10) {
        badSamples.push({
          part: r.part,
          text: r.text.slice(0, 30),
          axis,
          raw,
          want: want.slice(0, 12),
          got: got.slice(0, 12),
        });
      }
    }
  }
}

console.log(`比对 ${total} 条 Delta（来自 ${new Set(rows.map((r) => r.part)).size} 个 Content.xml）`);
if (bad) {
  console.log(`\n${bad} 条不一致：`);
  for (const s of badSamples) console.log(JSON.stringify(s, null, 2));
  process.exit(1);
}
console.log('全部一致 ✓');
