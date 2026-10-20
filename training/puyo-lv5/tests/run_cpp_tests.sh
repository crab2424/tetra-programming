#!/bin/bash
# C++ 単体テスト（おじゃまシナリオ）をビルドして実行する。
set -e
cd "$(dirname "$0")/.."
NATIVE=../../public/cpu/puyo/lv5/native
mkdir -p build
${CXX:-clang++} -std=c++17 -O1 -pthread -I"$NATIVE" -Isim -Isim/tet_stub \
  tests/test_ojama.cpp sim/field.cpp sim/player.cpp sim/tet_cpu5.cpp sim/tet_player.cpp \
  $NATIVE/core/bitboard.cpp $NATIVE/core/chain.cpp $NATIVE/eval/shape.cpp \
  $NATIVE/eval/form.cpp $NATIVE/eval/eval.cpp $NATIVE/build/build.cpp \
  -o build/test_ojama
./build/test_ojama
