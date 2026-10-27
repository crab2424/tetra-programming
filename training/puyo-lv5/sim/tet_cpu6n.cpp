// ─────────────────────────────────────────────
// sim/tet_cpu6n.cpp — テト CPU lv7（本番 public/cpu/tet/lv7/engine、clys がもと・MIT）を native で呼ぶ
//   開発中の呼び名「lv6n」のまま（シミュのレベル 36・プリセット lv6n_*）
//   本番 wasm と同じ lv7_wasm.cpp の lv6Search をそのまま使う。名前空間 tetlv6n に包んで取り込む
//   （Board 等の名前が clys・ほかの CPU と衝突しないように）。C++20 が要るので build.sh で別にコンパイルする。
//   設計 source_assets/memory/cpu/tet/lv6-phase1-search-design.md
// ─────────────────────────────────────────────
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <bitset>
#include <cassert>
#include <chrono>
#include <climits>
#include <cmath>
#include <functional>
#include <iostream>
#include <mutex>
#include <optional>
#include <random>
#include <stdalign.h>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#define lv7_malloc tetlv6n_lv7_malloc
#define lv7_free   tetlv6n_lv7_free
#define lv7Search  tetlv6n_lv7Search
#define lv7Plan    tetlv6n_lv7Plan
namespace tetlv6n {
#include "../../../public/cpu/tet/lv7/engine/core/bag.cpp"
#include "../../../public/cpu/tet/lv7/engine/core/board.cpp"
#include "../../../public/cpu/tet/lv7/engine/core/move.cpp"
#include "../../../public/cpu/tet/lv7/engine/core/state.cpp"
#include "../../../public/cpu/tet/lv7/engine/ai/beam.cpp"
#include "../../../public/cpu/tet/lv7/engine/ai/eval.cpp"
#include "../../../public/cpu/tet/lv7/engine/ai/layer.cpp"
#include "../../../public/cpu/tet/lv7/engine/ai/path.cpp"
#include "../../../public/cpu/tet/lv7/engine/lv7_wasm.cpp"
}
#undef lv7_malloc
#undef lv7_free
#undef lv7Search
#undef lv7Plan

namespace tsim {

void cpuSearchLv6n(const uint8_t board[250], const int* queue, int nQueue, int hold, int bagAfter, int b2b, int ren,
                   int incoming, const int* weights, int nWeights, int width, int depth, int thinkMs, int* out,
                   int outLen) {
    tetlv6n::tetlv6n_lv7Search(board, queue, nQueue, hold, bagAfter, b2b, ren, incoming, weights, nWeights, width,
                               depth, thinkMs, out, outLen);
}

const int* lv6nDefaultWeights() { return tetlv6n::eval::DEFAULT_WEIGHTS; }
int lv6nWeightsLen() { return tetlv6n::eval::WEIGHT_LEN; }

} // namespace tsim
