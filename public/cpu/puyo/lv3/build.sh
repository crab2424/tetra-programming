#!/bin/bash
# ぷよ cpu3 を WASM にコンパイルする（v2.2.3 で追加）。
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
# ★ 再ビルド後は cpu_worker3.js の importScripts('cpu_wasm3.js?v=') と
#   cpu3.js の static WORKER_URLS の ?v= を上げること（プール中の worker は古いまま残るため）。
set -e
cd "$(dirname "$0")"
emcc cpu3.cpp -o cpu_wasm3.js \
  -O3 -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_my_malloc","_my_free","_searchBestMovePuyoWasm"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216
echo "✅ build done: cpu_wasm3.js / cpu_wasm3.wasm"
