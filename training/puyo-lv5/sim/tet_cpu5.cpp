// ─────────────────────────────────────────────
// sim/tet_cpu5.cpp — テト CPU 旧 lv5 の探索（固定版 sim/frozen/cpu5_v1.cpp）を native で呼ぶ
//   ぷよの対テト学習の相手役（TetPlayer の既定＝レベル 15）。新 lv5（本番 cpu5.cpp）は sim/tet_cpu5n.cpp。
//   固定版を名前空間 tetcpu5 の中へそのまま #include する
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
#include "frozen/cpu5_v1.cpp"
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

} // namespace tsim
