#include <emscripten.h>
#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>

const int COLS = 10;
const int ROWS = 25; // ★変更：JS側のy=-5に対応するため画面を25行に拡張 (内部的には 0~24)

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

// ★最適化：BFS内での無駄な演算を省くため、全ミノの座標を起動時に事前計算してテーブル化
GridBlock PRECALC_MINO_BLOCKS[7][4][4];
bool isPrecalcDone = false;

void ensurePrecalc() {
    if (isPrecalcDone) return;
    for (int type = 0; type < 7; type++) {
        for (int rot = 0; rot < 4; rot++) {
            MinoData tmpl = MINO_TEMPLATES[type];
            for (int i = 0; i < 4; i++) {
                float relX = tmpl.blocks[i].x - tmpl.pivotX;
                float relY = tmpl.blocks[i].y - tmpl.pivotY;
                float newX = relX, newY = relY;
                for (int r = 0; r < rot; r++) {
                    float tempX = -newY; float tempY = newX;
                    newX = tempX; newY = tempY;
                }
                PRECALC_MINO_BLOCKS[type][rot][i].x = std::round(newX + tmpl.pivotX);
                PRECALC_MINO_BLOCKS[type][rot][i].y = std::round(newY + tmpl.pivotY);
            }
        }
    }
    isPrecalcDone = true;
}

// 旧：毎度計算していた関数（比較用としてコメントアウト残し）
/*
void getRotatedBlocks(int type, int rot, int offsetX, int offsetY, GridBlock outBlocks[4]) {
    MinoData tmpl = MINO_TEMPLATES[type];
    for(int i = 0; i < 4; i++) { ... }
}
*/

// ★最適化：Boardクラスをビットボード化（250バイト → 50バイトへ圧縮）
class Board {
public:
    // uint8_t cells[ROWS][COLS]; // 旧：多次元配列
    uint16_t rows[ROWS];          // 新：各行をビット(10bit分)で管理

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

bool isValidPlacement(const Board& b, const GridBlock blocks[4]) {
    for(int i = 0; i < 4; i++) {
        const auto& blk = blocks[i];
        if(blk.x < 0 || blk.x >= COLS || blk.y >= ROWS || (blk.y >= 0 && ((b.rows[blk.y] >> blk.x) & 1))) return false;
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
            if (b.has(blk.x - 1, blk.y)) touchingCount++;
            if (b.has(blk.x + 1, blk.y)) touchingCount++;
            if (b.has(blk.x, blk.y + 1)) touchingCount++;
        }
    }
    return {isFullyGrounded, touchingCount};
}

// ★変更：slopeBonus, slopePenalty を追加
struct EvalWeights {
    int lineClear, hole, heightLimit, step3Plus, flat;
    int step1Good, step1Bad, step2, groundedBonus, touchingBonus;
    int iWell, iWellOver, blocksOverHole; 
    int line4, downstackGood, downstackBad;
    int p1Weight; 
    int tsdShape, tsdShapeOver, tsdFillBonus; 
    int tssClear, tsdClear, tsdHolePenalty, pureHole; 
    int comboBonus; 
    int btbKeep;    
    int renCutPenalty; 
    int tsmMiniPenalty;      
    int tMinoNoClearPenalty; 
    int tsdSetup;            
    int tsdSetupOver;        
    int slopeBonus;          // ★追加：ゆるやかな下り坂のボーナス
    int slopePenalty;        // ★追加：ゆるやかな下り坂を満たさないペナルティ
};

