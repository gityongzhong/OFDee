# 生成 OFD 阅读器图标（纯标准库：手绘 RGBA + zlib PNG + ICO 打包）
import zlib, struct, math, os

ACCENT = (76, 141, 255, 255)
WHITE = (255, 255, 255, 255)
FOLD = (210, 224, 246, 255)
LINE = (150, 178, 224, 255)
CLEAR = (0, 0, 0, 0)


def rounded_rect_sdf(x, y, cx, cy, w, h, r):
    dx = abs(x - cx) - w / 2 + r
    dy = abs(y - cy) - h / 2 + r
    ox = max(dx, 0.0)
    oy = max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r


def render(size):
    ss = 4
    n = size * ss
    buf = [[CLEAR] * n for _ in range(n)]
    # 页面几何（归一化坐标）
    px, py, pw, ph = 0.24, 0.14, 0.52, 0.72   # 页面
    fold = 0.16                                # 折角比例
    cx, cy = n / 2, n / 2

    def page_mask(x, y):
        # 页面主体 + 右上角折角
        fx = px + pw - fold
        fy = py + fold
        if x > fx and y < fy:
            # 折角三角
            return (x - fx) + (fy - y) <= fold
        return px <= x <= px + pw and py <= y <= py + ph

    for j in range(n):
        y = (j + 0.5) / n
        for i in range(n):
            x = (i + 0.5) / n
            c = CLEAR
            if page_mask(x, y):
                c = WHITE
                if x > px + pw - fold and y < py + fold:
                    c = FOLD
                # 文本行
                for k, lw in enumerate([0.30, 0.22, 0.30]):
                    ly = py + 0.24 + k * 0.13
                    if ly <= y <= ly + 0.055 and px + 0.09 <= x <= px + 0.09 + lw:
                        c = LINE
                # 底部色块
                if py + 0.60 <= y <= py + 0.655 and px + 0.09 <= x <= px + 0.36:
                    c = ACCENT[:3] + (255,)
            buf[j][i] = c

    # 盒降采样
    out = []
    for j in range(size):
        row = []
        for i in range(size):
            r = g = b = a = 0
            for sj in range(ss):
                for si in range(ss):
                    c = buf[j * ss + sj][i * ss + si]
                    r += c[0]; g += c[1]; b += c[2]; a += c[3]
            k = ss * ss
            row.append((round(r / k), round(g / k), round(b / k), round(a / k)))
        out.append(row)
    return out


def png_bytes(rows):
    h = len(rows)
    w = len(rows[0])
    raw = b''
    for row in rows:
        raw += b'\x00' + b''.join(struct.pack('4B', *px) for px in row)
    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        return c + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [(s, png_bytes(render(s))) for s in sizes]

header = struct.pack('<HHH', 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries = b''
data = b''
for s, blob in imgs:
    entries += struct.pack('<BBBBHHII', s if s < 256 else 0, s if s < 256 else 0, 0, 0, 1, 32, len(blob), offset)
    data += blob
    offset += len(blob)

os.makedirs('icons', exist_ok=True)
with open('icons/icon.ico', 'wb') as f:
    f.write(header + entries + data)
print('icon.ico written:', os.path.getsize('icons/icon.ico'), 'bytes,', len(sizes), 'sizes')
