// ─────────────────────────────────────────────
// sim/tet_clys.cpp — 参考AI clys（public/cpu/tet/clys/native、MIT (c) 2024 citrus610）を native で呼ぶ
//   本番 wasm と同じ clys_wasm.cpp の clysSearch をそのまま使う（1手ごとに thinkMs まで探索。時計は steady_clock）。
//   名前空間 tetclys に包んで取り込む（Board 等の名前がほかの CPU と衝突しないように）。C++20 が要るので
//   build.sh ではこのファイルだけ -std=c++20 で別にコンパイルする。設計 source_assets/memory/cpu/tet/clys-port-design.md
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

#define my_malloc  tetclys_my_malloc
#define my_free    tetclys_my_free
#define clysSearch tetclys_clysSearch
#define clysSearchEx tetclys_clysSearchEx
namespace tetclys {
#include "../../../public/cpu/tet/clys/native/core/bag.cpp"
#include "../../../public/cpu/tet/clys/native/core/board.cpp"
#include "../../../public/cpu/tet/clys/native/core/move.cpp"
#include "../../../public/cpu/tet/clys/native/core/state.cpp"
#include "../../../public/cpu/tet/clys/native/ai/beam.cpp"
#include "../../../public/cpu/tet/clys/native/ai/eval.cpp"
#include "../../../public/cpu/tet/clys/native/ai/layer.cpp"
#include "../../../public/cpu/tet/clys/native/ai/path.cpp"
#include "../../../public/cpu/tet/clys/native/clys_wasm.cpp"
}
#undef my_malloc
#undef my_free
#undef clysSearch
#undef clysSearchEx

namespace tsim {

void cpuSearchClys(const uint8_t board[250], const int* queueAll, int nAll, int nSearch, int hold, int bagAfter,
                   int b2b, int ren, int incoming, int thinkMs, int width, int branch, int* out, int outLen) {
    tetclys::tetclys_clysSearch(board, queueAll, nAll, nSearch, hold, bagAfter, b2b, ren, incoming, thinkMs, width,
                                branch, out, outLen);
}

void cpuSearchClysEx(const uint8_t board[250], const int* queueAll, int nAll, int nSearch, int hold, int bagAfter,
                     int b2b, int ren, int incoming, int thinkMs, int width, int branch, int depth, int* out, int outLen) {
    tetclys::tetclys_clysSearchEx(board, queueAll, nAll, nSearch, hold, bagAfter, b2b, ren, incoming, thinkMs, width,
                                  branch, depth, out, outLen);
}

unsigned long long clysNodeCount() { return tetclys::beam::real_nodes; }

} // namespace tsim
