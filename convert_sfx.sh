#!/bin/bash
# sfx_source 内の全 mp3 を sfx_ogg に opus(ogg) として変換するスクリプト
set -euo pipefail

# このスクリプトのある場所を基準にする
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/sfx_source"
OUT_DIR="$SCRIPT_DIR/sfx_ogg"

mkdir -p "$OUT_DIR"

shopt -s nullglob
mp3_files=("$SRC_DIR"/*.mp3)

if [ ${#mp3_files[@]} -eq 0 ]; then
  echo "変換対象の mp3 が見つかりません: $SRC_DIR"
  exit 0
fi

converted=0
skipped=0
for src in "${mp3_files[@]}"; do
  base="$(basename "$src" .mp3)"
  out="$OUT_DIR/$base.ogg"
  if [ -f "$out" ]; then
    echo "スキップ(既存): $base.ogg"
    skipped=$((skipped + 1))
    continue
  fi
  echo "変換中: $base.mp3 -> $base.ogg"
  ffmpeg -i "$src" -vn -c:a libopus -b:a 64k "$out"
  converted=$((converted + 1))
done

echo "完了: 変換 $converted 個 / スキップ $skipped 個 -> $OUT_DIR"
