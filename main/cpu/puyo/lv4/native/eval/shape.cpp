// ─────────────────────────────────────────────
// eval/shape.cpp — Ama 由来の盤面形状ヘルパー + quiescence
// ─────────────────────────────────────────────
#include "eval/shape.h"
#include "core/chain.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

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

int getShape(const int heights[COLS]) {
    static const int coef[COLS] = { 1, 1, 1, -1, -1, -1 };
    int avg = 0;
    for (int i = 0; i < COLS; ++i) avg += heights[i];
    avg /= COLS;
    int shape = 0;
    for (int i = 0; i < COLS; ++i) shape += std::abs(heights[i] - avg - coef[i]);
    return shape;
}

int getWell(const int heights[COLS]) {
    int well = 0;
    if (heights[0] < heights[1]) well += heights[1] - heights[0];
    if (heights[COLS-1] < heights[COLS-2]) well += heights[COLS-2] - heights[COLS-1];
    for (int i = 1; i < COLS - 1; ++i) {
        if (heights[i] < heights[i-1] && heights[i] < heights[i+1])
            well += std::min(heights[i-1], heights[i+1]) - heights[i];
    }
    return well;
}

int getSide(const int heights[COLS]) {
    // Ama eval.cpp:99-102 と同じ。COLS=6 前提（左2列 / 右3列 / 第3列=index2）。
    int heightLeft  = heights[0] + heights[1];
    int heightRight = heights[3] + heights[4] + heights[5];
    return std::max(heightLeft, heightRight) - heights[2];
}

int getBump(const int heights[COLS]) {
    int bump = 0;
    for (int i = 1; i < COLS - 1; ++i) {
        if (heights[i] > heights[i-1] && heights[i] > heights[i+1])
            bump += heights[i] - std::max(heights[i-1], heights[i+1]);
    }
    return bump;
}

void getLink23(const BitBoard& b, int& link2, int& link3) {
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
int calcQuiescenceEval(const BitBoard& b, const int heights[COLS], const EvalWeights& w,
                       int* outChainScore, int* outChainCount) {
    if (outChainScore) *outChainScore = 0;
    if (outChainCount) *outChainCount = 0;
    // 重みが全て0なら計算を省略（性能対策）。
    // ★トラップ注意：この早期returnは outChainScore も 0 のまま返す。outChainScore は
    //   探索側(build.cpp)の chainTarget 巻き上げ＝初手選択の中核信号にも使われるため、
    //   q重みを全て0にすると「quiescenceの評価加点を切る」つもりでも『潜在連鎖の到達価値』
    //   まで失われ、選択が base(構築品質)のみに退化する。q評価だけ無効化したい場合は
    //   どれか1つを微小値に残すか、この早期returnを外して chain.score 走査だけ生かすこと。
    //   （現行デフォルトは q重み非0なので発動しない。）
    if (w.qChainWeight == 0 && w.qYWeight == 0 && w.qKeyWeight == 0 && w.qChiWeight == 0
        && w.qLink2Weight == 0 && w.qLink3Weight == 0) return 0;

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
                // ★ 実際の着地行に積む。calcDropRow は内部行（11=床..0=天井）を返し、
                //   可視フィールドが満杯なら -1（=HIDDEN行へは積まない）。
                //   旧実装は heights[x]+i で「絶対行HIDDEN=床」と誤仮定し上下反転していた
                //   （高さ≥6で既存ぷよを上書き＝幻の潜在連鎖／高さ<6で浮いて取りこぼし）。
                int row = calcDropRow(plan, x);
                if (row < 0) break;
                int ar = row + HIDDEN;           // 着地マスの絶対行
                plan.set(x, ar, color);
                placed++;
                // この列に4連結が出来たか（軽量チェック）
                if (hasGroup4At(plan, x, ar, color)) { trig = true; break; }
            }
            if (!trig) continue;

            BitBoard sim = plan;
            ChainResult chain = simulateChain(sim);
            if (chain.chains <= 0) continue;

            // 「キーぷよ1個で着火できる連鎖」だけを potChain として巻き上げる。
            //   placed>=2（単色を複数積まないと着火しない＝まだ組み途中／ペアでは作りにくい）は
            //   selChain に計上しない。これにより selChain は常に「いま発火ツモ1個で撃てる連鎖」
            //   を意味し、「理論上は届くが実際にはペアで作れない」幻の潜在を排除する。
            //   ※ 下の q 評価（構築品質）は placed 1..3 を使い続ける＝組み途中の連鎖も育てる。
            if (placed == 1 && outChainScore && chain.score > *outChainScore) {
                *outChainScore = chain.score;
                if (outChainCount) *outChainCount = chain.chains;  // 同候補の段数（期待連鎖数）
            }

            int q = 0;
            q += chain.chains * w.qChainWeight;   // 連鎖数
            q += heights[x]   * w.qYWeight;        // 発火列高さ
            q += placed       * w.qKeyWeight;      // 必要追加ぷよ数（負重み）
            q += getChi(heights, x) * w.qChiWeight; // 伸長余地

            // ── 発火直前盤面(remain)の連結数（Ama eval.cpp:62-65 の remain link）──
            //   plan は key ぷよを落とした pop 前の盤面＝ama の quiet.remain に相当。
            //   発火直前の形に2/3連結がどれだけ仕込まれているか＝次連鎖の種を評価する。
            if (w.qLink2Weight != 0 || w.qLink3Weight != 0) {
                int rl2, rl3;
                getLink23(plan, rl2, rl3);
                q += rl2 * w.qLink2Weight;
                q += rl3 * w.qLink3Weight;
            }

            if (!found || q > best) { best = q; found = true; }
        }
    }
    return found ? best : 0;
}
