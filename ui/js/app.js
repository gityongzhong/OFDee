import { parseOfd, renderPage as renderOfdPage, MM2PX } from './ofd.js';
import { parsePdf, renderPdfPage, getPdfText, getPdfOutline, renderPdfTextLayer, PT2MM } from './pdf.js';
import {
  ofdPageCanvas,
  pdfPageCanvas,
  canvasToPngBytes,
  buildPdfBlob,
  buildZipBlob,
  exportDocAsPdf,
  exportDocAsPngZip
} from './exporter.js';

const $ = (id) => document.getElementById(id);
const PAGE_GAP = 22;

const TAURI = typeof window !== 'undefined' && window.__TAURI__ ? window.__TAURI__ : null;
const invoke = TAURI ? TAURI.core.invoke : null;

const state = {
  doc: null,
  kind: '',            // 'ofd' | 'pdf'
  fileName: '',
  filePath: '',
  zoom: 1,
  mode: 'fitWidth',
  spread: false,       // 双页对开
  current: 0,
  pageEls: [],
  pageTops: [],        // 每页相对 #stage 的顶部偏移（含 padding）
  rendered: new Set(),
  rendering: new Set(),
  thumbRendered: new Set(),
  recent: [],
  rawBytes: null,
  outlineFlat: [],     // 目录条目的扁平列表（用于滚动同步高亮）
  _outlineActive: null,
  _jumpTo: null,
  _zoomTimer: null,
  rotation: [],        // 每页的视图旋转角（0/90/180/270），只改显示不改文件
  /* ---- 多标签页 ---- */
  tabs: [],            // 每个标签页一份完整快照（含 DOM 片段）
  activeTabId: null,
  _tabSeq: 0,
  /* ---- 外观 ---- */
  theme: 'system',     // 'system' | 'dark' | 'light'（用户选择）
  _sysDark: true,      // 系统当前是否为深色
  railOn: true         // 缩略图侧栏：默认展开，用户关掉后会被记住
};

/* 随标签页快照切换的字段（state 始终镜像「当前活动标签」） */
const TAB_FIELDS = [
  'fileName', 'filePath', 'kind', 'doc', 'rawBytes',
  'zoom', 'mode', 'spread', 'current', 'pageEls', 'pageTops',
  'rendered', 'rendering', 'thumbRendered', 'outlineFlat', '_outlineActive',
  '_zoomTimer', '_jumpTo', '_statusHTML', 'rotation'
];

const freshTabState = () => ({
  fileName: '', filePath: '', kind: '', doc: null, rawBytes: null,
  zoom: 1, mode: 'fitWidth', spread: state.spread, current: 0,
  pageEls: [], pageTops: [], rendered: new Set(), rendering: new Set(),
  thumbRendered: new Set(), outlineFlat: [], _outlineActive: null,
  _zoomTimer: null, _jumpTo: null, _statusHTML: '', rotation: []
});

/* ---------------- 桥接层 ---------------- */

