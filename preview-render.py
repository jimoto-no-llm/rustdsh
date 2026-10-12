#!/usr/bin/env python3
"""試作プレビューPNGをPILで描画する。数値は報告値・イメージの表示確認用。"""
from PIL import Image, ImageDraw, ImageFont

W = 1000
FONT_JP = "/usr/share/fonts/google-droid-sans-fonts/DroidSansJapanese.ttf"
FONT_BOLD = "/usr/share/fonts/google-noto-sans-cjk-vf-fonts/NotoSansCJK-VF.ttc"

def font(size, bold=False):
    if bold:
        try:
            return ImageFont.truetype(FONT_BOLD, size, index=1)
        except Exception:
            return ImageFont.truetype(FONT_JP, size)
    return ImageFont.truetype(FONT_JP, size)

BG = (247, 247, 244)
CARD = (255, 255, 255)
LINE = (222, 222, 216)
FG = (34, 35, 31)
MUT = (116, 118, 109)
BLUE = (56, 110, 214)
BAR_BG = (235, 235, 230)
GREEN = (73, 132, 96)
YELLOW = (176, 134, 40)
RED = (179, 68, 50)

img = Image.new("RGB", (W, 1420), BG)
d = ImageDraw.Draw(img)

f_title = font(34, True)
f_h2 = font(24, True)
f_big = font(36, True)
f_body = font(20)
f_sub = font(17)
f_chip = font(16)

y = 28
d.text((40, y), "モデルカタログ（試作）", fill=FG, font=f_title)
y += 52
d.text((40, y), "手入力の報告値です。断定した実測ではありません。", fill=MUT, font=f_sub)
y += 36

def card(top, height):
    d.rounded_rectangle([32, top, W - 32, top + height], radius=14, fill=CARD, outline=LINE, width=2)
    return top + 24

def bar(x, y0, w, ratio, h=16, fill=BLUE):
    d.rounded_rectangle([x, y0, x + w, y0 + h], radius=h // 2, fill=BAR_BG)
    if ratio and ratio > 0:
        d.rounded_rectangle([x, y0, x + int(w * ratio), y0 + h], radius=h // 2, fill=fill)

def chip(x, y0, text):
    f = f_chip
    bb = d.textbbox((0, 0), text, font=f)
    tw = bb[2] - bb[0] + 24
    d.rounded_rectangle([x, y0, x + tw, y0 + 30], radius=15, outline=LINE, width=2, fill=CARD)
    d.text((x + 12, y0 + 4), text, fill=FG, font=f)
    return tw + 10

# --- Card 1: Mistral Large 4 ---
top = y
cy = card(top, 400)
d.text((56, cy), "Mistral Large 4", fill=FG, font=f_h2)
cy += 38
d.text((56, cy), "MoE  ·  公開プレビュー  ·  重み 10月末公開予定", fill=MUT, font=f_sub)
cy += 34
d.text((56, cy), "総パラメータ数", fill=MUT, font=f_sub)
d.text((420, cy), "有効パラメータ数", fill=MUT, font=f_sub)
cy += 26
d.text((56, cy), "約1兆", fill=FG, font=f_big)
d.text((420, cy), "490億", fill=FG, font=f_big)
cy += 56
bar(56, cy, 500, 0.49)
d.text((570, cy - 6), "0.49", fill=MUT, font=f_sub)
cy += 34
cx = 56
for t in ["確度: 報告値", "出所: 公開情報", "状態: プレビュー"]:
    cx += chip(cx, cy, t)
cy += 44
d.text((56, cy), "MoE構成。10月12日時点では公開プレビュー段階。", fill=MUT, font=f_sub)
y = top + 400 + 20

# --- Card 2: 使用量ヘッダー（イメージ） ---
top = y
cy = card(top, 210)
d.text((56, cy), "使用量ヘッダー（イメージ）", fill=FG, font=f_h2)
cy += 40
d.text((56, cy), "$12.34", fill=FG, font=f_big)
d.text((220, cy + 12), "期間合計 · 報告値の表示例", fill=MUT, font=f_sub)
cy += 60
bar(56, cy, 500, 0.64)
d.text((570, cy - 6), "64%", fill=MUT, font=f_sub)
cy += 34
y = top + 210 + 20

# --- Card 3: モデル別内訳（イメージ） ---
top = y
cy = card(top, 230)
d.text((56, cy), "モデル別内訳（イメージ）", fill=FG, font=f_h2)
cy += 42
segs = [(0.5, BLUE), (0.3, GREEN), (0.2, YELLOW)]
x = 56
bw = 500
for ratio, col in segs:
    wseg = int(bw * ratio)
    d.rectangle([x, cy, x + wseg, cy + 18], fill=col)
    x += wseg
d.rectangle([56, cy, 56 + bw, cy + 18], outline=LINE, width=2)
cy += 32
d.text((56, cy), "■ Model A 50%   ■ Model B 30%   ■ Model C 20%", fill=MUT, font=f_sub)
cy += 30
d.text((56, cy), "比率は金額比の表示例です。", fill=MUT, font=f_sub)
y = top + 230 + 20

# --- Card 4: 上限・請求（イメージ） ---
top = y
cy = card(top, 250)
d.text((56, cy), "上限・請求（イメージ）", fill=FG, font=f_h2)
cy += 42
cx = 56
for t in ["soft上限: 注意", "hard上限: 余裕あり", "請求: 支払済"]:
    cx += chip(cx, cy, t)
cy += 46
bar(56, cy, 500, 0.72, fill=GREEN)
d.text((570, cy - 6), "残量72%", fill=MUT, font=f_sub)
cy += 36
d.text((56, cy), "請求額とAPI換算は足し合わせません。", fill=MUT, font=f_sub)
y = top + 250 + 20

img.save("/home/sahen/Projects/windows-migration/c1a2a17f4ca1-rustdsh/preview-intelligent-ui.png")
print("saved", img.size)
