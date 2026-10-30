# 生成应用图标（多尺寸 .ico + 512 png）
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path(__file__).resolve().parent
BG = (30, 33, 40, 255)
ACCENT = (76, 141, 255, 255)
WHITE = (235, 238, 245, 255)


def render(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # 顶部光标条（呼应"文本编辑器"）
    bar_w = int(s * 0.16)
    d.rounded_rectangle(
        [int(s * 0.16), int(s * 0.17), int(s * 0.16) + bar_w, int(s * 0.17) + int(s * 0.055)],
        radius=int(bar_w / 2),
        fill=ACCENT,
    )

    # 主体大写 T
    font_path = "C:/Windows/Fonts/arialbd.ttf"
    try:
        font = ImageFont.truetype(font_path, int(s * 0.56))
    except OSError:
        font = ImageFont.load_default()

    text = "T"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(
        ((s - tw) / 2 - bbox[0], (s - th) / 2 - bbox[1] + int(s * 0.05)),
        text,
        font=font,
        fill=WHITE,
    )

    return img.resize((size, size), Image.LANCZOS)


sizes = [16, 24, 32, 48, 64, 128, 256]
images = [render(sz) for sz in sizes]

build = OUT / "build"
build.mkdir(exist_ok=True)
images[-1].save(build / "icon.ico", format="ICO", sizes=[(sz, sz) for sz in sizes])
render(512).save(build / "icon.png", format="PNG")
print("generated:", build / "icon.ico", (build / "icon.ico").stat().st_size, "bytes")
print("generated:", build / "icon.png")
