#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成脱敏演示 OFD。

用途：拿真实红头公文做界面截图会把文号/正文公开出去，不适合放进公开仓库。
本脚本保留原文档的**版式**（字符起点、字号、内嵌字体、行数），只把文字
替换成示例内容，并按原步长重新生成 DeltaX/DeltaY（统一用 `g n v` 压缩语法，
顺带真实检验该语法的渲染）。

用法：python tools/make_demo_ofd.py <源.ofd> <输出.ofd>
"""
import re
import shutil
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = 'http://www.ofdspec.org/2016'
ET.register_namespace('', NS)
ET.register_namespace('ofd', NS)

# 示例文本池：循环取用，不含任何真实信息
DEMO = (
    '示例文档版式效果演示用于展示国产版式文件的渲染能力'
    '这里是标题文字用于验证字号字重与居中对齐是否正常'
    '正文段落内容示例字距行距段首缩进与标点悬挂均可正常呈现'
    '第一章总则第二条适用范围第三条监督检查第四章附则'
    '表格项目数量金额备注合计人民币元整仟佰拾角分'
    '二零二六年十月二十三日示例单位办公室联系电话示例'
    '本项目为自由软件遵循通用开放许可条款可自由使用与分发'
)


def expand(delta, n):
    """按 GB/T 33190-2016 展开 'g n v'（值 v 重复 n 次）。"""
    need = max(0, n - 1)
    if not delta or need == 0:
        return []
    toks = delta.split()
    vals, i = [], 0
    while i < len(toks) and len(vals) < need:
        t = toks[i]
        if t in ('g', 'G'):
            cnt, v = int(toks[i + 1]), float(toks[i + 2])
            i += 3
            vals.extend([v] * min(cnt, need - len(vals)))
        else:
            vals.append(float(t))
            i += 1
    return vals[:need]


class Feed:
    """按顺序从示例池取字符，保证替换后长度与原文本一致。"""

    def __init__(self, pool):
        self.pool = pool
        self.i = 0

    def take(self, n):
        out = []
        for _ in range(n):
            out.append(self.pool[self.i % len(self.pool)])
            self.i += 1
        return ''.join(out)


def main(src, dst):
    feed = Feed(DEMO)
    changed = 0
    with zipfile.ZipFile(src) as zin:
        names = zin.namelist()
        with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                data = zin.read(name)
                if not name.endswith('Content.xml'):
                    zout.writestr(name, data)
                    continue
                root = ET.fromstring(data)
                for el in root.iter():
                    if not el.tag.endswith('}TextCode') and el.tag != 'TextCode':
                        continue
                    raw = el.text or ''
                    n = len(raw)
                    if n == 0:
                        continue
                    # 用原步长平均值重排，保持每行总宽度基本不变
                    def_avg = None
                    for axis in ('DeltaX', 'DeltaY'):
                        v = el.get(axis)
                        if not v:
                            continue
                        vals = expand(v, n)
                        if vals:
                            avg = sum(vals) / len(vals)
                            if axis == 'DeltaX':
                                def_avg = avg
                            if n > 1:
                                # 统一用 g 语法，顺带压测该语法的渲染
                                el.set(axis, f'g {n - 1} {avg:.4f}')
                            else:
                                el.set(axis, '')
                    el.text = feed.take(n)
                    changed += 1
                zout.writestr(name, ET.tostring(root, encoding='utf-8', xml_declaration=True))
    print(f'已替换 {changed} 个 TextCode → {dst}')


if __name__ == '__main__':
    s = sys.argv[1] if len(sys.argv) > 1 else 'sample.ofd'
    d = sys.argv[2] if len(sys.argv) > 2 else 'tools/demo.ofd'
    main(s, d)