// ★最適化：引数に const int heights[COLS] = nullptr を追加
bool isTSDShape(const Board& board, int cx, int cy, const int heights[COLS] = nullptr) {
    if (cx < 1 || cx >= COLS - 1 || cy < 0 || cy >= ROWS - 1) return false;
    
    // ★最適化：盤面配列の直接参照をビット演算に置換
    if ((board.rows[cy] & (1<<cx)) || (board.rows[cy] & (1<<(cx-1))) || (board.rows[cy] & (1<<(cx+1))) || (board.rows[cy+1] & (1<<cx))) return false;
    
    auto isSolid = [&](int x, int y) {
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y < 0) return false;
        return (board.rows[y] & (1 << x)) != 0;
    }; 

    // ★最適化：TSDの地形が存在する高さのI-Wellチェックは、この関数の外（スキャン処理）で事前に1回だけ計算して除外するように変更
    /*
    for (int k = 0; k < COLS; k++) { ... }
    */

    if (!isSolid(cx - 1, cy + 1)) return false; // 左下の土台
    if (!isSolid(cx + 1, cy + 1)) return false; // 右下の土台
    if (!isSolid(cx - 2, cy + 1)) return false; 
    if (!isSolid(cx + 2, cy + 1)) return false; 
    
    bool leftRoof = (cy - 1 < 0) || (cx - 1 < 0) || (isSolid(cx-1, cy-1) && isSolid(cx-2, cy));
    bool rightRoof = (cy - 1 < 0) || (cx + 1 >= COLS) || (isSolid(cx+1, cy-1) && isSolid(cx+2, cy-1));
    if (!(leftRoof ^ rightRoof)) return false; 
    
    if (cy - 1 >= 0) {
        if (leftRoof) {
            if (isSolid(cx, cy-1) || (cx + 1 < COLS && isSolid(cx+1, cy-1))) return false;
        } else {
            if (isSolid(cx, cy-1) || (cx - 1 >= 0 && isSolid(cx-1, cy-1))) return false;
        }
    }

    int clearCol1 = cx;
    int clearCol2 = leftRoof ? cx + 1 : cx - 1;
    
    // ★最適化：heights配列が渡されている場合はループを回さずO(1)で計算
    if (heights != nullptr) {
        if (heights[clearCol1] > ROWS - cy) return false;
        if (heights[clearCol2] > ROWS - cy) return false;
    } else {
        for (int y = 0; y < cy; y++) {
            if (board.rows[y] & (1<<clearCol1)) return false;
            if (board.rows[y] & (1<<clearCol2)) return false;
        }
    }

    return true;
}

struct TSDStats { int count; int fillCount; int holeCount; };