async function readLocalFile(path) {
  if (invoke) {
    const bytes = await invoke('read_file', { path });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }
  const r = await fetch(path);
  if (!r.ok) throw new Error('读取失败：HTTP ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

async function pickFile() {
  if (!invoke) {
    $('fileInput').click();
    return null;
  }
  try {
    const path = await invoke('pick_doc');
    if (!path) return null;
    return { path, name: path.split(/[\\/]/).pop() };
  } catch (e) {
    console.warn('原生对话框不可用，回退到文件选择器', e);
    $('fileInput').click();
    return null;
  }
}

async function loadState() {
  try {
    if (invoke) {
      const raw = await invoke('load_state');
      const o = JSON.parse(raw || '{}');
      state.recent = Array.isArray(o.recent) ? o.recent : [];
      state.spread = !!o.spread;
      // 缺省 true：老版本的状态文件里没有这一项，按「默认展开缩略图」处理
      state.railOn = o.railOn === undefined ? true : !!o.railOn;
      if (o.theme === 'dark' || o.theme === 'light' || o.theme === 'system') state.theme = o.theme;
    } else {
      const o = JSON.parse(localStorage.getItem('ofd-recent') || '{}');
      state.recent = Array.isArray(o.recent) ? o.recent : [];
      state.spread = !!o.spread;
      state.railOn = o.railOn === undefined ? true : !!o.railOn;
      const th = o.theme || localStorage.getItem('ofdee-theme');
      if (th === 'dark' || th === 'light' || th === 'system') state.theme = th;
    }
  } catch (e) {
    state.recent = [];
  }
}

async function saveState() {
  try {
    const payload = JSON.stringify({
      recent: state.recent.slice(0, 10),
      spread: state.spread,
      theme: state.theme,
      railOn: state.railOn
    });
    if (invoke) await invoke('save_state', { data: payload });
    else localStorage.setItem('ofd-recent', payload);
  } catch (e) { /* 忽略 */ }
}

function pushRecent(path) {
  if (!path) return;
  state.recent = [path, ...state.recent.filter((p) => p !== path)].slice(0, 10);
  saveState();
  renderRecent();
}

/* ---------------- 界面：提示与状态 ---------------- */

function toast(msg, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function setBusy(on, text) {
  const b = $('busy');
  b.classList.toggle('on', !!on);
  if (text) $('busyText').textContent = text;
}

/* ---------------- 工具栏悬停提示 ----------------
 * 图标按钮只靠图形表意容易猜错，这里统一补中文名称 + 快捷键。
 * 原生 title 有 1s 左右延迟，图标按钮额外挂一个自绘气泡做即时反馈。
 */

function initTooltips() {
  const HOT = 620;          // 悬停多久出气泡（ms）
  const GAP = 8;
  const hasTitle = (el) => !!(el.getAttribute('title') || '').trim();

  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  let timer = 0;
  let cur = null;

  const hide = () => {
    clearTimeout(timer);
    cur = null;
    tip.classList.remove('on');
  };

  const place = (el) => {
    const r = el.getBoundingClientRect();
    // 先设内容再量尺寸：display 变化后需强制重排，否则量到的是上一次的宽高（首次为 0）
    tip.style.visibility = 'hidden';
    tip.classList.add('on');
    void tip.offsetWidth;
    const t = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2;
    let y = r.bottom + GAP;
    x = Math.max(8, Math.min(window.innerWidth - t.width - 8, x));
    if (y + t.height > window.innerHeight - 8) y = r.top - t.height - GAP; // 下方放不下就翻到上方
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
    tip.style.visibility = '';
  };

  const show = (el) => {
    const text = el.getAttribute('title');
    if (!text) return;
    tip.textContent = text;
    place(el);
    cur = el;
  };

  const bind = (el) => {
    if (el.__tip) return;
    el.__tip = true;
    el.addEventListener('pointerenter', () => {
      if (!hasTitle(el) || el.disabled) return;
      clearTimeout(timer);
      timer = setTimeout(() => show(el), HOT);
    });
    el.addEventListener('pointerleave', hide);
    el.addEventListener('pointerdown', hide);
  };

  // 仅处理「纯图标」按钮：有文字标签的按钮原生 title 已足够
  document.querySelectorAll('#bar button[title], .tab[title]').forEach((el) => {
    if (el.classList.contains('icon')) bind(el);
  });

  // 滚动或窗口变化时立即收起，避免气泡悬空
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', hide, true);

  // 调试可断言当前气泡内容
  window.__ofdee_tip = { el: () => cur, text: () => tip.textContent, on: () => tip.classList.contains('on') };
}

/** 未打开文档时，把依赖文档的按钮整组置灰（避免点了没反应） */
function syncToolbarEnabled() {
  const on = !!state.doc;
  const ids = ['btnPrev', 'btnNext', 'btnZoomIn', 'btnZoomOut', 'zoomLabel',
    'btnFitWidth', 'btnFitPage', 'btnCopy', 'btnExport'];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !on;
    el.classList.toggle('off', !on);
  }
  const pi = $('pageInput');
  if (pi) pi.disabled = !on;
  // 单双页/目录/缩略图/旋转在没有文档时保留可点（它们会自己 no-op），但视觉上也淡化
  for (const id of ['btnSpread', 'btnOutline', 'btnSide', 'btnRotate']) {
    const el = $(id);
    if (el) el.classList.toggle('off', !on);
  }
  updateRailUi();
}

/**
 * 缩略图侧栏的显示 = 用户的选择 + 当前有没有文档。
 * 没有文档时不让它占着位置（否则启动后是一条空白竖条）；
 * 按钮的高亮只反映用户选择，不等同于侧栏此刻是否可见。
 */
function updateRailUi() {
  const rail = $('rail');
  if (!rail) return;
  const show = state.railOn && !!state.doc;
  const was = rail.classList.contains('on');
  rail.classList.toggle('on', show);
  const btn = $('btnSide');
  if (btn) btn.classList.toggle('active', state.railOn);
  if (show === was) return;
  // 侧栏会挤掉一块阅读区宽度，等布局生效后按当前模式重新适配，并补渲染可视区缩略图
  requestAnimationFrame(() => {
    if (state.mode === 'fitWidth') fitWidth();
    else if (state.mode === 'fitPage') fitPage();
    ensureThumbsVisible();
  });
}

function renderRecent() {
  const box = $('recentList');
  if (!box) return;
  box.innerHTML = '';
  if (!state.recent.length) {
    box.innerHTML = '<div class="recent-empty">还没有最近打开的文件</div>';
    return;
  }
  for (const p of state.recent) {
    const name = p.split(/[\\/]/).pop();
    const item = document.createElement('button');
    item.className = 'recent-item';
    item.title = p;
    item.innerHTML = `<span class="ri-name"></span><span class="ri-dir"></span>`;
    item.querySelector('.ri-name').textContent = name;
    item.querySelector('.ri-dir').textContent = p.replace(/[\\/][^\\/]*$/, '');
    item.addEventListener('click', () => openByPath(p));
    box.appendChild(item);
  }
}

/** 文档信息区（解析参数、字体、元数据等，随文档切换而变） */
function statusInfo(lines) {
  const el = $('stInfo');
  if (!el) return;
  const html = lines.map((s) => `<span>${s}</span>`).join('<i></i>');
  el.innerHTML = html;
  // 记下来供标签页快照使用（不必从 DOM 反读，避免混入实时区）
  state._statusHTML = html;
}

/** 恢复标签页时直接写回已生成的 HTML */
function statusInfoHtml(html) {
  const el = $('stInfo');
  if (!el) return;
  const v = html || '<span>就绪</span>';
  el.innerHTML = v;
  state._statusHTML = v;
}

/** 状态栏左侧实时区：页码 / 阅读进度 / 缩放 / 单双页 */
function updateStatusLive() {
  const live = $('stLive');
  if (!live) return;
  const has = !!state.doc;
  live.classList.toggle('hide', !has);
  const zoomEl = $('stZoom');
  const modeEl = $('stMode');
  if (zoomEl) zoomEl.textContent = Math.round(state.zoom * 100) + '%';
  if (modeEl) modeEl.textContent = state.spread ? '双页' : '单页';
  if (!has) return;

  const total = state.doc.pages.length;
  const page = Math.min(total, Math.max(1, state.current + 1));
  const pageEl = $('stPage');
  if (pageEl) pageEl.textContent = `第 ${page} / ${total} 页`;

  // 阅读进度：以滚动位置为准，滚到底算 100%
  const st = stage();
  const max = st.scrollHeight - st.clientHeight;
  let pct = max > 4 ? st.scrollTop / max : 1;
  pct = Math.min(1, Math.max(0, pct));
  const bar = $('stProgress');
  if (bar) bar.style.width = (pct * 100).toFixed(1) + '%';
  const pctEl = $('stPercent');
  if (pctEl) pctEl.textContent = Math.round(pct * 100) + '%';
}

/* ---------------- 多标签页 ---------------- */

const activeTab = () => state.tabs.find((t) => t.id === state.activeTabId) || null;

function detachChildren(el) {
  const frag = document.createDocumentFragment();
  while (el.firstChild) frag.appendChild(el.firstChild);
  return frag;
}

/** 把当前活动标签的 state 字段与 DOM 收进快照 */
function snapshotActive() {
  const t = activeTab();
  if (!t) return;
  for (const f of TAB_FIELDS) t[f] = state[f];
  t.rotation = [...(state.rotation || [])]; // 数组要拷一份，否则两个标签共用同一份旋转状态
  t.loaded = !!state.doc;
  t.statusHTML = state.doc ? state._statusHTML || '' : '';
  t.scrollTop = stage().scrollTop;
  t.railScroll = $('rail').scrollTop;
  if (state.doc) {
    t.pagesFrag = detachChildren(pagesEl());
    t.railFrag = detachChildren($('railList'));
    t.outlineFrag = detachChildren($('outlineTree'));
  } else {
    t.pagesFrag = t.railFrag = t.outlineFrag = null;
  }
}

/** 恢复某个标签页：state 字段 + DOM 片段 + 各处 UI */
function restoreTab(t) {
  for (const f of TAB_FIELDS) state[f] = t[f];
  state.rotation = [...(t.rotation || [])];
  pagesEl().innerHTML = '';
  if (t.pagesFrag) { pagesEl().appendChild(t.pagesFrag); t.pagesFrag = null; }
  $('railList').innerHTML = '';
  if (t.railFrag) { $('railList').appendChild(t.railFrag); t.railFrag = null; }
  $('outlineTree').innerHTML = '';
  if (t.outlineFrag) { $('outlineTree').appendChild(t.outlineFrag); t.outlineFrag = null; }

  $('docName').textContent = state.fileName || '未打开文件';
  $('docName').title = state.filePath || state.fileName || '';
  $('empty').style.display = state.doc ? 'none' : '';
  $('viewer').classList.toggle('on', !!state.doc);
  $('pageTotal').textContent = state.doc ? '/ ' + state.doc.pages.length : '/ 0';
  if (state.doc) {
    $('pageInput').max = String(state.doc.pages.length);
    $('pageInput').value = String(state.current + 1);
  }
  $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  applySpreadUi();
  statusInfoHtml(state.doc ? t.statusHTML : '');

  stage().scrollTop = t.scrollTop || 0;
  $('rail').scrollTop = t.railScroll || 0;
  ensureThumbsVisible();
  ensureVisible();
  syncOutlineUi();
  updateStatusLive();
  syncToolbarEnabled();
}

async function switchTab(id) {
  if (id === state.activeTabId) return;
  const target = state.tabs.find((t) => t.id === id);
  if (!target) return;
  if ($('busy').classList.contains('on')) {
    toast('正在加载文档，稍候再切换', 'err', 2000);
    return;
  }
  snapshotActive();
  state.activeTabId = id;
  restoreTab(target);
  renderTabs();
  if (state.mode === 'fitWidth') fitWidth();
  else if (state.mode === 'fitPage') fitPage();
}

async function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if ($('busy').classList.contains('on')) {
    toast('正在加载文档，稍候再关闭', 'err', 2000);
    return;
  }
  const t = state.tabs[idx];
  const wasActive = id === state.activeTabId;
  if (wasActive) snapshotActive();
  if (t.doc && t.kind === 'pdf' && typeof t.doc.destroy === 'function') {
    t.doc.destroy().catch(() => {});
  }
  t.doc = null;
  state.tabs.splice(idx, 1);

  if (wasActive) {
    if (state.tabs.length) {
      const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
      state.activeTabId = next.id;
      restoreTab(next);
      if (state.mode === 'fitWidth') fitWidth();
    } else {
      // 全部关闭 → 回空状态
      state.activeTabId = null;
      Object.assign(state, freshTabState(), { spread: state.spread });
      pagesEl().innerHTML = '';
      $('railList').innerHTML = '';
      $('outlineTree').innerHTML = '';
      $('viewer').classList.remove('on');
      $('empty').style.display = '';
      $('docName').textContent = '未打开文件';
      $('pageTotal').textContent = '/ 0';
      statusInfoHtml('');
      syncToolbarEnabled();  // 置灰按钮，并把缩略图侧栏收回（没文档时不留空竖条）
      updateStatusLive();
    }
  }
  renderTabs();
}

/** 打开文件一律进新标签页；同一路径已打开则直接激活 */
async function openInNewTab(bytes, name, path) {
  if (path) {
    const exist = state.tabs.find((t) => t.loaded && t.filePath === path);
    if (exist) {
      setBusy(false); // openByPath 已置 busy，去重直接返回时要还原
      if (exist.id !== state.activeTabId) await switchTab(exist.id);
      return;
    }
  }
  snapshotActive();
  const t = {
    id: ++state._tabSeq,
    ...freshTabState(),
    loaded: false, statusHTML: '', scrollTop: 0, railScroll: 0,
    pagesFrag: null, railFrag: null, outlineFrag: null
  };
  state.tabs.push(t);
  state.activeTabId = t.id;
  Object.assign(state, freshTabState(), { spread: state.spread });
  pagesEl().innerHTML = '';
  $('railList').innerHTML = '';
  $('outlineTree').innerHTML = '';
  renderTabs();
  try {
    await openFromBytes(bytes, name, path);
    // 把加载结果同步进标签快照（否则活动标签的名称/loaded 一直是旧值）
    const at = activeTab();
    if (at && at.id === t.id && state.doc) {
      for (const f of TAB_FIELDS) at[f] = state[f];
      at.loaded = true;
      at.statusHTML = state._statusHTML || '';
    }
  } finally {
    // 加载失败（state.doc 仍为空）→ 回滚：撤掉空标签，恢复原标签
    if (!state.doc) {
      const i = state.tabs.findIndex((x) => x.id === t.id);
      if (i >= 0) state.tabs.splice(i, 1);
      if (state.tabs.length) {
        const next = state.tabs[Math.min(i, state.tabs.length - 1)];
        state.activeTabId = next.id;
        restoreTab(next);
      } else {
        state.activeTabId = null;
        Object.assign(state, freshTabState());
        $('viewer').classList.remove('on');
        $('empty').style.display = '';
        statusInfoHtml('');
        syncToolbarEnabled();
        updateStatusLive();
      }
    }
    renderTabs();
  }
}

function renderTabs() {
  const bar = $('tabs');
  bar.style.display = state.tabs.length ? 'flex' : 'none';
  const list = $('tabList');
  list.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeTabId ? ' active' : '');
    el.dataset.tabId = t.id;
    el.title = t.filePath || t.fileName || '新标签页';
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.fileName || '新标签页';
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭标签页（Ctrl+W）';
    el.appendChild(name);
    el.appendChild(close);
    el.addEventListener('click', (e) => {
      if (e.target === close) return;
      // 拖拽刚结束时会补发一次 click，这里吞掉，避免松手变成了「切换标签」
      if (tabDrag.justDropped) { tabDrag.justDropped = false; return; }
      switchTab(t.id);
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTab(t.id);
    });
    bindTabDrag(el);
    list.appendChild(el);
  }
}

