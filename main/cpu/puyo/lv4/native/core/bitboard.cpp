// ─────────────────────────────────────────────
// core/bitboard.cpp — 配置候補の生成・適用
// ─────────────────────────────────────────────
#include "core/bitboard.h"

int calcDropRow(const BitBoard& b, int col) {
    for (int row = ROWS - 1; row >= 0; row--) {
        if (b.isEmpty(col, row)) return row;
    }
    return -1;
}

std::vector<PairPlacement> getAllPlacements(const BitBoard& b) {
    const int DC[4] = { 0,  1,  0, -1 };
    const int DR[4] = {-1,  0,  1,  0 };
    (void)DR;

    std::vector<PairPlacement> result;
    result.reserve(32);

    for (int col = 0; col < COLS; col++) {
        for (int rot = 0; rot < 4; rot++) {
            int cc = col + DC[rot];
            if (cc < 0 || cc >= COLS) continue;

            int pr = calcDropRow(b, col);
            if (pr < 0) continue;

            int cr;
            if (rot == 0) {
                if (pr == 0) continue;
                cr = pr - 1;
                if (!b.isEmpty(col, pr - 1)) continue;
            } else if (rot == 2) {
                cr = calcDropRow(b, col);
                if (cr < 0) continue;
                pr = cr - 1;
                if (pr < 0) continue;
                if (!b.isEmpty(col, pr)) continue;
            } else {
                cr = calcDropRow(b, cc);
                if (cr < 0) continue;
            }

            PairPlacement p;
            p.col = col; p.rot = rot;
            p.pivotRow = pr; p.childRow = cr; p.childCol = cc;
            result.push_back(p);
        }
    }
    return result;
}

BitBoard applyPlacement(const BitBoard& b, const PairPlacement& p, uint8_t pivotColor, uint8_t childColor) {
    BitBoard nb = b;
    nb.set(p.col,      p.pivotRow + HIDDEN, pivotColor);
    nb.set(p.childCol, p.childRow + HIDDEN, childColor);
    return nb;
}

int placementTear(const PairPlacement& p) {
    // 横置き（pivot と child が別列：rot 1/3）で、2列の着地行が違うときちぎり。
    // 縦置き（rot 0/2、childCol==col）は着地行が連続するのでちぎらない。
    return (p.childCol != p.col && p.pivotRow != p.childRow) ? 1 : 0;
}
