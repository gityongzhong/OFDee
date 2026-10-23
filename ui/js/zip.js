// 极简 ZIP 读取器（仅支持 OFD 实际需要的 stored / deflate）
// 依赖浏览器原生 DecompressionStream('deflate-raw')，无需第三方库

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

function normalize(name) {
  let n = name.replace(/\\/g, '/');
  while (n.startsWith('./')) n = n.slice(2);
  if (n.startsWith('/')) n = n.slice(1);
  return n;
}

export async function openZip(arrayBuffer) {
  const buf = arrayBuffer;
  const dv = new DataView(buf);
  const size = buf.byteLength;
  if (size < 22) throw new Error('文件太小，不是有效的 OFD 容器');

  // 从尾部扫 EOCD
  let eocd = -1;
  const floor = Math.max(0, size - 66000);
  for (let i = size - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 目录，文件可能已损坏或不是 OFD');

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的 OFD');

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > size || dv.getUint32(p, true) !== SIG_CENTRAL) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = normalize(new TextDecoder('utf-8').decode(new Uint8Array(buf, p + 46, nameLen)));
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    entries.set(name, { method, compSize, dataStart });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (!entries.size) throw new Error('OFD 容器为空');

  const cache = new Map();

  async function readRaw(name) {
    const key = normalize(name);
    if (cache.has(key)) return cache.get(key);
    const e = entries.get(key);
    if (!e) return null;
    const raw = new Uint8Array(buf, e.dataStart, e.compSize);
    let out;
    if (e.method === 0) {
      out = raw.slice();
    } else if (e.method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(`不支持的压缩方式（method=${e.method}）：${key}`);
    }
    cache.set(key, out);
    return out;
  }

  return {
    names: () => [...entries.keys()],
    has: (n) => entries.has(normalize(n)),
    read: readRaw,
    async text(name) {
      const b = await readRaw(name);
      if (!b) return null;
      return new TextDecoder('utf-8').decode(b).replace(/^\uFEFF/, '');
    }
  };
}
