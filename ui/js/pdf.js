/* PDF 渲染适配层：基于 pdf.js（Apache-2.0），只负责「解析 → 给页面 → 画到 canvas」。
   与 ofd.js 保持同样的对外形态（doc 对象 + 按页渲染），由 app.js 统一调度。 */

const PT2MM = 25.4 / 72;

let libPromise = null;

/** 按需加载 pdf.js（首次打开 PDF 时才载入，避免拖慢启动） */
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/pdf.min.js', document.baseURI).href;
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) { reject(new Error('pdf.js 加载异常')); return; }
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', document.baseURI).href;
      resolve(lib);
    };
    s.onerror = () => reject(new Error('pdf.js 资源缺失，无法渲染 PDF'));
    document.head.appendChild(s);
  });
  return libPromise;
}

export function isPdfReady() {
  return !!window.pdfjsLib;
}

/** 解析 PDF，返回统一的 doc 结构 */
export async function parsePdf(arrayBuffer) {
  const lib = await loadPdfJs();
  let pdf;
  try {
    pdf = await lib.getDocument({
      data: new Uint8Array(arrayBuffer),
      cMapUrl: new URL('./vendor/cmaps/', document.baseURI).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/standard_fonts/', document.baseURI).href,
      isEvalSupported: false,
      // 字体与图片走主线程 fetch，worker 只做解析，行为更可控
      useSystemFonts: true,
      disableFontFace: false
    }).promise;
  } catch (e) {
    if (e && /password/i.test(e.name || e.message || '')) {
      throw new Error('该 PDF 已加密，需要密码才能打开');
    }
    throw new Error('PDF 解析失败：' + ((e && e.message) || e));
  }

  const pages = [];
  const proxies = new Map();
  for (let i = 0; i < pdf.numPages; i++) {
    const p = await pdf.getPage(i + 1);
    proxies.set(i, p);
    const vp = p.getViewport({ scale: 1 });
    pages.push({
      w: +(vp.width * PT2MM).toFixed(2),
      h: +(vp.height * PT2MM).toFixed(2),
      ptW: vp.width,
      ptH: vp.height
    });
  }

  let meta = {};
  try {
    const m = await pdf.getMetadata();
    meta = (m && m.info) || {};
  } catch (e) { /* 元数据缺失不影响阅读 */ }

  const first = pages[0] || { w: 210, h: 297 };

  return {
    kind: 'pdf',
    pages,
    numPages: pdf.numPages,
    pageW: first.w,
    pageH: first.h,
    pdf,
    proxies,
    meta,
    fonts: new Map(),
    fontWarnings: new Set(),
    async destroy() {
      try { await pdf.destroy(); } catch (e) { /* 忽略 */ }
    }
  };
}

async function pageProxy(doc, i) {
  let p = doc.proxies.get(i);
  if (!p) {
    p = await doc.pdf.getPage(i + 1);
    doc.proxies.set(i, p);
  }
  return p;
}

/* 单个 canvas 上限，避免超高倍率把内存打爆（A0 图纸放大时也会走到这里） */
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_PIXELS = 8192 * 8192;

/**
 * 把某页画到 canvas。
 * @param {number} cssWidth 目标显示宽度（CSS px），高度按页面比例自动
 * @param {number} dpr     设备像素比
 */
/**
 * @param {number} extraRotation 用户追加的视图旋转（0/90/180/270）。
 *   pdf.js 的 rotation 是「绝对角度」，会覆盖 PDF 自带的 /Rotate，
 *   所以要把页自带的角度加回来，否则本来歪着的页会被摆正。
 */
export async function renderPdfPage(doc, index, cssWidth, dpr = 1, extraRotation = 0) {
  const proxy = await pageProxy(doc, index);
  const rotation = ((proxy.rotate || 0) + extraRotation) % 360;
  const base = proxy.getViewport({ scale: 1, rotation });

  let scale = (cssWidth * dpr) / base.width;
  const pxW = base.width * scale;
  const pxH = base.height * scale;
  const overSide = Math.max(pxW, pxH) > MAX_CANVAS_SIDE;
  const overPixels = pxW * pxH > MAX_CANVAS_PIXELS;
  if (overSide || overPixels) {
    scale *= Math.min(
      MAX_CANVAS_SIDE / Math.max(pxW, pxH),
      Math.sqrt(MAX_CANVAS_PIXELS / (pxW * pxH))
    );
  }

  const vp = proxy.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await proxy.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;

  // 记录下来，缩放或旋转变化时判断是否需要重画
  canvas.dataset.cssWidth = String(cssWidth);
  canvas.dataset.backing = String(scale);
  canvas.dataset.rotation = String(rotation);
  return canvas;
}

