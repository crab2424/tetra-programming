#pragma once
#include <stdint.h>
#include "common.h"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// board: ビットボード本体と、配置の妥当性・接地・列高さの算出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ★最適化：Boardクラスをビットボード化（250バイト → 50バイトへ圧縮）
class Board {
public:
    uint16_t rows[ROWS];          // 各行を10bit分のビットで管理

    Board() {
        for(int y=0; y<ROWS; y++) rows[y] = 0;
    }

    inline bool has(int x, int y) const {
        if(x < 0 || x >= COLS || y >= ROWS) return true;
        if(y < 0) return false;
        return (rows[y] & (1 << x)) != 0;
    }

    inline void set(int x, int y) {
        if(x >= 0 && x < COLS && y >= 0 && y < ROWS) rows[y] |= (1 << x);
    }

    inline void clear(int x, int y) {
        if(x >= 0 && x < COLS && y >= 0 && y < ROWS) rows[y] &= ~(1 << x);
    }

    int checkLineAndClear() {
        int cleared = 0;
        int write_y = ROWS - 1;
        for (int y = ROWS - 1; y >= 0; y--) {
            if (rows[y] == 0x3FF) { // 10列すべてビットが立っている (1023)
                cleared++;
            } else {
                rows[write_y] = rows[y];
                write_y--;
            }
        }
        for (int y = write_y; y >= 0; y--) {
            rows[y] = 0;
        }
        return cleared;
    }
};

struct PlacementInfo { bool isFullyGrounded; int touchingCount; };

bool isValidPlacement(const Board& b, const GridBlock blocks[4]);
PlacementInfo calcPlacementInfo(const Board& b, const GridBlock blocks[4]);

// ビットボードから列ごとの高さを算出し、cols / heights を埋め、maxHeight を返す
int calcHeights(const Board& b, uint32_t cols[COLS], int heights[COLS]);