// ★最適化：引数に outMaxHeight を追加（SearchStateへの引継ぎ用）
int evaluateBoard(const Board& b, int linesCleared, bool isGrounded, int touchingCount, const EvalWeights& w, int ren = 0, bool backToBack = false, const GridBlock* droppedBlocks = nullptr, int tSpinType = 0, int* outMaxHeight = nullptr) {
    int score = 0;
    if (linesCleared > 0) score += (linesCleared - 2) * w.lineClear;
    if (linesCleared >= 4) score += w.line4;

    if (linesCleared >= 1 && linesCleared <= 3 && droppedBlocks != nullptr) {
        int minoBottomY = -1;
        for (int i=0; i<4; i++) {
            if (droppedBlocks[i].y > minoBottomY) minoBottomY = droppedBlocks[i].y;
        }
        int n = (ROWS - 1) - minoBottomY; 
        if (n < 0) n = 0;
        if (n >= 3 && isGrounded) score += w.downstackGood * n; 
        else if (n < 3) score += w.downstackBad * 10 * n; 
    }

    // ★最適化：ビットボードから一瞬で各列の高さを算出
    uint32_t cols[COLS] = {0};
    int heights[COLS] = {0};
    for(int y = 0; y < ROWS; y++) {
        uint16_t row = b.rows[y];
        for(int x = 0; x < COLS; x++) {
            if ((row >> x) & 1) cols[x] |= (1 << y);
        }
    }

    int maxHeight = 0; int minHeight = ROWS;
    for (int x = 0; x < COLS; x++) {
        if (cols[x] != 0) {
            // ★最適化：__builtin_ctz (最下位の0の数を数える超高速命令) を使って高さを一発で取得
            heights[x] = ROWS - __builtin_ctz(cols[x]); 
            if (heights[x] > maxHeight) maxHeight = heights[x];
            if (heights[x] < minHeight) minHeight = heights[x];
        } else {
            minHeight = 0;
        }
    }
    
    // 呼び出し元に高さを引き継ぐ
    if (outMaxHeight != nullptr) *outMaxHeight = maxHeight;

    if(maxHeight >= 8) score += (maxHeight - 7) * (maxHeight - 7) * w.heightLimit;
    if(maxHeight >= 18) score += 100 * maxHeight * maxHeight * w.heightLimit;

    // ★追加：ゆるやかな下り坂の評価
    // 左側 (y1=0, y2=1, y3=2, y4=3)
    float l_y1 = heights[0], l_y2 = heights[1] - l_y1, l_y3 = heights[2] - l_y1, l_y4 = heights[3] - l_y1;
    float l_cond1 =  -(2.0f * l_y2 + l_y3) / 2.0f;
    float l_cond2 = l_y4 - (l_y2 + l_y3) / 3.0f;
    if (l_cond1 >= 0.0f && l_cond2 <= 2.0f) {
        score += w.slopeBonus;
    } else if (maxHeight <= 10){
        score += (l_cond1) * (l_cond1) * w.slopePenalty;
        score += (l_cond2) * (l_cond2) * w.slopePenalty;
    }

    // 右側 (y1=9, y2=8, y3=7, y4=6)
    float r_y1 = heights[9], r_y2 = heights[8] - r_y1, r_y3 = heights[7] - r_y1, r_y4 = heights[6] - r_y1;
    float r_cond1 =  -(2.0f * r_y2 + r_y3) / 2.0f;
    float r_cond2 = r_y4 - (r_y2 + r_y3) / 3.0f;
    if (r_cond1 >= 0.0f && r_cond2 <= 2.0f) {
        score += w.slopeBonus;
    } else if (maxHeight <= 10){
        score += (r_cond1) * (r_cond1) * w.slopePenalty;
        score += (r_cond2) * (r_cond2) * w.slopePenalty;
    }

    // ★最適化：I-Well判定のループ外への切り出しをビット演算で完全一括処理
    bool hasIWellInRow[ROWS] = {false};
    for (int cy = 1; cy < ROWS - 1; cy++) {
        uint16_t row_up = (cy-1 < 0) ? 0 : b.rows[cy-1];
        uint16_t row_mid = b.rows[cy];
        uint16_t row_down = b.rows[cy+1];
        
        uint16_t empty_mask = (~row_up) & (~row_mid) & (~row_down) & 0x3FF;
        uint16_t solid_mask = row_up & row_mid & row_down;
        
        uint16_t left_solid = (solid_mask << 1) | 1;      // 左壁を含む
        uint16_t right_solid = (solid_mask >> 1) | 0x200; // 右壁を含む
        
        if (empty_mask & left_solid & right_solid) {
            hasIWellInRow[cy] = true;
        }
    }

    // 1回のスキャンでTSD判定
    TSDStats tsd = {0, 0, 0};
    bool isTSDRowForBlocksOverHole[ROWS] = {false};
    uint32_t ignoreMask = 0; // 穴として数えない行のビットマスク

    for (int cy = 1; cy < ROWS - 1; cy++) {
        if (hasIWellInRow[cy]) continue;

        for (int cx = 1; cx < COLS - 1; cx++) {
            if (isTSDShape(b, cx, cy, heights)) {
                isTSDRowForBlocksOverHole[cy] = true;
                isTSDRowForBlocksOverHole[cy + 1] = true;
                
                if (maxHeight <= 10) {
                    ignoreMask |= (1 << cy);
                    ignoreMask |= (1 << (cy + 1));
                }

                tsd.count++;
                if (tsd.count == 1) { 
                    uint16_t mask_cy = ~( (1<<(cx-1)) | (1<<cx) | (1<<(cx+1)) ) & 0x3FF;
                    uint16_t mask_cy1 = ~( (1<<cx) ) & 0x3FF;
                    tsd.fillCount += __builtin_popcount(b.rows[cy] & mask_cy);
                    tsd.fillCount += __builtin_popcount(b.rows[cy+1] & mask_cy1);
                    
                    for (int x = 0; x < COLS; x++) {
                        if (x != cx - 1 && x != cx && x != cx + 1) {
                            if (cy > ROWS - heights[x] && !((b.rows[cy] >> x) & 1)) tsd.holeCount++; 
                        }
                        if (x != cx) {
                            if (cy + 1 > ROWS - heights[x] && !((b.rows[cy+1] >> x) & 1)) tsd.holeCount++; 
                        }
                    }
                }
            }
        }
    }

    if (maxHeight <= 10) {
        for(int x = 0; x < COLS; x++) {
            int leftDiff = (x == 0) ? 999 : heights[x-1] - heights[x];
            int rightDiff = (x == COLS-1) ? 999 : heights[x+1] - heights[x];
            if(leftDiff >= 4 && rightDiff >= 4) {
                int startY = ROWS - heights[x];
                for (int dy = 0; dy < 4; dy++) {
                    if (startY + dy >= 0 && startY + dy < ROWS) {
                        ignoreMask |= (1 << (startY + dy));
                    }
                }
            }
        }
    }

    // ★最適化：holesのループをビット演算と popcount で一撃で計算
    int holes = 0;
    for (int x = 0; x < COLS; x++) {
        if (cols[x] == 0) continue;
        int first_y = __builtin_ctz(cols[x]);
        uint32_t filled = cols[x] | ignoreMask; // 穴を無視する行を埋める
        uint32_t mask = ~((1 << first_y) - 1);
        filled |= ~mask;                        // ブロック上空を 1 にして穴判定から消す
        filled |= ~((1 << ROWS) - 1);           // 盤面外を 1 にする
        
        holes += 32 - __builtin_popcount(filled); // 残った 0 の数が穴の数
    }

    score += holes * w.hole;
    if (holes > 0) score += (holes * holes) * (w.hole / 2);

    // ★最適化：pureHole も盤面の多重ループを消滅させ、ビット演算に置換
    int pureHolesCount = 0;
    for(int y = 0; y < ROWS; y++) {
        uint16_t row = b.rows[y];
        uint16_t empty = (~row) & 0x3FF;
        uint16_t up = (y == 0) ? 0x3FF : b.rows[y-1];
        uint16_t down = (y == ROWS-1) ? 0x3FF : b.rows[y+1];
        uint16_t left_wall = (row << 1) | 1;
        uint16_t right_wall = (row >> 1) | 0x200;
        uint16_t pure = empty & up & down & left_wall & right_wall;
        pureHolesCount += __builtin_popcount(pure);
    }
    
    score += pureHolesCount * w.pureHole;
    if (pureHolesCount > 0) score += (pureHolesCount * pureHolesCount) * (w.pureHole / 2);

    int step1Count = 0;
    int step2Count = 0;
    int step3PlusCount = 0;
    for(int x = 0; x < COLS - 1; x++) {
        int diff = std::abs(heights[x] - heights[x+1]);
        if(diff == 0) score += w.flat;
        else if(diff == 1) step1Count++;
        else if(diff == 2) step2Count++;
        else step3PlusCount++;
    }
    score += (step1Count <= 2) ? (step1Count * w.step1Good) : (step1Count * w.step1Bad);
    score += step2Count * w.step2;
    score += step3PlusCount * w.step3Plus;

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

    int totalIWellScore = 0;
    for(int x = 0; x < COLS; x++) {
        int continuousEmpty = 0; int maxContinuous = 0;
        for(int y = 0; y < ROWS; y++) {
            if(__builtin_popcount(b.rows[y]) == 9 && !((b.rows[y] >> x) & 1)) {
                continuousEmpty++;
                if(continuousEmpty > maxContinuous) maxContinuous = continuousEmpty;
            } else {
                continuousEmpty = 0; 
            }
        }
        if(maxContinuous > 0) {
            int wellScore = 0;
            if(maxContinuous <= 10) wellScore = maxContinuous * w.iWell;
            else wellScore = 10 * w.iWell + (maxContinuous - 10) * w.iWellOver;
            
            if (x <= 1 || x >= 8) totalIWellScore -= wellScore / 4;
            else totalIWellScore += wellScore;
        }
    }
    score += totalIWellScore;

    // ★最適化：totalBlocksOverLowestHole もループと条件分岐を消し去り、ビット演算に置換
    uint32_t tsdr_mask = 0;
    for (int y = 0; y < ROWS; y++) if (isTSDRowForBlocksOverHole[y]) tsdr_mask |= (1 << y);

    int totalBlocksOverLowestHole = 0;
    for (int x = 0; x < COLS; x++) {
        uint32_t c = cols[x];
        if (c == 0) continue;
        int firstBlockY = __builtin_ctz(c);
        uint32_t inv = ~c & ((1 << ROWS) - 1);
        inv &= ~((1 << (firstBlockY + 1)) - 1); // 最初のブロックより上空を無視
        if (inv != 0) {
            int lowestHoleY = 31 - __builtin_clz(inv); // 一番下にある穴の位置を特定
            uint32_t valid_blocks = c & ~tsdr_mask;    // TSD地形を除外したブロック列
            valid_blocks &= ((1 << lowestHoleY) - 1);  // 穴より上空のブロックだけを残す
            totalBlocksOverLowestHole += __builtin_popcount(valid_blocks);
        }
    }
    score += totalBlocksOverLowestHole * w.blocksOverHole;

    if(isGrounded) {
        score += w.groundedBonus;
        score += touchingCount * w.touchingBonus;
    } else {
        score -= 3 * w.groundedBonus;
    }

    if (tsd.count == 1) {
        score += w.tsdShape;
        score += tsd.fillCount * w.tsdFillBonus; 
        score += tsd.holeCount * w.tsdHolePenalty; 
    } else if (tsd.count >= 2) {
        score += w.tsdShape; 
        score += (tsd.count - 1) * w.tsdShapeOver; 
        score += tsd.holeCount * w.tsdHolePenalty; 
    }

    int tsdSetupCount = 0;
    for (int x = 1; x < COLS - 1; x++) {
        int y = ROWS - heights[x] - 1; 
        if (y > 0 && y < ROWS) {
            if ((b.rows[y] & (1<<(x-1))) && (b.rows[y] & (1<<(x+1)))) {
                if (!((b.rows[y-1] >> (x-1)) & 1) && !((b.rows[y-1] >> (x+1)) & 1)) {
                    tsdSetupCount++;
                }
            }
        }
    }

    if (tsdSetupCount > 0) {
        if (tsdSetupCount <= 2) score += tsdSetupCount * w.tsdSetup;
        else score += tsdSetupCount * w.tsdSetupOver;
    }

    if (ren > 0 && maxHeight >= 10) score += (ren-2) * (ren) * w.comboBonus;
    if (ren > 4) score += ren * ren * w.comboBonus;

    if (linesCleared > 0) {
        bool isBtBAction = (linesCleared >= 4) || (tSpinType > 0 && linesCleared > 0);
        if (isBtBAction) {
            score += w.btbKeep;
            if (backToBack) score += w.btbKeep; 
        } else {
            score -= w.btbKeep;
            if (backToBack) score -= w.btbKeep * 2; 
        }
    }

    return score;
}

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

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) { free(ptr); }

