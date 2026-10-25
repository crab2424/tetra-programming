// ─────────────────────────────────────────────
// sim/tet_cpu6.cpp — テト CPU lv6 のビーム探索（本番 public/cpu/tet/lv6/native/*.cpp）を native で呼ぶ
//   本番は6ファイルに分かれているので、1つの翻訳単位にまとめて名前空間 tetcpu6 の中へ #include する
//   （Board などの名前がぷよ側・lv4/lv5 と衝突しないように）。標準ヘッダは名前空間の外で先に読んでおく。
//   extern "C" の関数はマクロで名前を変える（lv4/lv5 と衝突するため）。
//   PC（パーフェクトクリア）探索 Worker は移植しない＝空盤面の開幕 PC だけ本番と差が出る（設計 §4.1）。
// ─────────────────────────────────────────────
#pragma clang fp contract(off)   // tet_cpu5.cpp と同じ理由（wasm は積和を融合しない）

#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <utility>
#include <vector>
#include <emscripten.h>

#define my_malloc                   tetcpu6_my_malloc
#define my_free                     tetcpu6_my_free
#define searchBestMoveWasm          tetcpu6_searchBestMoveWasm
#define evaluateSinglePlacementWasm tetcpu6_evaluateSinglePlacementWasm
namespace tetcpu6 {
#include "../../../public/cpu/tet/lv6/native/common.cpp"
#include "../../../public/cpu/tet/lv6/native/board.cpp"
#include "../../../public/cpu/tet/lv6/native/tslot.cpp"
#include "../../../public/cpu/tet/lv6/native/eval.cpp"
#include "../../../public/cpu/tet/lv6/native/placement.cpp"
#include "../../../public/cpu/tet/lv6/native/cpu6.cpp"
}
#undef my_malloc
#undef my_free
#undef searchBestMoveWasm
#undef evaluateSinglePlacementWasm

#include "tet.h"

namespace tsim {

static std::once_flag g_precalc6Once;

void cpuSearchLv6(const uint8_t board[250], int cur, int hold, const int next[8], int canHold,
                  const int* weights, int ren, int b2b, int incoming, int out[TET_OUT_LEN]) {
    std::call_once(g_precalc6Once, []() { tetcpu6::ensurePrecalc(); });
    tetcpu6::tetcpu6_searchBestMoveWasm(const_cast<uint8_t*>(board), cur, hold, next[0], next[1], next[2], next[3],
                                        next[4], next[5], next[6], next[7], canHold, const_cast<int*>(weights), out,
                                        ren, b2b, incoming);
}

} // namespace tsim