/* ---------------- 标签页拖拽排序 ----------------
 * 指针事件实现（不用 HTML5 DnD：拖影是系统截图、且无法控制落位动画）。
 * 拖动超过 4px 才算拖拽，否则仍按点击切换 —— 不影响原来的点击手感。
 */

const tabDrag = {
  active: false, el: null, id: null,
  startX: 0, startY: 0,
  moved: false,        // 是否已越过阈值、进入拖拽态
  changed: false,      // 本次拖拽是否真的改变了顺序
  justDropped: false   // 松手后抑制一次 click
};

/** 在数组里把标签从 fromIdx 移到 toIdx（toIdx 为移除后的插入下标） */
function moveTab(fromIdx, toIdx) {
  const arr = state.tabs;
  if (fromIdx === toIdx) return false;
  if (fromIdx < 0 || fromIdx >= arr.length) return false;
  if (toIdx < 0 || toIdx > arr.length - 1) return false;
  const [item] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, item);
  return true;
}

/**
 * 按指针位置确定落点并同步 DOM + 数组。
 * 判定规则：与「除自己以外」的标签中线比较，横向越过谁的中线就插到谁的位置。
 * 返回是否发生了换位。
 */
function reorderTo(clientX) {
  const el = tabDrag.el;
  const list = $('tabList');
  if (!el || !list) return false;

  const others = [...list.querySelectorAll('.tab')].filter((e) => e !== el);
  let insertAt = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) { insertAt = i; break; }
  }

  // tabDrag.id 取自 dataset（总是字符串），tabs[].id 是数字，比较前先统一成字符串
  const fromIdx = state.tabs.findIndex((t) => String(t.id) === String(tabDrag.id));
  if (fromIdx < 0) return false;
  if (insertAt === fromIdx) return false;   // 落点没变，不动
  if (!moveTab(fromIdx, insertAt)) return false;

  // DOM 同步：把自己插到目标位置
  const before = el.offsetLeft;             // offsetLeft 不受 transform 影响，可测真实布局位置
  const nextTab = state.tabs[insertAt + 1];
  const ref = nextTab ? list.querySelector(`[data-tab-id="${nextTab.id}"]`) : null;
  if (ref) list.insertBefore(el, ref);
  else list.appendChild(el);
  // 布局位置变了，把指针基准一起平移，视觉上标签始终跟着手不跳
  tabDrag.startX += el.offsetLeft - before;
  return true;
}

function bindTabDrag(el) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tab-close')) return;   // 点关闭按钮不拖
    if (state.tabs.length < 2) return;            // 只有一个标签谈不上排序
    if (tabDrag.active) return;                   // 已在拖拽中

    tabDrag.active = true;
    tabDrag.el = el;
    tabDrag.id = el.dataset.tabId;
    tabDrag.startX = e.clientX;
    tabDrag.startY = e.clientY;
    tabDrag.moved = false;
    tabDrag.changed = false;
    // 注意：不用 setPointerCapture —— 换位时元素会被 insertBefore 移动，
    // 移动等同于「移除再插入」，捕获会被解除，后续 pointerup 就收不到了。
    // 改在 document 上监听，事件一定拿得到。
    startTabDragListeners();
  });
}

/** 拖拽期间挂在 document 上的全局监听，结束时自动摘掉 */
function startTabDragListeners() {
  const onMove = (e) => {
    const el = tabDrag.el;
    if (!tabDrag.active || !el) return;
    const dx = e.clientX - tabDrag.startX;
    const dy = e.clientY - tabDrag.startY;

    if (!tabDrag.moved) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;   // 没过阈值，仍然算点击
      // 纵向位移明显大于横向 → 用户大概是想拖窗口，交还给系统
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.5) {
        endTabDrag(e, { silent: true });
        return;
      }
      tabDrag.moved = true;
      el.classList.add('dragging');
      $('tabs').classList.add('dragging');
    }

    el.style.transform = `translate(${dx}px, -1px)`;
    if (reorderTo(e.clientX)) tabDrag.changed = true;
    e.preventDefault();
  };

  const onUp = (e) => endTabDrag(e);
  const onCancel = (e) => endTabDrag(e, { silent: true });

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
  tabDrag._off = () => {
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
  };
}

/** 结束拖拽，清理视觉态与监听 */
function endTabDrag(e, opts = {}) {
  const el = tabDrag.el;
  if (!tabDrag.active || !el) return;
  const wasMoved = tabDrag.moved;
  const changed = tabDrag.changed;

  tabDrag.active = false;
  el.classList.remove('dragging');
  $('tabs').classList.remove('dragging');
  el.style.transform = '';
  if (tabDrag._off) { tabDrag._off(); tabDrag._off = null; }

  if (wasMoved && !opts.silent) {
    // 松手后浏览器还会补一次 click，吞掉它（见 renderTabs 里的 justDropped）
    tabDrag.justDropped = true;
    setTimeout(() => { tabDrag.justDropped = false; }, 80);
    if (changed) {
      el.classList.add('dropped');
      setTimeout(() => el.classList.remove('dropped'), 240);
      toast('标签顺序已更新', 'ok', 1200);
    }
  }
  tabDrag.el = null;
  tabDrag.id = null;
  tabDrag.moved = false;
  tabDrag.changed = false;
  void e;
}

/* ---------------- 打开文档 ---------------- */

function baseName(name) {
  return String(name || '').replace(/\.(ofd|pdf)$/i, '');
}

/** 按文件头判断类型，扩展名只作兜底 —— 改了后缀的文件照样能开 */
function detectKind(bytes, name) {
  if (bytes && bytes.length >= 5) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'ofd';
  }
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.ofd')) return 'ofd';
  return null;
}

async function openByPath(path) {
  try {
    setBusy(true, '正在读取文件…');
    const bytes = await readLocalFile(path);
    await openInNewTab(bytes, path.split(/[\\/]/).pop(), path);
    pushRecent(path);
  } catch (e) {
    setBusy(false);
    toast('打开失败：' + (e && e.message ? e.message : e), 'err', 6000);
  }
}

async function openFromFileObj(file) {
  try {
    setBusy(true, '正在读取文件…');
    const buf = await file.arrayBuffer();
    await openInNewTab(new Uint8Array(buf), file.name, file.path || '');
  } catch (e) {
    setBusy(false);
    toast('打开失败：' + (e && e.message ? e.message : e), 'err', 6000);
  }
}

