// ─────────────────────────────────────────────
// cpu2.cpp
// ぷよCPU lv2 - Web Worker + Wasm 版
// ビットボード (1マス3ビット) による超高速探索で、
// 発火の閾値制御と、正確な連鎖ポテンシャル計算を行う
// ─────────────────────────────────────────────

#include <emscripten.h>
#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>

const int COLS       = 6;
const int ROWS       = 12; 
const int HIDDEN     = 5;  
const int TOTAL_ROWS = ROWS + HIDDEN;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BitBoard 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct BitBoard {
    uint64_t cols[COLS];

    BitBoard() {
        for(int c = 0; c < COLS; c++) cols[c] = 0;
    }

    void fromArray(const uint8_t* data) {
        for(int c = 0; c < COLS; c++) cols[c] = 0;
        for (int r = 0; r < TOTAL_ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                uint8_t val = data[r * COLS + c];
                if (val != 0) {
                    cols[c] |= ((uint64_t)(val & 0x7) << ((TOTAL_ROWS - 1 - r) * 3));
                }
            }
        }
    }

    inline uint8_t get(int col, int r) const {
        if (col < 0 || col >= COLS || r < 0 || r >= TOTAL_ROWS) return 0;
        return (cols[col] >> ((TOTAL_ROWS - 1 - r) * 3)) & 0x7;
    }

    inline void set(int col, int r, uint8_t val) {
        if (col < 0 || col >= COLS || r < 0 || r >= TOTAL_ROWS) return;
        int shift = (TOTAL_ROWS - 1 - r) * 3;
        cols[col] &= ~(0x7ULL << shift);
        cols[col] |= ((uint64_t)(val & 0x7) << shift);
    }

    bool isEmpty(int col, int row) const {
        if (col < 0 || col >= COLS) return false;
        if (row >= ROWS) return false;
        int r = row + HIDDEN;
        if (r < 0) return true;
        return get(col, r) == 0;
    }

    bool isEmptyAll() const {
        for(int c = 0; c < COLS; c++) if (cols[c] != 0) return false;
        return true;
    }

    void applyGravity() {
        for (int c = 0; c < COLS; c++) {
            uint64_t col = cols[c];
            if (col == 0) continue; 
            
            uint64_t new_col = 0;
            int write_idx = 0;
            for (int i = 0; i < TOTAL_ROWS; i++) {
                uint64_t val = (col >> (i * 3)) & 0x7;
                if (val != 0) {
                    new_col |= (val << (write_idx * 3));
                    write_idx++;
                }
            }
            cols[c] = new_col;
        }
    }
};

struct PairPlacement {
    int col;
    int rot;
    int pivotRow;
    int childRow;
    int childCol;
};

static int calcDropRow(const BitBoard& b, int col) {
    for (int row = ROWS - 1; row >= 0; row--) {
        if (b.isEmpty(col, row)) return row;
    }
    return -1;
}

static std::vector<PairPlacement> getAllPlacements(const BitBoard& b) {
    const int DC[4] = { 0,  1,  0, -1 };
    const int DR[4] = {-1,  0,  1,  0 };

    std::vector<PairPlacement> result;
    result.reserve(32);

    for (int col = 0; col < COLS; col++) {
        for (int rot = 0; rot < 4; rot++) {
            int cc = col + DC[rot];
            if (cc < 0 || cc >= COLS) continue;

            int pr = calcDropRow(b, col);
            if (pr < 0) continue;

            int cr;
            if (rot == 0) {
                if (pr == 0) continue;
                cr = pr - 1;
                if (!b.isEmpty(col, pr - 1)) continue;
            } else if (rot == 2) {
                cr = calcDropRow(b, col);
                if (cr < 0) continue;
                pr = cr - 1;
                if (pr < 0) continue;
                if (!b.isEmpty(col, pr)) continue;
            } else {
                cr = calcDropRow(b, cc);
                if (cr < 0) continue;
            }

            PairPlacement p;
            p.col = col; p.rot = rot;
            p.pivotRow = pr; p.childRow = cr; p.childCol = cc;
            result.push_back(p);
        }
    }
    return result;
}

