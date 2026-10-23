// 单实例 + 窗口位置/大小记忆 e2e：驱动真实 exe 进程（不是无头浏览器）
// 用法：node tools/single_test.mjs <exe 路径> [用于传递的测试文档]
//
// 注意两点：
//  1. 会真实弹出窗口若干秒；用户的窗口记录与最近打开列表在结束时原样恢复。
//  2. 有些环境（沙箱 / 无交互桌面）里 exe 的 WebView 内容不会真正执行，
//     这时只验证 Rust 侧行为，依赖前端的项自动跳过并标注。
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const EXE = process.argv[2];
const DOC = process.argv[3] || 'tools/test_outline.pdf';
if (!EXE) {
  console.error('用法：node tools/single_test.mjs <exe 路径> [文档路径]');
  process.exit(2);
}

const APP = path.join(process.env.APPDATA || '', 'OFDee');
const WIN = path.join(APP, 'window.json');
const ST = path.join(APP, 'ofd-reader-state.json');
const PROBE = path.resolve('tools/_single_probe.pdf');

const results = [];
const check = (name, cond, extra = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`;
  results.push(line);
  console.log(line);
};
const skip = (name, why) => {
  const line = `SKIP  ${name}  [${why}]`;
  results.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  for (const n of ['ofd-viewer.exe', 'OFDee.exe']) {
    try {
      execSync(`taskkill /F /IM ${n} /T`, { stdio: 'ignore' });
    } catch (e) { /* 没有该进程时忽略 */ }
  }
}

/** 当前还在跑的实例进程数 */
function countProcs() {
  try {
    const out = execSync('tasklist /NH /FI "IMAGENAME eq ofd-viewer.exe"', { encoding: 'utf8' });
    return out.split(/\r?\n/).filter((l) => /ofd-viewer\.exe/i.test(l)).length;
  } catch (e) {
    return 0;
  }
}

const launch = (args = []) => spawn(EXE, args, { stdio: 'ignore' });
const winState = () => (existsSync(WIN) ? JSON.parse(readFileSync(WIN, 'utf8')) : null);
const recentList = () => {
  try {
    const st = JSON.parse(readFileSync(ST, 'utf8'));
    return Array.isArray(st.recent) ? st.recent : [];
  } catch (e) {
    return [];
  }
};
const hasProbe = () => recentList().some((p) => String(p).includes('_single_probe.pdf'));
const stripProbe = () => {
  try {
    const st = JSON.parse(readFileSync(ST, 'utf8'));
    if (st && Array.isArray(st.recent)) {
      st.recent = st.recent.filter((p) => !String(p).includes('_single_probe.pdf'));
      writeFileSync(ST, JSON.stringify(st));
    }
  } catch (e) { /* 状态文件不存在时忽略 */ }
};

/* ---------- 准备：备份用户数据，造一份专属探针文档 ---------- */
killAll();
await sleep(700);
const winBackup = existsSync(WIN) ? readFileSync(WIN) : null;
rmSync(WIN, { force: true });
copyFileSync(path.resolve(DOC), PROBE);
stripProbe();

/* ---------- 0) 环境探针：这个环境里 exe 的前端是否真的会执行 ---------- */
launch([PROBE]);
await sleep(11000);
killAll();
await sleep(700);
const feOk = hasProbe();
console.log(feOk ? '（环境探针：前端可正常执行）' : '（环境探针：本环境下 WebView 内容未执行 → 依赖前端的项将跳过）');
stripProbe();

/* ---------- 1) 冷启动：窗口尺寸位置应落盘 ---------- */
launch();
await sleep(5500);
let w = winState();
check('冷启动即写入窗口状态', !!w, w ? `${w.w}x${w.h} @ ${w.x},${w.y}` : '无文件');
check('记录尺寸不小于最小窗口', !!w && w.w >= 760 && w.h >= 520, w ? `${w.w}x${w.h}` : '-');
check('记录坐标为有效值（非最小化哨兵）', !!w && w.x > -30000 && w.y > -30000, w ? `${w.x},${w.y}` : '-');
check('未误记为最大化', !!w && w.maximized === false, w ? String(w.maximized) : '-');
check('此时只有 1 个实例', countProcs() === 1, `n=${countProcs()}`);

/* ---------- 2) 第二个实例带文件启动：应被拦截 ---------- */
const p2 = launch([PROBE]);
await sleep(3000);
check('第二个实例未常驻（进程数仍为 1）', countProcs() === 1, `n=${countProcs()}`);
check('第二个进程自行退出', p2.exitCode !== null, `exit=${p2.exitCode}`);
await sleep(2500);
if (feOk) {
  check('文件已被首个实例接手打开', hasProbe(),
    `recent=${recentList().map((s) => String(s).split(/[\\/]/).pop()).join(' | ') || '空'}`);
} else {
  skip('文件已被首个实例接手打开', '本环境 WebView 未执行，需人工双击验证');
}
check('首个实例仍然存活', countProcs() === 1, `n=${countProcs()}`);
killAll();
await sleep(700);

/* ---------- 3) 越界坐标：换了显示器/分辨率后应回退居中 ---------- */
writeFileSync(WIN, JSON.stringify({ x: -30000, y: -30000, w: 1000, h: 700, maximized: false }));
launch();
await sleep(5500);
let w3 = winState();
check('屏幕外坐标被纠正', !!w3 && w3.x > -30000 && w3.y > -30000, w3 ? `${w3.x},${w3.y}` : '无文件');
killAll();
await sleep(700);

/* ---------- 4) 异常过小的记录：应丢弃并改用默认尺寸 ---------- */
writeFileSync(WIN, JSON.stringify({ x: 200, y: 150, w: 100, h: 80, maximized: false }));
launch();
await sleep(5500);
let w4 = winState();
check('过小尺寸记录被丢弃并修正', !!w4 && w4.w >= 760 && w4.h >= 520, w4 ? `${w4.w}x${w4.h}` : '无文件');
check('修正后坐标仍有效', !!w4 && w4.x > -30000, w4 ? `${w4.x},${w4.y}` : '-');

/* ---------- 收尾：还原用户数据 ---------- */
killAll();
await sleep(500);
if (winBackup) writeFileSync(WIN, winBackup);
else rmSync(WIN, { force: true });
stripProbe();
rmSync(PROBE, { force: true });

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
const skipped = results.filter((r) => r.startsWith('SKIP')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过' + (skipped ? `（${skipped} 项跳过）` : ''));
process.exit(failed ? 1 : 0);
