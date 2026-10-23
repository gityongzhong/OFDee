#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从真实 OFD 里抽出所有 (TextCode 文本, DeltaX 原始串) 对，导出 JSON。
供 tools/delta_crosscheck.mjs 与 JS 端 parseDelta() 做逐条交叉比对。
"""
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = {'ofd': 'http://www.ofdspec.org/2016'}


def expand_delta(text, delta_str):
    """按 GB/T 33190-2016 展开：'g n v' = 值 v 重复 n 次。"""
    n = len(text)
    need = max(0, n - 1)
    if not delta_str or need == 0:
        return []
    toks = delta_str.strip().split()
    vals = []
    i = 0
    while i < len(toks) and len(vals) < need:
        t = toks[i]
        if t in ('g', 'G'):
            cnt = int(toks[i + 1])
            v = float(toks[i + 2])
            i += 3
            for _ in range(min(cnt, need - len(vals))):
                vals.append(v)
        else:
            vals.append(float(t))
            i += 1
    return vals[:need]


def main(path):
    out = []
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if re.search(r'Content\.xml$', n)]
        names.sort()
        for name in names:
            root = ET.fromstring(z.read(name))
            for tc in root.iter():
                if not tc.tag.endswith('}TextCode') and tc.tag != 'TextCode':
                    continue
                text = (tc.text or '')
                dx = tc.get('DeltaX')
                dy = tc.get('DeltaY')
                if not dx and not dy:
                    continue
                out.append({
                    'part': name,
                    'text': text,
                    'dx': dx or '',
                    'dy': dy or '',
                    'dxExp': expand_delta(text, dx) if dx else [],
                    'dyExp': expand_delta(text, dy) if dy else [],
                })
    json.dump(out, sys.stdout, ensure_ascii=False)
    return len(out)


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else r'E:\桌面文件\云金办便函〔2026〕248号.ofd'
    cnt = main(src)
    print(f'\n# {cnt} 条', file=sys.stderr)
