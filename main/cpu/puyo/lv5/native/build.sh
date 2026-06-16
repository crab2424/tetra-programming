#!/bin/bash
# cpu5.cpp を WASM にコンパイルする（ぷよCPU lv5）。
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
#
# ⚠️ 再ビルドのたびに wasm/cpu_worker5.js の importScripts と
#    cpu5.js の new Worker(...) の ?v= を必ず上げること（グルーjs/wasmのキャッシュ対策）。
# 出力先は隣の wasm/ ディレクトリ（native/ にソース、wasm/ に生成物）。
set -e
cd "$(dirname "$0")"

# ★ ファイル分割（ama-beam 構成を参考）。全 .cpp をまとめて1つの wasm にリンクする。
#   include は native ルート相対（例: "core/bitboard.h"）。-I. で解決する。
#   モード追加時は対応する .cpp をこのリストに足すこと（手順は MODES.md 参照）。
SRCS=(
  cpu5.cpp
  core/bitboard.cpp
  core/chain.cpp
  eval/shape.cpp
  eval/form.cpp
  eval/eval.cpp
  build/build.cpp
)

emcc "${SRCS[@]}" -o ../wasm/cpu_wasm5.js \
  -I. \
  -O3 -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_my_malloc","_my_free","_searchBestMovePuyoWasm"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=8388608
echo "✅ build done: cpu_wasm5.js / cpu_wasm5.wasm"
