#pragma once
#include <stdint.h>
#include <vector>
#include "common.h"
#include "board.h"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// placement: BFS による全配置列挙（SRS壁蹴り・Tスピン判定・経路記録）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

struct PlacementMeta {
    int rot, x, y, spawnY;
    int linesCleared;
    bool isFullyGrounded;
    int touchingCount;
    GridBlock blocks[4];
    int tSpinType = 0;
    uint8_t path[64];
    int pathLength = 0;
};

using Placement = PlacementMeta;

std::vector<Placement> getAllPlacements(const Board& baseBoard, int pieceType, int spawnY);
