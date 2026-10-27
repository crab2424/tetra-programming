// ─────────────────────────────────────────────
// sim/tet_pc6.cpp — 強化版 lv6 のパーフェクトクリア探索（旧本番 lv6/pc/native/pc6.cpp。2026-10-27 に本番から外し
//   sim/frozen/tet_lv6boost/pc/pc6.cpp に凍結）を native で呼ぶ。レベル 26 で使う
//   tet_cpu6.cpp と同じく名前空間 tetpc6 に包んで取り込み、extern "C" の名前はマクロで変える。
//   pc6.cpp のグローバルは thread_local（wasm では static と同じ）なのでスレッド並列で呼べる。
//   本番は時間上限つき（空盤面 300ms・途中 100ms）。nowMs は native では steady_clock。
// ─────────────────────────────────────────────
#include <stdint.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>
#include <emscripten.h>

#define my_malloc              tetpc6_my_malloc
#define my_free                tetpc6_my_free
#define searchPerfectClearWasm tetpc6_searchPerfectClearWasm
namespace tetpc6 {
#include "frozen/tet_lv6boost/pc/pc6.cpp"
}
#undef my_malloc
#undef my_free
#undef searchPerfectClearWasm

#include "tet.h"

namespace tsim {

static std::once_flag g_pcPrecalcOnce;

void cpuSearchPC6(const uint8_t board[250], const int pieces[11], int hold, int canHold, int maxDepth, int maxTimeMs,
                  int out[256]) {
    std::call_once(g_pcPrecalcOnce, []() { tetpc6::ensurePrecalc(); });
    int p[11];
    std::memcpy(p, pieces, sizeof p);
    tetpc6::tetpc6_searchPerfectClearWasm(const_cast<uint8_t*>(board), p, hold, canHold, maxDepth, maxTimeMs, out);
}

} // namespace tsim
