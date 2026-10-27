// ─────────────────────────────────────────────
// sim/tet_cpu6b.cpp — 強化版 lv6（2026-10-26 時点。B3/B6・相殺外し・REN 偏重の是正・通常探索の PC）のビーム探索を native で呼ぶ
//   本番から外した版を sim/frozen/tet_lv6boost/native に凍結してある（2026-10-27。本番 lv6 は main の版に戻した）。
//   レベル 16（PC 探索なし）・26（PC 探索あり）。比較・再現用
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

#define my_malloc                   tetcpu6b_my_malloc
#define my_free                     tetcpu6b_my_free
#define searchBestMoveWasm          tetcpu6b_searchBestMoveWasm
#define evaluateSinglePlacementWasm tetcpu6b_evaluateSinglePlacementWasm
#define searchBestMoveExt           tetcpu6b_searchBestMoveExt
#define lv6NodeCount                tetcpu6b_lv6NodeCount
namespace tetcpu6b {
#include "frozen/tet_lv6boost/native/common.cpp"
#include "frozen/tet_lv6boost/native/board.cpp"
#include "frozen/tet_lv6boost/native/tslot.cpp"
#include "frozen/tet_lv6boost/native/eval.cpp"
#include "frozen/tet_lv6boost/native/placement.cpp"
#include "frozen/tet_lv6boost/native/cpu6.cpp"
}
#undef my_malloc
#undef my_free
#undef searchBestMoveWasm
#undef evaluateSinglePlacementWasm
#undef searchBestMoveExt
#undef lv6NodeCount

#include "tet.h"

namespace tsim {

static std::once_flag g_precalc6bOnce;

void cpuSearchLv6b(const uint8_t board[250], int cur, int hold, const int next[8], int canHold,
                  const int* weights, int ren, int b2b, int incoming, int out[TET_OUT_LEN]) {
    std::call_once(g_precalc6bOnce, []() { tetcpu6b::ensurePrecalc(); });
    tetcpu6b::tetcpu6b_searchBestMoveWasm(const_cast<uint8_t*>(board), cur, hold, next[0], next[1], next[2], next[3],
                                        next[4], next[5], next[6], next[7], canHold, const_cast<int*>(weights), out,
                                        ren, b2b, incoming);
}

void cpuSearchLv6bExt(const uint8_t board[250], int cur, int hold, const int* next, int nNext, int canHold,
                     const int* weights, int ren, int b2b, int incoming, int width, int depth, int out[TET_OUT_LEN]) {
    std::call_once(g_precalc6bOnce, []() { tetcpu6b::ensurePrecalc(); });
    tetcpu6b::tetcpu6b_searchBestMoveExt(const_cast<uint8_t*>(board), cur, hold, next, nNext, canHold,
                                       const_cast<int*>(weights), out, ren, b2b, incoming, width, depth);
}

long long lv6bNodeCount() { return tetcpu6b::tetcpu6b_lv6NodeCount(); }

} // namespace tsim
