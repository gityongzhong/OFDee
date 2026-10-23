# -*- coding: utf-8 -*-
"""Generate rounded-corner icon.ico from ui/img/logo.png (radius ~23% to match in-app style)."""
from PIL import Image, ImageDraw
import os

SRC = os.path.join(os.path.dirname(__file__), "..", "ui", "img", "logo.png")
DST = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons", "icon.ico")

img = Image.open(SRC).convert("RGBA")
SS = 4  # supersample for smooth edges
big = img.resize((320 * SS, 320 * SS), Image.LANCZOS)

radius = int(320 * SS * 0.23)
mask = Image.new("L", big.size, 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle([0, 0, big.size[0] - 1, big.size[1] - 1], radius=radius, fill=255)
mask = mask.resize((320, 320), Image.LANCZOS)

out = img.convert("RGBA")
out.putalpha(mask)

os.makedirs(os.path.dirname(DST), exist_ok=True)
out.save(DST, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("saved", os.path.abspath(DST))
