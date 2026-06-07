#!/bin/bash
# cpu6.cpp を WASM にコンパイルする。
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
set -e
cd "$(dirname "$0")"
emcc cpu6.cpp -o cpu_wasm6.js \
  -O3 -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_my_malloc","_my_free","_searchBestMoveWasm","_evaluateSinglePlacementWasm"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=0 \
  -s INITIAL_MEMORY=33554432
echo "✅ build done: cpu_wasm6.js / cpu_wasm6.wasm"
