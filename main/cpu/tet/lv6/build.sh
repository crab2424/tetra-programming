#!/bin/bash
# cpu6 を WASM にコンパイルする。
# ソースは複数の翻訳単位に分割済み（common/board/tslot/eval/placement/cpu6）。
# -flto で TU 境界を越えたインライン化を有効化し、単一TU時代と同等のコードを生成する。
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
set -e
cd "$(dirname "$0")"
SRCS="common.cpp board.cpp tslot.cpp eval.cpp placement.cpp cpu6.cpp"
emcc $SRCS -o cpu_wasm6.js \
  -O3 -flto -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_my_malloc","_my_free","_searchBestMoveWasm","_evaluateSinglePlacementWasm"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=0 \
  -s INITIAL_MEMORY=33554432
echo "✅ build done: cpu_wasm6.js / cpu_wasm6.wasm"
