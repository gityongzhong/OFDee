import { parseDelta } from '../ui/js/ofd.js';
// 真实样本：文本与 DeltaX 直接取自 云金办便函〔2026〕248号.ofd
const cases = [
  ['个百分点。其中，', 'g 4 5.7996 5.7572 g 2 5.7996'],
  ['个百分点；人身险公司投诉', '5.6301 5.6726 g 2 5.6301 5.6726 g 2 5.6301 5.6726 g 2 5.6301 5.6726'],
  ['。其中，财产险公司投诉', 'g 7 5.6726 5.715 g 5 5.6726'],
  ['件。其中，终身寿险、两全寿险', 'g 7 5.6726 5.715 g 5 5.6726'],
  ['其中，健康保险', '5.715 5.6726 5.715 5.6726 5.715 5.6726'],
  ['二', 'g 2 2.7938'],
  ['银行保险', 'g 3 5.6726 5.6301'],
  ['000000', 'g 5 3.8946'],
  ['一二三四五六七八九十', 'g 7 5.6726 5.715 g 2 5.6726'],
];
let bad = 0;
for (const [txt, dx] of cases) {
  const v = parseDelta(dx, [...txt].length);
  const want = [...txt].length - 1;
  const ok = v.length === want;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'BAD '} chars=${[...txt].length} want=${want} got=${v.length}  [${v.join(', ')}]`);
}
console.log(bad ? `\n${bad} 项不匹配` : '\n全部匹配');
