// ─────────────────────────────────────────────
// cpu2.cpp
// ぷよCPU lv2 - Web Worker + Wasm 版
// ビットボード (1マス3ビット) による超高速探索で、
// 最大10手先までのビームサーチを行う
// ─────────────────────────────────────────────

#include <emscripten.h>
#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// フィールド定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const int COLS       = 6;
const int ROWS       = 12; // 見える行数
const int HIDDEN     = 5;  // 隠し行領域
const int TOTAL_ROWS = ROWS + HIDDEN; // 内部総行数 = 17

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BitBoard : ビットボードによる盤面表現
// ─ 1マス3ビット (0:空, 1〜5:色, 6:おじゃま, 7:未使用)
// ─ 1列17マス = 51ビット。uint64_t に収まる。
// ─ 下端(r=16)をLSB側(ビット0〜2)、上端(r=0)をMSB側(ビット48〜50)とする。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct BitBoard {
    uint64_t cols[COLS];

    BitBoard() {
        for(int c = 0; c < COLS; c++) cols[c] = 0;
    }

    // JSからの初期配列 (r=0が一番上、r=16が一番下) をビットボードに変換
    void fromArray(const uint8_t* data) {
        for(int c = 0; c < COLS; c++) cols[c] = 0;
        for (int r = 0; r < TOTAL_ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                uint8_t val = data[r * COLS + c];
                if (val != 0) {
                    // r=16が一番下なので、ビットシフト量は (16 - r) * 3
                    cols[c] |= ((uint64_t)(val & 0x7) << ((TOTAL_ROWS - 1 - r) * 3));
                }
            }
        }
    }

    // 値の取得
    inline uint8_t get(int col, int r) const {
        if (col < 0 || col >= COLS || r < 0 || r >= TOTAL_ROWS) return 0;
        return (cols[col] >> ((TOTAL_ROWS - 1 - r) * 3)) & 0x7;
    }

    // 値の設定
    inline void set(int col, int r, uint8_t val) {
        if (col < 0 || col >= COLS || r < 0 || r >= TOTAL_ROWS) return;
        int shift = (TOTAL_ROWS - 1 - r) * 3;
        cols[col] &= ~(0x7ULL << shift);
        cols[col] |= ((uint64_t)(val & 0x7) << shift);
    }

    // 表示行 (0〜11) の空きチェック
    bool isEmpty(int col, int row) const {
        if (col < 0 || col >= COLS) return false;
        if (row >= ROWS) return false;
        int r = row + HIDDEN;
        if (r < 0) return true;
        return get(col, r) == 0;
    }

    // 全消し判定
    bool isEmptyAll() const {
        for(int c = 0; c < COLS; c++) if (cols[c] != 0) return false;
        return true;
    }

    // ★ ビットボード最大の恩恵：超高速重力落下
    // シフト演算だけで、空いた0の隙間を消し去って下へ詰める
    void applyGravity() {
        for (int c = 0; c < COLS; c++) {
            uint64_t col = cols[c];
            if (col == 0) continue; // 全部空ならスキップ
            
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 組ぷよ 1 手の配置情報
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct PairPlacement {
    int col;
    int rot;
    int pivotRow;
    int childRow;
    int childCol;
};

// 落下行の計算
static int calcDropRow(const BitBoard& b, int col) {
    for (int row = ROWS - 1; row >= 0; row--) {
        if (b.isEmpty(col, row)) return row;
    }
    return -1;
}

// 全配置の列挙
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
    // 配置先は calcDropRow で接地判定済みのため、ここでは重力処理は不要
    return nb;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 連鎖処理（消去 → 落下 → 再消去）
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

        // おじゃまぷよ巻き込み
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

        // 消去
        for (auto& p : toErase) b.set(p.second, p.first, 0);
        for (auto& p : toEraseOjama) b.set(p.second, p.first, 0); 

        // 重力落下（超高速）
        b.applyGravity();
    }

    return res;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 連鎖ポテンシャル計算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int calcChainPotential(const BitBoard& b) {
    const uint8_t DUMMY_COLOR = 1;
    std::vector<PairPlacement> placements = getAllPlacements(b);
    int maxChains = 0;

    for (const auto& p : placements) {
        BitBoard tmp = applyPlacement(b, p, DUMMY_COLOR, DUMMY_COLOR);
        ChainResult res = simulateChain(tmp);
        if (res.chains > maxChains) maxChains = res.chains;
    }
    return maxChains;
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
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 動的テンプレート追従スコア計算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

    if (broken || matchCount == expectedCount) return 0;
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
                         const uint8_t* stairsPattern, const uint8_t* keyPattern) {
    int score = 0;

    if (stairsPattern != nullptr && keyPattern != nullptr) {
        score += calcTemplateScore(b, stairsPattern, keyPattern, w.templateBonus);
    }

    if (chain.chains > 0) {
        score += (chain.chains * chain.chains) * w.chainBonus;
    }
    score += chain.totalErased * w.erasedBonus;

    if (b.isEmptyAll()) score += w.zenkeshiBonus;

    int heights[COLS];
    for (int c = 0; c < COLS; c++) {
        heights[c] = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (b.get(c, r) != 0) heights[c]++;
        }
    }

    if (heights[2] >= 8) {
        score += (heights[2] - 7) * w.heightPenalty; 
    }
    for (int c = 0; c < COLS; c++) {
        if (heights[c] >= 10) {
            score += (heights[c] - 9) * (w.heightPenalty / 3);
        }
    }

    for (int c = 0; c < COLS - 1; c++) {
        int diff = std::abs(heights[c] - heights[c+1]);
        score += diff * w.heightDiffPenalty;
        if (diff == 0) score += w.flatBonus;
    }

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

    int potential = calcChainPotential(b);
    if (potential > 0) {
        score += (potential * potential) * w.chainPotentialBonus;
    }

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
// Wasm エクスポート関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) { free(ptr); }

// ─────────────────────────────────────────────
// searchBestMovePuyoWasm
// ★ 10手読みビームサーチ拡張版
// ─────────────────────────────────────────────
EMSCRIPTEN_KEEPALIVE
void searchBestMovePuyoWasm(
    uint8_t* boardData,
    int* nextPairs,         // ★ 10手分の色配列 (サイズ20: pivot0, child0, pivot1, child1...)
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

    BitBoard baseBoard;
    baseBoard.fromArray(boardData);

    int initialPuyoCount = 0;
    for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
        for (int c = 0; c < COLS; c++) {
            if (baseBoard.get(c, r) != 0) initialPuyoCount++;
        }
    }
    if (initialPuyoCount > (ROWS * COLS) / 3) {
        if (w.erasedBonus <= 0) {
            w.erasedBonus = std::abs(w.erasedBonus) * 10;
            if (w.erasedBonus == 0) w.erasedBonus = 3;
        }
    }

    std::vector<SearchNode> currentNodes;
    SearchNode rootNode;
    rootNode.board = baseBoard;
    currentNodes.push_back(rootNode);

    const int MAX_DEPTH = 10; // ★ 10手読み
    
    for (int depth = 0; depth < MAX_DEPTH; depth++) {
        std::vector<SearchNode> nextNodes;
        int pivot = nextPairs[depth * 2];
        int child = nextPairs[depth * 2 + 1];

        // 深くなるほどビーム幅を絞って計算爆発を防ぐ
        int beamWidth = 4;
        if (depth == 0) beamWidth = 10;
        else if (depth == 1) beamWidth = 10;
        else if (depth == 2) beamWidth = 8;
        else if (depth == 3) beamWidth = 6;
        else if (depth <= 5) beamWidth = 4;
        else beamWidth = 2; // 6〜10手目は上位2つのみ

        for (const auto& node : currentNodes) {
            std::vector<PairPlacement> placements = getAllPlacements(node.board);
            if (placements.empty()) {
                // ゲームオーバーになる手は極大ペナルティ
                SearchNode deathNode = node;
                deathNode.accumulatedScore -= 999999;
                nextNodes.push_back(deathNode);
                continue;
            }

            for (const auto& p : placements) {
                BitBoard nb = applyPlacement(node.board, p, (uint8_t)pivot, (uint8_t)child);
                ChainResult chain = simulateChain(nb);
                int scoreRaw = evaluateBoard(nb, chain, w, stairsPattern, keyPattern);
                
                int score = scoreRaw;
                if (depth == 0) score = score * w.p1Weight / 100;
                // 未来の手ほどスコアの影響度を割引 (1手につき0.9倍)
                for(int i = 0; i < depth; i++) score = (score * 9) / 10;

                SearchNode nextNode = node;
                nextNode.board = nb;
                nextNode.accumulatedScore += score;
                
                // JSの予想表示用に、最初の3手のアクションだけ保持
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

        // 評価順にソート
        std::sort(nextNodes.begin(), nextNodes.end(), [](const SearchNode& a, const SearchNode& b) {
            return a.accumulatedScore > b.accumulatedScore;
        });

        // 枝刈り
        if ((int)nextNodes.size() > beamWidth) {
            nextNodes.resize(beamWidth);
        }
        currentNodes = nextNodes;

        // 全ルートが死ぬ場合、これ以上深く読んでも無駄なので打ち切り
        if (!currentNodes.empty() && currentNodes[0].accumulatedScore < -900000) {
            break;
        }
    }

    // 最終的に生き残った最善手を出力
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