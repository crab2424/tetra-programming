#include "placement.h"
#include <cmath>
#include <cstring>

const int KICK_I_CW[4][5][2] = {
    {{0,0}, {-2,0}, {1,0}, {-2,1}, {1,-2}},
    {{0,0}, {-1,0}, {2,0}, {-1,-2}, {2,1}},
    {{0,0}, {2,0}, {-1,0}, {2,-1}, {-1,2}},
    {{0,0}, {1,0}, {-2,0}, {1,2}, {-2,-1}}
};
const int KICK_I_CCW[4][5][2] = {
    {{0,0}, {-1,0}, {2,0}, {-1,-2}, {2,1}},  // 0→3: ✓
    {{0,0}, {2,0}, {-1,0}, {2,-1}, {-1,2}},  // 1→0: fix (was [3]の値)
    {{0,0}, {1,0}, {-2,0}, {1,2}, {-2,-1}},  // 2→1: ✓
    {{0,0}, {-2,0}, {1,0}, {-2,1}, {1,-2}}   // 3→2: fix (was [1]の値)
};
const int KICK_OTHER_CW[4][5][2] = {
    {{0,0}, {-1,0}, {-1,-1}, {0,2}, {-1,2}},
    {{0,0}, {1,0}, {1,1}, {0,-2}, {1,-2}},
    {{0,0}, {1,0}, {1,-1}, {0,2}, {1,2}},
    {{0,0}, {-1,0}, {-1,1}, {0,-2}, {-1,-2}}
};
const int KICK_OTHER_CCW[4][5][2] = {
    {{0,0}, {1,0}, {1,-1}, {0,2}, {1,2}},    // 0→3: -CW[3] ✓
    {{0,0}, {1,0}, {1,1}, {0,-2}, {1,-2}},   // 1→0: -CW[0] (fix: was [3]の値)
    {{0,0}, {-1,0}, {-1,-1}, {0,2}, {-1,2}}, // 2→1: -CW[1] ✓
    {{0,0}, {-1,0}, {-1,1}, {0,-2}, {-1,-2}} // 3→2: -CW[2] (fix: was [1]の値)
};

struct BFSState {
    int x, y, rot;
    bool lastActionWasRotation;
    bool lastRotUsedPoint5;
};

struct ParentInfo {
    int8_t x, y, rot, action;
};

