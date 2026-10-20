// ─────────────────────────────────────────────
// sim/tet_cpu5.cpp — テト CPU lv5 の探索（本番 public/cpu/tet/lv5/cpu5.cpp）を native で呼ぶ
//   本番ソースはコピーせず、名前空間 tetcpu5 の中へそのまま #include する
//   （Board などの名前がぷよ側 native と衝突しないように）。emscripten.h は sim/tet_stub の空ヘッダ。
//   探索の作業配列は本番側で thread_local 化済み。ブロック表の初期化だけ once で守る。
// ─────────────────────────────────────────────
// wasm（emcc）は浮動小数の積和を融合しない。native（-march=native）で FMA に融合されると
// 評価値の float→int 切り捨てが1ずれるので、この翻訳単位だけ融合を止める（tests/test_tet_parity.py）。
#pragma clang fp contract(off)

#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>
#include <emscripten.h>

namespace tetcpu5 {
#include "../../../public/cpu/tet/lv5/cpu5.cpp"
}

#include "tet.h"

namespace tsim {

static std::once_flag g_precalcOnce;

static void ensureTables() {
    std::call_once(g_precalcOnce, []() { tetcpu5::ensurePrecalc(); });
}

void cpuSearch(const uint8_t board[250], int cur, int hold, const int next[5], int canHold,
               const int weights[TET_W_LEN], int ren, int b2b, int out[TET_OUT_LEN]) {
    ensureTables();
    tetcpu5::searchBestMoveWasm(const_cast<uint8_t*>(board), cur, hold, next[0], next[1], next[2], next[3], next[4],
                                canHold, const_cast<int*>(weights), out, ren, b2b);
}

void pieceBlocks(int type, int rot, int outXY[8]) {
    ensureTables();
    for (int i = 0; i < 4; i++) {
        outXY[i * 2]     = tetcpu5::PRECALC_MINO_BLOCKS[type][rot][i].x;
        outXY[i * 2 + 1] = tetcpu5::PRECALC_MINO_BLOCKS[type][rot][i].y;
    }
}

void kickTable(int type, int fromRot, int dir, int outKicks[10]) {
    const int (*t)[2] = (type == 0)
        ? (dir == 1 ? tetcpu5::KICK_I_CW[fromRot] : tetcpu5::KICK_I_CCW[fromRot])
        : (dir == 1 ? tetcpu5::KICK_OTHER_CW[fromRot] : tetcpu5::KICK_OTHER_CCW[fromRot]);
    for (int i = 0; i < 5; i++) { outKicks[i * 2] = t[i][0]; outKicks[i * 2 + 1] = t[i][1]; }
}

} // namespace tsim
