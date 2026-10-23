import { parseDelta } from '../ui/js/ofd.js';
// 样本：Delta 模式取自真实红头公文（含 g n v 压缩语法），
// 文本已替换为同长度的虚构内容，不含任何真实信息
const cases = [
  ['正文示例。其中，', 'g 4 5.7996 5.7572 g 2 5.7996'],
  ['示范正文；机构文档与样例', '5.6301 5.6726 g 2 5.6301 5.6726 g 2 5.6301 5.6726 g 2 5.6301 5.6726'],
  ['其中，示范机构文档呈现', 'g 7 5.6726 5.715 g 5 5.6726'],
  ['件。其中，甲乙丙三份示例文件', 'g 7 5.6726 5.715 g 5 5.6726'],
  ['其中，示例文档', '5.715 5.6726 5.715 5.6726 5.715 5.6726'],
  ['二', 'g 2 2.7938'],
  ['示例文档', 'g 3 5.6726 5.6301'],
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
