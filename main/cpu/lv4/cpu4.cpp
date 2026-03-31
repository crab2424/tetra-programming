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

std::vector<Placement> getAllPlacements(const Board& baseBoard, int pieceType, int spawnY) {
    std::vector<Placement> placements;
    placements.reserve(64); 
    
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
    int first_action; // 1手目の行動(0: Play, 1: Hold)
    int hold_mino;    // 現在のホールドに入っているミノの種類
    int next_idx;     // 次に消費するNEXTキューのインデックス

    int p1_score; 
    int total_score; 
    Board board;

    bool has_p[6];      // 各ステップでミノを置いたか
    Placement p[6];     // 各ステップの配置
    int step_score[6];  // 各ステップのスコア
    int p_id[6];        // 実際にそのステップで配置されたミノのID

    SearchState() {
        first_action = -1;
        hold_mino = -1;
        next_idx = 0;
        p1_score = 0;
        total_score = 0;
        for(int i = 0; i < 6; ++i) { 
            has_p[i] = false; 
            step_score[i] = 0; 
            p_id[i] = -1; 
        }
    }
};

EMSCRIPTEN_KEEPALIVE
void searchBestMoveWasm(
    uint8_t* boardData, int currentType, int holdType, int next1, int next2, int next3, int next4, int next5, int canHold,
    int* weightsArray, int* outResult
){
    for(int i = 0; i < 43; i++) outResult[i] = -1;
    for(int i = 36; i < 43; i++) outResult[i] = 0; 

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
    
    int next_queue[7] = { currentType, next1, next2, next3, next4, next5, 0 };

    auto getSpawnY = [](int type) { return type == 0 ? -1 : -2; };
    auto calcEventBonus = [&](const Placement& p, int step_num) {
        int bonus = 0; int multiplier = 7 - step_num; 
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

    final_states.reserve(128);
    current_states.reserve(BEAM_WIDTH);
    next_states.reserve(1024);

    auto expandState = [&](const SearchState& s, int piece, int new_hold, int new_next_idx, int step_num, bool is_first, int first_action) -> int {
        std::vector<Placement> p_list = getAllPlacements(is_first ? baseBoard : s.board, piece, getSpawnY(piece));
        
        // ★ 条件1: Block Out（出現位置にミノが重なっており置けない）
        if (p_list.empty()) {
            SearchState dead_s = s;
            dead_s.total_score -= 1000000; // ゲームオーバー手への特大ペナルティ
            if (is_first) dead_s.first_action = first_action;
            
            // これ以上探索を進められないため、最終状態として保存して枝刈り
            final_states.push_back(dead_s);
            return 0; 
        }

        int pushed_count = 0;
        for(size_t j = 0; j < p_list.size(); j++) {
            const auto& p = p_list[j];
            
            // ★ 条件2: Lock Out（固定された全ブロックが y < 0 である）
            bool isAllOutside = true;
            for(int k=0; k<4; k++) {
                if(p.blocks[k].y >= 0) {
                    isAllOutside = false;
                    break;
                }
            }

            Board simBoard = is_first ? baseBoard : s.board;
            for(int k=0; k<4; k++) {
                if(p.blocks[k].y >= 0 && p.blocks[k].y < ROWS && p.blocks[k].x >= 0 && p.blocks[k].x < COLS) {
                    simBoard.cells[p.blocks[k].y][p.blocks[k].x] = 1;
                }
            }
            simBoard.checkLineAndClear();

            int score = evaluateBoard(simBoard, p.linesCleared, p.isFullyGrounded, p.touchingCount, w, p.blocks);
            int eventBonus = calcEventBonus(p, step_num);
            int stepScore = is_first ? (score * P1_WEIGHT_PCT / 100 + eventBonus) : (score + eventBonus);

            // Lock Out なら特大ペナルティを与える
            if (isAllOutside) {
                stepScore -= 1000000;
            }

            SearchState next_s = s;
            next_s.hold_mino = new_hold;
            next_s.next_idx = new_next_idx;
            if (is_first) {
                next_s.first_action = first_action;
                next_s.p1_score = score;
            }
            next_s.total_score += stepScore;
            next_s.board = simBoard;
            next_s.p[step_num - 1] = p;
            next_s.has_p[step_num - 1] = true;
            next_s.step_score[step_num - 1] = stepScore;
            next_s.p_id[step_num - 1] = piece; 

            // Lock Out になった手も、これ以上は探索しないため最終状態に退避
            if (isAllOutside) {
                final_states.push_back(next_s);
            } else {
                next_states.push_back(next_s);
                pushed_count++;
            }
        }
        return pushed_count;
    };

    // ────────────────────────────
    // 1手目 (Step 1)
    // ────────────────────────────
    SearchState initial_state;
    
    expandState(initial_state, next_queue[0], holdType, 1, 1, true, 0);

    if(canHold == 1) {
        int piece;
        int new_hold = next_queue[0]; 
        int new_next_idx;
        if(holdType != -1) {
            piece = holdType; 
            new_next_idx = 1; 
        } else {
            piece = next_queue[1]; 
            new_next_idx = 2; 
        }
        expandState(initial_state, piece, new_hold, new_next_idx, 1, true, 1);
    }

    if(next_states.size() > BEAM_WIDTH) {
        std::partial_sort(next_states.begin(), next_states.begin() + BEAM_WIDTH, next_states.end(), 
            [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
        next_states.resize(BEAM_WIDTH);
    }
    current_states = next_states;

    // ────────────────────────────
    // 2手目 〜 6手目 (Step 2 to 6)
    // ────────────────────────────
    for (int depth = 1; depth < 6; depth++) {
        int step_num = depth + 1;
        next_states.clear();

        for (const auto& state : current_states) {
            int cur_mino = state.next_idx < 6 ? next_queue[state.next_idx] : 0;
            
            expandState(state, cur_mino, state.hold_mino, state.next_idx + 1, step_num, false, -1);
            
            if (state.hold_mino != -1 && state.hold_mino != cur_mino) {
                expandState(state, state.hold_mino, cur_mino, state.next_idx + 1, step_num, false, -1);
            }
        }

        if (next_states.empty()) break; 

        if(next_states.size() > BEAM_WIDTH) {
            std::partial_sort(next_states.begin(), next_states.begin() + BEAM_WIDTH, next_states.end(), 
                [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
            next_states.resize(BEAM_WIDTH);
        }
        current_states = next_states;
    }

    // 最後まで到達した安全な状態を final_states に統合
    for (const auto& state : current_states) {
        final_states.push_back(state);
    }

    // ────────────────────────────
    // 最適解の決定と出力
    // ────────────────────────────
    // ペナルティ付き（-1,000,000等）も比較対象として残るため初期値を極小に設定
    int bestTotalScore = -100000000;
    const SearchState* bestState = nullptr;

    for(const auto& state : final_states) {
        if(state.total_score > bestTotalScore) {
            bestTotalScore = state.total_score;
            bestState = &state;
        }
    }

    if(bestState) {
        outResult[0] = bestState->first_action; 
        outResult[1] = bestState->p1_score; 
        outResult[2] = bestState->p1_score - baseScore; 

        outResult[3] = bestState->p_id[0]; outResult[4] = bestState->p[0].rot; outResult[5] = bestState->p[0].x; outResult[6] = bestState->p[0].y; outResult[7] = bestState->p[0].spawnY;
        outResult[12] = bestState->p[0].isTSpin ? 1 : 0;
        
        if(bestState->has_p[1]) { outResult[8] = bestState->p_id[1]; outResult[9] = bestState->p[1].rot; outResult[10] = bestState->p[1].x; outResult[11] = bestState->p[1].y; }
        if(bestState->has_p[2]) { outResult[13] = bestState->p_id[2]; outResult[14] = bestState->p[2].rot; outResult[15] = bestState->p[2].x; outResult[16] = bestState->p[2].y; }
        if(bestState->has_p[3]) { outResult[17] = bestState->p_id[3]; outResult[18] = bestState->p[3].rot; outResult[19] = bestState->p[3].x; outResult[20] = bestState->p[3].y; }
        if(bestState->has_p[4]) { outResult[21] = bestState->p_id[4]; outResult[22] = bestState->p[4].rot; outResult[23] = bestState->p[4].x; outResult[24] = bestState->p[4].y; }
        if(bestState->has_p[5]) { outResult[25] = bestState->p_id[5]; outResult[26] = bestState->p[5].rot; outResult[27] = bestState->p[5].x; outResult[28] = bestState->p[5].y; }

        outResult[29] = bestState->total_score;
        outResult[30] = bestState->step_score[0];
        outResult[31] = bestState->has_p[1] ? bestState->step_score[1] : 0;
        outResult[32] = bestState->has_p[2] ? bestState->step_score[2] : 0;
        outResult[33] = bestState->has_p[3] ? bestState->step_score[3] : 0;
        outResult[34] = bestState->has_p[4] ? bestState->step_score[4] : 0;
        outResult[35] = bestState->has_p[5] ? bestState->step_score[5] : 0;
        
        int finalPath[64];
        int finalPathLen = 0;
        
        if (bestState->first_action == 1) {
            finalPath[finalPathLen++] = 7; 
        }
        // p_list.empty()で初手死した場合は p[0].pathLength が 0 なので安全
        for (int i = 0; i < bestState->p[0].pathLength && finalPathLen < 64; i++) {
            finalPath[finalPathLen++] = bestState->p[0].path[i];
        }
        
        for (int i = 0; i < finalPathLen; i++) {
            int idx = i / 10;
            int shift = (i % 10) * 3;
            outResult[36 + idx] |= (finalPath[i] & 0x7) << shift;
        }
    }
}
}