async function openFromBytes(bytes, name, path) {
  const kind = detectKind(bytes, name);
  if (!kind) {
    setBusy(false);
    toast('不支持的文件类型，请选择 OFD 或 PDF', 'err', 5000);
    return;
  }

  const t0 = performance.now();
  setBusy(true, kind === 'pdf' ? '正在解析 PDF…' : '正在解析 OFD…');

  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  let doc;
  try {
    doc = kind === 'pdf' ? await parsePdf(ab) : await parseOfd(ab);
  } catch (e) {
    setBusy(false);
    toast('打开失败：' + ((e && e.message) || e), 'err', 6000);
    return;
  }
  const t1 = performance.now();

  // 标签页各自持有文档，切换/关闭时才释放 PDF 资源
  if (kind === 'ofd') doc.kind = 'ofd';

  state.doc = doc;
  state.kind = kind;
  state.fileName = name || (kind === 'pdf' ? '未命名.pdf' : '未命名.ofd');
  state.filePath = path || '';
  // 原始字节仅 PDF「转存」时需要，OFD 用不到就不占内存
  state.rawBytes = kind === 'pdf' ? bytes : null;
  state.rendered.clear();
  state.rendering.clear();
  state.thumbRendered.clear();

  $('docName').textContent = state.fileName;
  $('docName').title = path || name;
  $('empty').style.display = 'none';
  $('viewer').classList.add('on');
  $('pageTotal').textContent = '/ ' + doc.pages.length;
  $('pageInput').max = String(doc.pages.length);
  $('pageInput').value = '1';
  state.current = 0;

  buildPagePlaceholders();
  buildThumbs();
  applySpreadUi();
  fitWidth();
  stage().scrollTop = 0;

  // 目录侧栏跟随新文档重建
  state.outlineFlat = [];
  state._outlineActive = null;
  if ($('outline').classList.contains('on')) buildOutline();

  if (typeof state._jumpTo === 'number') {
    const target = state._jumpTo;
    state._jumpTo = null;
    if (target > 0 && target < doc.pages.length) setTimeout(() => goPage(target), 30);
  }

  statusInfo(kind === 'pdf' ? pdfStatus(doc, t1 - t0) : ofdStatus(doc, t1 - t0));
  updateStatusLive();
  setBusy(false);
}

function ofdStatus(doc, ms) {
  const warn = [...doc.fontWarnings];
  const fontCount = [...doc.fonts.values()].filter((f) => f.embedded).length;
  return [
    `OFD · 共 ${doc.pages.length} 页`,
    `${doc.pageW}×${doc.pageH} mm`,
    `内嵌字体 ${fontCount} 个`,
    `解析 ${ms.toFixed(0)} ms`,
    warn.length ? `<b class="warn">字体缺失：${warn.join('、')}</b>` : '字体完整'
  ];
}

