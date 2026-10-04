#!/bin/bash
# Burns a diagonal repeating watermark into review letters, so the scans can't be
# reused as clean documents. Usage: watermark.sh <input.jpg> <output.jpg>
# Needs ImageMagick and DejaVu Sans (Cyrillic).
set -euo pipefail
IN=$1; OUT=$2
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
TEXT="МАТЕМАТИКА БИЗНЕСА · ТОЛЬКО ДЛЯ ПРОСМОТРА"
TILE=$(mktemp --suffix=.png)
trap 'rm -f "$TILE"' EXIT

W=$(identify -format %w "$IN")
PT=$(( W / 34 ))   # text size scales with the image

convert -size $((W * 9 / 10))x$((W * 2 / 5)) xc:none -font "$FONT" -pointsize "$PT" \
  -fill 'rgba(15,44,92,0.22)' -gravity center -annotate -28x-28+0+0 "$TEXT" "$TILE"
convert "$IN" \( +clone -alpha transparent -tile "$TILE" -draw "color 0,0 reset" \) \
  -compose over -composite -strip -quality 82 "$OUT"
