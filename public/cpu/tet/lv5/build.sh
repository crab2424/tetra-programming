#!/bin/bash
# cpu5 を WASM にコンパイルする（v2.2.3 で追加。フラグは既存成果物に合わせた）。
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
# ★ 再ビルド後は cpu5.js の static WORKER_URLS と cpu_worker5.js の importScripts に ?v= を付けて上げること
#   （/cpu/* は must-revalidate なので付けなくても取り直されるが、プール中の worker は古いまま残るため）。
set -e
cd "$(dirname "$0")"
emcc cpu5.cpp -o cpu_wasm5.js \
  -O3 -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_my_malloc","_my_free","_searchBestMoveWasm","_evaluateSinglePlacementWasm"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216
echo "✅ build done: cpu_wasm5.js / cpu_wasm5.wasm"