function pdfStatus(doc, ms) {
  const p = doc.pages[0] || { w: 0, h: 0 };
  const multi = doc.pages.some((x) => Math.abs(x.w - p.w) > 1 || Math.abs(x.h - p.h) > 1);
  const title = doc.meta && (doc.meta.Title || '');
  return [
    `PDF · 共 ${doc.pages.length} 页`,
    multi ? '页面尺寸不一' : `${p.w}×${p.h} mm`,
    `解析 ${ms.toFixed(0)} ms`,
    'pdf.js 渲染',
    title ? '标题：' + escapeHtml(String(title)).slice(0, 40) : '可正常阅读'
  ];
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 视图 ---------------- */

const stage = () => $('stage');
const pagesEl = () => $('pages');

function pageSize(i) {
  const d = state.doc;
  const p = d.pages[i];
  if (p && p.w) return p;
  return { w: d.pageW, h: d.pageH };
}

/** 第 i 页的视图旋转角（0/90/180/270） */
const pageRotation = (i) => (state.rotation[i] || 0) % 360;

/**
 * 旋转后的等效页面尺寸（mm）。90/270 度时宽高互换。
 * 布局、适配、缩略图一律走这里 —— 不要直接读 pageSize，
 * 否则旋转后页面会溢出容器、双页对开的行高也算错。
 */
function effectiveSize(i) {
  const s = pageSize(i);
  return pageRotation(i) % 180 === 0 ? s : { w: s.h, h: s.w };
}

function buildPagePlaceholders() {
  const host = pagesEl();
  host.innerHTML = '';
  state.pageEls = [];
  for (let i = 0; i < state.doc.pages.length; i++) {
    const el = document.createElement('div');
    el.className = 'page kind-' + state.kind;
    el.dataset.index = String(i);
    host.appendChild(el);
    state.pageEls.push(el);
  }
}

/* ---- PDF 渲染并发控制：同时最多两页，翻页不抢 CPU ---- */
const pdfQueue = { active: 0, max: 2, jobs: [] };
function schedulePdf(task) {
  return new Promise((resolve, reject) => {
    pdfQueue.jobs.push({ task, resolve, reject });
    pumpPdfQueue();
  });
}
function pumpPdfQueue() {
  while (pdfQueue.active < pdfQueue.max && pdfQueue.jobs.length) {
    const job = pdfQueue.jobs.shift();
    pdfQueue.active++;
    job.task()
      .then(job.resolve, job.reject)
      .finally(() => { pdfQueue.active--; pumpPdfQueue(); });
  }
}

function pdfStale(el) {
  const cv = el.querySelector('canvas.pdf-canvas');
  if (!cv) return true;
  const want = el.clientWidth;
  const got = parseFloat(cv.dataset.cssWidth || '0');
  if (!want || !got || Math.abs(want - got) / want > 0.02) return true;
  // 转过角度就得重画：画布宽高已经互换，旧的位图不能再拿来拉伸顶着
  const idx = Number(el.dataset.index || 0);
  return Number(cv.dataset.rotation || 0) !== pageRotation(idx);
}

/** 生成某页的可视节点：OFD → SVG，PDF → canvas（+ 可选文字层） */
async function renderPageNode(i, doc) {
  const rot = pageRotation(i);
  if (doc.kind === 'pdf') {
    const el = state.pageEls[i];
    const cssW = Math.max(80, el ? el.clientWidth : effectiveSize(i).w * MM2PX);
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    return schedulePdf(() => renderPdfPage(doc, i, cssW, dpr, rot));
  }
  return renderOfdPage(doc, i, rot);
}

/** 给已渲染的 PDF 页挂文字层（划选复制用）；扫描件没有文字层则返回 false */
async function attachTextLayer(i, doc, canvas, host) {
  try {
    const cssW = canvas.dataset.cssWidth ? parseFloat(canvas.dataset.cssWidth) : host.clientWidth;
    const { layer, hasText } = await renderPdfTextLayer(doc, i, cssW, pageRotation(i));
    if (!hasText || !layer) return false;
    if (state.doc !== doc) return false;
    layer.dataset.index = String(i);
    host.appendChild(layer);
    fitTextLayer(layer, host);
    return true;
  } catch (e) {
    console.warn('文字层生成失败', i, e);
    return false;
  }
}

/** 文字层按排版宽度生成，页面被 CSS 拉伸时用 scale 对齐，保证选字位置准确 */
function fitTextLayer(layer, host) {
  const w = parseFloat(layer.style.width) || 0;
  if (!w) return;
  const k = host.clientWidth / w;
  layer.style.transform = 'scale(' + k.toFixed(4) + ')';
  layer.style.transformOrigin = '0 0';
}

function fitAllTextLayers() {
  for (const el of state.pageEls) {
    const layer = el && el.querySelector('.textLayer');
    if (layer) fitTextLayer(layer, el);
  }
}

async function ensurePage(i) {
  if (!state.doc || i < 0 || i >= state.pageEls.length) return;
  if (state.rendering.has(i)) return;
  const isPdf = state.kind === 'pdf';
  const el = state.pageEls[i];
  if (!el) return;
  if (state.rendered.has(i) && (!isPdf || !pdfStale(el))) return;

  const doc = state.doc;
  state.rendering.add(i);
  try {
    const node = await renderPageNode(i, doc);
    if (state.doc !== doc || !node) return;
    el.innerHTML = '';
    el.appendChild(node);
    state.rendered.add(i);
    // PDF 挂文字层：支持鼠标划选、Ctrl+A、右键复制
    if (isPdf) attachTextLayer(i, doc, node, el);
  } catch (e) {
    if (state.doc !== doc) return;
    el.innerHTML = `<div class="page-error">第 ${i + 1} 页渲染失败<br><span>${escapeHtml(
      String((e && e.message) || e)
    )}</span></div>`;
    console.error('页面渲染失败', i, e);
  } finally {
    state.rendering.delete(i);
  }
}

function layout() {
  if (!state.doc) return;
  const perRow = state.spread ? 2 : 1;
  const n = state.pageEls.length;
  // 双页对开：同一行的两页共享顶部偏移，行高取较大者
  let rowTop = 22; // #pages 的 padding-top
  let rowH = 0;
  let col = 0;
  state.pageTops = [];
  for (let i = 0; i < n; i++) {
    const s = effectiveSize(i);
    const w = s.w * MM2PX * state.zoom;
    const h = s.h * MM2PX * state.zoom;
    const el = state.pageEls[i];
    el.style.width = w.toFixed(2) + 'px';
    el.style.height = h.toFixed(2) + 'px';
    state.pageTops[i] = rowTop;
    rowH = Math.max(rowH, h);
    col++;
    if (col >= perRow || i === n - 1) {
      rowTop += rowH + PAGE_GAP;
      rowH = 0;
      col = 0;
    }
  }
  fitAllTextLayers();
}

/** 二分查找：给定滚动位置落在第几页（双页模式归到行首） */
function pageAt(offset) {
  const tops = state.pageTops;
  if (!tops.length) return 0;
  let lo = 0, hi = tops.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (state.spread && ans % 2 === 1) ans -= 1;
  return ans;
}

/** 翻页步长：双页对开一次翻一屏（两页） */
function pageStep() {
  return state.spread ? 2 : 1;
}

/* 依据滚动位置确定性渲染视口附近页面（不依赖 IntersectionObserver） */
function ensureVisible() {
  if (!state.doc) return;
  const st = stage();
  const first = Math.max(0, pageAt(st.scrollTop) - 1);
  const last = Math.min(state.pageEls.length - 1, pageAt(st.scrollTop + st.clientHeight) + 1);
  for (let i = first; i <= last; i++) ensurePage(i);
}

function setZoom(z, mode) {
  if (!state.doc) return;
  state.zoom = Math.min(6, Math.max(0.1, z));
  state.mode = mode || 'custom';
  layout();
  $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  updateStatusLive();
  // 连续缩放时合并重绘；旧画布先被 CSS 拉伸顶着，不会闪白
  clearTimeout(state._zoomTimer);
  state._zoomTimer = setTimeout(ensureVisible, 70);
  ensureThumbsVisible();
}

/**
 * 适配时用的「行宽」（mm）。取所有行里的最大值，而不是只看第一页：
 * 各页尺寸不一致时（扫描件混了 A4/A5、或只有部分页被旋转），
 * 按第一页适配会让更宽的页横向溢出。双页模式下按 layout 的 (0,1)(2,3) 配对累加。
 */
function rowWidthMM() {
  const n = state.doc ? state.doc.pages.length : 0;
  if (!n) return 210;
  let max = 0;
  for (let i = 0; i < n; i += state.spread ? 2 : 1) {
    let w = effectiveSize(i).w;
    if (state.spread && i + 1 < n) w += effectiveSize(i + 1).w;
    if (w > max) max = w;
  }
  return max;
}

function rowHeightMM() {
  const n = state.doc ? state.doc.pages.length : 0;
  if (!n) return 297;
  let max = 0;
  for (let i = 0; i < n; i += state.spread ? 2 : 1) {
    let h = effectiveSize(i).h;
    if (state.spread && i + 1 < n) h = Math.max(h, effectiveSize(i + 1).h);
    if (h > max) max = h;
  }
  return max;
}

/**
 * 量舞台的可用宽高。量之前先把竖向滚动条的占位锁住：
 * 首次适配时滚动条往往还没出现，量到的宽度会比落定后宽出滚动条那一截（约 10px），
 * 同一个窗口里不同标签就会得到 127% / 129% 这样对不齐的适配比例。
 */
function stageAvail(padW, padH) {
  const st = stage();
  const prev = st.style.overflowY;
  st.style.overflowY = 'scroll';
  const w = st.clientWidth - padW;
  const h = st.clientHeight - padH;
  st.style.overflowY = prev;
  return { w, h };
}

function fitWidth() {
  if (!state.doc) return;
  const avail = stageAvail(56, 0).w;
  setZoom(avail / (rowWidthMM() * MM2PX), 'fitWidth');
}

function fitPage() {
  if (!state.doc) return;
  const a = stageAvail(56, 48);
  setZoom(Math.min(a.w / (rowWidthMM() * MM2PX), a.h / (rowHeightMM() * MM2PX)), 'fitPage');
}

/**
 * 旋转会同时改画布朝向和页面占位尺寸，转完必须做三件事：
 * ① 丢掉该页的渲染缓存（旧位图朝向不对，且 pdfStale 会因角度变化判定重画）
 * ② 重算缩略图占位比例（宽高互换）
 * ③ 布局与适应模式重算，否则页面会溢出阅读区
 */
function applyRotation(changed) {
  if (!state.doc) return;
  for (const i of changed) {
    state.rendered.delete(i);
    state.rendering.delete(i);
    state.thumbRendered.delete(i);
    const el = state.pageEls[i];
    if (el) el.innerHTML = '';
    const sheet = document.querySelector(`.thumb[data-index="${i}"] .thumb-sheet`);
    if (sheet) {
      const s = effectiveSize(i);
      sheet.style.aspectRatio = `${s.w} / ${s.h}`;
      sheet.innerHTML = '';
    }
  }
  layout();
  if (state.mode === 'fitWidth') fitWidth();
  else if (state.mode === 'fitPage') fitPage();
  ensureVisible();
  ensureThumbsVisible();
}

function rotatePage(i) {
  if (!state.doc || !state.doc.pages[i]) return;
  state.rotation[i] = (pageRotation(i) + 90) % 360;
  applyRotation([i]);
  saveState();
}

function rotateAllPages() {
  if (!state.doc) return;
  const all = state.doc.pages.map((_, i) => i);
  for (let i = 0; i < state.doc.pages.length; i++) {
    state.rotation[i] = (pageRotation(i) + 90) % 360;
  }
  applyRotation(all);
  saveState();
}

function resetRotation() {
  if (!state.doc) return;
  const changed = [];
  for (let i = 0; i < state.doc.pages.length; i++) {
    if (state.rotation[i]) { state.rotation[i] = 0; changed.push(i); }
  }
  if (!changed.length) { toast('当前没有旋转过的页面', 'info', 1800); return; }
  applyRotation(changed);
  saveState();
}

function toggleSpread() {
  if (!state.doc) return;
  state.spread = !state.spread;
  saveState();
  applySpreadUi();
  const keep = state.current;
  layout();
  fitWidth();
  goPage(keep);
}

function applySpreadUi() {
  $('pages').classList.toggle('spread', state.spread);
  const btn = $('btnSpread');
  if (btn) btn.classList.toggle('active', state.spread);
  const modeEl = $('stMode');
  if (modeEl) modeEl.textContent = state.spread ? '双页' : '单页';
}

function goPage(i) {
  if (!state.doc) return;
  let idx = Math.max(0, Math.min(state.doc.pages.length - 1, i));
  if (state.spread) idx -= idx % 2;
  const top = state.pageTops[idx];
  stage().scrollTo({ top: Math.max(0, (top || 0) - 16), behavior: 'smooth' });
  state.current = idx;
  syncPageUi();
}

function syncPageUi() {
  // 文档状态可能刚变化（打开/关闭），统一刷新按钮可用态
  syncToolbarEnabled();
  if (!state.doc) return;
  $('pageInput').value = String(state.current + 1);
  for (const t of document.querySelectorAll('.thumb')) {
    t.classList.toggle('cur', Number(t.dataset.index) === state.current);
  }
  syncOutlineUi();
  updateStatusLive();
}

/* ---------------- 目录侧栏 ---------------- */

function toggleOutline() {
  const panel = $('outline');
  const on = !panel.classList.contains('on');
  panel.classList.toggle('on', on);
  $('btnOutline').classList.toggle('active', on);
  if (on && state.doc) buildOutline();
  // 侧栏改变了 stage 宽度，fit 类模式要重算
  setTimeout(() => {
    if (state.mode === 'fitWidth') fitWidth();
    else if (state.mode === 'fitPage') fitPage();
  }, 60);
}

async function buildOutline() {
  const doc = state.doc;
  if (!doc) return;
  state.outlineFlat = [];
  state._outlineActive = null;
  const tree = $('outlineTree');
  tree.innerHTML = '<div class="ol-empty">正在读取目录…</div>';
  let nodes = [];
  try {
    nodes = state.kind === 'pdf' ? await getPdfOutline(doc) : (doc.outline || []);
  } catch (e) {
    nodes = [];
  }
  if (state.doc !== doc) return;
  tree.innerHTML = '';

  if (nodes.length) {
    renderOutlineNodes(tree, nodes);
  } else {
    // 没有内置目录：降级为页面快速跳转网格
    const hint = document.createElement('div');
    hint.className = 'ol-empty';
    hint.textContent = '本文档没有内置目录，可按页快速跳转：';
    tree.appendChild(hint);
    const grid = document.createElement('div');
    grid.className = 'ol-grid';
    for (let i = 0; i < doc.pages.length; i++) {
      const b = document.createElement('button');
      b.className = 'ol-pgbtn';
      b.textContent = String(i + 1);
      b.dataset.index = String(i);
      b.addEventListener('click', () => goPage(i));
      grid.appendChild(b);
    }
    tree.appendChild(grid);
  }
  syncOutlineUi();
}

function renderOutlineNodes(host, nodes) {
  for (const n of nodes) {
    const b = document.createElement('button');
    b.className = 'ol-item';
    const txt = document.createElement('span');
    txt.className = 'ol-text';
    txt.textContent = n.title;
    txt.title = n.title;
    b.appendChild(txt);
    if (n.page !== null && n.page !== undefined) {
      const pg = document.createElement('span');
      pg.className = 'ol-pg';
      pg.textContent = String(n.page + 1);
      b.appendChild(pg);
      b.addEventListener('click', () => goPage(n.page));
      state.outlineFlat.push({ el: b, page: n.page });
    } else {
      b.style.cursor = 'default';
    }
    host.appendChild(b);
    if (n.children && n.children.length) {
      const child = document.createElement('div');
      child.className = 'ol-child';
      renderOutlineNodes(child, n.children);
      host.appendChild(child);
    }
  }
}

/** 滚动/翻页时同步目录高亮：取页面序号之前最近的一个条目 */
function syncOutlineUi() {
  const panel = $('outline');
  if (!panel.classList.contains('on')) return;

  if (state.outlineFlat.length) {
    let active = null;
    for (const e of state.outlineFlat) {
      if (e.page <= state.current) active = e;
      else break;
    }
    for (const e of state.outlineFlat) e.el.classList.toggle('cur', e === active);
    if (active && active !== state._outlineActive) {
      active.el.scrollIntoView({ block: 'nearest' });
    }
    state._outlineActive = active;
    return;
  }

  // 页面网格模式
  for (const b of panel.querySelectorAll('.ol-pgbtn')) {
    b.classList.toggle('cur', Number(b.dataset.index) === state.current);
  }
}

let scrollTick = null;
function onScroll() {
  if (!state.doc || scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = null;
    const st = stage();
    const probe = st.scrollTop + st.clientHeight * 0.32;
    const idx = pageAt(probe);
    if (idx !== state.current) {
      state.current = idx;
      syncPageUi();
    }
    // 进度条逐帧跟手（页码不变时也要更新）
    updateStatusLive();
    // 离当前页过远的页面释放 DOM，长文档才不吃内存
    if (state.pageEls.length > 24) {
      for (const i of [...state.rendered]) {
        if (Math.abs(i - state.current) > 8) {
          state.pageEls[i].innerHTML = '';
          state.rendered.delete(i);
        }
      }
    }
    ensureVisible();
  });
}

