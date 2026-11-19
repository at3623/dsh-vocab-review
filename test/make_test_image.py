"""Generate the 3-underlined-word acceptance fixture (test/vocab-test-image.png)."""
import os

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 960, 440
REGULAR_CANDIDATES = [
    r"C:\Windows\Fonts\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]
BOLD_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def load_font(candidates, size):
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


title_font = load_font(BOLD_CANDIDATES, 30)
body_font = load_font(REGULAR_CANDIDATES, 26)
hint_font = load_font(REGULAR_CANDIDATES, 18)

image = Image.new("RGB", (WIDTH, HEIGHT), "white")
draw = ImageDraw.Draw(image)

draw.text((60, 45), "Vocabulary Worksheet", font=title_font, fill=(20, 20, 20))
draw.text((60, 88), "Read each sentence. Only the underlined words are imported.", font=hint_font, fill=(90, 90, 90))

lines = [
    ("Do not ", "abandon", " your plan when it gets difficult."),
    ("Regular exercise can ", "benefit", " your health."),
    ("Be ", "cautious", " when you cross the busy street."),
]

y = 155
for before, target, after in lines:
    x = 60
    draw.text((x, y), before, font=body_font, fill=(25, 25, 25))
    x += draw.textlength(before, font=body_font)
    draw.text((x, y), target, font=body_font, fill=(15, 15, 15))
    width = draw.textlength(target, font=body_font)
    baseline = y + body_font.size + 6
    draw.line([(x + 1, baseline), (x + width - 1, baseline)], fill=(15, 15, 15), width=2)
    x += width
    draw.text((x, y), after, font=body_font, fill=(25, 25, 25))
    y += 74

draw.text((60, 390), "Test fixture: exactly 3 underlined words (abandon, benefit, cautious).", font=hint_font, fill=(120, 120, 120))

out = os.path.join(os.path.dirname(__file__), "vocab-test-image.png")
image.save(out)
print(out, image.size)