struct SearchState {
    int first_action; 
    int hold_mino;    
    int next_idx;     

    int p1_score; 
    int total_score; 
    Board board;

    bool has_p[6];      
    Placement p[6];     
    int step_score[6];  
    int p_id[6];        

    int max_height;     
    
    int ren;        
    bool backToBack; 

    SearchState() {
        first_action = -1;
        hold_mino = -1;
        next_idx = 0;
        p1_score = 0;
        total_score = 0;
        max_height = 0;
        ren = 0;        
        backToBack = false; 
        for(int i = 0; i < 6; ++i) { 
            has_p[i] = false; 
            step_score[i] = 0; 
            p_id[i] = -1; 
        }
    }
};

EMSCRIPTEN_KEEPALIVE
void evaluateSinglePlacementWasm(
    uint8_t* boardData, int minoType, int rot, int x, int y, 
    int* weightsArray, int* outResult,
    int ren, int backToBack, int tSpinType
) {
    ensurePrecalc();
    
    Board baseBoard;
    for(int i = 0; i < 250; i++) {
        if (boardData[i]) baseBoard.set(i % 10, i / 10);
    }

    EvalWeights w = {
        weightsArray[0], weightsArray[1], weightsArray[2], weightsArray[3], weightsArray[4],
        weightsArray[5], weightsArray[6], weightsArray[7], weightsArray[8], weightsArray[9],
        weightsArray[10], weightsArray[11], weightsArray[12], weightsArray[13], weightsArray[14], 
        weightsArray[15], weightsArray[16], weightsArray[17], weightsArray[18], weightsArray[19], 
        weightsArray[20], weightsArray[21], weightsArray[22], weightsArray[23],
        weightsArray[24], weightsArray[25], weightsArray[26], weightsArray[27], weightsArray[28],
        weightsArray[29], weightsArray[30], weightsArray[31], weightsArray[32] 
    };

    int baseScore = evaluateBoard(baseBoard, 0, false, 0, w, ren, backToBack != 0, nullptr, 0, nullptr);

    GridBlock blocks[4];
    for(int i=0; i<4; i++) {
        blocks[i].x = PRECALC_MINO_BLOCKS[minoType][rot][i].x + x;
        blocks[i].y = PRECALC_MINO_BLOCKS[minoType][rot][i].y + y;
    }

    Board simBoard = baseBoard;
    for(int i=0; i<4; i++) {
        simBoard.set(blocks[i].x, blocks[i].y);
    }
    
    PlacementInfo info = calcPlacementInfo(baseBoard, blocks);
    int cleared = simBoard.checkLineAndClear();

    int score = evaluateBoard(simBoard, cleared, info.isFullyGrounded, info.touchingCount, w, ren, backToBack != 0, blocks, tSpinType, nullptr);
    
    int eventBonus = 0;
    int multiplier = 6; 
    if (cleared >= 4) eventBonus += w.line4 * multiplier;
    if (tSpinType == 1) { 
        if (cleared == 1) eventBonus += w.tssClear; 
        else if (cleared >= 2) eventBonus += w.tsdClear * multiplier; 
    } else if (tSpinType == 2) { 
        eventBonus += w.tsmMiniPenalty * multiplier;
    }

    int stepScore = score * w.p1Weight / 100 + eventBonus;

    bool hasBlockOutside = false;
    for(int i=0; i<4; i++) {
        if(blocks[i].y < 0) {
            hasBlockOutside = true;
            break;
        }
    }
    if (hasBlockOutside) stepScore -= 100000000;

    int prevHeight = 0;
    for(int y = 0; y < ROWS; y++) {
        if (baseBoard.rows[y] != 0) {
            prevHeight = ROWS - y;
            break;
        }
    }

    if (prevHeight <= 10) {
        if (minoType == 2 && cleared == 0) stepScore += w.tMinoNoClearPenalty;
    }

    outResult[0] = stepScore;
    outResult[1] = stepScore - baseScore;
}