std::vector<Placement> getAllPlacements(const Board& baseBoard, int pieceType, int spawnY) {
    std::vector<Placement> placements;
    placements.reserve(64);

    static bool visited[4][35][19];
    static bool placementFound[4][35][19];
    static ParentInfo parent[4][35][19];

    std::memset(visited, 0, sizeof(visited));
    std::memset(placementFound, 0, sizeof(placementFound));

    for(int r=0; r<4; r++)
        for(int y=0; y<35; y++)
            for(int x=0; x<19; x++)
                parent[r][y][x].x = -100;

    int spawnX = COLS / 2 - 2;
    int initialRot = 0;

    // ★最適化：getRotatedBlocks() の呼び出しを排除し、事前計算されたテーブルから直接ブロック位置を取得
    GridBlock startBlocks[4];
    for(int i=0; i<4; i++) {
        startBlocks[i].x = PRECALC_MINO_BLOCKS[pieceType][initialRot][i].x + spawnX;
        startBlocks[i].y = PRECALC_MINO_BLOCKS[pieceType][initialRot][i].y + spawnY;
    }

    if (!isValidPlacement(baseBoard, startBlocks)) {
        spawnY -= 1;
        for(int i=0; i<4; i++) {
            startBlocks[i].y = PRECALC_MINO_BLOCKS[pieceType][initialRot][i].y + spawnY;
        }
        if (!isValidPlacement(baseBoard, startBlocks)) return placements;
    }

    static BFSState bfsQueue[3000];
    int qHead = 0, qTail = 0;

    bfsQueue[qTail++] = {spawnX, spawnY, initialRot, false, false};
    if (spawnY + 5 >= 0 && spawnY + 5 < 35 && spawnX + 4 >= 0 && spawnX + 4 < 19) {
        visited[initialRot][spawnY + 5][spawnX + 4] = true;
    }

    while(qHead < qTail) {
        BFSState curr = bfsQueue[qHead++];

        GridBlock blocks_down[4];
        for(int i=0; i<4; i++) {
            blocks_down[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x;
            blocks_down[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y + 1;
        }
        bool canMoveDown = isValidPlacement(baseBoard, blocks_down);

        if (!canMoveDown) {
            if (curr.y + 5 >= 0 && curr.y + 5 < 35 && curr.x + 4 >= 0 && curr.x + 4 < 19) {
                if (!placementFound[curr.rot][curr.y + 5][curr.x + 4]) {
                    placementFound[curr.rot][curr.y + 5][curr.x + 4] = true;

                    GridBlock droppedBlocks[4];
                    for(int i=0; i<4; i++) {
                        droppedBlocks[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x;
                        droppedBlocks[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
                    }

                    Board simBoard = baseBoard;
                    for(int i=0; i<4; i++) {
                        simBoard.set(droppedBlocks[i].x, droppedBlocks[i].y);
                    }
                    PlacementInfo info = calcPlacementInfo(baseBoard, droppedBlocks);
                    int cleared = simBoard.checkLineAndClear();

                    int tSpinType = 0;
                    if (pieceType == 2 && curr.lastActionWasRotation) {
                        float cx = curr.x + MINO_TEMPLATES[pieceType].pivotX - 0.5f;
                        float cy = curr.y + MINO_TEMPLATES[pieceType].pivotY - 0.5f;
                        int px = std::round(cx), py = std::round(cy);

                        int corners[4][2] = {{px-1, py-1}, {px+1, py-1}, {px-1, py+1}, {px+1, py+1}};
                        bool occupied[4];
                        for(int i=0; i<4; i++) occupied[i] = baseBoard.has(corners[i][0], corners[i][1]);

                        int abIdx[2], cdIdx[2];
                        if (curr.rot == 0) { abIdx[0]=0; abIdx[1]=1; cdIdx[0]=2; cdIdx[1]=3; }
                        else if (curr.rot == 1) { abIdx[0]=1; abIdx[1]=3; cdIdx[0]=0; cdIdx[1]=2; }
                        else if (curr.rot == 2) { abIdx[0]=3; abIdx[1]=2; cdIdx[0]=1; cdIdx[1]=0; }
                        else if (curr.rot == 3) { abIdx[0]=2; abIdx[1]=0; cdIdx[0]=3; cdIdx[1]=1; }

                        int abFilled = 0, cdFilled = 0;
                        if(occupied[abIdx[0]]) abFilled++;
                        if(occupied[abIdx[1]]) abFilled++;
                        if(occupied[cdIdx[0]]) cdFilled++;
                        if(occupied[cdIdx[1]]) cdFilled++;

                        if (curr.lastRotUsedPoint5) tSpinType = 1;
                        else if (abFilled == 2 && cdFilled >= 1) tSpinType = 1; // Normal T-Spin
                        else if (cdFilled == 2 && abFilled >= 1) tSpinType = 2; // Mini T-Spin
                    }

                    uint8_t path[64];
                    int pathLen = 0;
                    int traceX = curr.x, traceY = curr.y, traceRot = curr.rot;
                    while(true) {
                        if (traceY + 5 < 0 || traceY + 5 >= 35 || traceX + 4 < 0 || traceX + 4 >= 19) break;
                        ParentInfo& pInfo = parent[traceRot][traceY + 5][traceX + 4];
                        if (pInfo.x == -100) break;
                        if (pathLen < 63) path[pathLen++] = (uint8_t)pInfo.action;
                        traceX = pInfo.x; traceY = pInfo.y; traceRot = pInfo.rot;
                    }
                    for (int i=0; i < pathLen / 2; i++) {
                        uint8_t tmp = path[i];
                        path[i] = path[pathLen - 1 - i];
                        path[pathLen - 1 - i] = tmp;
                    }
                    path[pathLen++] = 6;

                    Placement p;
                    p.rot = curr.rot; p.x = curr.x; p.y = curr.y; p.spawnY = spawnY;
                    p.linesCleared = cleared;
                    p.isFullyGrounded = info.isFullyGrounded;
                    p.touchingCount = info.touchingCount;
                    for(int i=0; i<4; i++) p.blocks[i] = droppedBlocks[i];
                    p.tSpinType = tSpinType;
                    for(int i=0; i<pathLen; i++) p.path[i] = path[i];
                    p.pathLength = pathLen;

                    placements.push_back(p);
                }
            }
        }

        auto tryPush = [&](int nx, int ny, int nrot, bool isRot, bool isPoint5, int action) {
            if (ny + 5 >= 0 && ny + 5 < 35 && nx + 4 >= 0 && nx + 4 < 19) {
                if (!visited[nrot][ny + 5][nx + 4]) {
                    visited[nrot][ny + 5][nx + 4] = true;
                    parent[nrot][ny + 5][nx + 4] = { (int8_t)curr.x, (int8_t)curr.y, (int8_t)curr.rot, (int8_t)action };
                    bfsQueue[qTail++] = {nx, ny, nrot, isRot, isPoint5};
                }
            }
        };

        if (canMoveDown) tryPush(curr.x, curr.y + 1, curr.rot, false, false, 3);

        GridBlock blocks_left[4];
        for(int i=0; i<4; i++) {
            blocks_left[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x - 1;
            blocks_left[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
        }
        if (isValidPlacement(baseBoard, blocks_left)) tryPush(curr.x - 1, curr.y, curr.rot, false, false, 1);

        GridBlock blocks_right[4];
        for(int i=0; i<4; i++) {
            blocks_right[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x + 1;
            blocks_right[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
        }
        if (isValidPlacement(baseBoard, blocks_right)) tryPush(curr.x + 1, curr.y, curr.rot, false, false, 2);

        for (int rotDir : {1, -1}) {
            int toRot = (curr.rot + (rotDir == 1 ? 1 : 3)) % 4;
            int actionId = (rotDir == 1) ? 4 : 5;
            bool isI = (pieceType == 0);
            const int (*table)[2] = isI ? (rotDir == 1 ? KICK_I_CW[curr.rot] : KICK_I_CCW[curr.rot])
                                        : (rotDir == 1 ? KICK_OTHER_CW[curr.rot] : KICK_OTHER_CCW[curr.rot]);

            for (int i = 0; i < 5; i++) {
                int kx = table[i][0];
                int ky = table[i][1];
                GridBlock blocks_rot[4];
                for(int j=0; j<4; j++) {
                    blocks_rot[j].x = PRECALC_MINO_BLOCKS[pieceType][toRot][j].x + curr.x + kx;
                    blocks_rot[j].y = PRECALC_MINO_BLOCKS[pieceType][toRot][j].y + curr.y + ky;
                }
                if (isValidPlacement(baseBoard, blocks_rot)) {
                    bool usedPoint5 = (i == 4);
                    tryPush(curr.x + kx, curr.y + ky, toRot, true, usedPoint5, actionId);
                    break;
                }
            }
        }
    }

    return placements;
}