/* ---------------- 缩略图 ---------------- */

function buildThumbs() {
  const rail = $('railList');
  rail.innerHTML = '';
  state.doc.pages.forEach((_, i) => {
    const s = effectiveSize(i);
    const b = document.createElement('button');
    b.className = 'thumb';
    b.dataset.index = String(i);
    b.innerHTML = `<div class="thumb-sheet"></div><span class="thumb-no">${i + 1}</span>`;
    b.querySelector('.thumb-sheet').style.aspectRatio = `${s.w} / ${s.h}`;
    b.addEventListener('click', () => goPage(i));
    rail.appendChild(b);
  });
  syncPageUi();
  ensureThumbsVisible();
}

function ensureThumbsVisible() {
  if (!state.doc) return;
  const rail = $('rail');
  const total = state.pageEls.length;
  if (!total || !rail.clientHeight) return;
  const step = rail.scrollHeight / total || 1;
  const first = Math.max(0, Math.floor(rail.scrollTop / step) - 2);
  const last = Math.min(total - 1, Math.ceil((rail.scrollTop + rail.clientHeight) / step) + 2);
  for (let i = first; i <= last; i++) ensureThumb(i);
}

async function ensureThumb(i) {
  if (state.thumbRendered.has(i) || !state.doc) return;
  const doc = state.doc;
  state.thumbRendered.add(i);
  try {
    let node;
    if (doc.kind === 'pdf') {
      const slot = document.querySelector(`.thumb[data-index="${i}"] .thumb-sheet`);
      const w = slot && slot.clientWidth ? slot.clientWidth : 140;
      node = await schedulePdf(() => renderPdfPage(doc, i, w, Math.min(2, window.devicePixelRatio || 1), pageRotation(i)));
    } else {
      node = await renderOfdPage(doc, i, pageRotation(i));
    }
    if (state.doc !== doc) return;
    const slot = document.querySelector(`.thumb[data-index="${i}"] .thumb-sheet`);
    if (slot) slot.appendChild(node);
  } catch (e) {
    state.thumbRendered.delete(i);
  }
}

/* ---------------- 导出 ---------------- */

function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 原生另存为（无 Tauri 时回退浏览器下载）；返回是否已保存 */
async function saveBytes(bytes, defaultName, filterName, exts, mime) {
  if (invoke) {
    const path = await invoke('save_doc', {
      data: bytesToBase64(bytes),
      defaultName,
      filterName,
      exts
    });
    return !!path;
  }
  download(new Blob([bytes], { type: mime }), defaultName);
  return true;
}

function setExportMenu(on) {
  $('exportMenu').classList.toggle('on', !!on);
}

async function exportCurrentPage() {
  if (!state.doc) return;
  const idx = state.current;
  setBusy(true, '正在生成图片…');
  try {
    const canvas =
      state.kind === 'pdf'
        ? await schedulePdf(() => pdfPageCanvas(state.doc, idx, 144, pageRotation(idx)))
        : await ofdPageCanvas(state.doc, idx, 2, pageRotation(idx));
    const bytes = canvasToPngBytes(canvas);
    const ok = await saveBytes(
      bytes,
      `${baseName(state.fileName)}-第${idx + 1}页.png`,
      'PNG 图片',
      ['png'],
      'image/png'
    );
    toast(ok ? '已保存当前页 PNG' : '已取消保存', 'ok');
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e), 'err', 5000);
  } finally {
    setBusy(false);
  }
}

async function exportAllPng() {
  if (!state.doc) return;
  try {
    const blob = await exportDocAsPngZip(
      state.doc,
      state.kind,
      baseName(state.fileName),
      (done, total, tail) => setBusy(true, tail || `正在生成第 ${done}/${total} 页…`),
      { rotOf: pageRotation }
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ok = await saveBytes(
      bytes,
      `${baseName(state.fileName)}-全部页图片.zip`,
      'ZIP 压缩包',
      ['zip'],
      'application/zip'
    );
    toast(ok ? `已导出全部 ${state.doc.pages.length} 页 PNG（zip）` : '已取消保存', 'ok');
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e), 'err', 6000);
  } finally {
    setBusy(false);
  }
}

async function exportSavePdf() {
  if (!state.doc) return;
  try {
    const { blob } = await exportDocAsPdf(
      state.doc,
      state.kind,
      state.rawBytes,
      (done, total, tail) => setBusy(true, tail || `正在处理第 ${done}/${total} 页…`),
      { rotOf: pageRotation }
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ok = await saveBytes(
      bytes,
      `${baseName(state.fileName)}.pdf`,
      'PDF 文档',
      ['pdf'],
      'application/pdf'
    );
    toast(ok ? '已保存 PDF' : '已取消保存', 'ok');
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e), 'err', 6000);
  } finally {
    setBusy(false);
  }
}

async function copyCurrentText() {
  if (!state.doc) return;
  if (state.kind !== 'pdf') {
    toast('OFD 暂不支持文字提取', 'err');
    return;
  }
  setBusy(true, '正在提取文字…');
  try {
    const text = await getPdfText(state.doc, state.current);
    if (!text.trim()) throw new Error('本页没有可提取的文字（可能是扫描件）');
    await navigator.clipboard.writeText(text);
    toast(`已复制第 ${state.current + 1} 页文字（${text.length} 字）`, 'ok');
  } catch (e) {
    toast('复制失败：' + ((e && e.message) || e), 'err', 5000);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 文字选择与复制 ---------------- */

/** 取当前选中的文字（限定在页面内，避免选到 UI 控件） */
function selectedPageText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  const s = sel.toString();
  if (!s.trim()) return '';
  const node = sel.anchorNode;
  const host = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!host || !host.closest('#pages')) return '';
  return s;
}

