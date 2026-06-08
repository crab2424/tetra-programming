#include "board.h"

bool isValidPlacement(const Board& b, const GridBlock blocks[4]) {
    for(int i = 0; i < 4; i++) {
        const auto& blk = blocks[i];
        if(blk.x < 0 || blk.x >= COLS || blk.y >= ROWS || (blk.y >= 0 && ((b.rows[blk.y] >> blk.x) & 1))) return false;
    }
    return true;
}

PlacementInfo calcPlacementInfo(const Board& b, const GridBlock blocks[4]) {
    int bottomEdges[COLS];
    for(int i=0; i<COLS; i++) bottomEdges[i] = -100;
    for(int i=0; i<4; i++) {
        const auto& blk = blocks[i];
        if(blk.y > bottomEdges[blk.x]) bottomEdges[blk.x] = blk.y;
    }
    bool isFullyGrounded = true;
    for(int x=0; x<COLS; x++) {
        if(bottomEdges[x] == -100) continue;
        int by = bottomEdges[x];
        if(!((by + 1 >= ROWS) || b.has(x, by + 1))) { isFullyGrounded = false; break; }
    }
    int touchingCount = 0;
    if(isFullyGrounded) {
        for(int bi=0; bi<4; bi++) {
            const auto& blk = blocks[bi];
            if (b.has(blk.x - 1, blk.y)) touchingCount++;
            if (b.has(blk.x + 1, blk.y)) touchingCount++;
            if (b.has(blk.x, blk.y + 1)) touchingCount++;
        }
    }
    return {isFullyGrounded, touchingCount};
}

int calcHeights(const Board& b, uint32_t cols[COLS], int heights[COLS]) {
    for(int x = 0; x < COLS; x++) { cols[x] = 0; heights[x] = 0; }
    for(int y = 0; y < ROWS; y++) {
        uint16_t row = b.rows[y];
        for(int x = 0; x < COLS; x++) {
            if ((row >> x) & 1) cols[x] |= (1 << y);
        }
    }
    int maxHeight = 0;
    for (int x = 0; x < COLS; x++) {
        if (cols[x] != 0) {
            // ★最適化：__builtin_ctz (最下位の0の数を数える超高速命令) を使って高さを一発で取得
            heights[x] = ROWS - __builtin_ctz(cols[x]);
            if (heights[x] > maxHeight) maxHeight = heights[x];
        }
    }
    return maxHeight;
}
