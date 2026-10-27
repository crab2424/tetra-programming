#!/bin/bash
# テト CPU lv7（新しい探索 engine/）を WASM にコンパイルする。設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
set -e
cd "$(dirname "$0")"
SRCS="core/bag.cpp core/board.cpp core/move.cpp core/state.cpp ai/beam.cpp ai/eval.cpp ai/layer.cpp ai/path.cpp lv7_wasm.cpp"
# 成果物は ../wasm/ に出す。手生成 move::expand は再帰 DFS なのでスタックを広めに取る。
emcc $SRCS -I. -o ../wasm/cpu_wasm7.js \
  -std=c++20 -O3 -flto -DNDEBUG -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_lv7_malloc","_lv7_free","_lv7Search"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s STACK_SIZE=1048576
echo "✅ build done: ../wasm/cpu_wasm7.js / ../wasm/cpu_wasm7.wasm"
