// ─────────────────────────────────────────────
// core/bitboard.h — ビットボード盤面とぷよ配置の生成
//   BitBoard: 1列を uint64_t で表現（1マス3ビット）。
//   PairPlacement: 1ペアの落下結果（列・回転・着地行）。
// ─────────────────────────────────────────────
#pragma once

#include <stdint.h>
#include <vector>
#include "def.h"

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BitBoard
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct BitBoard {
    uint64_t cols[COLS];

    BitBoard() {
        for(int c = 0; c < COLS; c++) cols[c] = 0;
    }

    void fromArray(const uint8_t* data) {
        for(int c = 0; c < COLS; c++) cols[c] = 0;
        for (int r = 0; r < TOTAL_ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                uint8_t val = data[r * COLS + c];
                if (val != 0) {
                    cols[c] |= ((uint64_t)(val & 0x7) << ((TOTAL_ROWS - 1 - r) * 3));
                }
            }
        }
    }

    inline uint8_t get(int col, int r) const {
        if (col < 0 || col >= COLS || r < 0 || r >= TOTAL_ROWS) return 0;
        return (cols[col] >> ((TOTAL_ROWS - 1 - r) * 3)) & 0x7;
    }

    inline void set(int col, int r, uint8_t val) {
        if (col < 0 || col >= COLS || r < 0 || r >= TOTAL_ROWS) return;
        int shift = (TOTAL_ROWS - 1 - r) * 3;
        cols[col] &= ~(0x7ULL << shift);
        cols[col] |= ((uint64_t)(val & 0x7) << shift);
    }

    bool isEmpty(int col, int row) const {
        if (col < 0 || col >= COLS) return false;
        if (row >= ROWS) return false;
        int r = row + HIDDEN;
        if (r < 0) return true;
        return get(col, r) == 0;
    }

    bool isEmptyAll() const {
        for(int c = 0; c < COLS; c++) if (cols[c] != 0) return false;
        return true;
    }

    void applyGravity() {
        for (int c = 0; c < COLS; c++) {
            uint64_t col = cols[c];
            if (col == 0) continue;

            uint64_t new_col = 0;
            int write_idx = 0;
            for (int i = 0; i < TOTAL_ROWS; i++) {
                uint64_t val = (col >> (i * 3)) & 0x7;
                if (val != 0) {
                    new_col |= (val << (write_idx * 3));
                    write_idx++;
                }
            }
            cols[c] = new_col;
        }
    }
};

struct PairPlacement {
    int col;
    int rot;
    int pivotRow;
    int childRow;
    int childCol;
};

// 列 col のぷよが落下して着地する行（内部下基準）。置けなければ -1。
int calcDropRow(const BitBoard& b, int col);

// 盤面 b に対する全ての配置候補（最大 6列×4回転）を返す。
std::vector<PairPlacement> getAllPlacements(const BitBoard& b);

// 配置 p を pivot/child の色で盤面に適用した新しい盤面を返す。
BitBoard applyPlacement(const BitBoard& b, const PairPlacement& p, uint8_t pivotColor, uint8_t childColor);

// 配置 p で「ちぎり（tear）」が発生するか（0 or 1）を返す。
//   Ama get_drop_pair_frame と等価: 横置き(pivot/childが別列)で、その2列の落下行が
//   異なる＝ペアが2列に分かれてバラバラに落ちる場合のみ 1。縦置きは常に 0。
//   原典: source_assets/puyoAI/ama-beam/core/field.cpp get_drop_pair_frame
int placementTear(const PairPlacement& p);
