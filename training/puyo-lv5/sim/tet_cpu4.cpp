// ─────────────────────────────────────────────
// sim/tet_cpu4.cpp — テト CPU lv4 の探索（本番 public/cpu/tet/lv4/cpu4.cpp）を native で呼ぶ
//   tet_cpu5.cpp と同じく、本番ソースをコピーせず名前空間 tetcpu4 の中へそのまま #include する。
//   extern "C" の関数は名前空間を無視して大域の名前になる（lv5 と衝突する）ので、マクロで名前を変えて取り込む。
//   探索の作業配列は本番側で thread_local 化済み（lv4 は事前計算テーブルを持たない）。
// ─────────────────────────────────────────────
#pragma clang fp contract(off)   // tet_cpu5.cpp と同じ理由（wasm は積和を融合しない）

#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <emscripten.h>

#define my_malloc          tetcpu4_my_malloc
#define my_free            tetcpu4_my_free
#define searchBestMoveWasm tetcpu4_searchBestMoveWasm
namespace tetcpu4 {
#include "../../../public/cpu/tet/lv4/cpu4.cpp"
}
#undef my_malloc
#undef my_free
#undef searchBestMoveWasm

#include "tet.h"

namespace tsim {

void cpuSearchLv4(const uint8_t board[250], int cur, int hold, const int next[5], int canHold,
                  const int* weights, int out[TET_OUT_LEN]) {
    tetcpu4::tetcpu4_searchBestMoveWasm(const_cast<uint8_t*>(board), cur, hold, next[0], next[1], next[2], next[3],
                                        next[4], canHold, const_cast<int*>(weights), out);
}

} // namespace tsim