/** 复制当前选中的文字 */
async function copySelection() {
  const text = selectedPageText();
  if (!text) {
    toast('先选中要复制的文字（PDF 可直接划选）', 'info', 2400);
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    const n = text.replace(/\s/g, '').length;
    toast(`已复制选中内容（${n} 字）`, 'ok', 1800);
    return true;
  } catch (e) {
    toast('复制失败：' + ((e && e.message) || e), 'err', 4000);
    return false;
  }
}

/** 页面右键菜单：复制选中 / 复制整页文字 / 缩放 / 跳页 */
function showContextMenu(x, y) {
  hideContextMenu();
  const sel = selectedPageText();
  const items = [];
  if (sel) items.push({ label: `复制选中内容（${sel.replace(/\s/g, '').length} 字）`, act: () => copySelection() });
  items.push({ label: '复制本页全部文字', act: () => copyCurrentText() });
  items.push({ sep: true });
  items.push({ label: '放大', act: () => setZoom(state.zoom * 1.2) });
  items.push({ label: '缩小', act: () => setZoom(state.zoom / 1.2) });
  items.push({ label: '适应宽度', act: () => fitWidth() });
  items.push({ label: '适应整页', act: () => fitPage() });
  items.push({ sep: true });
  items.push({ label: '旋转本页 90°', act: () => rotatePage(state.current) });
  items.push({ label: '旋转全部页 90°', act: () => rotateAllPages() });
  if (state.rotation.some((r) => r)) items.push({ label: '复位旋转', act: () => resetRotation() });

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctxMenu';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item';
    b.textContent = it.label;
    b.addEventListener('click', () => {
      hideContextMenu();
      it.act();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);

  // 贴边修正，避免菜单跑出窗口
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

function hideContextMenu() {
  const m = $('ctxMenu');
  if (m) m.remove();
}

/* ---------------- 外观主题：跟随系统 / 深色 / 浅色 ---------------- */

const THEME_LABEL = { system: '跟随系统', dark: '深色', light: '浅色' };
const THEME_ORDER = ['system', 'dark', 'light'];

function prefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    return true; // 老 WebView 没有该 API，按深色处理（与旧版观感一致）
  }
}

/** 解析出实际生效的主题（system 时跟随系统） */
function effectiveTheme() {
  if (state.theme === 'dark' || state.theme === 'light') return state.theme;
  return state._sysDark ? 'dark' : 'light';
}

/**
 * 应用主题：写 html[data-theme] 驱动 CSS 变量；
 * 同时把底色同步给 Tauri 原生窗口（防止缩放/拖动时露出旧底色）。
 */
function applyTheme(theme, { persist = false } = {}) {
  if (THEME_ORDER.includes(theme)) state.theme = theme;
  state._sysDark = prefersDark();
  const eff = effectiveTheme();
  document.documentElement.setAttribute('data-theme', eff);
  // 供首屏防闪脚本与下次启动复用（Tauri 下同样写一份，localStorage 在 WebView 数据目录内）
  try { localStorage.setItem('ofdee-theme', state.theme); } catch (e) { /* 忽略 */ }

  // 原生窗口底色（缩放/拖动时不会露出旧主题的底色）
  try {
    if (TAURI && TAURI.window && TAURI.window.getCurrentWindow) {
      const w = TAURI.window.getCurrentWindow();
      const rgba = eff === 'light' ? [233, 235, 238, 255] : [15, 17, 21, 255];
      if (w.setBackgroundColor) w.setBackgroundColor(rgba);
    }
  } catch (e) { /* 浏览器环境或权限不足时忽略 */ }

  syncThemeUi();
  if (persist) saveState();
}

