#!/bin/bash
# 学習用シミュレータ（共有ライブラリ）をビルドする。
#   本番の探索ソース（public/cpu/puyo/lv5/native）をコピーせずに直接コンパイルする
#   （cpu5.cpp は emscripten 専用のエントリなので除外）。
#   出力: build/libpuyosim.dylib（macOS）/ build/libpuyosim.so（Linux）
set -e
cd "$(dirname "$0")"
NATIVE=../../public/cpu/puyo/lv5/native
mkdir -p build
EXT=so; [ "$(uname)" = "Darwin" ] && EXT=dylib
SRCS=(
  sim/field.cpp sim/player.cpp sim/api.cpp
  $NATIVE/core/bitboard.cpp $NATIVE/core/chain.cpp
  $NATIVE/eval/shape.cpp $NATIVE/eval/form.cpp $NATIVE/eval/eval.cpp
  $NATIVE/build/build.cpp
)
${CXX:-clang++} -std=c++17 -O3 -march=native -fPIC -shared -pthread \
  -I"$NATIVE" -Isim "${SRCS[@]}" -o build/libpuyosim.$EXT
echo "✅ build/libpuyosim.$EXT"
