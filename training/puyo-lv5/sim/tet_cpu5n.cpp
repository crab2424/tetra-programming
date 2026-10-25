// ─────────────────────────────────────────────
// sim/tet_cpu5n.cpp — テト CPU 新 lv5 の探索（本番 public/cpu/tet/lv5/cpu5.cpp）を native で呼ぶ（レベル 5）
//   旧 lv5（sim/tet_cpu5.cpp＝固定版）と同じく、本番ソースをコピーせず名前空間 tetcpu5n の中へ #include する。
//   extern "C" の関数は旧 lv5 と名前が衝突するので、tet_cpu4.cpp と同じくマクロで改名する。
// ─────────────────────────────────────────────
#pragma clang fp contract(off)   // tet_cpu5.cpp と同じ理由（wasm は積和を融合しない）

#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>
#include <emscripten.h>

#define my_malloc                   tetcpu5n_my_malloc
#define my_free                     tetcpu5n_my_free
#define searchBestMoveWasm          tetcpu5n_searchBestMoveWasm
#define evaluateSinglePlacementWasm tetcpu5n_evaluateSinglePlacementWasm
namespace tetcpu5n {
#include "../../../public/cpu/tet/lv5/cpu5.cpp"
}
#undef my_malloc
#undef my_free
#undef searchBestMoveWasm
#undef evaluateSinglePlacementWasm

#include "tet.h"

namespace tsim {

static std::once_flag g_precalcOnce5n;

void cpuSearchLv5(const uint8_t board[250], int cur, int hold, const int next[5], int canHold,
                  const int* weights, int ren, int b2b, int out[TET_OUT_LEN]) {
    std::call_once(g_precalcOnce5n, []() { tetcpu5n::ensurePrecalc(); });
    tetcpu5n::tetcpu5n_searchBestMoveWasm(const_cast<uint8_t*>(board), cur, hold, next[0], next[1], next[2], next[3],
                                          next[4], canHold, const_cast<int*>(weights), out, ren, b2b);
}

} // namespace tsim
