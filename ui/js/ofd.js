// OFD 解析与渲染内核（自研，遵循 GB/T 33190-2016 的常用子集）
// 设计取舍：
//  - 输出 SVG，缩放走 CSS，矢量不重绘，放大不糊
//  - 解析与渲染分离，按页懒渲染由外层控制
//  - 字体优先使用 OFD 内嵌 TTF/OTF，缺字才回退系统字体

import { openZip } from './zip.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MM2PX = 96 / 25.4;

/* ---------------- 小工具 ---------------- */

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('XML 结构错误：' + (err.textContent || '').slice(0, 120));
  return doc;
}

function first(root, localName) {
  if (!root) return null;
  const list = root.children || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].localName === localName) return list[i];
  }
  return null;
}

function collect(root, localName, out = []) {
  if (!root) return out;
  const list = root.children || [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.localName === localName) out.push(c);
    collect(c, localName, out);
  }
  return out;
}

function deepText(el) {
  if (!el) return '';
  return (el.textContent || '').trim();
}

function attr(el, name) {
  return el ? el.getAttribute(name) : null;
}

function num(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function nums(v, want) {
  if (!v) return null;
  const arr = v.trim().split(/[\s,]+/).map(parseFloat).filter((n) => isFinite(n));
  if (want && arr.length !== want) return null;
  return arr;
}

function parseBox(v) {
  const a = nums(v, 4);
  if (!a) return null;
  return { x: a[0], y: a[1], w: a[2], h: a[3] };
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function resolvePath(baseDir, rel) {
  if (!rel) return '';
  let r = rel.replace(/\\/g, '/').trim();
  if (r.startsWith('/')) return r.slice(1);
  const parts = (baseDir ? baseDir.split('/') : []).concat(r.split('/'));
  const out = [];
  for (const s of parts) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

function colorOf(el) {
  if (!el) return null;
  const v = attr(el, 'Value');
  if (!v) return null;
  const parts = v.trim().split(/\s+/).map(Number);
  if (parts.length >= 3 && parts.every((n) => isFinite(n))) {
    const [r, g, b] = parts;
    const a = parts.length >= 4 ? parts[3] / 255 : 1;
    return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
  if (/^#?[0-9a-fA-F]{6,8}$/.test(v.trim())) {
    return v.trim().startsWith('#') ? v.trim() : '#' + v.trim();
  }
  return null;
}

function mimeOf(name) {
  const e = (name.split('.').pop() || '').toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    tif: 'image/tiff', tiff: 'image/tiff', jb2: 'image/jbig2'
  }[e] || 'application/octet-stream';
}

function fontMimeOf(name) {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (e === 'otf' || e === 'cff') return 'font/otf';
  return 'font/ttf';
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  if (attrs) for (const k in attrs) {
    if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== '') {
      el.setAttribute(k, String(attrs[k]));
    }
  }
  return el;
}

/* 测量文字宽度（无字距信息时的兜底），1px 与 1mm 数值等价 */
let measureCtx = null;
function measureChar(ch, family, size) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px "${family}"`;
  const w = measureCtx.measureText(ch).width;
  return isFinite(w) && w > 0 ? w : size;
}

/* DeltaX 解析：支持 数字 / g N v1..vN 分组循环填充，语义为「第 i 个字符到第 i+1 个的间距」 */
/**
 * 解析 DeltaX / DeltaY 的字距数组。相邻两字符共用一个间距，有效长度是 charCount - 1。
 *
 * 标准写法是一串数值，其中 `g n v` 表示「数值 v 连续重复 n 次」，例如
 *   `g 4 5.7996 5.7572 g 2 5.7996` → [5.7996, 5.7996, 5.7996, 5.7996, 5.7572, 5.7996, 5.7996]
 * 早先把它误读成「g 后面 n 个数构成一个循环单元、再循环填满」，
 * 会把下一个 g 的**重复次数**当成间距值（比如读出 2.0 这种比正常字距小一半多的值），
 * 字符随即挤成一团，看上去就像整段文字丢了字。
 */
export function parseDelta(str, charCount) {
  const need = Math.max(0, charCount - 1);
  if (!str || need === 0) return [];
  const toks = str.trim().split(/\s+/);
  const vals = [];
  let i = 0;
  while (i < toks.length && vals.length < need) {
    const t = toks[i];
    if (t === 'g' || t === 'G') {
      const cnt = parseInt(toks[i + 1], 10);
      const v = parseFloat(toks[i + 2]);
      i += 3;
      // 参数不全（不规范文件）就跳过这一组，剩下的交给调用方按实测字宽兜底
      if (!isFinite(cnt) || cnt <= 0 || !isFinite(v)) continue;
      for (let k = 0; k < cnt && vals.length < need; k++) vals.push(v);
    } else {
      const v = parseFloat(t);
      i += 1;
      if (isFinite(v)) vals.push(v);
    }
  }
  return vals.slice(0, need);
}

/* AbbreviatedData → SVG path d */
export function abbrToPathD(data) {
  if (!data) return '';
  const toks = data.match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!toks) return '';
  let d = '';
  let i = 0;
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;

  const read = (n) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      const v = parseFloat(toks[i + k]);
      if (!isFinite(v)) return null;
      out.push(v);
    }
    i += n;
    return out;
  };

  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z]$/.test(t)) { cmd = t; i++; }
    if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M' || C === 'L') {
      const a = read(2);
      if (!a) break;
      const x = rel ? cx + a[0] : a[0];
      const y = rel ? cy + a[1] : a[1];
      d += `${C === 'M' ? 'M' : 'L'}${x.toFixed(4)} ${y.toFixed(4)}`;
      cx = x; cy = y;
      if (C === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
    } else if (C === 'C') {
      const a = read(6);
      if (!a) break;
      const x1 = rel ? cx + a[0] : a[0], y1 = rel ? cy + a[1] : a[1];
      const x2 = rel ? cx + a[2] : a[2], y2 = rel ? cy + a[3] : a[3];
      const x = rel ? cx + a[4] : a[4], y = rel ? cy + a[5] : a[5];
      d += `C${x1.toFixed(4)} ${y1.toFixed(4)} ${x2.toFixed(4)} ${y2.toFixed(4)} ${x.toFixed(4)} ${y.toFixed(4)}`;
      cx = x; cy = y;
    } else if (C === 'Q') {
      const a = read(4);
      if (!a) break;
      const x1 = rel ? cx + a[0] : a[0], y1 = rel ? cy + a[1] : a[1];
      const x = rel ? cx + a[2] : a[2], y = rel ? cy + a[3] : a[3];
      d += `Q${x1.toFixed(4)} ${y1.toFixed(4)} ${x.toFixed(4)} ${y.toFixed(4)}`;
      cx = x; cy = y;
    } else if (C === 'A' || C === 'S' || C === 'T') {
      // 圆弧/平滑曲线在 OFD 中较少见，按参数个数尽量吸收，避免整条路径失败
      const a = read(C === 'A' ? 7 : C === 'S' ? 4 : 2);
      if (!a) break;
      if (C === 'S') {
        const x2 = rel ? cx + a[0] : a[0], y2 = rel ? cy + a[1] : a[1];
        const x = rel ? cx + a[2] : a[2], y = rel ? cy + a[3] : a[3];
        d += `S${x2.toFixed(4)} ${y2.toFixed(4)} ${x.toFixed(4)} ${y.toFixed(4)}`;
        cx = x; cy = y;
      } else if (C === 'T') {
        const x = rel ? cx + a[0] : a[0], y = rel ? cy + a[1] : a[1];
        d += `T${x.toFixed(4)} ${y.toFixed(4)}`;
        cx = x; cy = y;
      } else {
        const x = rel ? cx + a[5] : a[5], y = rel ? cy + a[6] : a[6];
        d += `A${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${x.toFixed(4)} ${y.toFixed(4)}`;
        cx = x; cy = y;
      }
    } else if (C === 'B') {
      d += 'Z';
      cx = sx; cy = sy;
    } else {
      i++;
    }
  }
  return d;
}

/* ---------------- 文档大纲 ---------------- */

/* 解析 Document.xml 里的 <Bookmarks><Bookmark Name Dest PageID .../>。
   注意：部分电子公文生成器会塞入 quanwen / outgoingNo 这类纯英文锚点，
   不是给人看的目录 —— 全部为 ASCII 标识符时按无大纲处理。 */
function parseOutline(bookmarksEl, pageIdIndex) {
  if (!bookmarksEl) return [];
  let hasCJK = false;
  const walk = (parent) => {
    const out = [];
    for (const c of parent.children || []) {
      if (c.localName !== 'Bookmark') continue;
      const name = (attr(c, 'Name') || '').trim();
      if (/^[\x21-\x7e]+$/.test(name)) continue; // 纯 ASCII：隐藏锚点，丢弃
      if (/[\u4e00-\u9fff]/.test(name)) hasCJK = true;
      const destEl = first(c, 'Dest');
      const pid = attr(destEl, 'PageID');
      out.push({
        title: name || '（未命名）',
        page: pageIdIndex.has(pid) ? pageIdIndex.get(pid) : null,
        children: walk(c)
      });
    }
    return out;
  };
  const tree = walk(bookmarksEl);
  return hasCJK ? tree : [];
}

/* ---------------- 文档解析 ---------------- */

export async function parseOfd(arrayBuffer) {
  const zip = await openZip(arrayBuffer);

  let ofdText = await zip.text('OFD.xml');
  if (!ofdText) throw new Error('缺少 OFD.xml，不是标准 OFD 文件');
  let ofdDoc = parseXml(ofdText);
  let docBody = collect(ofdDoc.documentElement, 'DocBody')[0];
  if (!docBody) throw new Error('OFD.xml 中缺少 DocBody');

  const docInfoEl = first(docBody, 'DocInfo');
  const docInfo = {
    author: deepText(first(docInfoEl, 'Author')),
    creator: deepText(first(docInfoEl, 'Creator')),
    date: deepText(first(docInfoEl, 'CreationDate')),
    title: deepText(first(docInfoEl, 'Title')),
    subject: deepText(first(docInfoEl, 'Subject'))
  };

  const docRootPath = resolvePath('', deepText(first(docBody, 'DocRoot')) || 'Doc_0/Document.xml');
  const docXmlText = await zip.text(docRootPath);
  if (!docXmlText) throw new Error('缺少文档根对象：' + docRootPath);
  const docXml = parseXml(docXmlText);
  const docEl = docXml.documentElement;
  const commonData = first(docEl, 'CommonData');

  const pageArea = first(commonData, 'PageArea');
  const phys = parseBox(deepText(first(pageArea, 'PhysicalBox'))) || { x: 0, y: 0, w: 210, h: 297 };

  // 字体
  const fonts = new Map();
  const fontFiles = [];
  const imageIndex = new Map();
  const publicResRel = deepText(first(commonData, 'PublicRes'));
  if (publicResRel) {
    const pPath = resolvePath(dirOf(docRootPath), publicResRel);
    const pText = await zip.text(pPath);
    if (pText) {
      const pXml = parseXml(pText);
      const baseLoc = attr(pXml.documentElement, 'BaseLoc') || '';
      const baseDir = resolvePath(dirOf(pPath), baseLoc);
      for (const f of collect(pXml.documentElement, 'Font')) {
        const id = attr(f, 'ID');
        const ffile = first(f, 'FontFile');
        const rec = {
          id,
          name: attr(f, 'FontName') || '',
          file: ffile ? resolvePath(baseDir, deepText(ffile)) : null,
          family: `ofd-f${id}`,
          embedded: false
        };
        fonts.set(id, rec);
        if (rec.file) fontFiles.push(rec);
      }
      for (const mm of collect(pXml.documentElement, 'MultiMedia')) {
        const mf = first(mm, 'MediaFile');
        if (mf) imageIndex.set(attr(mm, 'ID'), resolvePath(baseDir, deepText(mf)));
      }
    }
  }

  // 图片
  const docResRel = deepText(first(commonData, 'DocumentRes'));
  if (docResRel) {
    const dPath = resolvePath(dirOf(docRootPath), docResRel);
    const dText = await zip.text(dPath);
    if (dText) {
      const dXml = parseXml(dText);
      const baseLoc = attr(dXml.documentElement, 'BaseLoc') || '';
      const baseDir = resolvePath(dirOf(dPath), baseLoc);
      for (const mm of collect(dXml.documentElement, 'MultiMedia')) {
        const mf = first(mm, 'MediaFile');
        if (mf) imageIndex.set(attr(mm, 'ID'), resolvePath(baseDir, deepText(mf)));
      }
    }
  }

  // 页面
  const pagesEl = first(docEl, 'Pages');
  const pages = [];
  const pageIdIndex = new Map();
  for (const pg of collect(pagesEl, 'Page')) {
    const loc = attr(pg, 'BaseLoc');
    if (!loc) continue;
    const pid = attr(pg, 'ID');
    pageIdIndex.set(pid, pages.length);
    pages.push({
      id: pid,
      path: resolvePath(dirOf(docRootPath), loc)
    });
  }
  if (!pages.length) throw new Error('文档中没有页面');

  // 文档大纲：Bookmarks 里的 Bookmark 节点（有的公文用它放隐藏锚点，名称是英文字段 id）
  const outline = parseOutline(first(docEl, 'Bookmarks'), pageIdIndex);

  const doc = {
    zip,
    docInfo,
    pageW: phys.w || 210,
    pageH: phys.h || 297,
    pages,
    outline,
    fonts,
    images: imageIndex,
    fontWarnings: new Set(),
    fontCSS: null,
    // 缓存字体二进制，导出 PNG/PDF 时内联用
    fontBytes: new Map(),
    imageURLCache: new Map()
  };

  await loadFonts(doc);
  return doc;
}

/* OFD 内嵌字体常有三类不合规，都会被浏览器 OTS 校验拒绝，导致中文全部回退系统字体：
   1) 表目录未按标签升序、表数据偏移未随目录递增
   2) OS/2 表标签被写成小写 "os/2"（国产字体常见）
   3) cmap 里引用了超出 glyph 总数的字形号（子集化残留）
   做法：整体重建 sfnt —— 目录归一化排序、表数据按序重排、修补 cmap、
   重算每个表校验和与 head.checkSumAdjustment，输出一份合规字体。 */
function tagKey(t) {
  return ((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0;
}

const T_OS2 = tagKey([0x4f, 0x53, 0x2f, 0x32]);
const T_HEAD = tagKey([0x68, 0x65, 0x61, 0x64]);
const T_MAXP = tagKey([0x6d, 0x61, 0x78, 0x70]);
const T_CMAP = tagKey([0x63, 0x6d, 0x61, 0x70]);

function patchCmap(src, numGlyphs) {
  const out = src.slice();
  try {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const n = dv.getUint16(2);
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const rec = 4 + i * 8;
      if (rec + 8 > out.byteLength) break;
      const sub = dv.getUint32(rec + 4);
      if (seen.has(sub) || sub + 16 > out.byteLength) continue;
      seen.add(sub);
      const fmt = dv.getUint16(sub);
      if (fmt === 4) {
        const segX2 = dv.getUint16(sub + 6);
        const seg = segX2 >> 1;
        const endBase = sub + 14;
        const startBase = endBase + segX2 + 2;
        const deltaBase = startBase + segX2;
        const rangeBase = deltaBase + segX2;
        // 末尾哨兵段（0xFFFF→0xFFFF）必须映射到 glyph 0，部分字体把 idDelta 写成 0，
        // 会让映射结果落到 65535 而被 OTS 判定越界。规范做法是 idDelta = 1。
        for (let s = 0; s < seg; s++) {
          const st = dv.getUint16(startBase + s * 2);
          const en = dv.getUint16(endBase + s * 2);
          const ro = dv.getUint16(rangeBase + s * 2);
          if (ro === 0 && st === 0xffff && en === 0xffff) {
            const g = (st + dv.getInt16(deltaBase + s * 2)) & 0xffff;
            if (g >= numGlyphs) dv.setInt16(deltaBase + s * 2, 1);
          }
        }
        for (let s = 0; s < seg; s++) {
          const ro = dv.getUint16(rangeBase + s * 2);
          if (!ro) continue;
          const start = dv.getUint16(startBase + s * 2);
          const end = dv.getUint16(endBase + s * 2);
          const glyphPos = rangeBase + s * 2 + ro;
          for (let c = start; c <= end && c !== 0xffff; c++) {
            const p = glyphPos + (c - start) * 2;
            if (p + 2 > out.byteLength) break;
            const g = dv.getUint16(p);
            if (g >= numGlyphs) dv.setUint16(p, 0);
          }
        }
      } else if (fmt === 12) {
        const groups = dv.getUint32(sub + 12);
        for (let g = 0; g < groups; g++) {
          const p = sub + 16 + g * 12;
          if (p + 12 > out.byteLength) break;
          if (dv.getUint32(p + 8) >= numGlyphs) dv.setUint32(p + 8, 0);
        }
      }
    }
  } catch (e) { /* 修补失败就按原样使用 */ }
  return out;
}

function rebuildSfnt(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sig = dv.getUint32(0);
    if (sig !== 0x00010000 && sig !== 0x74727565) return bytes;
    const numTables = dv.getUint16(4);
    const dirLen = 12 + numTables * 16;
    if (!numTables || dirLen > bytes.byteLength) return bytes;

    const readTag = (o) => {
      const t = [dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)];
      if (tagKey(t) === tagKey([0x6f, 0x73, 0x2f, 0x32])) return [0x4f, 0x53, 0x2f, 0x32];
      return t;
    };

    const tables = [];
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const off = dv.getUint32(o + 8);
      const len = dv.getUint32(o + 12);
      if (off + len > bytes.byteLength) return bytes;
      const tag = readTag(o);
      tables.push({ tag, key: tagKey(tag), off, len, data: null });
    }

    const maxp = tables.find((t) => t.key === T_MAXP);
    const numGlyphs = maxp && maxp.len >= 6 ? new DataView(bytes.buffer, bytes.byteOffset + maxp.off).getUint16(4) : 0;
    if (numGlyphs) {
      const cmap = tables.find((t) => t.key === T_CMAP);
      if (cmap) cmap.data = patchCmap(bytes.subarray(cmap.off, cmap.off + cmap.len), numGlyphs);
    }

    tables.sort((a, b) => a.key - b.key);

    let cursor = dirLen;
    for (const t of tables) {
      cursor = (cursor + 3) & ~3;
      t.newOff = cursor;
      cursor += ((t.data ? t.data.length : t.len) + 3) & ~3;
    }
    const out = new Uint8Array(cursor);
    out.set(bytes.subarray(0, 12), 0);
    for (const t of tables) {
      out.set(t.data || bytes.subarray(t.off, t.off + t.len), t.newOff);
    }

    const odv = new DataView(out.buffer);
    const head = tables.find((t) => t.key === T_HEAD);
    if (head && head.len >= 12) odv.setUint32(head.newOff + 8, 0);

    const checksumOf = (buf, off, len) => {
      let sum = 0;
      for (let i = 0; i < len; i += 4) {
        const b0 = buf[off + i] || 0;
        const b1 = i + 1 < len ? buf[off + i + 1] : 0;
        const b2 = i + 2 < len ? buf[off + i + 2] : 0;
        const b3 = i + 3 < len ? buf[off + i + 3] : 0;
        sum = (sum + ((b0 << 24) >>> 0) + (b1 << 16) + (b2 << 8) + b3) >>> 0;
      }
      return sum >>> 0;
    };

    tables.forEach((t, i) => {
      const o = 12 + i * 16;
      const len = t.data ? t.data.length : t.len;
      out[o] = t.tag[0]; out[o + 1] = t.tag[1]; out[o + 2] = t.tag[2]; out[o + 3] = t.tag[3];
      odv.setUint32(o + 4, checksumOf(out, t.newOff, len));
      odv.setUint32(o + 8, t.newOff);
      odv.setUint32(o + 12, len);
    });

    if (head && head.len >= 12) {
      const fileSum = checksumOf(out, 0, out.byteLength);
      odv.setUint32(head.newOff + 8, (0xb1b0afba - fileSum) >>> 0);
    }
    return out;
  } catch (e) {
    return bytes;
  }
}

async function loadFonts(doc) {
  const jobs = [];
  for (const f of doc.fonts.values()) {
    if (!f.file) continue;
    jobs.push((async () => {
      const bytes = await doc.zip.read(f.file);
      if (!bytes || !bytes.byteLength) return;
      const fixed = rebuildSfnt(bytes);
      doc.fontBytes.set(f.id, fixed);
      try {
        // FontFace 直接吃 ArrayBuffer，省掉 base64
        const face = new FontFace(f.family, fixed.buffer.slice(fixed.byteOffset, fixed.byteOffset + fixed.byteLength));
        await face.load();
        document.fonts.add(face);
        f.embedded = true;
      } catch (e) {
        f.error = (e && e.message) || String(e);
        doc.fontWarnings.add(`${f.name}（内嵌字体无法载入）`);
        console.warn('字体载入失败', f.name, f.file, f.error);
      }
    })().catch(() => {}));
  }
  await Promise.all(jobs);
}

/* ---------------- 页面渲染 ---------------- */

/**
 * @param {number} rotation 顺时针视图旋转（0/90/180/270）。
 *   90/270 度时画布宽高互换，页面内容整体套一层 g 变换；
 *   白底矩形留在 g 外面铺满新画布，否则转完会露出空白三角。
 */
export async function renderPage(doc, index, rotation = 0) {
  const pg = doc.pages[index];
  if (!pg) throw new Error('页索引越界');
  const text = await doc.zip.text(pg.path);
  if (!text) throw new Error('页面内容缺失：' + pg.path);
  const xml = parseXml(text);

  const W = doc.pageW;
  const H = doc.pageH;
  const rot = ((rotation % 360) + 360) % 360;
  const swap = rot % 180 !== 0;
  const cw = swap ? H : W; // 旋转后画布尺寸（mm）
  const ch = swap ? W : H;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${cw} ${ch}`,
    preserveAspectRatio: 'xMidYMid meet',
    xmlns: SVGNS
  });
  svg.dataset.page = String(index);
  svg.dataset.rotation = String(rot);
  svg.setAttribute('width', String(cw * MM2PX));
  svg.setAttribute('height', String(ch * MM2PX));
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = '100%';

  const bg = svgEl('rect', {
    x: 0, y: 0, width: cw, height: ch, fill: '#ffffff'
  });
  svg.appendChild(bg);

  // 内容容器：没旋转就直接挂 svg，省一层无用的 g
  let host = svg;
  if (rot) {
    const shift =
      rot === 90 ? `translate(${H} 0) rotate(90)`
      : rot === 180 ? `translate(${W} ${H}) rotate(180)`
      : `translate(0 ${W}) rotate(270)`;
    host = svgEl('g', { transform: shift });
    svg.appendChild(host);
  }

  const objects = [];
  for (const ln of ['TextObject', 'PathObject', 'ImageObject']) {
    for (const el of collect(xml.documentElement, ln)) objects.push(el);
  }
  // 按文档顺序恢复（collect 分类型收集会打乱层叠次序，需重排）
  objects.sort((a, b) => {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  for (const el of objects) {
    let node = null;
    try {
      if (el.localName === 'TextObject') node = buildText(doc, el);
      else if (el.localName === 'PathObject') node = buildPath(el);
      else if (el.localName === 'ImageObject') node = await buildImage(doc, el);
    } catch (e) {
      console.warn('对象渲染失败', el.localName, e);
    }
    if (node) host.appendChild(node);
  }
  return svg;
}

function baseTransform(el) {
  const b = parseBox(attr(el, 'Boundary')) || { x: 0, y: 0, w: 0, h: 0 };
  const ctm = nums(attr(el, 'CTM'), 6) || [1, 0, 0, 1, 0, 0];
  const t = `translate(${b.x} ${b.y}) matrix(${ctm.join(' ')})`;
  return { boundary: b, ctm, transform: t };
}

function familyFor(doc, fontId) {
  const f = doc.fonts.get(fontId);
  if (f) {
    if (!f.embedded) doc.fontWarnings.add(f.name || ('字体 ' + fontId));
    return `"${f.family}", "${f.name}", "SimSun", serif`;
  }
  return '"SimSun", serif';
}

function buildText(doc, el) {
  const { boundary, transform } = baseTransform(el);
  const size = num(attr(el, 'Size'), 3.5);
  const fontId = attr(el, 'Font');
  const fill = colorOf(first(el, 'FillColor')) || '#000000';
  const strokeEl = first(el, 'StrokeColor');
  const stroke = colorOf(strokeEl);
  const hscale = num(attr(el, 'HScale'), 1);
  const italic = String(attr(el, 'Italic') || '').toLowerCase() === 'true';
  const weight = num(attr(el, 'Weight'), 400);
  const charDir = num(attr(el, 'CharDirection'), 0);

  const g = svgEl('g', { transform });
  if (hscale && hscale !== 1) g.setAttribute('transform', `${transform} scale(${hscale} 1)`);

  const family = familyFor(doc, fontId);
  const codes = collect(el, 'TextCode');
  if (!codes.length) return null;

  for (const tc of codes) {
    const raw = tc.textContent || '';
    if (!raw) continue;
    const chars = [...raw];
    const X = num(attr(tc, 'X'), 0);
    const Y = num(attr(tc, 'Y'), 0);

    const t = svgEl('text', {
      y: Y, 'font-size': size, 'font-family': family, fill,
      'font-weight': weight && weight !== 400 ? weight : null,
      'font-style': italic ? 'italic' : null,
      'xml:space': 'preserve',
      'letter-spacing': 0
    });

    if (charDir === 1) {
      // 竖排：逐字下移
      const gaps = parseDelta(attr(tc, 'DeltaY'), chars.length);
      let cy = Y;
      chars.forEach((ch, i) => {
        t.appendChild(svgEl('tspan', { x: X, y: cy }));
        t.lastChild.textContent = ch;
        cy += gaps[i] !== undefined ? gaps[i] : size;
      });
    } else {
      const gaps = parseDelta(attr(tc, 'DeltaX'), chars.length);
      const xs = [];
      let cx = X;
      for (let i = 0; i < chars.length; i++) {
        xs.push(+cx.toFixed(4));
        const g0 = gaps[i];
        cx += g0 !== undefined ? g0 : measureChar(chars[i], family, size);
      }
      // 逐字给 x 列表，保证与原稿字距完全一致
      t.setAttribute('x', xs.join(' '));
      t.textContent = raw;
    }

    if (stroke) {
      t.setAttribute('stroke', stroke);
      t.setAttribute('stroke-width', '0.05');
    }
    g.appendChild(t);
  }

  if (!g.childNodes.length) return null;
  return g;
}

function buildPath(el) {
  const { transform } = baseTransform(el);
  const abbr = deepText(first(el, 'AbbreviatedData'));
  const d = abbrToPathD(abbr);
  if (!d) return null;

  const fill = colorOf(first(el, 'FillColor'));
  const stroke = colorOf(first(el, 'StrokeColor'));
  const lw = num(attr(el, 'LineWidth'), 0.353);
  const dash = attr(el, 'DashPattern');

  const attrs = {
    d,
    transform,
    fill: fill || 'none',
    stroke: stroke || (fill ? 'none' : '#000000'),
    'stroke-width': lw,
    'stroke-linecap': (attr(el, 'Cap') || 'Butt').toLowerCase(),
    'stroke-linejoin': (attr(el, 'Join') || 'Miter').toLowerCase(),
    'fill-rule': 'nonzero'
  };
  if (dash && !/^0(\s+0)*$/.test(dash.trim())) {
    attrs['stroke-dasharray'] = dash.trim().split(/\s+/).map(parseFloat).join(' ');
  }
  return svgEl('path', attrs);
}

async function buildImage(doc, el) {
  const rid = attr(el, 'ResourceID');
  const file = doc.images.get(rid);
  if (!file) return null;
  const { boundary, ctm, transform } = baseTransform(el);

  let url = doc.imageURLCache.get(rid);
  if (!url) {
    const bytes = await doc.zip.read(file);
    if (!bytes) return null;
    url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(file) }));
    doc.imageURLCache.set(rid, url);
  }

  // CTM 作用在单位正方形上（OFD 图片对象的常见表达）
  const m = ctm.join(' ') === '1 0 0 1 0 0'
    ? `translate(${boundary.x} ${boundary.y}) matrix(${boundary.w} 0 0 ${boundary.h} 0 0)`
    : transform;

  const img = svgEl('image', {
    href: url,
    x: 0, y: 0, width: 1, height: 1,
    preserveAspectRatio: 'none',
    transform: m
  });
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
  return img;
}

/* ---------------- 导出用：字体内联 ---------------- */

function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function buildFontCSS(doc) {
  const parts = [];
  for (const [id, bytes] of doc.fontBytes) {
    const f = doc.fonts.get(id);
    const name = (f && f.file) || '';
    parts.push(`@font-face{font-family:"ofd-f${id}";src:url(data:${fontMimeOf(name)};base64,${toBase64(bytes)});}`);
  }
  // 让内联字体也能覆盖到 family 兜底名
  return parts.join('\n');
}

export { MM2PX };
