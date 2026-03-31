#include <emscripten.h>
#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>

const int COLS = 10;
const int ROWS = 20;

struct GridBlock { int x, y; };

struct MinoData {
    GridBlock blocks[4];
    float pivotX, pivotY;
};

const MinoData MINO_TEMPLATES[7] = {
    {{{0,1},{1,1},{2,1},{3,1}}, 1.5f, 1.5f}, 
    {{{1,1},{2,1},{1,2},{2,2}}, 1.5f, 1.5f}, 
    {{{1,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f}, 
    {{{0,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f}, 
    {{{2,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f}, 
    {{{1,1},{2,1},{0,2},{1,2}}, 1.0f, 2.0f}, 
    {{{0,1},{1,1},{1,2},{2,2}}, 1.0f, 2.0f}  
};

class Board {
public:
    uint8_t cells[ROWS][COLS];
    Board() {
        for(int y=0; y<ROWS; y++) for(int x=0; x<COLS; x++) cells[y][x] = 0;
    }
    bool has(int x, int y) const {
        if(x < 0 || x >= COLS || y >= ROWS) return true;
        if(y < 0) return false;
        return cells[y][x] != 0;
    }
    bool hasBlockAbove(int x, int y) const {
        for (int ty = y - 1; ty >= 0; ty--) {
            if (cells[ty][x] != 0) return true;
        }
        return false;
    }
    int checkLineAndClear() {
        int cleared = 0;
        for(int y = 0; y < ROWS; y++) {
            bool full = true;
            for(int x = 0; x < COLS; x++) if(cells[y][x] == 0) { full = false; break; }
            if(full) {
                cleared++;
                for(int ty = y; ty > 0; ty--) for(int x = 0; x < COLS; x++) cells[ty][x] = cells[ty-1][x];
                for(int x = 0; x < COLS; x++) cells[0][x] = 0;
            }
        }
        return cleared;
    }
};

void getRotatedBlocks(int type, int rot, int offsetX, int offsetY, GridBlock outBlocks[4]) {
    MinoData tmpl = MINO_TEMPLATES[type];
    for(int i = 0; i < 4; i++) {
        float relX = tmpl.blocks[i].x - tmpl.pivotX;
        float relY = tmpl.blocks[i].y - tmpl.pivotY;
        float newX = relX, newY = relY;
        for(int r = 0; r < rot; r++) {
            float tempX = -newY; float tempY = newX;
            newX = tempX; newY = tempY;
        }
        outBlocks[i].x = std::round(newX + tmpl.pivotX) + offsetX;
        outBlocks[i].y = std::round(newY + tmpl.pivotY) + offsetY;
    }
}

bool isValidPlacement(const Board& b, const GridBlock blocks[4]) {
    for(int i = 0; i < 4; i++) {
        const auto& blk = blocks[i];
        if(blk.x < 0 || blk.x >= COLS || blk.y >= ROWS || (blk.y >= 0 && b.has(blk.x, blk.y))) return false;
    }
    return true;
}

struct PlacementInfo { bool isFullyGrounded; int touchingCount; };

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
            int dx[] = {-1, 1, 0}; int dy[] = {0, 0, 1};
            for(int i=0; i<3; i++) {
                int nx = blk.x + dx[i]; int ny = blk.y + dy[i];
                if(nx < 0 || nx >= COLS || ny >= ROWS || b.has(nx, ny)) touchingCount++;
            }
        }
    }
    return {isFullyGrounded, touchingCount};
}

struct EvalWeights {
    int lineClear, hole, heightLimit, heightDiff, flat;
    int step1Good, step1Bad, step2Plus, groundedBonus, touchingBonus;
    int iWell, iWellOver, blocksOverHole; 
    int line4, downstackGood, downstackBad;
    int p1Weight; 
    int tsdShape, tsdShapeOver, tsdFillBonus; 
    int tssClear, tsdClear, tsdHolePenalty, pureHole; 
};

bool isTSDShape(const Board& board, int cx, int cy) {
    if (cx < 1 || cx >= COLS - 1 || cy < 0 || cy >= ROWS - 1) return false;
    if (board.cells[cy][cx] != 0 || board.cells[cy][cx-1] != 0 || board.cells[cy][cx+1] != 0 || board.cells[cy+1][cx] != 0) return false;
    auto isSolid = [&](int x, int y) {
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y < 0) return false;
        return board.cells[y][x] != 0;
    };
    if (!isSolid(cx - 2, cy)) return false;
    if (!isSolid(cx + 2, cy)) return false;
    if (!isSolid(cx - 2, cy + 1)) return false;
    if (!isSolid(cx + 2, cy + 1)) return false;
    if (!isSolid(cx - 1, cy + 1)) return false; 
    if (!isSolid(cx + 1, cy + 1)) return false; 
    
    bool leftRoof = (cy - 1 < 0) || (cx - 1 < 0) || (board.cells[cy-1][cx-1] != 0);
    bool rightRoof = (cy - 1 < 0) || (cx + 1 >= COLS) || (board.cells[cy-1][cx+1] != 0);
    if (!(leftRoof ^ rightRoof)) return false; 
    
    if (cy - 1 >= 0) {
        if (leftRoof) {
            if (board.cells[cy-1][cx] != 0 || (cx + 1 < COLS && board.cells[cy-1][cx+1] != 0)) return false;
        } else {
            if (board.cells[cy-1][cx] != 0 || (cx - 1 >= 0 && board.cells[cy-1][cx-1] != 0)) return false;
        }
    }

    int clearCol1 = cx;
    int clearCol2 = leftRoof ? cx + 1 : cx - 1;
    for (int y = 0; y < cy; y++) {
        if (board.cells[y][clearCol1] != 0) return false;
        if (board.cells[y][clearCol2] != 0) return false;
    }

    bool greenFilled = true;
    for(int x = 0; x < COLS; x++) {
        if (x != cx && !isSolid(x, cy + 1)) { greenFilled = false; break; }
    }
    bool yellowFilled = true;
    for(int x = 0; x < COLS; x++) {
        if (x != cx && !isSolid(x, cy + 2)) { yellowFilled = false; break; }
    }
    if (!greenFilled && !yellowFilled) return false;
    return true;
}

struct TSDStats { int count; int fillCount; int holeCount; };

TSDStats analyzeTSD(const Board& board) {
    TSDStats stats = {0, 0, 0};
    for (int cy = 1; cy < ROWS - 1; cy++) {
        for (int cx = 1; cx < COLS - 1; cx++) {
            if (isTSDShape(board, cx, cy)) {
                stats.count++;
                if (stats.count == 1) { 
                    for (int x = 0; x < COLS; x++) {
                        if (x != cx - 1 && x != cx && x != cx + 1) {
                            if (board.cells[cy][x] != 0) stats.fillCount++;
                            else if (board.hasBlockAbove(x, cy)) stats.holeCount++; 
                        }
                        if (x != cx) {
                            if (board.cells[cy + 1][x] != 0) stats.fillCount++;
                            else if (board.hasBlockAbove(x, cy + 1)) stats.holeCount++; 
                        }
                    }
                }
            }
        }
    }
    return stats;
}

int evaluateBoard(const Board& b, int linesCleared, bool isGrounded, int touchingCount, const EvalWeights& w, const GridBlock* droppedBlocks = nullptr) {
    int score = 0;
    if (linesCleared > 0) score += (linesCleared - 2) * w.lineClear;
    if (linesCleared >= 4) score += w.line4;

    if (linesCleared >= 1 && linesCleared <= 3 && droppedBlocks != nullptr) {
        int minoBottomY = -1;
        for (int i=0; i<4; i++) {
            if (droppedBlocks[i].y > minoBottomY) minoBottomY = droppedBlocks[i].y;
        }
        int n = 19 - minoBottomY;
        if (n < 0) n = 0;
        if (n >= 3 && isGrounded) score += w.downstackGood * n; 
        else if (n < 3) score += w.downstackBad * 10 * n; 
    }

    int heights[COLS] = {0};
    int holes = 0;
    for(int x = 0; x < COLS; x++) {
        bool foundTop = false; int colBlocks = 0;
        for(int y = 0; y < ROWS; y++) {
            if(b.cells[y][x] != 0) {
                if(!foundTop) { heights[x] = ROWS - y; foundTop = true; }
                colBlocks++;
            }
        }
        if(foundTop) holes += (heights[x] - colBlocks);
    }

    int maxHeight = 0; int minHeight = ROWS;
    for(int h : heights) {
        if(h > maxHeight) maxHeight = h;
        if(h < minHeight) minHeight = h;
    }

    score += (maxHeight - minHeight) * w.heightDiff;
    if(maxHeight >= 8) score += (maxHeight - 7) * w.heightLimit;
    score += holes * w.hole;

    int pureHolesCount = 0;
    for(int y = 0; y < ROWS; y++) {
        for(int x = 0; x < COLS; x++) {
            if(b.cells[y][x] == 0) {
                bool up    = (y == 0) || (b.cells[y-1][x] != 0);
                bool down  = (y == ROWS-1) || (b.cells[y+1][x] != 0);
                bool left  = (x == 0) || (b.cells[y][x-1] != 0);
                bool right = (x == COLS-1) || (b.cells[y][x+1] != 0);
                if(up && down && left && right) pureHolesCount++;
            }
        }
    }
    score += pureHolesCount * w.pureHole;

    int step1Count = 0;
    for(int x = 0; x < COLS - 1; x++) {
        int diff = std::abs(heights[x] - heights[x+1]);
        if(diff == 0) score += w.flat;
        else if(diff == 1) step1Count++;
        else score += w.step2Plus;
    }
    score += (step1Count <= 2) ? (step1Count * w.step1Good) : (step1Count * w.step1Bad);

    int deepWells = 0; int totalDepth = 0;
    for(int x = 0; x < COLS; x++) {
        int leftDiff = (x == 0) ? 999 : heights[x-1] - heights[x];
        int rightDiff = (x == COLS-1) ? 999 : heights[x+1] - heights[x];
        if(leftDiff >= 3 && rightDiff >= 3) {
            int depth = std::min(leftDiff, rightDiff);
            if(x == 0) depth = rightDiff;
            if(x == COLS-1) depth = leftDiff;
            deepWells++; totalDepth += depth;
        }
    }
    if(deepWells == 1) score += 1;
    else if(deepWells >= 2) score += totalDepth * -10;

    int blocksInRowArray[ROWS] = {0};
    for(int y = 0; y < ROWS; y++) {
        for(int x = 0; x < COLS; x++) {
            if(b.cells[y][x] != 0) blocksInRowArray[y]++;
        }
    }

    int totalIWellScore = 0;
    for(int x = 0; x < COLS; x++) {
        int continuousEmpty = 0; int maxContinuous = 0;
        for(int y = 0; y < ROWS; y++) {
            if(blocksInRowArray[y] == 9 && b.cells[y][x] == 0) {
                continuousEmpty++;
                if(continuousEmpty > maxContinuous) maxContinuous = continuousEmpty;
            } else {
                continuousEmpty = 0; 
            }
        }
        if(maxContinuous > 0) {
            if(maxContinuous <= 10) totalIWellScore += maxContinuous * w.iWell;
            else totalIWellScore += 10 * w.iWell + (maxContinuous - 10) * w.iWellOver;
        }
    }
    score += totalIWellScore;

    int totalBlocksOverLowestHole = 0;
    for(int x = 0; x < COLS; x++) {
        int firstBlockY = -1;
        for(int y = 0; y < ROWS; y++) {
            if(b.cells[y][x] != 0) { firstBlockY = y; break; }
        }
        if (firstBlockY != -1) {
            int lowestHoleY = -1;
            for(int y = ROWS - 1; y > firstBlockY; y--) {
                if(b.cells[y][x] == 0) { lowestHoleY = y; break; }
            }
            if(lowestHoleY != -1) {
                int blocksAbove = 0;
                for(int y = 0; y < lowestHoleY; y++) {
                    if(b.cells[y][x] != 0) blocksAbove++;
                }
                totalBlocksOverLowestHole += blocksAbove;
            }
        }
    }
    score += totalBlocksOverLowestHole * w.blocksOverHole;

    if(isGrounded) {
        score += w.groundedBonus;
        score += touchingCount * w.touchingBonus;
    } else {
        score -= 3 * w.groundedBonus;
    }

    TSDStats tsd = analyzeTSD(b);
    if (tsd.count == 1) {
        score += w.tsdShape;
        score += tsd.fillCount * w.tsdFillBonus; 
        score += tsd.holeCount * w.tsdHolePenalty; 
    } else if (tsd.count >= 2) {
        score += w.tsdShape; 
        score += (tsd.count - 1) * w.tsdShapeOver; 
        score += tsd.holeCount * w.tsdHolePenalty; 
    }
    return score;
}

struct PlacementMeta {
    int rot, x, y, spawnY;
    int linesCleared;
    bool isFullyGrounded;
    int touchingCount;
    GridBlock blocks[4];
    bool isTSpin = false;
    uint8_t path[64]; 
    int pathLength = 0;
};

using Placement = PlacementMeta;

const int KICK_I_CW[4][5][2] = {
    {{0,0}, {-2,0}, {1,0}, {-2,1}, {1,-2}}, 
    {{0,0}, {-1,0}, {2,0}, {-1,-2}, {2,1}}, 
    {{0,0}, {2,0}, {-1,0}, {2,-1}, {-1,2}}, 
    {{0,0}, {1,0}, {-2,0}, {1,2}, {-2,-1}}  
};
const int KICK_I_CCW[4][5][2] = {
    {{0,0}, {-1,0}, {2,0}, {-1,-2}, {2,1}}, 
    {{0,0}, {-2,0}, {1,0}, {-2,1}, {1,-2}}, 
    {{0,0}, {1,0}, {-2,0}, {1,2}, {-2,-1}}, 
    {{0,0}, {2,0}, {-1,0}, {2,-1}, {-1,2}}  
};
const int KICK_OTHER_CW[4][5][2] = {
    {{0,0}, {-1,0}, {-1,-1}, {0,2}, {-1,2}}, 
    {{0,0}, {1,0}, {1,1}, {0,-2}, {1,-2}},   
    {{0,0}, {1,0}, {1,-1}, {0,2}, {1,2}},    
    {{0,0}, {-1,0}, {-1,1}, {0,-2}, {-1,-2}} 
};
const int KICK_OTHER_CCW[4][5][2] = {
    {{0,0}, {1,0}, {1,-1}, {0,2}, {1,2}},    
    {{0,0}, {-1,0}, {-1,1}, {0,-2}, {-1,-2}},
    {{0,0}, {-1,0}, {-1,-1}, {0,2}, {-1,2}}, 
    {{0,0}, {1,0}, {1,1}, {0,-2}, {1,-2}}    
};

struct BFSState {
    int x, y, rot;
    bool lastActionWasRotation;
    bool lastRotUsedPoint5;
};

struct ParentInfo {
    int8_t x, y, rot, action;
};

// ★変更点: 動的アロケーションを避けるため、Boardの返却をやめる。
// Boardは呼び出し元で p.blocks から再構築する。
std::vector<Placement> getAllPlacements(const Board& baseBoard, int pieceType, int spawnY) {
    std::vector<Placement> placements;
    placements.reserve(64); // vectorの再アロケーションを防ぐ
    
    // staticによるスタック消費抑制
    static bool visited[4][30][19];
    static bool placementFound[4][30][19];
    static ParentInfo parent[4][30][19]; 
    
    std::memset(visited, 0, sizeof(visited));
    std::memset(placementFound, 0, sizeof(placementFound));
    
    for(int r=0; r<4; r++) 
        for(int y=0; y<30; y++) 
            for(int x=0; x<19; x++) 
                parent[r][y][x].x = -100; 
    
    int spawnX = COLS / 2 - 2; 
    int initialRot = 0;
    
    GridBlock startBlocks[4];
    getRotatedBlocks(pieceType, initialRot, spawnX, spawnY, startBlocks);
    if (!isValidPlacement(baseBoard, startBlocks)) {
        spawnY -= 1; 
        getRotatedBlocks(pieceType, initialRot, spawnX, spawnY, startBlocks);
        if (!isValidPlacement(baseBoard, startBlocks)) return placements; 
    }
    
    // ★変更点: std::queue のヒープ動的確保を廃止し、静的なリングバッファに変更
    static BFSState bfsQueue[3000]; 
    int qHead = 0, qTail = 0;
    
    bfsQueue[qTail++] = {spawnX, spawnY, initialRot, false, false};
    if (spawnY + 5 >= 0 && spawnY + 5 < 30 && spawnX + 4 >= 0 && spawnX + 4 < 19) {
        visited[initialRot][spawnY + 5][spawnX + 4] = true;
    }

    while(qHead < qTail) {
        BFSState curr = bfsQueue[qHead++];
        
        GridBlock blocks_down[4];
        getRotatedBlocks(pieceType, curr.rot, curr.x, curr.y + 1, blocks_down);
        bool canMoveDown = isValidPlacement(baseBoard, blocks_down);
        
        if (!canMoveDown) {
            if (curr.y + 5 >= 0 && curr.y + 5 < 30 && curr.x + 4 >= 0 && curr.x + 4 < 19) {
                if (!placementFound[curr.rot][curr.y + 5][curr.x + 4]) {
                    placementFound[curr.rot][curr.y + 5][curr.x + 4] = true;
                    
                    GridBlock droppedBlocks[4];
                    getRotatedBlocks(pieceType, curr.rot, curr.x, curr.y, droppedBlocks);
                    
                    // ここでのみ一時的に評価用のBoardを作るが、vectorには追加しない
                    Board simBoard = baseBoard;
                    for(int i=0; i<4; i++) {
                        const auto& blk = droppedBlocks[i];
                        if(blk.y >= 0 && blk.y < ROWS && blk.x >= 0 && blk.x < COLS) {
                            simBoard.cells[blk.y][blk.x] = 1;
                        }
                    }
                    PlacementInfo info = calcPlacementInfo(baseBoard, droppedBlocks);
                    int cleared = simBoard.checkLineAndClear();
                    
                    bool isTSpin = false;
                    if (pieceType == 2 && curr.lastActionWasRotation) {
                        float cx = curr.x + MINO_TEMPLATES[pieceType].pivotX - 0.5f;
                        float cy = curr.y + MINO_TEMPLATES[pieceType].pivotY - 0.5f;
                        int px = std::round(cx), py = std::round(cy);
                        
                        int corners[4][2] = {{px-1, py-1}, {px+1, py-1}, {px-1, py+1}, {px+1, py+1}};
                        bool occupied[4];
                        for(int i=0; i<4; i++) occupied[i] = (corners[i][0] < 0 || corners[i][0] >= COLS || corners[i][1] < 0 || corners[i][1] >= ROWS || baseBoard.has(corners[i][0], corners[i][1]));
                        
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
                        
                        if (curr.lastRotUsedPoint5) isTSpin = true;
                        else if (abFilled == 2 && cdFilled >= 1) isTSpin = true;
                        else if (cdFilled == 2 && abFilled >= 1) isTSpin = true;
                    }
                    
                    uint8_t path[64];
                    int pathLen = 0;
                    int traceX = curr.x, traceY = curr.y, traceRot = curr.rot;
                    while(true) {
                        if (traceY + 5 < 0 || traceY + 5 >= 30 || traceX + 4 < 0 || traceX + 4 >= 19) break;
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
                    p.isTSpin = isTSpin;
                    for(int i=0; i<pathLen; i++) p.path[i] = path[i];
                    p.pathLength = pathLen;
                    
                    placements.push_back(p);
                }
            }
        }
        
        auto tryPush = [&](int nx, int ny, int nrot, bool isRot, bool isPoint5, int action) {
            if (ny + 5 >= 0 && ny + 5 < 30 && nx + 4 >= 0 && nx + 4 < 19) {
                if (!visited[nrot][ny + 5][nx + 4]) {
                    visited[nrot][ny + 5][nx + 4] = true;
                    parent[nrot][ny + 5][nx + 4] = { (int8_t)curr.x, (int8_t)curr.y, (int8_t)curr.rot, (int8_t)action };
                    // キューに追加
                    bfsQueue[qTail++] = {nx, ny, nrot, isRot, isPoint5};
                }
            }
        };

        if (canMoveDown) tryPush(curr.x, curr.y + 1, curr.rot, false, false, 3);
        
        GridBlock blocks_left[4];
        getRotatedBlocks(pieceType, curr.rot, curr.x - 1, curr.y, blocks_left);
        if (isValidPlacement(baseBoard, blocks_left)) tryPush(curr.x - 1, curr.y, curr.rot, false, false, 1);
        
        GridBlock blocks_right[4];
        getRotatedBlocks(pieceType, curr.rot, curr.x + 1, curr.y, blocks_right);
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
                getRotatedBlocks(pieceType, toRot, curr.x + kx, curr.y + ky, blocks_rot);
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

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) { free(ptr); }

struct SearchState {
    int action; int path_index; int p1_score; int total_score; Board board;
    Placement p1; bool has_p1 = false; int step1_score = 0;
    Placement p2; bool has_p2 = false; int step2_score = 0;
    Placement p3; bool has_p3 = false; int step3_score = 0;
    Placement p4; bool has_p4 = false; int step4_score = 0;
};

EMSCRIPTEN_KEEPALIVE
void searchBestMoveWasm(
    uint8_t* boardData, int currentType, int holdType, int next1, int next2, int next3, int canHold,
    int* weightsArray, int* outResult
){
    for(int i = 0; i < 33; i++) outResult[i] = -1;
    for(int i = 26; i < 33; i++) outResult[i] = 0; 

    Board baseBoard;
    for(int i = 0; i < 200; i++) baseBoard.cells[i / 10][i % 10] = boardData[i];

    EvalWeights w = {
        weightsArray[0], weightsArray[1], weightsArray[2], weightsArray[3], weightsArray[4],
        weightsArray[5], weightsArray[6], weightsArray[7], weightsArray[8], weightsArray[9],
        weightsArray[10], weightsArray[11], weightsArray[12], weightsArray[13], weightsArray[14], 
        weightsArray[15], weightsArray[16], weightsArray[17], weightsArray[18], weightsArray[19], 
        weightsArray[20], weightsArray[21], weightsArray[22], weightsArray[23]
    };

    int baseScore = evaluateBoard(baseBoard, 0, false, 0, w);
    
    int A = currentType; int B = holdType; int C = next1; int D = next2; int E = next3;
    struct Path { int action; int p1; int p2; int p3; int p4; };
    std::vector<Path> paths;

    paths.push_back({0, A, C, D, E});
    if(canHold == 1) {
        if(B != -1) paths.push_back({1, B, A, C, D});
        else paths.push_back({1, C, A, D, E});
    }

    auto getSpawnY = [](int type) { return type == 0 ? -1 : -2; };
    auto calcEventBonus = [&](const Placement& p, int depth) {
        int bonus = 0; int multiplier = 5 - depth; 
        if (p.linesCleared >= 4) bonus += w.line4 * multiplier;
        if (p.isTSpin) {
            if (p.linesCleared == 0 || p.linesCleared == 1) bonus += w.tssClear * multiplier; 
            else if (p.linesCleared >= 2) bonus += w.tsdClear * multiplier; 
        }
        return bonus;
    };

    std::vector<SearchState> final_states;
    std::vector<SearchState> current_states;
    std::vector<SearchState> next_states;
    
    const size_t BEAM_WIDTH = 8;
    const int P1_WEIGHT_PCT = w.p1Weight; 

    // ★重要: ヒープの再割り当てによる断片化と枯渇を防ぐため容量を予約
    final_states.reserve(128);
    current_states.reserve(BEAM_WIDTH);
    next_states.reserve(1024);

    for(size_t i = 0; i < paths.size(); i++) {
        const auto& path = paths[i];
        std::vector<Placement> p1_list = getAllPlacements(baseBoard, path.p1, getSpawnY(path.p1));
        for(size_t j = 0; j < p1_list.size(); j++) {
            const auto& p1 = p1_list[j];
            
            Board simBoard = baseBoard;
            for(int k=0; k<4; k++) {
                if(p1.blocks[k].y >= 0 && p1.blocks[k].y < ROWS && p1.blocks[k].x >= 0 && p1.blocks[k].x < COLS) {
                    simBoard.cells[p1.blocks[k].y][p1.blocks[k].x] = 1;
                }
            }
            simBoard.checkLineAndClear();

            int score1 = evaluateBoard(simBoard, p1.linesCleared, p1.isFullyGrounded, p1.touchingCount, w, p1.blocks);
            int eventBonus = calcEventBonus(p1, 1);
            int totalScore = score1 * P1_WEIGHT_PCT / 100 + eventBonus;

            SearchState s;
            s.action = path.action; s.path_index = i;
            s.p1_score = score1; s.total_score = totalScore;
            s.board = simBoard; s.p1 = p1; s.has_p1 = true;
            s.step1_score = totalScore;
            next_states.push_back(s);
        }
    }

    if(next_states.size() > BEAM_WIDTH) {
        std::partial_sort(next_states.begin(), next_states.begin() + BEAM_WIDTH, next_states.end(), 
            [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
        next_states.resize(BEAM_WIDTH);
    }
    current_states = next_states;

    next_states.clear();
    for(const auto& state : current_states) {
        int p2_type = paths[state.path_index].p2;
        std::vector<Placement> p2_list = getAllPlacements(state.board, p2_type, getSpawnY(p2_type));
        if(p2_list.empty()) { final_states.push_back(state); continue; }
        for(size_t j = 0; j < p2_list.size(); j++) {
            const auto& p2 = p2_list[j];
            
            Board simBoard = state.board;
            for(int k=0; k<4; k++) {
                if(p2.blocks[k].y >= 0 && p2.blocks[k].y < ROWS && p2.blocks[k].x >= 0 && p2.blocks[k].x < COLS) {
                    simBoard.cells[p2.blocks[k].y][p2.blocks[k].x] = 1;
                }
            }
            simBoard.checkLineAndClear();

            int score2 = evaluateBoard(simBoard, p2.linesCleared, p2.isFullyGrounded, p2.touchingCount, w, p2.blocks);
            int stepScore = score2 + calcEventBonus(p2, 2);
            SearchState s = state;
            s.total_score += stepScore; s.board = simBoard; s.p2 = p2; s.has_p2 = true;
            s.step2_score = stepScore;
            next_states.push_back(s);
        }
    }

    if(next_states.size() > BEAM_WIDTH) {
        std::partial_sort(next_states.begin(), next_states.begin() + BEAM_WIDTH, next_states.end(), 
            [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
        next_states.resize(BEAM_WIDTH);
    }
    current_states = next_states;

    next_states.clear();
    for(const auto& state : current_states) {
        int p3_type = paths[state.path_index].p3;
        std::vector<Placement> p3_list = getAllPlacements(state.board, p3_type, getSpawnY(p3_type));
        if(p3_list.empty()) { final_states.push_back(state); continue; }
        for(size_t j = 0; j < p3_list.size(); j++) {
            const auto& p3 = p3_list[j];
            
            Board simBoard = state.board;
            for(int k=0; k<4; k++) {
                if(p3.blocks[k].y >= 0 && p3.blocks[k].y < ROWS && p3.blocks[k].x >= 0 && p3.blocks[k].x < COLS) {
                    simBoard.cells[p3.blocks[k].y][p3.blocks[k].x] = 1;
                }
            }
            simBoard.checkLineAndClear();

            int score3 = evaluateBoard(simBoard, p3.linesCleared, p3.isFullyGrounded, p3.touchingCount, w, p3.blocks);
            int stepScore = score3 + calcEventBonus(p3, 3);
            SearchState s = state;
            s.total_score += stepScore; s.board = simBoard; s.p3 = p3; s.has_p3 = true;
            s.step3_score = stepScore;
            next_states.push_back(s);
        }
    }

    if(next_states.size() > BEAM_WIDTH) {
        std::partial_sort(next_states.begin(), next_states.begin() + BEAM_WIDTH, next_states.end(), 
            [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
        next_states.resize(BEAM_WIDTH);
    }
    current_states = next_states;

    next_states.clear();
    for(const auto& state : current_states) {
        int p4_type = paths[state.path_index].p4;
        std::vector<Placement> p4_list = getAllPlacements(state.board, p4_type, getSpawnY(p4_type));
        if(p4_list.empty()) { final_states.push_back(state); continue; }
        for(size_t j = 0; j < p4_list.size(); j++) {
            const auto& p4 = p4_list[j];
            
            Board simBoard = state.board;
            for(int k=0; k<4; k++) {
                if(p4.blocks[k].y >= 0 && p4.blocks[k].y < ROWS && p4.blocks[k].x >= 0 && p4.blocks[k].x < COLS) {
                    simBoard.cells[p4.blocks[k].y][p4.blocks[k].x] = 1;
                }
            }
            simBoard.checkLineAndClear();

            int score4 = evaluateBoard(simBoard, p4.linesCleared, p4.isFullyGrounded, p4.touchingCount, w, p4.blocks);
            int stepScore = score4 + calcEventBonus(p4, 4);
            SearchState s = state;
            s.total_score += stepScore; s.board = simBoard; s.p4 = p4; s.has_p4 = true;
            s.step4_score = stepScore;
            next_states.push_back(s);
        }
    }

    if(next_states.size() > BEAM_WIDTH) {
        std::partial_sort(next_states.begin(), next_states.begin() + BEAM_WIDTH, next_states.end(), 
            [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
        next_states.resize(BEAM_WIDTH);
    }

    for(const auto& state : next_states) final_states.push_back(state);

    int bestTotalScore = -10000000;
    const SearchState* bestState = nullptr;

    for(const auto& state : final_states) {
        if(state.total_score > bestTotalScore) {
            bestTotalScore = state.total_score;
            bestState = &state;
        }
    }

    if(bestState) {
        const auto& path = paths[bestState->path_index];
        outResult[0] = bestState->action; 
        outResult[1] = bestState->p1_score; 
        outResult[2] = bestState->p1_score - baseScore; 

        outResult[3] = path.p1; outResult[4] = bestState->p1.rot; outResult[5] = bestState->p1.x; outResult[6] = bestState->p1.y; outResult[7] = bestState->p1.spawnY;
        outResult[12] = bestState->p1.isTSpin ? 1 : 0;
        
        if(bestState->has_p2) { outResult[8] = path.p2; outResult[9] = bestState->p2.rot; outResult[10] = bestState->p2.x; outResult[11] = bestState->p2.y; }
        if(bestState->has_p3) { outResult[13] = path.p3; outResult[14] = bestState->p3.rot; outResult[15] = bestState->p3.x; outResult[16] = bestState->p3.y; }
        if(bestState->has_p4) { outResult[17] = path.p4; outResult[18] = bestState->p4.rot; outResult[19] = bestState->p4.x; outResult[20] = bestState->p4.y; }

        outResult[21] = bestState->total_score;
        outResult[22] = bestState->step1_score;
        outResult[23] = bestState->has_p2 ? bestState->step2_score : 0;
        outResult[24] = bestState->has_p3 ? bestState->step3_score : 0;
        outResult[25] = bestState->has_p4 ? bestState->step4_score : 0;
        
        int finalPath[64];
        int finalPathLen = 0;
        
        if (bestState->action == 1) {
            finalPath[finalPathLen++] = 7; 
        }
        for (int i = 0; i < bestState->p1.pathLength && finalPathLen < 64; i++) {
            finalPath[finalPathLen++] = bestState->p1.path[i];
        }
        
        for (int i = 0; i < finalPathLen; i++) {
            int idx = i / 10;
            int shift = (i % 10) * 3;
            outResult[26 + idx] |= (finalPath[i] & 0x7) << shift;
        }
    }
}
}