/** 导出用：按指定像素宽度离屏渲染一页（extraRotation 同 renderPdfPage） */
export async function renderPdfPageToCanvas(doc, index, targetWidthPx, extraRotation = 0) {
  const proxy = await pageProxy(doc, index);
  const rotation = ((proxy.rotate || 0) + extraRotation) % 360;
  const base = proxy.getViewport({ scale: 1, rotation });
  const scale = targetWidthPx / base.width;
  const vp = proxy.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await proxy.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
  return canvas;
}

/** PDF 全文文字（导出/复制整页时用） */
export async function getPdfText(doc, index) {
  try {
    const p = await pageProxy(doc, index);
    const tc = await p.getTextContent();
    return tc.items.map((it) => it.str).join('');
  } catch (e) {
    return '';
  }
}

/**
 * 生成页面的文字层（可选中/可复制的透明 DOM 覆盖在 canvas 上）。
 * pdf.js 按 viewport 把每个文字片段定位成 <span>，文字透明、仅保留选择高亮。
 * @param {number} widthPx 该页在屏幕上的 CSS 宽度（与 canvas 显示宽度一致）
 * @returns {Promise<{layer: HTMLElement|null, hasText: boolean}>}
 */
export async function renderPdfTextLayer(doc, index, widthPx, extraRotation = 0) {
  const lib = window.pdfjsLib;
  if (!lib || typeof lib.renderTextLayer !== 'function') return { layer: null, hasText: false };
  const proxy = await pageProxy(doc, index);
  const rotation = ((proxy.rotate || 0) + extraRotation) % 360;
  const base = proxy.getViewport({ scale: 1, rotation });
  const scale = widthPx / base.width;
  // 与画布共用同一个 vp，pdf.js 会自己把每个文字片段排到旋转后的位置
  const vp = proxy.getViewport({ scale, rotation });

  const content = await proxy.getTextContent();
  if (!content.items.length) return { layer: null, hasText: false };

  const layer = document.createElement('div');
  layer.className = 'textLayer';
  // 按绘制时的宽度排版；容器用百分比缩放兜住尺寸变化（重渲染时会重建）
  layer.style.width = Math.round(vp.width) + 'px';
  layer.style.height = Math.round(vp.height) + 'px';

  const task = lib.renderTextLayer({
    textContentSource: content,
    container: layer,
    viewport: vp,
    textDivs: []
  });
  if (task && task.promise) await task.promise;
  else if (task && typeof task._render === 'function') await new Promise((res) => task._render(res));

  // 文字层只用来选字，pointer 事件交给上层容器统一控制
  return { layer, hasText: true };
}

/** 解析 PDF 书签树，dest（命名目标或显式数组）解析为 0 起始页码，解析失败为 null */
export async function getPdfOutline(doc) {
  if (doc._outline) return doc._outline;
  try {
    const raw = await doc.pdf.getOutline();
    if (!raw || !raw.length) { doc._outline = []; return doc._outline; }
    const resolvePage = async (dest) => {
      try {
        let d = dest;
        if (typeof d === 'string') d = await doc.pdf.getDestination(d);
        if (!Array.isArray(d) || !d.length) return null;
        return await doc.pdf.getPageIndex(d[0]);
      } catch (e) {
        return null;
      }
    };
    const walk = async (items) => {
      const out = [];
      for (const it of items || []) {
        const node = {
          title: String(it.title || '').trim() || '（无标题）',
          page: await resolvePage(it.dest),
          children: (it.items && it.items.length) ? await walk(it.items) : []
        };
        out.push(node);
      }
      return out;
    };
    doc._outline = await walk(raw);
    return doc._outline;
  } catch (e) {
    doc._outline = [];
    return doc._outline;
  }
}

export { PT2MM };