static BitBoard applyPlacement(const BitBoard& b, const PairPlacement& p, uint8_t pivotColor, uint8_t childColor) {
    BitBoard nb = b;
    nb.set(p.col,      p.pivotRow + HIDDEN, pivotColor);
    nb.set(p.childCol, p.childRow + HIDDEN, childColor);
    return nb;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 連鎖シミュレーション
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct ChainResult {
    int chains;
    int totalErased;
    int maxGroup;
};

static ChainResult simulateChain(BitBoard& b) {
    ChainResult res = {0, 0, 0};
    static bool visited[TOTAL_ROWS][COLS];

    while (true) {
        memset(visited, 0, sizeof(visited));
        std::vector<std::pair<int,int>> toErase; 
        std::vector<std::pair<int,int>> toEraseOjama;
        bool found = false;

        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                if (visited[r][c]) continue;
                uint8_t color = b.get(c, r);
                if (color == 0 || color == 6) continue; 

                std::vector<std::pair<int,int>> group;
                std::vector<std::pair<int,int>> queue;
                queue.push_back({r, c});
                visited[r][c] = true;

                while (!queue.empty()) {
                    auto [cr, cc] = queue.back();
                    queue.pop_back();
                    group.push_back({cr, cc});

                    const int dr[] = {-1, 1,  0, 0};
                    const int dc[] = { 0, 0, -1, 1};
                    for (int d = 0; d < 4; d++) {
                        int nr = cr + dr[d];
                        int nc = cc + dc[d];
                        if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                        if (visited[nr][nc]) continue;
                        if (b.get(nc, nr) != color) continue;
                        visited[nr][nc] = true;
                        queue.push_back({nr, nc});
                    }
                }

                if ((int)group.size() >= 4) {
                    found = true;
                    if ((int)group.size() > res.maxGroup) res.maxGroup = (int)group.size();
                    res.totalErased += (int)group.size();
                    for (auto& cell : group) toErase.push_back(cell);
                }
            }
        }

        if (!found) break;

        for (auto& cell : toErase) {
            const int dr[] = {-1, 1,  0, 0};
            const int dc[] = { 0, 0, -1, 1};
            for (int d = 0; d < 4; d++) {
                int nr = cell.first + dr[d];
                int nc = cell.second + dc[d];
                if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                if (b.get(nc, nr) == 6) {
                    toEraseOjama.push_back({nr, nc});
                }
            }
        }

        res.chains++;

        for (auto& p : toErase) b.set(p.second, p.first, 0);
        for (auto& p : toEraseOjama) b.set(p.second, p.first, 0); 

        b.applyGravity();
    }

    return res;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 連鎖ポテンシャルと発火点の安全性計算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct PotentialInfo {
    int maxChains;
    int triggerCol;
    int triggerRow;
    uint8_t triggerColor;
    bool isSafe; // 発火点の上、左、右のいずれかが空いているか
};

