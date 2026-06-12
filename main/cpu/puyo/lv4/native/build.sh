#!/bin/bash
# cpu4.cpp を WASM にコンパイルする（ぷよCPU lv4）。
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
#
# ⚠️ 再ビルドのたびに cpu_worker4.js の importScripts と
#    cpu4.js の new Worker(...) の ?v= を必ず上げること（グルーjs/wasmのキャッシュ対策）。
set -e
cd "$(dirname "$0")"
emcc cpu4.cpp -o cpu_wasm4.js \
  -O3 -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_my_malloc","_my_free","_searchBestMovePuyoWasm"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=8388608
echo "✅ build done: cpu_wasm4.js / cpu_wasm4.wasm"
