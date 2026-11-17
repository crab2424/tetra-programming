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
    int8_t spawnIrs = 0;   // この手で使った出し方: 先行回転（0/1/-1）
    int8_t spawnIhs = 0;   // 先行ホールドで出したミノか
    uint8_t path[64];
    int pathLength = 0;
};

using Placement = PlacementMeta;

std::vector<Placement> getAllPlacements(const Board& baseBoard, int pieceType, int spawnY);
// 起点（向き・内部座標）を決めて BFS（先行回転で回した向きで出たミノ・ZONE 設計 VERSUS 編 §22）
std::vector<Placement> getAllPlacementsFrom(const Board& baseBoard, int pieceType, int startRot, int startX, int startY);
// 実機の出現位置（irsDir 0=向き 0、1/-1=先行回転）。出せれば true と起点
bool spawnPose(const Board& b, int pieceType, int irsDir, int& rot, int& x, int& y);
