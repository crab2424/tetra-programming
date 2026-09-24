#include <emscripten.h>
#include <stdint.h>
#include <vector>
#include <algorithm>
#include <cmath>
#include <cstdlib>

const int COLS = 10;
// ★ v2.2.3 I: 20行(可視のみ) → 25行(隠し5行込み。内部 y = 実機 y + 5)。
//   旧20行モデルは可視外(実機 y<0)のブロックを盤面から落としていたため、はみ出して置いた
//   ブロックを忘れて「高く積むほど得」に見え、出現位置が塞がる死(Block Out)も読めなかった。
const int ROWS = 25;
const int HIDDEN_ROWS = 5;

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

std::vector<GridBlock> getRotatedBlocks(int type, int rot, int offsetX, int offsetY) {
    std::vector<GridBlock> result(4);
    MinoData tmpl = MINO_TEMPLATES[type];
    for(int i = 0; i < 4; i++) {
        float relX = tmpl.blocks[i].x - tmpl.pivotX;
        float relY = tmpl.blocks[i].y - tmpl.pivotY;
        float newX = relX, newY = relY;
        for(int r = 0; r < rot; r++) {
            float tempX = -newY; float tempY = newX;
            newX = tempX; newY = tempY;
        }
        result[i].x = std::round(newX + tmpl.pivotX) + offsetX;
        result[i].y = std::round(newY + tmpl.pivotY) + offsetY;
    }
    return result;
}

bool isValidPlacement(const Board& b, const std::vector<GridBlock>& blocks) {
    for(const auto& blk : blocks) {
        if(blk.x < 0 || blk.x >= COLS || blk.y >= ROWS || (blk.y >= 0 && b.has(blk.x, blk.y))) return false;
    }
    return true;
}

// ★ v2.2.3 I: 実機の出現判定（game/tet/board.js popMino: x=3・回転0で出現位置→1段上の順に試す）
bool canSpawnPiece(const Board& b, int pieceType) {
    int spawnY = (pieceType == 0) ? 4 : 3;
    for (int dy = 0; dy <= 1; dy++) {
        if (isValidPlacement(b, getRotatedBlocks(pieceType, 0, COLS / 2 - 2, spawnY - dy))) return true;
    }
    return false;
}
// ★ v2.2.3 I: 実機の Lock Out（固定したミノの4ブロック全てが可視外）
bool isLockOut(const std::vector<GridBlock>& blocks) {
    for (const auto& blk : blocks) if (blk.y >= HIDDEN_ROWS) return false;
    return true;
}
// 死亡ペナルティ: step は死ぬ手番（1〜5。5 は「4手目の後に次のミノが出せない」）。早い死ほど重く、
// どの死も生存より必ず悪い（評価値の累積は 1e7 未満）。
inline int deathPenalty(int step) { return 100000000 * (6 - step); }

struct PlacementInfo { bool isFullyGrounded; int touchingCount; };