EMSCRIPTEN_KEEPALIVE
void searchBestMoveWasm(
    uint8_t* boardData, int currentType, int holdType, int next1, int next2, int next3, int next4, int next5, int canHold,
    int* weightsArray, int* outResult,
    int ren, int backToBack 
){
    ensurePrecalc();
    
    for(int i = 0; i < 43; i++) outResult[i] = -1;
    for(int i = 36; i < 43; i++) outResult[i] = 0; 

    Board baseBoard;
    for(int i = 0; i < 250; i++) {
        if (boardData[i]) baseBoard.set(i % 10, i / 10);
    }

    EvalWeights w = {
        weightsArray[0], weightsArray[1], weightsArray[2], weightsArray[3], weightsArray[4],
        weightsArray[5], weightsArray[6], weightsArray[7], weightsArray[8], weightsArray[9],
        weightsArray[10], weightsArray[11], weightsArray[12], weightsArray[13], weightsArray[14], 
        weightsArray[15], weightsArray[16], weightsArray[17], weightsArray[18], weightsArray[19], 
        weightsArray[20], weightsArray[21], weightsArray[22], weightsArray[23],
        weightsArray[24], weightsArray[25], weightsArray[26], weightsArray[27], weightsArray[28],
        weightsArray[29], weightsArray[30], weightsArray[31], weightsArray[32]
    };

    int baseMaxHeight = 0; 
    int baseScore = evaluateBoard(baseBoard, 0, false, 0, w, ren, backToBack != 0, nullptr, 0, &baseMaxHeight);
    
    int next_queue[7] = { currentType, next1, next2, next3, next4, next5, 0 };
    auto getSpawnY = [](int type) { return type == 0 ? 4 : 3; }; 
    
    auto calcEventBonus = [&](const Placement& p, int step_num) {
        int bonus = 0; int multiplier = 7 - step_num; 
        if (p.linesCleared >= 4) bonus += w.line4 * multiplier;
        if (p.tSpinType == 1) {
            if (p.linesCleared == 1) bonus += w.tssClear; 
            else if (p.linesCleared >= 2) bonus += w.tsdClear * multiplier; 
        } else if (p.tSpinType == 2) {
            bonus += w.tsmMiniPenalty * multiplier;
        }
        return bonus;
    };

    std::vector<SearchState> final_states;
    std::vector<SearchState> current_states;
    std::vector<SearchState> next_states_N;
    std::vector<SearchState> next_states_L;
    
    const size_t BEAM_WIDTH = 8;
    const int P1_WEIGHT_PCT = w.p1Weight; 

    final_states.reserve(128);
    current_states.reserve(BEAM_WIDTH * 2); 
    next_states_N.reserve(1024);
    next_states_L.reserve(1024);

    auto expandState = [&](const SearchState& s, int piece, int new_hold, int new_next_idx, int step_num, bool is_first, int first_action) -> int {
        std::vector<Placement> p_list = getAllPlacements(is_first ? baseBoard : s.board, piece, getSpawnY(piece));
        
        if (p_list.empty()) {
            SearchState dead_s = s;
            dead_s.total_score -= 100000000 * (7 - step_num); 
            if (is_first) dead_s.first_action = first_action;
            final_states.push_back(dead_s);
            return 0; 
        }

        int pushed_count = 0;
        for(size_t j = 0; j < p_list.size(); j++) {
            const auto& p = p_list[j];
            
            bool hasBlockOutside = false;
            for(int k=0; k<4; k++) {
                if(p.blocks[k].y < 0) {
                    hasBlockOutside = true;
                    break;
                }
            }

            Board simBoard = is_first ? baseBoard : s.board;
            for(int k=0; k<4; k++) {
                simBoard.set(p.blocks[k].x, p.blocks[k].y);
            }
            simBoard.checkLineAndClear();

            int cur_ren = is_first ? ren : s.ren;
            bool cur_btb = is_first ? (backToBack != 0) : s.backToBack;

            int current_max_height = 0;
            int score = evaluateBoard(simBoard, p.linesCleared, p.isFullyGrounded, p.touchingCount, w, cur_ren, cur_btb, p.blocks, p.tSpinType, &current_max_height);
            int eventBonus = calcEventBonus(p, step_num);
            int stepScore = is_first ? (score * P1_WEIGHT_PCT / 100 + eventBonus) : (score + eventBonus);

            if (hasBlockOutside) stepScore -= 100000000 * (7 - step_num);

            int prevHeight = is_first ? baseMaxHeight : s.max_height;
            if (prevHeight <= 10) {
                if (cur_ren > 0 && cur_ren <= 2 && p.linesCleared == 0) stepScore += w.renCutPenalty; 
                if (piece == 2 && p.linesCleared == 0) stepScore += w.tMinoNoClearPenalty;
            }

            int next_ren = (p.linesCleared > 0) ? (cur_ren + 1) : 0;
            bool isBtBAction = (p.linesCleared >= 4) || (p.tSpinType > 0 && p.linesCleared > 0);
            bool next_btb = cur_btb;
            if (p.linesCleared > 0) next_btb = isBtBAction; 

            SearchState next_s = s;
            next_s.hold_mino = new_hold;
            next_s.next_idx = new_next_idx;
            next_s.ren = next_ren;       
            next_s.backToBack = next_btb; 
            next_s.max_height = current_max_height;
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

            if (hasBlockOutside) {
                final_states.push_back(next_s);
            } else {
                if (p.linesCleared > 0) next_states_L.push_back(next_s);
                else next_states_N.push_back(next_s);
                pushed_count++;
            }
        }
        return pushed_count;
    };

    auto trimAndMerge = [&]() {
        if(next_states_N.size() > BEAM_WIDTH) {
            std::partial_sort(next_states_N.begin(), next_states_N.begin() + BEAM_WIDTH, next_states_N.end(), 
                [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
            next_states_N.resize(BEAM_WIDTH);
        }
        if(next_states_L.size() > BEAM_WIDTH) {
            std::partial_sort(next_states_L.begin(), next_states_L.begin() + BEAM_WIDTH, next_states_L.end(), 
                [](const SearchState& a, const SearchState& b){ return a.total_score > b.total_score; });
            next_states_L.resize(BEAM_WIDTH);
        }
        
        current_states.clear();
        for (const auto& s : next_states_N) current_states.push_back(s);
        for (const auto& s : next_states_L) current_states.push_back(s);
        
        next_states_N.clear();
        next_states_L.clear();
    };

    SearchState initial_state;
    initial_state.ren = ren;
    initial_state.backToBack = (backToBack != 0);
    initial_state.max_height = baseMaxHeight;
    
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

    trimAndMerge();

    for (int depth = 1; depth < 6; depth++) {
        int step_num = depth + 1;
        next_states_N.clear();
        next_states_L.clear();

        for (const auto& state : current_states) {
            int cur_mino = state.next_idx < 6 ? next_queue[state.next_idx] : 0;
            
            expandState(state, cur_mino, state.hold_mino, state.next_idx + 1, step_num, false, -1);
            
            if (state.hold_mino != -1 && state.hold_mino != cur_mino) {
                expandState(state, state.hold_mino, cur_mino, state.next_idx + 1, step_num, false, -1);
            }
        }

        if (next_states_N.empty() && next_states_L.empty()) break; 

        trimAndMerge();
    }

    for (const auto& state : current_states) {
        final_states.push_back(state);
    }

    int bestTotalScore = -2000000000;
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
        
        outResult[12] = bestState->p[0].tSpinType;
        
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