#include <emscripten.h>
#include <stdint.h>
#include <vector>
#include <algorithm>
#include <cmath>
#include <cstdlib>

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

// JS側から受け取るパラメータ構造体
struct EvalWeights {
    int lineClear, hole, heightLimit, heightDiff, flat;
    int step1Good, step1Bad, step2Plus, groundedBonus, touchingBonus;
    int iWell, iWellOver, blocksOverHole; 
    int line4, downstackGood, downstackBad;
    int p1Weight; // ★追加：1手目の重み
};

int evaluateBoard(const Board& b, int linesCleared, bool isGrounded, int touchingCount, const EvalWeights& w, const std::vector<GridBlock>& droppedBlocks = {}) {
    int score = 0;

    // ★修正: ライン消去が発生した時のみ、ペナルティ/ボーナスを計算する
    if (linesCleared > 0) {
        score += (linesCleared - 2) * w.lineClear;
    }
    
    if (linesCleared >= 4) {
        score += w.line4;
    }

    if (linesCleared >= 1 && linesCleared <= 3 && !droppedBlocks.empty()) {
        int minoBottomY = -1;
        for (const auto& blk : droppedBlocks) {
            if (blk.y > minoBottomY) {
                minoBottomY = blk.y;
            }
        }
        
        int n = 19 - minoBottomY;
        if (n < 0) n = 0;

        if (n >= 5 && isGrounded) {
            score += w.downstackGood * n; 
        } else if (n >= 5 && !isGrounded) {
            // score += 0;
        } else if (n < 5) {
            score += w.downstackBad * 10 * n; 
        }
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

    return score;
}

struct Placement {
    int rot, x, y, spawnY;
    Board board;
    int linesCleared;
    bool isFullyGrounded;
    int touchingCount;
    std::vector<GridBlock> blocks;
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

EMSCRIPTEN_KEEPALIVE
void searchBestMoveWasm(
    uint8_t* boardData, int currentType, int holdType, int next1, int next2, int canHold,
    int* weightsArray, 
    int* outResult
){
    Board baseBoard;
    for(int i = 0; i < 200; i++) baseBoard.cells[i / 10][i % 10] = boardData[i];

    // JSから受け取った配列を構造体にマッピング（17要素に拡張）
    EvalWeights w = {
        weightsArray[0], weightsArray[1], weightsArray[2], weightsArray[3], weightsArray[4],
        weightsArray[5], weightsArray[6], weightsArray[7], weightsArray[8], weightsArray[9],
        weightsArray[10], weightsArray[11], weightsArray[12], 
        weightsArray[13], weightsArray[14], weightsArray[15],
        weightsArray[16] // ★追加：p1Weight
    };

    int baseScore = evaluateBoard(baseBoard, 0, false, 0, w);
    
    int A = currentType; int B = holdType; int C = next1; int D = next2;
    struct Path { int action; int p1; int p2; };
    std::vector<Path> paths;
    paths.push_back({0, A, C});
    paths.push_back({0, A, B != -1 ? B : D});

    if(canHold == 1) {
        int firstPieceToPlay = (B != -1) ? B : C;
        int nextPiece = (B != -1) ? C : D;
        paths.push_back({1, firstPieceToPlay, nextPiece});
        paths.push_back({1, firstPieceToPlay, A});
    }

    auto getSpawnY = [](int type) { return type == 0 ? -1 : -2; };

    struct EvaluatedP1 {
        Path path;
        Placement p1;
        int score1;
    };
    std::vector<EvaluatedP1> all_p1_evals;
    int globalMaxScore1 = -1000000;

    for(const auto& path : paths) {
        std::vector<Placement> p1_list = getAllPlacements(baseBoard, path.p1, getSpawnY(path.p1));
        for(const auto& p1 : p1_list) {
            int score1 = evaluateBoard(p1.board, p1.linesCleared, p1.isFullyGrounded, p1.touchingCount, w, p1.blocks);
            all_p1_evals.push_back({path, p1, score1});
            if(score1 > globalMaxScore1) {
                globalMaxScore1 = score1;
            }
        }
    }

    int bestTotalScore = -10000000;
    outResult[0] = -1;
    
    // ★JSから渡された重みを使用
    const int P1_WEIGHT = w.p1Weight; 

    for(const auto& ep1 : all_p1_evals) {
        
        if(ep1.score1 < 0 && ep1.score1 < globalMaxScore1) {
            continue;
        }

        std::vector<Placement> p2_list = getAllPlacements(ep1.p1.board, ep1.path.p2, getSpawnY(ep1.path.p2));
        
        if(p2_list.empty()) {
            int totalScore = ep1.score1 * P1_WEIGHT - 10000;
            if(totalScore > bestTotalScore) {
                bestTotalScore = totalScore;
                outResult[0] = ep1.path.action; 
                outResult[1] = ep1.score1;             
                outResult[2] = ep1.score1 - baseScore; 
                outResult[3] = ep1.path.p1; outResult[4] = ep1.p1.rot; outResult[5] = ep1.p1.x; outResult[6] = ep1.p1.y; outResult[7] = ep1.p1.spawnY;
                outResult[8] = -1;
            }
            continue;
        }

        for(const auto& p2 : p2_list) {
            int score2 = evaluateBoard(p2.board, p2.linesCleared, p2.isFullyGrounded, p2.touchingCount, w, p2.blocks);
            
            // 1手目の評価に重みをかけて総合スコアを算出
            int totalScore = ep1.score1 * P1_WEIGHT + score2;
            
            if(totalScore > bestTotalScore) {
                bestTotalScore = totalScore;
                outResult[0] = ep1.path.action; 
                outResult[1] = ep1.score1;             
                outResult[2] = ep1.score1 - baseScore; 
                outResult[3] = ep1.path.p1; outResult[4] = ep1.p1.rot; outResult[5] = ep1.p1.x; outResult[6] = ep1.p1.y; outResult[7] = ep1.p1.spawnY;
                outResult[8] = ep1.path.p2; outResult[9] = p2.rot; outResult[10] = p2.x; outResult[11] = p2.y;
            }
        }
    }
}
}