PlacementInfo calcPlacementInfo(const Board& b, const std::vector<GridBlock>& blocks) {
    int bottomEdges[COLS];
    for(int i=0; i<COLS; i++) bottomEdges[i] = -100;
    for(const auto& blk : blocks) {
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
        for(const auto& blk : blocks) {
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
    int tsdShape;  
    int tsdShapeOver; 
    int tsdFillBonus; 
    int tssClear;       
    int tsdClear;  
    int tsdHolePenalty; 
    int pureHole; 
};

bool isTSDShape(const Board& board, int cx, int cy) {
    if (cx < 1 || cx >= COLS - 1 || cy < 0 || cy >= ROWS - 1) return false;
    
    if (board.cells[cy][cx] != 0 || 
        board.cells[cy][cx-1] != 0 || 
        board.cells[cy][cx+1] != 0 || 
        board.cells[cy+1][cx] != 0) {
        return false;
    }
    
    auto isSolid = [&](int x, int y) {
        if (x < 0 || x >= COLS || y >= ROWS) return true; // 壁や床はブロックとして扱う
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

    // ★追加: Tの穴3列(cx-1, cx, cx+1)のうち、屋根の列を含まない2列が、穴(cy)より上全て空いていること
    // これにより、上からTミノが進入できない閉じ込められた空間をTSDとして誤評価するのを防ぐ
    int clearCol1 = cx;
    int clearCol2 = leftRoof ? cx + 1 : cx - 1;
    for (int y = 0; y < cy; y++) {
        if (board.cells[y][clearCol1] != 0) return false;
        if (board.cells[y][clearCol2] != 0) return false;
    }

    // ★追加：地形が独立しないための土台条件 (緑 or 黄色の行が埋まっていること)
    
    // 条件1: 緑の行 (cy + 1) が cx 以外すべて埋まっているか
    bool greenFilled = true;
    for(int x = 0; x < COLS; x++) {
        if (x != cx && !isSolid(x, cy + 1)) {
            greenFilled = false;
            break;
        }
    }
    
    // 条件2: 黄色の行 (cy + 2) が cx 以外すべて埋まっているか
    bool yellowFilled = true;
    for(int x = 0; x < COLS; x++) {
        if (x != cx && !isSolid(x, cy + 2)) {
            yellowFilled = false;
            break;
        }
    }

    // どちらの条件も満たしていない場合は「孤立した空中の地形」とみなし、TSDとして評価しない
    if (!greenFilled && !yellowFilled) {
        return false;
    }

    return true;
}

struct TSDStats {
    int count;
    int fillCount; 
    int holeCount; 
};

TSDStats analyzeTSD(const Board& board) {
    TSDStats stats = {0, 0, 0};
    for (int cy = 1; cy < ROWS - 1; cy++) {
        for (int cx = 1; cx < COLS - 1; cx++) {
            if (isTSDShape(board, cx, cy)) {
                stats.count++;
                if (stats.count == 1) { 
                    for (int x = 0; x < COLS; x++) {
                        if (x != cx - 1 && x != cx && x != cx + 1) {
                            if (board.cells[cy][x] != 0) {
                                stats.fillCount++;
                            } else if (board.hasBlockAbove(x, cy)) {
                                stats.holeCount++; 
                            }
                        }
                        if (x != cx) {
                            if (board.cells[cy + 1][x] != 0) {
                                stats.fillCount++;
                            } else if (board.hasBlockAbove(x, cy + 1)) {
                                stats.holeCount++; 
                            }
                        }
                    }
                }
            }
        }
    }
    return stats;
}

int evaluateBoard(const Board& b, int linesCleared, bool isGrounded, int touchingCount, const EvalWeights& w, const std::vector<GridBlock>& droppedBlocks = {}) {
    int score = 0;

    if (linesCleared > 0) score += (linesCleared - 2) * w.lineClear;
    if (linesCleared >= 4) score += w.line4;

    if (linesCleared >= 1 && linesCleared <= 3 && !droppedBlocks.empty()) {
        int minoBottomY = -1;
        for (const auto& blk : droppedBlocks) {
            if (blk.y > minoBottomY) minoBottomY = blk.y;
        }
        int n = (ROWS - 1) - minoBottomY;
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
        int continuousEmpty = 0;
        int maxContinuous = 0;
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
            if(b.cells[y][x] != 0) {
                firstBlockY = y;
                break;
            }
        }
        if (firstBlockY != -1) {
            int lowestHoleY = -1;
            for(int y = ROWS - 1; y > firstBlockY; y--) {
                if(b.cells[y][x] == 0) {
                    lowestHoleY = y;
                    break;
                }
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
    }else{
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

struct Placement {
    int rot, x, y, spawnY;
    Board board;
    int linesCleared;
    bool isFullyGrounded;
    int touchingCount;
    std::vector<GridBlock> blocks;
    bool isTSpin = false;
};

std::vector<Placement> getAllPlacements(const Board& baseBoard, int pieceType, int spawnY) {
    std::vector<Placement> placements;
    for(int rot = 0; rot < 4; rot++) {
        for(int x = -2; x < 12; x++) {
            std::vector<GridBlock> simBlocks = getRotatedBlocks(pieceType, rot, x, spawnY);
            if(!isValidPlacement(baseBoard, simBlocks)) continue;

            int ghostY = spawnY;
            while(true) {
                std::vector<GridBlock> testBlocks = getRotatedBlocks(pieceType, rot, x, ghostY + 1);
                if(isValidPlacement(baseBoard, testBlocks)) ghostY++;
                else break;
            }

            std::vector<GridBlock> droppedBlocks = getRotatedBlocks(pieceType, rot, x, ghostY);
            Board simBoard = baseBoard;
            for(const auto& blk : droppedBlocks) {
                if(blk.y >= 0) simBoard.cells[blk.y][blk.x] = 1;
            }
            PlacementInfo info = calcPlacementInfo(baseBoard, droppedBlocks);
            int cleared = simBoard.checkLineAndClear();
            
            placements.push_back({rot, x, ghostY, spawnY, simBoard, cleared, info.isFullyGrounded, info.touchingCount, droppedBlocks});
        }
    }

    if (pieceType == 2) { 
        for (int cy = 1; cy < ROWS - 1; cy++) {
            for (int cx = 1; cx < COLS - 1; cx++) {
                if (isTSDShape(baseBoard, cx, cy)) {
                    int rot = 2; 
                    int x = cx - 1;
                    int y = cy - 2;
                    int spawn = cy - 2;
                    
                    std::vector<GridBlock> droppedBlocks = getRotatedBlocks(pieceType, rot, x, y);
                    Board simBoard = baseBoard;
                    for(const auto& blk : droppedBlocks) {
                        if(blk.y >= 0 && blk.y < ROWS && blk.x >= 0 && blk.x < COLS) {
                            simBoard.cells[blk.y][blk.x] = 1;
                        }
                    }
                    
                    PlacementInfo info = calcPlacementInfo(baseBoard, droppedBlocks);
                    int cleared = simBoard.checkLineAndClear();
                    
                    Placement p; 
                    p.rot = rot; p.x = x; p.y = y; p.spawnY = spawn;
                    p.board = simBoard; p.linesCleared = cleared; 
                    p.isFullyGrounded = info.isFullyGrounded;
                    p.touchingCount = info.touchingCount;
                    p.blocks = droppedBlocks;
                    p.isTSpin = true; 
                    
                    placements.push_back(p);
                }
            }
        }
    }
    return placements;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) {
    return malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) {
    free(ptr);
}

struct SearchState {
    int action;
    int path_index;
    int p1_score;     
    int total_score;  
    Board board;
    
    Placement p1; bool has_p1 = false; int step1_score = 0;
    Placement p2; bool has_p2 = false; int step2_score = 0;
    Placement p3; bool has_p3 = false; int step3_score = 0;
    Placement p4; bool has_p4 = false; int step4_score = 0;
};

EMSCRIPTEN_KEEPALIVE
void searchBestMoveWasm(
    uint8_t* boardData, int currentType, int holdType, int next1, int next2, int next3, int canHold,
    int* weightsArray, 
    int* outResult
){
    for(int i = 0; i < 26; i++) outResult[i] = -1;

    Board baseBoard;
    for(int i = 0; i < 250; i++) baseBoard.cells[i / 10][i % 10] = boardData[i];

    EvalWeights w = {
        weightsArray[0], weightsArray[1], weightsArray[2], weightsArray[3], weightsArray[4],
        weightsArray[5], weightsArray[6], weightsArray[7], weightsArray[8], weightsArray[9],
        weightsArray[10], weightsArray[11], weightsArray[12], 
        weightsArray[13], weightsArray[14], weightsArray[15],
        weightsArray[16], weightsArray[17], weightsArray[18], weightsArray[19], weightsArray[20],
        weightsArray[21], weightsArray[22], weightsArray[23]
    };

    int baseScore = evaluateBoard(baseBoard, 0, false, 0, w);
    
    int A = currentType; int B = holdType; int C = next1; int D = next2; int E = next3;

    // s2〜s5: 各手番で「キューから出現する」ミノ（-1=不明）。HOLD で差し替えて置く場合も、出現できなければその時点で死亡。
    struct Path { int action; int p1; int p2; int p3; int p4; int s2 = -1; int s3 = -1; int s4 = -1; int s5 = -1; };
    std::vector<Path> paths;

    paths.push_back({0, A, C, D, E, C, D, E, -1});
    if(canHold == 1) {
        if(B != -1) {
            paths.push_back({1, B, A, C, D, C, D, E, -1});
            // ★ v2.2.3 I: HOLD 後に持ち替えず、キューのミノをそのまま置いていく経路も読む
            //   （旧来の経路は2手目以降も常に HOLD と入れ替える固定順だけで、それが詰む局面で
            //    「持ち替えなければ生き残れる」手を見落としていた）。
            paths.push_back({1, B, C, D, E, C, D, E, -1});
        }
        else paths.push_back({1, C, A, D, E, D, E, -1, -1});
    }

    auto getSpawnY = [](int type) { return type == 0 ? 4 : 3; }; // 内部座標（実機 -1 / -2）

    auto calcEventBonus = [&](const Placement& p, int depth) {
        int bonus = 0; 
        int multiplier = 5 - depth; 
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

    // ─── ★ v2.2.3 I: 致死を正しく扱う探索 ───
    //   旧実装は「次のミノが置けない枝」をペナルティ無しで final に入れていた。探索は各手の評価値
    //   (多くは負)を足していくので、死んで打ち切られた枝ほど合計が高くなり「死ぬほど得」になっていた。
    //   ・Lock Out（4ブロック全て可視外）はその手番で死亡
    //   ・次の手番で出現するミノが出せない（Block Out）ならその手番で死亡
    //   として deathPenalty を与えて final へ送り、ビーム枠には生存する枝だけを残す。
    auto spawnOf = [&](const Path& path, int step) {
        return step == 2 ? path.s2 : step == 3 ? path.s3 : step == 4 ? path.s4 : step == 5 ? path.s5 : -1;
    };
    auto pieceOf = [&](const Path& path, int step) {
        return step == 1 ? path.p1 : step == 2 ? path.p2 : step == 3 ? path.p3 : path.p4;
    };
    auto setStep = [&](SearchState& st, int step, const Placement& p, int stepScore) {
        switch (step) {
            case 1: st.p1 = p; st.has_p1 = true; st.step1_score = stepScore; break;
            case 2: st.p2 = p; st.has_p2 = true; st.step2_score = stepScore; break;
            case 3: st.p3 = p; st.has_p3 = true; st.step3_score = stepScore; break;
            default: st.p4 = p; st.has_p4 = true; st.step4_score = stepScore; break;
        }
    };

    // 1手ぶん展開する。base=nullptr なら初手（盤面は baseBoard）
    auto expand = [&](const SearchState* base, int pathIndex, int step) {
        const Path& path = paths[pathIndex];
        const Board& board = base ? base->board : baseBoard;
        int piece = pieceOf(path, step);
        // HOLD から出すミノ(初手の HOLD 経路)・キューから出るミノが出現できなければこの手番で死亡
        bool spawnBlocked = false;
        if (step == 1 && path.action == 1) spawnBlocked = !canSpawnPiece(board, path.p1); // HOLD から/キューから出るミノ
        std::vector<Placement> plist;
        if (!spawnBlocked) plist = getAllPlacements(board, piece, getSpawnY(piece));
        if (plist.empty()) {
            SearchState d;
            if (base) d = *base; else { d.action = path.action; d.path_index = pathIndex; d.p1_score = 0; d.total_score = 0; d.board = board; }
            d.total_score -= deathPenalty(step);
            if (step >= 2) final_states.push_back(d); // 初手で置けない枝は手を持たないので候補にしない
            return;
        }
        for (const auto& p : plist) {
            int sc = evaluateBoard(p.board, p.linesCleared, p.isFullyGrounded, p.touchingCount, w, p.blocks);
            int stepScore = (step == 1 ? sc * P1_WEIGHT_PCT / 100 : sc) + calcEventBonus(p, step);

            SearchState st;
            if (base) st = *base; else { st.action = path.action; st.path_index = pathIndex; st.p1_score = sc; st.total_score = 0; }
            st.total_score += stepScore;
            st.board = p.board;
            setStep(st, step, p, stepScore);

            if (isLockOut(p.blocks)) {                       // Lock Out: この手番で死亡
                st.total_score -= deathPenalty(step);
                final_states.push_back(st);
                continue;
            }
            int nextSpawn = spawnOf(path, step + 1);
            if (nextSpawn >= 0 && !canSpawnPiece(p.board, nextSpawn)) { // 次の手番で Block Out
                st.total_score -= deathPenalty(step + 1);
                final_states.push_back(st);
                continue;
            }
            next_states.push_back(st);
        }
    };

    auto trim = [&]() {
        if(next_states.size() > BEAM_WIDTH) {
            std::partial_sort(next_states.begin(), next_states.begin() + BEAM_WIDTH, next_states.end(), 
                [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
            next_states.resize(BEAM_WIDTH);
        }
        current_states = next_states;
        next_states.clear();
    };

    for (size_t i = 0; i < paths.size(); i++) expand(nullptr, (int)i, 1);
    trim();
    for (int step = 2; step <= 4; step++) {
        for (const auto& st : current_states) expand(&st, st.path_index, step);
        trim();
    }
    for(const auto& state : current_states) final_states.push_back(state);

    // ─── 最終結果選択 ───
    int bestTotalScore = -2000000000; // ★ v2.2.3 I: 全枝が死ぬ局面でも「最も遅く死ぬ手」を必ず返す
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
    }
}
}