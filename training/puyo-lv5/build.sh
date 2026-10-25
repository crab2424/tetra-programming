#!/bin/bash
# 学習用シミュレータ（共有ライブラリ）をビルドする。
#   本番の探索ソース（public/cpu/puyo/lv5/native）をコピーせずに直接コンパイルする
#   （cpu5.cpp は emscripten 専用のエントリなので除外）。
#   テト側は本番 public/cpu/tet/lv{4,5}/cpu*.cpp・lv6/native/*.cpp を sim/tet_cpu{4,5,6}.cpp から名前空間に包んで取り込む。
#   出力: build/libpuyosim.dylib（macOS）/ build/libpuyosim.so（Linux）
set -e
cd "$(dirname "$0")"
NATIVE=../../public/cpu/puyo/lv5/native
mkdir -p build
EXT=so; [ "$(uname)" = "Darwin" ] && EXT=dylib
SRCS=(
  sim/field.cpp sim/player.cpp sim/api.cpp
  sim/tet_cpu4.cpp sim/tet_cpu5.cpp sim/tet_cpu5n.cpp sim/tet_cpu6.cpp sim/tet_player.cpp sim/tet_api.cpp
  $NATIVE/core/bitboard.cpp $NATIVE/core/chain.cpp
  $NATIVE/eval/shape.cpp $NATIVE/eval/form.cpp $NATIVE/eval/eval.cpp
  $NATIVE/build/build.cpp
)
${CXX:-clang++} -std=c++17 -O3 -march=native -fPIC -shared -pthread \
  -I"$NATIVE" -Isim -Isim/tet_stub "${SRCS[@]}" -o build/libpuyosim.$EXT
echo "✅ build/libpuyosim.$EXT"
