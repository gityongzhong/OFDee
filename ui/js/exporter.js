/* 导出模块：全文 PDF / 全部页 PNG(zip)
   - PDF 合成：自研最小写入器（JPEG DCTDecode，逐页 MediaBox 按 mm→pt），零依赖
   - ZIP 打包：store 模式 + CRC32，零依赖
   - 光栅化：OFD 走 SVG→<img>→canvas（注入内嵌字体 data URL）；PDF 走 pdf.js 直绘 */
import { renderPage as renderOfdPage, buildFontCSS, MM2PX } from './ofd.js';
import { renderPdfPageToCanvas } from './pdf.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function nextFrame() {
  return new Promise((r) => setTimeout(r, 0));
}

/* ---------------- OFD 单页 → canvas ---------------- */

export async function ofdPageCanvas(doc, index, scale, rotation = 0) {
  const svg = await renderOfdPage(doc, index, rotation);
  const clone = svg.cloneNode(true);
  const css = buildFontCSS(doc);
  if (css) {
    const style = document.createElementNS(SVGNS, 'style');
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);
  }
  // 90/270 度时画布宽高已随旋转互换
  const swap = ((rotation % 360) + 360) % 360 % 180 !== 0;
  const w = (swap ? doc.pageH : doc.pageW) * MM2PX * scale;
  const h = (swap ? doc.pageW : doc.pageH) * MM2PX * scale;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('xmlns', SVGNS);
  const text = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error(`第 ${index + 1} 页 SVG 光栅化失败`));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------------- PDF 单页 → canvas（按 DPI） ---------------- */

export async function pdfPageCanvas(doc, index, dpi, rotation = 0) {
  const p = doc.pages[index];
  const ptW = (p && p.ptW) || 595;
  return renderPdfPageToCanvas(doc, index, Math.round(ptW * dpi / 72), rotation);
}

/* ---------------- canvas → JPEG 字节 ---------------- */

export function canvasToJpegBytes(canvas, quality = 0.92) {
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return base64ToBytes(b64);
}

