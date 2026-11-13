#!/usr/bin/env python3
"""Svarmo icon: build/icon.svg is the source. build/render-icon.cjs (npx electron) rasterises it
to build/icon.png (1024); this script turns that PNG into build/icon.ico — classic BMP entries,
not PNG-compressed, so Wine/rcedit on CI can embed it — and build/icon.icns via iconutil."""
import os
import shutil
import struct
import subprocess
import tempfile
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
img = Image.open(os.path.join(here, "icon.png")).convert("RGBA")
assert img.size == (1024, 1024), f"icon.png должен быть 1024×1024, а он {img.size}"


def dib_for(im: Image.Image) -> bytes:
    """Uncompressed 32bpp XOR + empty AND mask (ICO-compatible DIB)."""
    im = im.convert("RGBA")
    w, h = im.size
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = im.getpixel((x, y))
            xor += bytes((b, g, r, a))
    and_row = ((w + 31) // 32) * 4
    and_mask = bytes(and_row * h)
    header = struct.pack(
        "<IIIHHIIIIII",
        40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0,
    )
    return header + xor + and_mask


def write_bmp_ico(path: str, source: Image.Image, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    payloads = [dib_for(source.resize((s, s), Image.Resampling.LANCZOS)) for s in sizes]
    count = len(sizes)
    buf = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    for s, payload in zip(sizes, payloads):
        bw = 0 if s >= 256 else s
        bh = 0 if s >= 256 else s
        buf += struct.pack("<BBBBHHII", bw, bh, 0, 0, 1, 32, len(payload), offset)
        offset += len(payload)
    for payload in payloads:
        buf += payload
    with open(path, "wb") as f:
        f.write(buf)


ico_path = os.path.join(here, "icon.ico")
write_bmp_ico(ico_path, img)
print("wrote", ico_path)


# macOS: iconutil собирает .icns из папки .iconset со стандартным набором размеров.
if shutil.which("iconutil"):
    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, "icon.iconset")
    os.mkdir(iconset)
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
            img.resize((px, px), Image.Resampling.LANCZOS).save(os.path.join(iconset, name))
    icns_path = os.path.join(here, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns_path], check=True)
    shutil.rmtree(tmp)
    print("wrote", icns_path)
else:
    print("iconutil нет (не macOS) — icon.icns не пересобран")
