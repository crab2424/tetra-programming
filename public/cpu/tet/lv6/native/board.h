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

    // ZONE（設計 source_assets/memory/tet_zone/tetlabo-zone-versus-cpu-design.md §5.2 C1）:
    //   底にある ZONE 段の数。-1＝発動していない（このときは今までと全く同じ動き）。
    //   発動中は ZONE 段を消去判定せず、そろった段は「下を 1 段上げて底へ移す」（上の段は動かない）
    int16_t zone = -1;
    int zoneClear() {
        const int floorY = ROWS - zone;
        int cleared = 0, w = 0;
        for (int y = 0; y < floorY; y++) {
            if (rows[y] == 0x3FF) { cleared++; continue; }
            rows[w++] = rows[y];
        }
        for (int y = w; y < floorY; y++) rows[y] = 0x3FF;
        zone += cleared;
        return cleared;
    }

    int checkLineAndClear() {
        if (zone >= 0) return zoneClear();
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
