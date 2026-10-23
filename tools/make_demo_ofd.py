#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成脱敏演示 OFD。

用途：拿真实红头公文做界面截图会把文号/正文公开出去，不适合放进公开仓库。
本脚本保留原文档的**版式**（字符起点、字号、内嵌字体、行数），只把文字
替换成示例内容，并按原步长重新生成 DeltaX/DeltaY（统一用 `g n v` 压缩语法，
顺带真实检验该语法的渲染）。

替换策略：
- 结构性片段（红头、文号、标题、主送）按 (页面, 页内序号) 精确映射，
  长度与原文逐字一致 —— 这些是截图里的"门面"；
- 正文按原片段长度从一篇连贯说明文里流式取字，行与行之间语义连续；
- 纯数字/百分号片段从数字池取半角字符（窄步长位置放全角字会互相重叠）；
- 标点与个别版式中性单字（〔〕：、号 等）保持原样。

用法：python tools/make_demo_ofd.py <源.ofd> <输出.ofd>
"""
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = 'http://www.ofdspec.org/2016'
ET.register_namespace('', NS)
ET.register_namespace('ofd', NS)

# ---- 结构性片段：键 (页面目录名, 页内 TextCode 序号)，值长度必须与原文一致 ----
# 序号按 Content.xml 里的实际 TextCode 顺序（含无 Delta 的标点片段）
SPECIAL = {
    ('Page_0', 3): '示例市版式文档标准应用示范中心办公室',  # 红头 18 字
    ('Page_0', 4): '示例办便函〔',                          # 文号前缀 6 字
    ('Page_0', 5): '2026',                                  # 年份 4 位
    ('Page_0', 7): '108',                                   # 文号数字 3 位
    ('Page_0', 9): '示例市版式文档办公室关于',              # 标题前段 12 字
    ('Page_0', 10): '2026',                                 # 年份 4 位
    ('Page_0', 11): '年上半年版式文件应用示范情况通报',     # 标题后段 16 字
    ('Page_0', 12): '各区县示范单位',                       # 主送 7 字
    ('Page_0', 14): '各直属示范推广中心',                   # 主送 9 字
    ('Page_0', 16): '示例文档技术应用有限',                 # 主送 10 字
    ('Page_0', 17): '公司',                                 # 主送 2 字
    ('Page_0', 19): '各技术企业省级分公司',                 # 主送 10 字
    ('Page_0', 21): '省级版式协会',                         # 主送 6 字
    ('Page_0', 23): '省版式推广协会',                       # 主送 7 字
}

# 门面区：第 1 页前 26 个片段（红头/文号/标题/主送及其标点）整段保留语义，
# 其中未列入 SPECIAL 的标点与单字原样保留
HERO_PAGE, HERO_END = 'Page_0', 26

# 保持原样的字符：标点（版式中性）
KEEP = set('〔〕（）【】：；、。，—…·“”‘’0123456789')

# 目标字距（毫米）：全角正文标准步长，替换后按总宽不变反推字数
TARGET_MM = 5.65

# 页脚装饰区（A4 高 297mm，页码 — 1 — 位于 y≈269.5）
FOOTER_Y = 260.0

# 正文池：一篇连贯的说明文，按原片段长度流式取字（需 ≥1900 字，不足会回绕）
DEMO = (
    '版式文档是一种把版面效果固定下来的电子文件格式，常用于公文、票据、证照与图书'
    '等对呈现效果要求严格的领域。与流式文档不同，版式文件在任何设备上打开，文字的'
    '位置、字体、字号、行距与图文关系都保持原样，不因环境差异而重排或变形。'
    '本文件是一份演示文档，由脚本依据一份版式骨架生成，全部文字均为示例内容，'
    '不含任何真实单位与事项。打开文件时，阅读器会先解析容器的目录结构，再逐页载入'
    '页面描述，把文字、路径、图像与印章组合成完整的版面。正文遵循公文排版惯例，'
    '段首缩进两个字，标点按禁则处理，行末不出现悬挂的引号或括号。字符间距按照标准'
    '提供的压缩语法存储，阅读器将其逐条展开为精确的坐标序列，使每一行的疏密与设计'
    '稿一致。字体方面，文件内嵌了宋体、仿宋、楷体与黑体等字形，阅读器会自动检查'
    '内嵌字体的合规性，对表目录错序、标签大小写异常、哨兵字形越界等常见问题进行'
    '修复，保证文字以设计者预期的面貌显示。缩放时矢量内容按新尺寸重新绘制，文字'
    '边缘始终清晰，不出现位图放大后的锯齿。侧栏提供整册缩略图，点击页码即可直达'
    '对应页面，也可以用键盘方向键连续翻阅。目录大纲读取自文件的导航结构，篇幅较长'
    '的文件可以借此迅速定位章节。划选正文片段可以复制到剪贴板，便于摘录与引用。'
    '导出功能把整册内容转换为常见图片格式或通用文档格式，方便在更多场景流转。'
    '全部处理均在本机完成，不依赖网络，也不上传任何数据，适合内容不宜外传的场合。'
    '窗口提供浅色与深色主题，深色模式下纸张保持白色，正文对比度不受影响。阅读进度、'
    '缩放比例与界面状态保存在本机配置目录，下次打开时自动恢复。页面可以整册旋转，'
    '也可以只转当前页，双页对开模式适合像纸书一样左右阅读。文件关联设置好后，在'
    '资源管理器里双击文件即可直接打开。命令行参数支持一次传入多个文件，每个文件各占'
    '一个标签。程序是单个可执行文件，不写注册表，卸载只需删除文件本身，不会在系统里'
    '留下残余。表格与附表沿用原文档的行列结构，单元格内容按列对齐，表头线条粗细与'
    '间距按原始数据呈现。印章图像保持原有透明通道，叠放在文字之上不遮挡正文。'
    '附件与正文之间以目录层级区分，阅读器在侧栏中以缩进方式呈现层级关系。'
    '多标签设计让几份文件可以同时打开比较，标签可以在窗口之间拖动整理。'
    '全屏模式隐藏界面元素，只留下文档本身，适合长时间阅读或投屏讲解。'
    '打印时按页面原始尺寸输出，不做额外缩放，保证纸质件与屏幕所见一致。'
    '搜索定位功能正在规划中，后续版本将支持全文检索与关键词高亮。'
    '本示例文档的所有数据均为虚构，如有雷同纯属巧合。'
    '从文件的内部结构看，一册版式文档由描述元信息的入口、一个或多个文档对象以及'
    '每个文档对象下的页面列表组成，页面里记录文字对象、图形对象与图像对象的排布。'
    '文字对象除了内容本身，还携带字形引用与字符间距信息，图形对象描述线条与填充，'
    '图像对象指向内嵌的资源文件，三者按照先后顺序叠加，形成最终的视觉效果。'
    '阅读器在解析时严格遵循标准定义的坐标体系，以毫米为基本单位换算屏幕像素，'
    '保证在不同分辨率的显示器上版面比例一致。对于印章这类位置敏感的元素，'
    '还原精度直接影响观感，因此渲染管线对亚像素定位做了专门处理。'
    '资源复用是版式格式的重要特性，同一字体或同一图片在整册文档中只存储一份，'
    '各页面通过引用共享，既减小文件体积，也保证样式统一。阅读器据此做了缓存，'
    '重复出现的字形与图像只在首次使用时解码，后续页面直接复用，翻页更加流畅。'
    '对于结构异常或字段缺失的文件，解析器采用宽容策略，能读则读，不能读的部分'
    '跳过并提示，而不是直接拒绝打开，尽量让用户看到更多内容。'
    '键盘操作覆盖了常用路径：跳转页码、切换单双页、缩放、旋转都有快捷键，'
    '配合方向键与翻页键可以完全脱离鼠标完成阅读。状态栏实时显示当前页码、'
    '文件类型、页面尺寸与缩放比例，信息一目了然。'
    '演示文档共六页，首页为红头与正文起始，中间各页承接正文，末页为附表。'
    '各页尺寸与版心完全一致，翻阅时不会出现跳动。'
    '关于文件的来源还需要说明几句：它的版式骨架取自一份常见的公文样本，'
    '制作时保留了原有的页面尺寸、页边距、字号层级与行数分布，'
    '因此各元素在页面上的位置与真实文件完全相同，适合用来检查渲染精度。'
    '如果放大到很高的倍数观察，可以看到文字笔画边缘平滑，横竖撇捺的结构完整，'
    '红头分隔线的两端对齐版心，粗细过渡均匀，没有锯齿或断线。'
    '附表中的行列线同样按原始坐标绘制，单元格之间的间距始终如一。'
    '在日常使用中，一份文件往往需要在不同的电脑之间流转，'
    '如果对方没有安装相应的阅读软件，沟通成本就会明显上升，'
    '而便携版的思路正是把这一步省掉：把程序拷进存储介质，'
    '在任何一台电脑上都能立即打开文件，不需要管理员权限，'
    '也不会向系统目录写入任何内容，用完即可删除。'
    '对于内容敏感的单位来说，这种不联网、不留痕的处理方式尤其重要，'
    '文件的打开记录、阅读进度与界面偏好都只保存在本机的配置目录里，'
    '删除配置目录即可完全清除使用痕迹。'
    '在长期维护的规划里，渲染内核会继续补齐标准中尚未覆盖的子集，'
    '例如更完整的字体嵌入形态、更多压缩变体以及复杂表格的边线合并规则，'
    '同时保持零第三方运行时依赖的约束，让程序体积与启动速度维持在现有水平。'
    '文档格式的互操作同样值得投入精力，把常见版式文件无损转换为通用格式，'
    '可以大幅降低接收方的使用门槛，这也是导出功能持续打磨的方向。'
    '感谢阅读到这里，这份演示文本到此结束，剩余页面为表格与附注内容。'
)


class Feed:
    """从池中循环取字，保证替换后长度与原文本一致。"""

    def __init__(self, pool):
        self.pool = pool
        self.i = 0

    def take(self, n):
        out = []
        for _ in range(n):
            out.append(self.pool[self.i % len(self.pool)])
            self.i += 1
        return ''.join(out)


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


def main(src, dst):
    cjk_feed = Feed(DEMO)
    changed = kept = 0
    with zipfile.ZipFile(src) as zin:
        names = zin.namelist()
        with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                data = zin.read(name)
                if not name.endswith('Content.xml'):
                    zout.writestr(name, data)
                    continue
                page = name.split('/Pages/')[-1].split('/')[0] if '/Pages/' in name else name
                idx = 0
                obj_y = None  # 当前 TextObject 的纵向起点
                root = ET.fromstring(data)
                for el in root.iter():
                    tag = el.tag
                    if tag.endswith('}TextObject') or tag == 'TextObject':
                        b = (el.get('Boundary') or '').split()
                        obj_y = float(b[1]) if len(b) >= 4 else None
                        continue
                    if not tag.endswith('}TextCode') and tag != 'TextCode':
                        continue
                    raw = el.text or ''
                    n = len(raw)
                    my_idx = idx
                    idx += 1
                    if n == 0:
                        continue
                    if (page, my_idx) in SPECIAL:
                        new = SPECIAL[(page, my_idx)]
                        if len(new) != n:
                            raise SystemExit(f'SPECIAL 长度不符: {(page, my_idx)} 原 {n} 新 {len(new)}')
                        # 用原步长平均值重排（统一 g 语法）
                        for axis in ('DeltaX', 'DeltaY'):
                            v = el.get(axis)
                            if not v:
                                continue
                            vals = expand(v, n)
                            if vals and n > 1:
                                el.set(axis, f'g {n - 1} {sum(vals) / len(vals):.4f}')
                            elif vals:
                                el.set(axis, '')
                        el.text = new
                        changed += 1
                        continue
                    # 门面区其余片段保留（文号括号、主送标点等）
                    if page == HERO_PAGE and my_idx < HERO_END:
                        kept += 1
                        continue
                    # 单字片段：页脚装饰（— 1 —）保留；正文里的行溢出字、
                    # 上标引用号等替换为正文流字符，避免孤字悬在句中
                    if n == 1 and obj_y is not None and obj_y > FOOTER_Y:
                        kept += 1
                        continue
                    # 其余：按「总宽度不变」反推字数，正文统一为全角步长。
                    # 原数字片段步长约为全角一半，收缩后字距恢复正常，避免全角字重叠。
                    axis = 'DeltaX' if el.get('DeltaX') else ('DeltaY' if el.get('DeltaY') else None)
                    vals = expand(el.get(axis), n) if axis else []
                    if not vals:
                        el.text = cjk_feed.take(n)  # 无步长信息：等长替换
                        changed += 1
                        continue
                    total = sum(vals)  # 首字到末字的距离（近似）
                    n_new = max(1, round(total / TARGET_MM) + 1) if total > 0 else 1
                    if n_new == 1:
                        el.set(axis, '')
                    else:
                        el.set(axis, f'g {n_new - 1} {total / (n_new - 1):.4f}')
                    el.text = cjk_feed.take(n_new)
                    changed += 1
                zout.writestr(name, ET.tostring(root, encoding='utf-8', xml_declaration=True))
    print(f'已替换 {changed} 个 TextCode（另保留 {kept} 个门面/标点片段）→ {dst}')


if __name__ == '__main__':
    s = sys.argv[1] if len(sys.argv) > 1 else 'sample.ofd'
    d = sys.argv[2] if len(sys.argv) > 2 else 'tools/demo.ofd'
    main(s, d)
