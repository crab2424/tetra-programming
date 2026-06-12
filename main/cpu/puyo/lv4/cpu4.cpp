// ─────────────────────────────────────────────
// cpu4.cpp
// ぷよCPU lv4 - Web Worker + Wasm 版
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

// スコア計算用テーブル
const int SCORE_BASE = 10;
const int CHAIN_BONUS_TABLE[] = {0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512};
const int COLOR_BONUS_TABLE[] = {0, 3, 6, 12, 24};
const int GROUP_BONUS_TABLE[] = {0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 10};

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
    int score; 
};

static ChainResult simulateChain(BitBoard& b) {
    ChainResult res = {0, 0, 0, 0};
    static bool visited[TOTAL_ROWS][COLS];

    while (true) {
        memset(visited, 0, sizeof(visited));
        std::vector<std::pair<int,int>> toErase; 
        std::vector<std::pair<int,int>> toEraseOjama;
        bool found = false;

        int stepErasedPuyo = 0;
        int usedColorBitmask = 0;
        int groupBonusSum = 0;

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
                    
                    stepErasedPuyo += (int)group.size();
                    usedColorBitmask |= (1 << color);
                    int gSize = (int)group.size();
                    int gbIdx = std::min(gSize, 11);
                    groupBonusSum += GROUP_BONUS_TABLE[gbIdx];

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

        int cbIdx = std::min(std::max(0, res.chains - 1), 18);
        int cb = CHAIN_BONUS_TABLE[cbIdx];

        int colorCount = 0;
        for (int i = 1; i <= 5; i++) {
            if (usedColorBitmask & (1 << i)) colorCount++;
        }
        int colorIdx = std::min(std::max(0, colorCount - 1), 4);
        int colorB = COLOR_BONUS_TABLE[colorIdx];

        int bonus = std::max(1, cb + colorB + groupBonusSum);
        res.score += SCORE_BASE * stepErasedPuyo * bonus;

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
    int maxScore; 
    int triggerCol;
    int triggerRow;
    uint8_t triggerColor;
    bool isSafe; 
};

static PotentialInfo calcChainPotential(const BitBoard& b) {
    PotentialInfo best = {0, 0, -1, -1, 0, false};
    for (int col = 0; col < COLS; col++) {
        int r = calcDropRow(b, col);
        if (r < 0) continue;
        
        for (uint8_t color = 1; color <= 5; color++) {
            BitBoard tmp = b;
            tmp.set(col, r + HIDDEN, color);
            ChainResult res = simulateChain(tmp);
            
            if (res.score > best.maxScore || (res.score == best.maxScore && res.chains > best.maxChains)) {
                best.maxScore = res.score;
                best.maxChains = res.chains;
                best.triggerCol = col;
                best.triggerRow = r;
                best.triggerColor = color;
            }
        }
    }
    
    if (best.maxChains > 0 || best.maxScore > 0) {
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
// ─────────────────────────────
// 【報酬 (reward)】
//   配置前後の盤面を比較し、配置後にのみ現れた変化に対して1回だけ加算する。
//   chainBonus, erasedBonus, zenkeshiBonus, chainPotentialBonus, templateBonus
//
// 【評価値 (eval)】
//   配置後の盤面状態をそのまま毎ターン評価する。
//   heightPenalty, heightDiffPenalty, flatBonus, colorConnBonus
//
// 【制御パラメータ】
//   p1Weight, ignitionThreshold, emergencyHeight, ignitionScoreThreshold
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct EvalWeights {
    // ── 報酬 (reward) ──
    int chainBonus;           // 発火連鎖ボーナス（1手限り）
    int erasedBonus;          // 消去ぷよ数ボーナス（1手限り）
    int zenkeshiBonus;        // 全消しボーナス（1手限り）
    int chainPotentialBonus;  // 連鎖ポテンシャル増加ボーナス（差分）
    int templateBonus;        // テンプレート一致ボーナス（差分）

    // ── 評価値 (eval) ──
    int heightPenalty;        // 高さペナルティ（毎ターン）
    int heightDiffPenalty;    // 高さ差ペナルティ（毎ターン）
    int flatBonus;            // 平坦ボーナス（毎ターン）
    int colorConnBonus;       // 同色隣接ボーナス（毎ターン）

    // ── 制御パラメータ ──
    int p1Weight;
    int ignitionThreshold;
    int emergencyHeight;
    int ignitionScoreThreshold;

    // ── Ama 由来の評価値（毎ターン・加算式・0で無効化可能）──
    // 参考: source_assets/puyoAI/ama-beam/ai/search/beam/eval.cpp
    int shapeWeight;    // [13] 理想L字形(左3列高/右3列低)からの偏差ペナルティ（負）
    int wellWeight;     // [14] 井戸(両隣より低い列)の深さペナルティ（負）
    int bumpWeight;     // [15] 凸(両隣より高い列)ペナルティ（負）
    int qChainWeight;   // [16] quiescence: 連鎖ポテンシャル数ボーナス（正）
    int qYWeight;       // [17] quiescence: 発火列の高さボーナス（正＝高く積める連鎖を評価）
    int qKeyWeight;     // [18] quiescence: 発火に必要な追加ぷよ数ペナルティ（負）
    int qChiWeight;     // [19] quiescence: 発火点の左右伸長余地ボーナス（正）
    int link2Weight;    // [20] 2連結ボーナス（正）
    int link3Weight;    // [21] 3連結ボーナス（正・発火直前形に近く価値大）
};

static int getTemplateScore(const BitBoard& b, const uint8_t* pattern, int templateBonus, bool isGtr) {
    uint8_t colorOfGroup[8] = {0}; 
    bool broken = false;
    int matchScore = 0; 
    const int TEMPLATE_TOP_ROW = 8; 

    for (int row = 0; row < 4; row++) {
        for (int col = 0; col < COLS; col++) {
            int idx = row * COLS + col;
            uint8_t g = pattern[idx];
            if (g == 0) continue; 
            
            int r = (TEMPLATE_TOP_ROW + row) + HIDDEN;
            if (r < 0 || r >= TOTAL_ROWS) continue;
            
            uint8_t c = b.get(col, r);
            if (c >= 1 && c <= 5) {
                int weight = 1;
                
                if (isGtr && col < 3 && row >= 1) {
                    weight = 10; 
                    
                    if (row == 3 && col < 2) {
                        weight = 50; 
                    }
                }

                if (g == 6) {
                    matchScore += weight;
                } else {
                    if (colorOfGroup[g] != 0 && colorOfGroup[g] != c) {
                        broken = true; break;
                    }
                    colorOfGroup[g] = c;
                    matchScore += weight;
                }
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
            if (g1 == 0 || g1 == 6) continue; 
            uint8_t c1 = colorOfGroup[g1];
            if (c1 == 0) continue; 

            if (col + 1 < COLS) {
                uint8_t g2 = pattern[row * COLS + col + 1];
                if (g2 >= 1 && g2 <= 5 && g1 != g2 && colorOfGroup[g2] != 0 && c1 == colorOfGroup[g2]) {
                    broken = true; break;
                }
            }
            if (row + 1 < 4) {
                uint8_t g2 = pattern[(row + 1) * COLS + col];
                if (g2 >= 1 && g2 <= 5 && g1 != g2 && colorOfGroup[g2] != 0 && c1 == colorOfGroup[g2]) {
                    broken = true; break;
                }
            }
        }
        if (broken) break;
    }

    if (broken) return 0;
    return matchScore * templateBonus;
}

static int calcTemplateScore(const BitBoard& b, const uint8_t* gtrPattern, const uint8_t* keyPattern, int templateBonus) {
    if (templateBonus <= 0) return 0;
    int scoreGtr = getTemplateScore(b, gtrPattern, templateBonus, true);
    int scoreKey = getTemplateScore(b, keyPattern, templateBonus, false);
    return std::max(scoreGtr, scoreKey);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Ama 由来のヘルパー（スカラ移植）
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/eval.cpp / quiet.cpp
//   SIMD/threadは移植せず、現lv4のスカラbitboardで同等の評価を再現する。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 発火点 x が左右にどれだけ伸ばせるか（隣列が発火点以下で連続する数）
static int getChi(const int heights[COLS], int x) {
    int chi = 0;
    if (x < COLS - 1) {
        for (int i = x + 1; i < COLS; ++i) { if (heights[i] >  heights[x]) break; chi++; }
        for (int i = x + 1; i < COLS; ++i) { if (heights[i] >= heights[x]) break; chi++; }
    }
    if (x > 0) {
        for (int i = x - 1; i >= 0; --i) { if (heights[i] >  heights[x]) break; chi++; }
        for (int i = x - 1; i >= 0; --i) { if (heights[i] >= heights[x]) break; chi++; }
    }
    return chi;
}

// 理想L字形 coef={1,1,1,-1,-1,-1}（左3列高・右3列低＝GTR土台）からの高さ偏差
static int getShape(const int heights[COLS]) {
    static const int coef[COLS] = { 1, 1, 1, -1, -1, -1 };
    int avg = 0;
    for (int i = 0; i < COLS; ++i) avg += heights[i];
    avg /= COLS;
    int shape = 0;
    for (int i = 0; i < COLS; ++i) shape += std::abs(heights[i] - avg - coef[i]);
    return shape;
}

// 井戸の深さ（両隣より低い列の落差合計）。端列は片隣のみで判定。
static int getWell(const int heights[COLS]) {
    int well = 0;
    if (heights[0] < heights[1]) well += heights[1] - heights[0];
    if (heights[COLS-1] < heights[COLS-2]) well += heights[COLS-2] - heights[COLS-1];
    for (int i = 1; i < COLS - 1; ++i) {
        if (heights[i] < heights[i-1] && heights[i] < heights[i+1])
            well += std::min(heights[i-1], heights[i+1]) - heights[i];
    }
    return well;
}

// 凸（両隣より高い列の突出合計）
static int getBump(const int heights[COLS]) {
    int bump = 0;
    for (int i = 1; i < COLS - 1; ++i) {
        if (heights[i] > heights[i-1] && heights[i] > heights[i+1])
            bump += heights[i] - std::max(heights[i-1], heights[i+1]);
    }
    return bump;
}

// 2連結・3連結の数を数える（各連結ぷよが属する連結成分サイズで分類）
//   size==2 → link_2、size>=3 → link_3。おじゃま(6)は除外。
static void getLink23(const BitBoard& b, int& link2, int& link3) {
    link2 = 0; link3 = 0;
    static bool seen[TOTAL_ROWS][COLS];
    memset(seen, 0, sizeof(seen));
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = { 0, 0,-1, 1};
    for (int r = HIDDEN; r < TOTAL_ROWS; ++r) {
        for (int c = 0; c < COLS; ++c) {
            if (seen[r][c]) continue;
            uint8_t color = b.get(c, r);
            if (color == 0 || color == 6) continue;
            // 連結成分をBFS
            std::vector<std::pair<int,int>> stack;
            stack.push_back({r, c});
            seen[r][c] = true;
            int size = 0;
            while (!stack.empty()) {
                auto [cr, cc] = stack.back(); stack.pop_back();
                size++;
                for (int d = 0; d < 4; ++d) {
                    int nr = cr + dr[d], nc = cc + dc[d];
                    if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                    if (seen[nr][nc]) continue;
                    if (b.get(nc, nr) != color) continue;
                    seen[nr][nc] = true;
                    stack.push_back({nr, nc});
                }
            }
            if (size == 2) link2++;
            else if (size == 3) link3++;
        }
    }
}

// (col,row) を含む同色連結成分が4以上か（軽量チェック・全消去シミュ不要）
static bool hasGroup4At(const BitBoard& b, int col, int row, uint8_t color) {
    static bool seen[TOTAL_ROWS][COLS];
    memset(seen, 0, sizeof(seen));
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = { 0, 0,-1, 1};
    std::vector<std::pair<int,int>> stack;
    stack.push_back({row, col});
    seen[row][col] = true;
    int size = 0;
    while (!stack.empty()) {
        auto [cr, cc] = stack.back(); stack.pop_back();
        if (++size >= 4) return true;
        for (int d = 0; d < 4; ++d) {
            int nr = cr + dr[d], nc = cc + dc[d];
            if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
            if (seen[nr][nc]) continue;
            if (b.get(nc, nr) != color) continue;
            seen[nr][nc] = true;
            stack.push_back({nr, nc});
        }
    }
    return false;
}

// quiescence: 各列に同色を最大3個まで（4連結が出来るまで）落として連鎖を試し、
//   連鎖数・発火列高さ・必要追加ぷよ数(key)・伸長余地(chi) を q スコア化して最大値を返す。
//   原典 quiet.cpp の探索を bounded 列範囲でスカラ再現。
static const int MAX_QDROP = 3;
static int calcQuiescenceEval(const BitBoard& b, const int heights[COLS], const EvalWeights& w) {
    // 重みが全て0なら計算を省略（性能対策）
    if (w.qChainWeight == 0 && w.qYWeight == 0 && w.qKeyWeight == 0 && w.qChiWeight == 0) return 0;

    // 発火可能な列範囲（11段以下まで）
    int xMin = 2, xMax = 2;
    for (int x = 3; x < COLS; ++x) { if (heights[x] > 11) break; xMax++; }
    for (int x = 1; x >= 0; --x)  { if (heights[x] > 11) break; xMin--; }

    int best = 0;
    bool found = false;

    for (int x = xMin; x <= xMax; ++x) {
        int dropMax = std::min(MAX_QDROP, 12 - heights[x]);
        if (dropMax <= 0) continue;

        for (uint8_t color = 1; color <= 5; ++color) {
            BitBoard plan = b;
            int placed = 0;
            bool trig = false;
            for (int i = 0; i < dropMax; ++i) {
                int row = heights[x] + i;        // 内部下基準の高さ
                plan.set(x, row + HIDDEN, color);
                placed++;
                // この列に4連結が出来たか（軽量チェック）
                if (hasGroup4At(plan, x, row + HIDDEN, color)) { trig = true; break; }
            }
            if (!trig) continue;

            BitBoard sim = plan;
            ChainResult chain = simulateChain(sim);
            if (chain.chains <= 0) continue;

            int q = 0;
            q += chain.chains * w.qChainWeight;   // 連鎖数
            q += heights[x]   * w.qYWeight;        // 発火列高さ
            q += placed       * w.qKeyWeight;      // 必要追加ぷよ数（負重み）
            q += getChi(heights, x) * w.qChiWeight; // 伸長余地

            if (!found || q > best) { best = q; found = true; }
        }
    }
    return found ? best : 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 【評価値】盤面状態スコア計算（毎ターン加算）
//   配置後の盤面状態のみを見て評価する。
//   報酬パラメータは含まない。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int calcEvalScore(const BitBoard& b, const EvalWeights& w, const int heights[COLS]) {
    int score = 0;

    // 高さペナルティ（3列目は特に重要）
    if (heights[2] >= 8) score += (heights[2] - 7) * w.heightPenalty; 
    for (int c = 0; c < COLS; c++) {
        if (heights[c] >= 10) score += (heights[c] - 9) * (w.heightPenalty / 3);
    }

    // 隣接列の高さ差ペナルティ・平坦ボーナス
    for (int c = 0; c < COLS - 1; c++) {
        int diff = std::abs(heights[c] - heights[c+1]);
        score += diff * w.heightDiffPenalty;
        if (diff == 0) score += w.flatBonus;
    }

    // 同色隣接ボーナス
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

    // ── Ama 由来の盤面形状評価（加算式・各重み0で無効化）──
    if (w.shapeWeight != 0) score += getShape(heights) * w.shapeWeight;
    if (w.wellWeight  != 0) score += getWell(heights)  * w.wellWeight;
    if (w.bumpWeight  != 0) score += getBump(heights)  * w.bumpWeight;

    // 2連結/3連結（3連結は発火直前形に近いので別重み）
    if (w.link2Weight != 0 || w.link3Weight != 0) {
        int l2, l3;
        getLink23(b, l2, l3);
        score += l2 * w.link2Weight;
        score += l3 * w.link3Weight;
    }

    // quiescence による連鎖ポテンシャル評価（連鎖の組みやすさを毎ターン誘導）
    score += calcQuiescenceEval(b, heights, w);

    return score;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 【報酬】配置による変化スコア計算（1手限り）
//   配置前後の差分として初めて現れた変化にのみ加算する。
//   chainBonus, erasedBonus: 連鎖は配置により初めて発生するため差分不要。
//   chainPotentialBonus: 配置前後のポテンシャル差分で計算。
//   zenkeshiBonus: 配置後に全消しが成立した場合のみ加算。
//   templateBonus: 配置前後のテンプレートスコア差分で計算。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int calcRewardScore(
    const BitBoard& postBoard,          // 配置後の盤面
    const ChainResult& chain,           // 配置後の連鎖結果
    const EvalWeights& w,
    const uint8_t* gtrPattern,
    const uint8_t* keyPattern,
    const PotentialInfo& prePot,        // 配置前のポテンシャル
    int preTemplateScore,               // 配置前のテンプレートスコア
    bool isEmergencyPre,                // ★ 配置前の盤面で判定した緊急事態フラグ
    int currentIgnitionThreshold,
    int currentIgnitionScoreThreshold
) {
    int score = 0;
    bool isIgnitionMode = (prePot.maxChains >= currentIgnitionThreshold || prePot.maxScore >= currentIgnitionScoreThreshold);

    // ── chainBonus / erasedBonus ──
    // 連鎖は配置により初めて発生するので前後差分は不要。発火条件に応じて1回だけ加算。
    if (chain.chains > 0) {
        bool triggersIgnition = (chain.chains >= currentIgnitionThreshold || chain.score >= currentIgnitionScoreThreshold);
        bool fulfillsPotential = isIgnitionMode && (chain.chains >= prePot.maxChains || chain.score >= prePot.maxScore);

        if (triggersIgnition || fulfillsPotential) {
            int effectiveChains = std::max(chain.chains, prePot.maxChains);
            score += (effectiveChains * effectiveChains * effectiveChains) * w.chainBonus * 10;
            score += (chain.score / 100) * w.chainBonus; 
            score += chain.totalErased * std::abs(w.erasedBonus);
        } else if (isEmergencyPre || postBoard.isEmptyAll()) {
            score += (chain.chains * chain.chains) * w.chainBonus * 5;
            score += (chain.score / 100) * w.chainBonus / 2;
            score += chain.totalErased * std::abs(w.erasedBonus);

            // ★ 緊急事態時は、連鎖後に3列目（致死列）の高さが低いほど特大ボーナスを与える
            if (isEmergencyPre) {
                int postH2 = 0;
                for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
                    if (postBoard.get(2, r) != 0) postH2++;
                }
                int col2_reduction = std::max(0, 12 - postH2);
                score += col2_reduction * 20000; 
            }
        } else if (isIgnitionMode) {
            PotentialInfo postPot = calcChainPotential(postBoard);
            bool keepsPotential = (postPot.maxChains >= currentIgnitionThreshold || postPot.maxScore >= currentIgnitionScoreThreshold);
            if (keepsPotential && postPot.isSafe) {
                score += chain.totalErased * std::abs(w.erasedBonus);
            } else {
                score -= (chain.chains * chain.chains) * 5000;
            }
        } else {
            score -= (chain.chains * chain.chains) * 5000;
        }
    }

    // ── zenkeshiBonus ──
    // 配置後に全消しが成立した場合のみ1回加算。
    if (postBoard.isEmptyAll()) score += w.zenkeshiBonus;

    // ── chainPotentialBonus ──
    // 配置後のポテンシャルを計算し、配置前からの増加分（差分）に対して報酬を与える。
    if (chain.chains == 0) {
        // 連鎖が起きなかった場合のみ（連鎖時はchainBonusで評価済み）
        PotentialInfo postPot = calcChainPotential(postBoard);
        int postPotScore = postPot.maxScore;
        int postPotChains = postPot.maxChains;
        // 差分：配置後が配置前を上回った分だけ報酬
        int potChainGain = postPotChains - prePot.maxChains;
        int potScoreGain = postPotScore  - prePot.maxScore;

        if (isIgnitionMode) {
            bool keepsPotential = (postPotChains >= currentIgnitionThreshold || postPotScore >= currentIgnitionScoreThreshold);
            if (keepsPotential) {
                if (postPot.isSafe) {
                    // ポテンシャルを維持できているので、絶対値でも報酬を与える（維持自体に価値がある）
                    score += (postPotChains * postPotChains) * w.chainPotentialBonus * 5;
                    score += (postPotScore / 1000) * w.chainPotentialBonus; 
                } else {
                    score -= 10000;
                }
            } else {
                score -= 10000;
            }
        } else {
            if (postPotChains > 0 || postPotScore > 0) {
                if (postPot.isSafe) {
                    if (postPotChains >= currentIgnitionThreshold || postPotScore >= currentIgnitionScoreThreshold) {
                        // 発火閾値に到達した場合は大きな報酬（絶対値＋差分）
                        score += (postPotChains * postPotChains) * w.chainPotentialBonus * 5;
                        score += (postPotScore / 1000) * w.chainPotentialBonus * 2;
                        score += std::max(0, potChainGain) * w.chainPotentialBonus;
                        score += std::max(0, potScoreGain / 1000) * w.chainPotentialBonus;
                    } else {
                        // 閾値未満は差分のみ報酬
                        score += std::max(0, potChainGain) * w.chainPotentialBonus;
                        score += std::max(0, potScoreGain / 1000) * w.chainPotentialBonus;
                    }
                } else {
                    // 発火点が不安定な場合は半額
                    score += std::max(0, potChainGain) * (w.chainPotentialBonus / 2);
                }
            }
        }
    }

    // ── templateBonus ──
    // 配置前後のテンプレートスコア差分に対して報酬を与える。
    if (gtrPattern != nullptr && keyPattern != nullptr && w.templateBonus > 0) {
        int postTemplateScore = calcTemplateScore(postBoard, gtrPattern, keyPattern, w.templateBonus);
        int templateGain = postTemplateScore - preTemplateScore;
        if (templateGain > 0) score += templateGain;
    }

    return score;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 盤面評価関数
//   報酬（1手限り）と評価値（毎ターン）を合算して返す。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int evaluateBoard(
    const BitBoard& preBoard,           // 配置前の盤面（報酬差分計算用）
    const BitBoard& postBoard,          // 配置後の盤面
    const ChainResult& chain,
    const EvalWeights& w,
    const uint8_t* gtrPattern,
    const uint8_t* keyPattern,
    const PotentialInfo& prePot,        // 配置前のポテンシャル（searchBestMove側で計算済み）
    bool isEmergencyPre                 // ★ 配置前の盤面で判定した緊急事態フラグ
) {
    // ── 配置後の高さを計算（評価値・緊急報酬で共用）
    int heights[COLS];
    for (int c = 0; c < COLS; c++) {
        heights[c] = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (postBoard.get(c, r) != 0) heights[c]++;
        }
    }

    // ── 発火閾値（緊急時は緩和）
    // ★ 連鎖前の判定（isEmergencyPre）を使用する
    int currentIgnitionThreshold      = isEmergencyPre ? 1 : w.ignitionThreshold;
    int currentIgnitionScoreThreshold = isEmergencyPre ? 0 : w.ignitionScoreThreshold;

    // ── 配置前のテンプレートスコア（templateBonus差分計算用）
    int preTemplateScore = (gtrPattern != nullptr && keyPattern != nullptr && w.templateBonus > 0)
        ? calcTemplateScore(preBoard, gtrPattern, keyPattern, w.templateBonus)
        : 0;

    // ── 【報酬】1手限りの変化に対するスコア
    int rewardScore = calcRewardScore(
        postBoard, chain, w,
        gtrPattern, keyPattern,
        prePot, preTemplateScore,
        isEmergencyPre,
        currentIgnitionThreshold, currentIgnitionScoreThreshold
    );

    // ── 【評価値】配置後の盤面状態スコア（毎ターン）
    int evalScore = calcEvalScore(postBoard, w, heights);

    return rewardScore + evalScore;
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
    uint8_t* gtrPattern,    
    uint8_t* keyPattern     
) {
    for (int i = 0; i < 7; i++) outResult[i] = -1;

    EvalWeights w;
    // ── 報酬 (reward) ──
    w.chainBonus          = weightsArray[0];
    w.erasedBonus         = weightsArray[1];
    w.zenkeshiBonus       = weightsArray[6];
    w.chainPotentialBonus = weightsArray[7];
    w.templateBonus       = weightsArray[9];
    // ── 評価値 (eval) ──
    w.heightPenalty       = weightsArray[2];
    w.heightDiffPenalty   = weightsArray[3];
    w.flatBonus           = weightsArray[4];
    w.colorConnBonus      = weightsArray[5];
    // ── 制御パラメータ ──
    w.p1Weight            = weightsArray[8];
    w.ignitionThreshold   = weightsArray[10];
    w.emergencyHeight     = weightsArray[11];
    w.ignitionScoreThreshold = weightsArray[12];
    // ── Ama 由来の評価値 ──
    w.shapeWeight         = weightsArray[13];
    w.wellWeight          = weightsArray[14];
    w.bumpWeight          = weightsArray[15];
    w.qChainWeight        = weightsArray[16];
    w.qYWeight            = weightsArray[17];
    w.qKeyWeight          = weightsArray[18];
    w.qChiWeight          = weightsArray[19];
    w.link2Weight         = weightsArray[20];
    w.link3Weight         = weightsArray[21];

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

            // ★ 配置前（連鎖前）の盤面で緊急事態かどうかを判定する
            bool isEmergencyPre = false;
            int avgH = 0;
            int col2H = 0;
            for (int c = 0; c < COLS; c++) {
                int h = 0;
                for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
                    if (node.board.get(c, r) != 0) h++;
                }
                avgH += h;
                if (c == 2) col2H = h;
            }
            avgH /= COLS;
            if (avgH >= w.emergencyHeight || col2H >= 9) {
                isEmergencyPre = true;
            }

            PotentialInfo prePot = calcChainPotential(node.board);

            for (const auto& p : placements) {
                BitBoard nb = applyPlacement(node.board, p, (uint8_t)pivot, (uint8_t)child);
                ChainResult chain = simulateChain(nb);
                
                // ★ 配置前の盤面（node.board）と配置後の盤面（nb）を両方渡す
                //    報酬は前後差分で、評価値は配置後のみで計算される
                int scoreRaw = evaluateBoard(node.board, nb, chain, w, gtrPattern, keyPattern, prePot, isEmergencyPre);
                
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