static PotentialInfo calcChainPotential(const BitBoard& b) {
    PotentialInfo best = {0, -1, -1, 0, false};
    for (int col = 0; col < COLS; col++) {
        int r = calcDropRow(b, col);
        if (r < 0) continue;
        
        for (uint8_t color = 1; color <= 5; color++) {
            BitBoard tmp = b;
            tmp.set(col, r + HIDDEN, color);
            ChainResult res = simulateChain(tmp);
            if (res.chains > best.maxChains) {
                best.maxChains = res.chains;
                best.triggerCol = col;
                best.triggerRow = r;
                best.triggerColor = color;
            }
        }
    }
    
    // 発火点が特定できたら、その周囲の安全性を確認
    if (best.maxChains > 0) {
        int c = best.triggerCol;
        int r = best.triggerRow;
        bool upSafe    = b.isEmpty(c, r - 1);
        bool leftSafe  = b.isEmpty(c - 1, r);
        bool rightSafe = b.isEmpty(c + 1, r);
        best.isSafe = (upSafe || leftSafe || rightSafe);
    }
    
    return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 評価パラメータ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct EvalWeights {
    int chainBonus;
    int erasedBonus;
    int heightPenalty;
    int heightDiffPenalty;
    int flatBonus;
    int colorConnBonus;
    int zenkeshiBonus;
    int chainPotentialBonus;
    int p1Weight;
    int templateBonus;
    int ignitionThreshold;
    int emergencyHeight;  
};

static int getTemplateScore(const BitBoard& b, const uint8_t* pattern, int templateBonus) {
    uint8_t colorOfGroup[6] = {0};
    bool broken = false;
    int matchCount = 0;
    int expectedCount = 0;
    const int TEMPLATE_TOP_ROW = 8; 

    for (int row = 0; row < 4; row++) {
        for (int col = 0; col < COLS; col++) {
            int idx = row * COLS + col;
            uint8_t g = pattern[idx];
            if (g == 0) continue; 
            expectedCount++;
            
            int r = (TEMPLATE_TOP_ROW + row) + HIDDEN;
            if (r < 0 || r >= TOTAL_ROWS) continue;
            
            uint8_t c = b.get(col, r);
            if (c >= 1 && c <= 5) {
                if (colorOfGroup[g] != 0 && colorOfGroup[g] != c) {
                    broken = true; break;
                }
                colorOfGroup[g] = c;
                matchCount++;
            } else if (c == 6) {
                broken = true; break;
            }
        }
        if (broken) break;
    }

    if (broken) return 0;

    for (int row = 0; row < 4; row++) {
        for (int col = 0; col < COLS; col++) {
            uint8_t g1 = pattern[row * COLS + col];
            if (g1 == 0) continue;
            uint8_t c1 = colorOfGroup[g1];
            if (c1 == 0) continue; 

            if (col + 1 < COLS) {
                uint8_t g2 = pattern[row * COLS + col + 1];
                if (g2 != 0 && g1 != g2 && colorOfGroup[g2] != 0 && c1 == colorOfGroup[g2]) {
                    broken = true; break;
                }
            }
            if (row + 1 < 4) {
                uint8_t g2 = pattern[(row + 1) * COLS + col];
                if (g2 != 0 && g1 != g2 && colorOfGroup[g2] != 0 && c1 == colorOfGroup[g2]) {
                    broken = true; break;
                }
            }
        }
        if (broken) break;
    }

    if (broken) return 0;
    return matchCount * templateBonus;
}

static int calcTemplateScore(const BitBoard& b, const uint8_t* stairsPattern, const uint8_t* keyPattern, int templateBonus) {
    if (templateBonus <= 0) return 0;
    int scoreStairs = getTemplateScore(b, stairsPattern, templateBonus);
    int scoreKey    = getTemplateScore(b, keyPattern, templateBonus);
    return std::max(scoreStairs, scoreKey);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 盤面評価関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int evaluateBoard(const BitBoard& b, const ChainResult& chain, const EvalWeights& w,
                         const uint8_t* stairsPattern, const uint8_t* keyPattern,
                         const PotentialInfo& prePot) {
    int score = 0;

    if (stairsPattern != nullptr && keyPattern != nullptr) {
        score += calcTemplateScore(b, stairsPattern, keyPattern, w.templateBonus);
    }

    int heights[COLS];
    bool isEmergency = false;
    for (int c = 0; c < COLS; c++) {
        heights[c] = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (b.get(c, r) != 0) heights[c]++;
        }
        if (heights[c] >= w.emergencyHeight || (c == 2 && heights[c] >= 9)) {
            isEmergency = true;
        }
    }

    // ──────────────────────────────────────────
    // ★ 発火モードと防衛判定
    // ──────────────────────────────────────────
    bool isIgnitionMode = (prePot.maxChains >= w.ignitionThreshold);

    if (chain.chains > 0) {
        // 本線の大連鎖が起きた場合
        if (chain.chains >= w.ignitionThreshold || (isIgnitionMode && chain.chains >= prePot.maxChains)) {
            int effectiveChains = std::max(chain.chains, prePot.maxChains);
            score += (effectiveChains * effectiveChains * effectiveChains) * w.chainBonus * 10;
            score += chain.totalErased * std::abs(w.erasedBonus);
        } else if (isEmergency || b.isEmptyAll()) {
            // 致死回避の掘り、または全消し消化
            score += (chain.chains * chain.chains) * w.chainBonus * 5;
            score += chain.totalErased * std::abs(w.erasedBonus);
        } else if (isIgnitionMode) {
            // 発火モード中の小連鎖
            PotentialInfo postPot = calcChainPotential(b);
            if (postPot.maxChains >= w.ignitionThreshold && postPot.isSafe) {
                // 発火点が埋まらないことを優先した「回避のための小連鎖」として許容
                score += chain.totalErased * std::abs(w.erasedBonus);
            } else {
                // 回避にもならず本線を破壊する完全な暴発
                score -= (chain.chains * chain.chains) * 5000;
            }
        } else {
            // 発火モード未満での暴発（タネの無駄遣い）
            score -= (chain.chains * chain.chains) * 5000;
        }
    } else {
        // 連鎖なし（ただ置いただけ）
        if (isIgnitionMode) {
            PotentialInfo postPot = calcChainPotential(b);
            if (postPot.maxChains >= w.ignitionThreshold) {
                if (postPot.isSafe) {
                    // 発火点を安全に維持できた
                    score += (postPot.maxChains * postPot.maxChains) * w.chainPotentialBonus * 5;
                    score += w.flatBonus * 2; 
                } else {
                    // ポテンシャルはあるが、発火点が塞がれてしまった
                    // 回避小連鎖ルートを選ばせるために強烈なペナルティ
                    score -= 10000;
                }
            } else {
                // 置きミスによりポテンシャルが壊れた
                score -= 10000;
            }
        } else {
            // 通常のポテンシャル評価
            PotentialInfo postPot = calcChainPotential(b);
            if (postPot.maxChains > 0) {
                if (postPot.isSafe) {
                    if (postPot.maxChains >= w.ignitionThreshold) {
                        score += (postPot.maxChains * postPot.maxChains) * w.chainPotentialBonus * 5;
                    } else {
                        score += (postPot.maxChains * postPot.maxChains) * w.chainPotentialBonus;
                    }
                } else {
                    // 発火点が塞がっているポテンシャルは低く評価
                    score += (postPot.maxChains * postPot.maxChains) * (w.chainPotentialBonus / 2);
                }
            }
        }
    }

    if (b.isEmptyAll()) score += w.zenkeshiBonus;

    // 高さ・平坦ペナルティ
    if (heights[2] >= 8) score += (heights[2] - 7) * w.heightPenalty; 
    for (int c = 0; c < COLS; c++) {
        if (heights[c] >= 10) score += (heights[c] - 9) * (w.heightPenalty / 3);
    }
    for (int c = 0; c < COLS - 1; c++) {
        int diff = std::abs(heights[c] - heights[c+1]);
        score += diff * w.heightDiffPenalty;
        if (diff == 0) score += w.flatBonus;
    }

    // 連結ボーナス
    int connPairs = 0;
    for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
        for (int c = 0; c < COLS; c++) {
            uint8_t col_val = b.get(c, r);
            if (col_val == 0 || col_val == 6) continue;
            
            if (c + 1 < COLS && b.get(c+1, r) == col_val) connPairs++;
            if (r + 1 < TOTAL_ROWS && b.get(c, r+1) == col_val) connPairs++;
        }
    }
    score += connPairs * w.colorConnBonus;

    return score;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 探索ノード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct SearchNode {
    BitBoard board;
    int accumulatedScore;
    int col1, rot1;
    int col2, rot2;
    int col3, rot3;

    SearchNode() : accumulatedScore(0), col1(-1), rot1(-1), col2(-1), rot2(-1), col3(-1), rot3(-1) {}
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Wasm エクスポート
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) { free(ptr); }

EMSCRIPTEN_KEEPALIVE
void searchBestMovePuyoWasm(
    uint8_t* boardData,
    int* nextPairs,         
    int* weightsArray,
    int* outResult,
    uint8_t* stairsPattern, 
    uint8_t* keyPattern     
) {
    for (int i = 0; i < 7; i++) outResult[i] = -1;

    EvalWeights w;
    w.chainBonus          = weightsArray[0];
    w.erasedBonus         = weightsArray[1];
    w.heightPenalty       = weightsArray[2];
    w.heightDiffPenalty   = weightsArray[3];
    w.flatBonus           = weightsArray[4];
    w.colorConnBonus      = weightsArray[5];
    w.zenkeshiBonus       = weightsArray[6];
    w.chainPotentialBonus = weightsArray[7];
    w.p1Weight            = weightsArray[8];
    w.templateBonus       = weightsArray[9];
    w.ignitionThreshold   = weightsArray[10]; 
    w.emergencyHeight     = weightsArray[11]; 

    BitBoard baseBoard;
    baseBoard.fromArray(boardData);

    std::vector<SearchNode> currentNodes;
    SearchNode rootNode;
    rootNode.board = baseBoard;
    currentNodes.push_back(rootNode);

    const int MAX_DEPTH = 10; 
    
    for (int depth = 0; depth < MAX_DEPTH; depth++) {
        std::vector<SearchNode> nextNodes;
        int pivot = nextPairs[depth * 2];
        int child = nextPairs[depth * 2 + 1];

        int beamWidth = 4;
        if (depth == 0) beamWidth = 10;
        else if (depth == 1) beamWidth = 8;
        else if (depth == 2) beamWidth = 6;
        else beamWidth = 4;

        for (const auto& node : currentNodes) {
            std::vector<PairPlacement> placements = getAllPlacements(node.board);
            if (placements.empty()) {
                SearchNode deathNode = node;
                deathNode.accumulatedScore -= 999999;
                nextNodes.push_back(deathNode);
                continue;
            }

            // ★ 置く前の盤面のポテンシャルを1回だけ計算して使い回す（高速化）
            PotentialInfo prePot = calcChainPotential(node.board);

            for (const auto& p : placements) {
                BitBoard nb = applyPlacement(node.board, p, (uint8_t)pivot, (uint8_t)child);
                ChainResult chain = simulateChain(nb);
                
                int scoreRaw = evaluateBoard(nb, chain, w, stairsPattern, keyPattern, prePot);
                
                int score = scoreRaw;
                if (depth == 0) score = score * w.p1Weight / 100;
                for(int i = 0; i < depth; i++) score = (score * 9) / 10;

                SearchNode nextNode = node;
                nextNode.board = nb;
                nextNode.accumulatedScore += score;
                
                if (depth == 0) {
                    nextNode.col1 = p.col; nextNode.rot1 = p.rot;
                } else if (depth == 1) {
                    nextNode.col2 = p.col; nextNode.rot2 = p.rot;
                } else if (depth == 2) {
                    nextNode.col3 = p.col; nextNode.rot3 = p.rot;
                }
                
                nextNodes.push_back(nextNode);
            }
        }

        std::sort(nextNodes.begin(), nextNodes.end(), [](const SearchNode& a, const SearchNode& b) {
            return a.accumulatedScore > b.accumulatedScore;
        });

        if ((int)nextNodes.size() > beamWidth) {
            nextNodes.resize(beamWidth);
        }
        currentNodes = nextNodes;

        if (!currentNodes.empty() && currentNodes[0].accumulatedScore < -900000) {
            break;
        }
    }

    if (!currentNodes.empty()) {
        const auto& bestNode = currentNodes.front();
        outResult[0] = bestNode.col1;
        outResult[1] = bestNode.rot1;
        outResult[2] = bestNode.accumulatedScore;
        outResult[3] = bestNode.col2;
        outResult[4] = bestNode.rot2;
        outResult[5] = bestNode.col3;
        outResult[6] = bestNode.rot3;
    }
}

} // extern "C"