/** 把当前选择同步到设置面板的分段控件 */
function syncThemeUi() {
  const seg = $('segTheme');
  if (!seg) return;
  for (const btn of seg.querySelectorAll('.seg-btn')) {
    const on = btn.dataset.themeVal === state.theme;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const note = $('themeNote');
  if (note) {
    if (state.theme === 'system') {
      note.className = 'set-note';
      note.textContent = `跟随系统：当前系统为${state._sysDark ? '深色' : '浅色'}，界面显示为${THEME_LABEL[effectiveTheme()]}`;
    } else {
      note.className = 'set-note';
      note.textContent = '';
    }
  }
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = effectiveTheme();
}

/** 监听系统主题变化：仅在「跟随系统」时实时切换 */
function watchSystemTheme() {
  let mq = null;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
  } catch (e) {
    return;
  }
  const onChange = () => {
    state._sysDark = mq.matches;
    if (state.theme === 'system') applyTheme('system');
    else syncThemeUi();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/** 点击分段按钮 */
function setTheme(theme) {
  if (!THEME_ORDER.includes(theme)) return;
  applyTheme(theme, { persist: true });
  toast(`外观：${THEME_LABEL[theme]}`, 'ok', 1500);
}

/* ---------------- 设置面板（文件关联） ---------------- */

function openSettings() {
  const mask = $('settingsMask');
  const panel = $('settings');
  if (!mask || !panel) return;
  mask.classList.add('on');
  panel.classList.add('on');
  refreshAssocUi();
  fillAbout();
}

function closeSettings() {
  const mask = $('settingsMask');
  const panel = $('settings');
  if (mask) mask.classList.remove('on');
  if (panel) panel.classList.remove('on');
}

/** 读取真实关联状态（注册表不可用时降级为「不支持」） */
async function refreshAssocUi() {
  const sw = $('swAssoc');
  const note = $('assocNote');
  const row = $('rowAssoc');
  if (!sw) return;
  if (!invoke) {
    sw.setAttribute('aria-checked', 'false');
    sw.classList.add('busy');
    if (note) { note.className = 'set-note err'; note.textContent = '文件关联仅在桌面程序中生效'; }
    if (row) row.style.opacity = '.55';
    return;
  }
  try {
    const st = await invoke('assoc_status');
    sw.setAttribute('aria-checked', st ? 'true' : 'false');
    if (note) { note.className = 'set-note'; note.textContent = st ? '当前已关联：双击 .ofd 文件将用 OFDee 打开' : ''; }
  } catch (e) {
    if (note) { note.className = 'set-note err'; note.textContent = '读取关联状态失败'; }
  }
}

async function fillAbout() {
  const ver = $('setVer');
  if (ver) {
    const m = document.title.match(/v[\d.]+/);
    if (m) ver.textContent = m[0];
  }
  const p = $('setExePath');
  if (p && invoke) {
    try {
      const dir = await invoke('app_dir');
      p.textContent = dir;
    } catch (e) { /* 忽略 */ }
  }
}

async function toggleAssoc() {
  const sw = $('swAssoc');
  const note = $('assocNote');
  if (!sw || !invoke) return;
  const next = sw.getAttribute('aria-checked') !== 'true';
  sw.classList.add('busy');
  if (note) { note.className = 'set-note'; note.textContent = next ? '正在写入注册表…' : '正在取消关联…'; }
  try {
    const msg = await invoke('assoc_set', { enable: next });
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    if (note) { note.className = 'set-note ok'; note.textContent = msg || (next ? '已关联' : '已取消关联'); }
    toast(next ? '已关联 .ofd 文件' : '已取消 .ofd 关联', 'ok');
  } catch (e) {
    if (note) { note.className = 'set-note err'; note.textContent = '操作失败：' + (e && e.message ? e.message : e); }
    toast('关联设置失败：' + (e && e.message ? e.message : e), 'err', 5000);
  } finally {
    sw.classList.remove('busy');
  }
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  $('btnOpen').addEventListener('click', async () => {
    const picked = await pickFile();
    if (picked) openByPath(picked.path);
  });
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) openFromFileObj(f);
    e.target.value = '';
  });
  $('btnPrev').addEventListener('click', () => goPage(state.current - pageStep()));
  $('btnNext').addEventListener('click', () => goPage(state.current + pageStep()));
  $('pageInput').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (isFinite(v)) goPage(v - 1);
    else syncPageUi();
  });
  $('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.2));
  $('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.2));
  $('zoomLabel').addEventListener('click', () => setZoom(1, 'custom'));
  $('btnFitWidth').addEventListener('click', fitWidth);
  $('btnFitPage').addEventListener('click', fitPage);
  $('btnSpread').addEventListener('click', toggleSpread);
  $('btnOutline').addEventListener('click', toggleOutline);
  $('btnNewTab').addEventListener('click', async () => {
    const picked = await pickFile();
    if (picked) openByPath(picked.path);
  });

  // 设置面板
  const btnSet = $('btnSettings');
  if (btnSet) btnSet.addEventListener('click', openSettings);
  const btnSetClose = $('btnSetClose');
  if (btnSetClose) btnSetClose.addEventListener('click', closeSettings);
  const mask = $('settingsMask');
  if (mask) mask.addEventListener('click', closeSettings);
  const sw = $('swAssoc');
  if (sw) {
    sw.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleAssoc(); });
    sw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAssoc(); }
    });
  }
  const rowAssoc = $('rowAssoc');
  if (rowAssoc) rowAssoc.addEventListener('click', (e) => {
    if (e.target.closest('.switch')) return;
    toggleAssoc();
  });

  // 外观三档（点整块 + 键盘方向键都在同一组内切换）
  const segTheme = $('segTheme');
  if (segTheme) {
    segTheme.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (btn && btn.dataset.themeVal) setTheme(btn.dataset.themeVal);
    });
    segTheme.addEventListener('keydown', (e) => {
      const btns = [...segTheme.querySelectorAll('.seg-btn')];
      const cur = btns.findIndex((b) => b === document.activeElement);
      if (cur < 0) return;
      let next = -1;
      if (e.key === 'ArrowRight') next = (cur + 1) % btns.length;
      else if (e.key === 'ArrowLeft') next = (cur - 1 + btns.length) % btns.length;
      if (next >= 0) {
        e.preventDefault();
        btns[next].focus();
        setTheme(btns[next].dataset.themeVal);
      }
    });
  }
  $('btnSide').addEventListener('click', () => {
    state.railOn = !state.railOn;
    updateRailUi();
    saveState();   // 记住这次选择，下次启动沿用
    setTimeout(() => {
      if (state.mode === 'fitWidth') fitWidth();
      else if (state.mode === 'fitPage') fitPage();
      ensureThumbsVisible();
    }, 60);
  });
  $('btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.doc) {
      toast('先打开文件再导出', 'err');
      return;
    }
    setExportMenu(!$('exportMenu').classList.contains('on'));
  });
  document.addEventListener('click', (e) => {
    if (!$('exportWrap').contains(e.target)) setExportMenu(false);
  });
  $('exportMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    setExportMenu(false);
    const act = b.dataset.act;
    if (act === 'pagePng') exportCurrentPage();
    else if (act === 'allPng') exportAllPng();
    else if (act === 'savePdf') exportSavePdf();
  });

  const setRotateMenu = (on) => $('rotateMenu').classList.toggle('on', !!on);
  $('btnRotate').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.doc) {
      toast('先打开文件再旋转', 'err');
      return;
    }
    setRotateMenu(!$('rotateMenu').classList.contains('on'));
  });
  document.addEventListener('click', (e) => {
    if (!$('rotateWrap').contains(e.target)) setRotateMenu(false);
  });
  $('rotateMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    setRotateMenu(false);
    if (b.dataset.act === 'cur') rotatePage(state.current);
    else if (b.dataset.act === 'all') rotateAllPages();
    else if (b.dataset.act === 'reset') resetRotation();
  });
  const btnCopy = $('btnCopy');
  if (btnCopy) btnCopy.addEventListener('click', copyCurrentText);
  $('btnEmptyOpen').addEventListener('click', async () => {
    const picked = await pickFile();
    if (picked) openByPath(picked.path);
  });

  stage().addEventListener('scroll', onScroll, { passive: true });
  $('rail').addEventListener('scroll', () => { ensureThumbsVisible(); }, { passive: true });

  stage().addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    setZoom(state.zoom * (dir > 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  window.addEventListener('resize', () => {
    if (!state.doc) return;
    layout();
    if (state.mode === 'fitWidth') fitWidth();
    else if (state.mode === 'fitPage') fitPage();
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' && e.key !== 'Escape') return;
    // Esc：优先关设置面板
    if (e.key === 'Escape' && $('settings') && $('settings').classList.contains('on')) {
      e.preventDefault();
      closeSettings();
      return;
    }
    // Ctrl+C：有选中文字时复制选中内容（不打断无选中时的其余逻辑）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedPageText()) {
      e.preventDefault();
      copySelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && state.doc) {
      // Ctrl+A 全选当前页文字（PDF 文字层）
      const layer = state.pageEls[state.current] && state.pageEls[state.current].querySelector('.textLayer');
      if (layer) {
        e.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(layer);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      $('btnOpen').click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (state.activeTabId !== null) closeTab(state.activeTabId);
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (state.tabs.length > 1) {
        const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        const dir = e.shiftKey ? -1 : 1;
        const next = state.tabs[(idx + dir + state.tabs.length) % state.tabs.length];
        switchTab(next.id);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
      e.preventDefault();
      $('btnNewTab').click();
    } else if (e.key === 'PageDown' || e.key === 'ArrowRight') {
      goPage(state.current + pageStep());
    } else if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
      goPage(state.current - pageStep());
    } else if (e.key === 'Home') {
      goPage(0);
    } else if (e.key === 'End') {
      goPage(state.doc ? state.doc.pages.length - 1 : 0);
    } else if (e.key === '+' || e.key === '=') {
      setZoom(state.zoom * 1.2);
    } else if (e.key === '-') {
      setZoom(state.zoom / 1.2);
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      fitWidth();
    }
  });

  // 拖拽打开
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropHint').classList.add('on');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropHint').classList.remove('on');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').classList.remove('on');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(ofd|pdf)$/i.test(f.name)) {
      toast('只能打开 OFD 或 PDF：' + f.name, 'err');
      return;
    }
    openFromFileObj(f);
  });

  // 防止 WebView 内默认的整页拖拽导航
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // 页面区域右键菜单（只在文档视图内；输入框保留原生菜单）
  stage().addEventListener('contextmenu', (e) => {
    if (!state.doc) return;
    if (e.target.closest('input, textarea')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.ctx-menu')) hideContextMenu();
  }, true);
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  stage().addEventListener('scroll', hideContextMenu, { passive: true });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  bind();
  initTooltips();
  await loadState();
  // 首屏尽早确定主题（loadState 可能较慢，先用默认值渲染一帧也行，这里是唯一入口）
  applyTheme(state.theme);
  watchSystemTheme();
  renderRecent();
  statusInfoHtml('');
  updateStatusLive();
  syncToolbarEnabled();

  const qs = new URLSearchParams(location.search);
  const src = qs.get('src');
  if (src) {
    const pq = parseInt(qs.get('page'), 10);
    state._jumpTo = isFinite(pq) && pq > 0 ? pq - 1 : null;
    openByPath(src);
    return;
  }

  // 单实例：程序已被打开过时，双击的文件由已有窗口接手
  if (TAURI && TAURI.event && TAURI.event.listen) {
    // 包在 try 里：事件 API 万一不可用也不能挡住后面的启动流程
    try {
      TAURI.event.listen('open-file', (e) => {
        if (e.payload) openByPath(e.payload);
        // 队列里可能还留着同一份（事件到达时它也在），取走丢掉，免得下次启动重复打开
        invoke('take_pending_files').catch(() => {});
      }).catch(() => {});
      // 事件可能早于前端就绪（连着双击两个文件时），那份存在队列里，起来后自取
      const pends = await invoke('take_pending_files');
      for (const p of pends || []) openByPath(p);
    } catch (e) { /* 忽略 */ }
  }

  if (invoke) {
    try {
      const p = await invoke('startup_file');
      if (p) { openByPath(p); return; }
    } catch (e) { /* 忽略 */ }
  }
}

boot();

/* 测试与排障用的最小调试接口（不影响正常使用） */
window.__ofdee = {
  open: openByPath,
  tabs: () => state.tabs.map((t) => t.id === state.activeTabId
    ? { id: t.id, name: state.fileName, loaded: !!state.doc }
    : { id: t.id, name: t.fileName, loaded: !!t.loaded }),
  active: () => state.activeTabId,
  switch: switchTab,
  close: closeTab,
  rotate: {
    get: (i) => pageRotation(i === undefined ? state.current : i),
    all: () => state.doc ? state.doc.pages.map((_, i) => pageRotation(i)) : [],
    page: rotatePage,
    all90: rotateAllPages,
    reset: resetRotation,
    size: (i) => effectiveSize(i)
  },
  settings: { open: openSettings, close: closeSettings, toggleAssoc, refresh: refreshAssocUi },
  theme: {
    get: () => state.theme,
    effective: () => effectiveTheme(),
    set: setTheme,
    apply: applyTheme
  },
  tabsApi: {
    order: () => state.tabs.map((t) => t.fileName || '新标签页'),
    domOrder: () => [...document.querySelectorAll('#tabList .tab')].map((e) => e.textContent.replace('×', '').trim()),
    move: (from, to) => { if (moveTab(from, to)) renderTabs(); },
    dragging: () => !!tabDrag.moved
  }
};
