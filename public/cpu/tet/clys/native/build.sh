#!/bin/bash
# clys（参考AI・MIT）を WASM にコンパイルする。設計: source_assets/memory/cpu/tet/clys-port-design.md
# 事前に emsdk_env.sh を source しておくこと:
#   source ~/emsdk/emsdk_env.sh
set -e
cd "$(dirname "$0")"
SRCS="core/bag.cpp core/board.cpp core/move.cpp core/state.cpp ai/beam.cpp ai/eval.cpp ai/layer.cpp ai/path.cpp clys_wasm.cpp"
# 成果物（グルーjs/.wasm）は隣の wasm/ に出力する（cpu_worker_clys.js と同居させるため）。
# 手生成 move::expand は再帰 DFS なのでスタックを広めに取る。
emcc $SRCS -I. -o ../wasm/cpu_wasm_clys.js \
  -std=c++20 -O3 -flto -DNDEBUG -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_my_malloc","_my_free","_clysSearch"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s STACK_SIZE=1048576
echo "✅ build done: ../wasm/cpu_wasm_clys.js / ../wasm/cpu_wasm_clys.wasm"