export function canvasToPngBytes(canvas) {
  const dataUrl = canvas.toDataURL('image/png');
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return base64ToBytes(b64);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- 最小 PDF 写入器（图像页） ----------------
   对象布局：1 Catalog · 2 Pages · 每页 3 个对象（Page / 内容流 / 图片 XObject） */

export function buildPdfBlob(pages, opts = {}) {
  const quality = opts.quality || 0.92;
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (data) => {
    const u8 = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(u8);
    offset += u8.length;
  };
  const obj = (body) => {
    offsets.push(offset);
    push(body);
  };

  push('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n');

  const n = pages.length;
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  obj(`2 0 obj\n<< /Type /Pages /Count ${n} /Kids [${kids}] >>\nendobj\n`);

  pages.forEach((pg, i) => {
    const jpeg = canvasToJpegBytes(pg.canvas, quality);
    const wPt = (pg.wMM * 72) / 25.4;
    const hPt = (pg.hMM * 72) / 25.4;
    const pw = pg.canvas.width;
    const ph = pg.canvas.height;
    const pageId = 3 + i * 3;
    const contentId = pageId + 1;
    const imgId = pageId + 2;

    obj(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(
        2
      )}] /Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`
    );
    const content = `q\n${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
    obj(
      `${contentId} 0 obj\n<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`
    );
    obj(
      `${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pw} /Height ${ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    );
    push(jpeg);
    push('\nendstream\nendobj\n');
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  // pdf.js 等阅读器要求 trailer 携带 /ID
  const idHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`
  );

  const total = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    total.set(c, p);
    p += c.length;
  }
  return new Blob([total], { type: 'application/pdf' });
}

/* ---------------- ZIP（store 模式）打包 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime() {
  const d = new Date();
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/** entries: [{name, bytes}] → Blob。文件名按 UTF-8（置 flag bit 11） */
export function buildZipBlob(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const e of entries) {
    const nameB = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const sz = e.bytes.length;

    const local = new Uint8Array(30 + nameB.length);
    local.set(u32(0x04034b50), 0);
    local.set(u16(20), 4); // version needed
    local.set(u16(0x0800), 6); // UTF-8 flag
    local.set(u16(0), 8); // method: store
    local.set(u16(time), 10);
    local.set(u16(date), 12);
    local.set(u32(crc), 14);
    local.set(u32(sz), 18); // compressed
    local.set(u32(sz), 22); // uncompressed
    local.set(u16(nameB.length), 26);
    local.set(u16(0), 28);
    local.set(nameB, 30);
    parts.push(local, e.bytes);

    const cen = new Uint8Array(46 + nameB.length);
    cen.set(u32(0x02014b50), 0);
    cen.set(u16(20), 4); // version made by
    cen.set(u16(20), 6); // version needed
    cen.set(u16(0x0800), 8);
    cen.set(u16(0), 10);
    cen.set(u16(time), 12);
    cen.set(u16(date), 14);
    cen.set(u32(crc), 16);
    cen.set(u32(sz), 20);
    cen.set(u32(sz), 24);
    cen.set(u16(nameB.length), 28);
    cen.set(u32(offset), 42);
    cen.set(nameB, 46);
    central.push(cen);

    offset += local.length + sz;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  eocd.set(u32(0x06054b50), 0);
  eocd.set(u16(entries.length), 8);
  eocd.set(u16(entries.length), 10);
  eocd.set(u32(centralSize), 12);
  eocd.set(u32(offset), 16);

  const all = [...parts, ...central, eocd];
  return new Blob(all, { type: 'application/zip' });
}

/* ---------------- 高层导出 ---------------- */

/**
 * 全文转 PDF：OFD 光栅化逐页 / PDF 直接用原始字节
 * 返回 { blob, fromRaw }
 */
export async function exportDocAsPdf(doc, kind, rawBytes, onProgress, opts = {}) {
  const rotOf = opts.rotOf || (() => 0);
  // PDF 原样转存会丢掉用户手动加的旋转（文件里的 /Rotate 没变），
  // 所以只要有任何一页被转过，就改走重新渲染的路线。
  const rotated = doc.pages.some((_, i) => rotOf(i));
  if (kind === 'pdf' && !rotated) {
    if (!rawBytes || !rawBytes.length) throw new Error('原始 PDF 数据不可用');
    return { blob: new Blob([rawBytes], { type: 'application/pdf' }), fromRaw: true };
  }
  const pages = [];
  for (let i = 0; i < doc.pages.length; i++) {
    if (onProgress) onProgress(i + 1, doc.pages.length);
    const rot = rotOf(i);
    const swap = rot % 180 !== 0;
    let canvas, wMM, hMM;
    if (kind === 'pdf') {
      const p = doc.pages[i];
      const ptW = (p && p.ptW) || 595;
      const ptH = (p && p.ptH) || 842;
      canvas = await pdfPageCanvas(doc, i, opts.dpi || 144, rot);
      wMM = ((swap ? ptH : ptW) * 25.4) / 72;
      hMM = ((swap ? ptW : ptH) * 25.4) / 72;
    } else {
      canvas = await ofdPageCanvas(doc, i, opts.ofdScale || 2, rot);
      wMM = swap ? doc.pageH : doc.pageW;
      hMM = swap ? doc.pageW : doc.pageH;
    }
    pages.push({ canvas, wMM, hMM });
    await nextFrame();
  }
  if (onProgress) onProgress(doc.pages.length, doc.pages.length, '合成 PDF…');
  return { blob: buildPdfBlob(pages), fromRaw: false };
}

/**
 * 全部页导出 PNG（zip）
 * scale: OFD 光栅化倍率；dpi: PDF 渲染 DPI
 */
export async function exportDocAsPngZip(doc, kind, base, onProgress, opts = {}) {
  const ofdScale = opts.ofdScale || 2;
  const dpi = opts.dpi || 144;
  const rotOf = opts.rotOf || (() => 0);
  const entries = [];
  for (let i = 0; i < doc.pages.length; i++) {
    if (onProgress) onProgress(i + 1, doc.pages.length);
    const canvas =
      kind === 'pdf'
        ? await pdfPageCanvas(doc, i, dpi, rotOf(i))
        : await ofdPageCanvas(doc, i, ofdScale, rotOf(i));
    entries.push({ name: `${base}-第${i + 1}页.png`, bytes: canvasToPngBytes(canvas) });
    await nextFrame();
  }
  if (onProgress) onProgress(doc.pages.length, doc.pages.length, '打包 zip…');
  return buildZipBlob(entries);
}
