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

Link3Counts getLink23(const BitBoard& b) {
    Link3Counts out = {0, 0, 0, 0};
    static thread_local bool seen[TOTAL_ROWS][COLS];   // thread_local: 学習用ネイティブ並列ビルド向け（wasm では static と同じ）
    memset(seen, 0, sizeof(seen));
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = { 0, 0,-1, 1};
    for (int r = HIDDEN; r < TOTAL_ROWS; ++r) {
        for (int c = 0; c < COLS; ++c) {
            if (seen[r][c]) continue;
            uint8_t color = b.get(c, r);
            if (color == 0 || color == 6) continue;
            // 連結成分をBFS（scan順より seed(r,c)＝この成分の最上段・最左セル）
            std::vector<std::pair<int,int>> stack;
            stack.push_back({r, c});
            seen[r][c] = true;
            int size = 0;
            // 3連結の形状判定: 全セルが seed と同一行なら横一直線、同一列なら縦一直線、
            //   どちらでもなければ L字（折れ）。比較はセル毎に2回だけ＝追加コストはほぼ無い。
            bool sameRow = true, sameCol = true;
            while (!stack.empty()) {
                auto [cr, cc] = stack.back(); stack.pop_back();
                size++;
                if (cr != r) sameRow = false;  // seed と異なる行が出たら横一直線でない
                if (cc != c) sameCol = false;  // seed と異なる列が出たら縦一直線でない
                for (int d = 0; d < 4; ++d) {
                    int nr = cr + dr[d], nc = cc + dc[d];
                    if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                    if (seen[nr][nc]) continue;
                    if (b.get(nc, nr) != color) continue;
                    seen[nr][nc] = true;
                    stack.push_back({nr, nc});
                }
            }
            if (size == 2) out.link2++;
            else if (size == 3) {
                if      (sameRow) out.l3H++;  // 全セル同一行＝横一直線
                else if (sameCol) out.l3V++;  // 全セル同一列＝縦一直線
                else              out.l3L++;  // それ以外＝L字（折れ）
            }
        }
    }
    return out;
}

// (col,row) を含む同色連結成分が4以上か（軽量チェック・全消去シミュ不要）
static bool hasGroup4At(const BitBoard& b, int col, int row, uint8_t color) {
    static thread_local bool seen[TOTAL_ROWS][COLS];   // thread_local: 学習用ネイティブ並列ビルド向け（wasm では static と同じ）
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

// ── 副砲・ゴミの評価（提案3 E2a/E2b）──
//   本線 M：quiescence の候補のうち点が最大の潜在連鎖で消えるぷよ（連鎖前の位置）。
//   副砲 S：消えるぷよが M と交わらず、かつ M のどのぷよの下も消さない（＝撃っても M が落ちない）候補の最大。
//           途中まで本線を綺麗に組み、崩れた場所は本線とは別の連鎖（副砲）として組む、をねらう。
//   ゴミ  ：色ぷよ − M − S（どちらの連鎖にも使っていない色ぷよ）。
//   E2a = ゴミ × 埋まり具合（色ぷよ ÷ 72）× qJunkWeight（負）… 序盤の組み途中は軽く、盤面が埋まるほど重く。
//   E2b = 副砲で送れるおじゃま（点 ÷ 70）× qSubWeight（正）。
//   ※ 発火色を積んだマス（盤面に無い位置）は M・S に数えない。
//   G1/G2（lv6-harass-design.md §10.3。既定0＝条件なし）：E2b は次をすべて満たすときだけ足す。
//     本線 M の段数 ≥ subMinMainChains・M の色ぷよ数 ≥ subMinMainPuyos（本線をある程度組んでから副砲）、
//     盤面の色ぷよ数 ≥ subMinFill（それ以上の構築が難しくなってから副砲ゾーンを設ける）。
static const int OJAMA_RATE = 70;
struct QuietPop { CellMask mask; int score; int chains; };   // quiescence の1候補：消えたぷよ（連鎖前の位置）・点・段数
static int calcSubJunkEval(const BitBoard& b, const EvalWeights& w, const QuietPop* pops, int nPops,
                           MainSubInfo* info) {
    CellMask occupied, colored;
    int nColor = 0;
    for (int r = HIDDEN; r < TOTAL_ROWS; ++r) {
        for (int c = 0; c < COLS; ++c) {
            uint8_t v = b.get(c, r);
            if (v == 0) continue;
            occupied.set(r, c);
            if (v != 6) { colored.set(r, c); nColor++; }
        }
    }
    // 本線 M＝点が最大の候補
    int mainIdx = -1;
    for (int i = 0; i < nPops; ++i) if (mainIdx < 0 || pops[i].score > pops[mainIdx].score) mainIdx = i;
    CellMask M;
    if (mainIdx >= 0) M = pops[mainIdx].mask & occupied;
    // 列ごとの M の最上段（行番号が小さいほど上）。M の無い列は TOTAL_ROWS（どこを消してもよい）
    int topM[COLS];
    for (int c = 0; c < COLS; ++c) {
        topM[c] = TOTAL_ROWS;
        for (int r = HIDDEN; r < TOTAL_ROWS; ++r) if (M.test(r, c)) { topM[c] = r; break; }
    }
    // 副砲 S＝M と交わらず、M の下を消さない候補のうち点が最大のもの
    int subIdx = -1;
    for (int i = 0; i < nPops; ++i) {
        if (i == mainIdx) continue;
        CellMask s = pops[i].mask & occupied;
        if (!s.any() || (s & M).any()) continue;
        bool undermines = false;
        for (int r = HIDDEN; r < TOTAL_ROWS && !undermines; ++r)
            for (int c = 0; c < COLS; ++c)
                if (s.test(r, c) && r > topM[c]) { undermines = true; break; }
        if (undermines) continue;
        if (subIdx < 0 || pops[i].score > pops[subIdx].score) subIdx = i;
    }
    CellMask S;
    if (subIdx >= 0) S = pops[subIdx].mask & occupied;

    int score = 0;
    int mainPuyos = (M & colored).count();
    if (w.qJunkWeight != 0) {
        int junk = nColor - mainPuyos - (S & colored).count();
        score += junk * nColor * w.qJunkWeight / 72;
    }
    bool subAllowed = mainIdx >= 0 && pops[mainIdx].chains >= w.subMinMainChains &&
                      mainPuyos >= w.subMinMainPuyos && nColor >= w.subMinFill;
    if (w.qSubWeight != 0 && subIdx >= 0 && subAllowed) score += (pops[subIdx].score / OJAMA_RATE) * w.qSubWeight;
    if (info) {
        info->mainChains = mainIdx >= 0 ? pops[mainIdx].chains : 0;
        info->mainPuyos  = mainPuyos;
        info->subScore   = subIdx >= 0 ? pops[subIdx].score : 0;
        info->colored    = nColor;
        info->subAllowed = subAllowed;
    }
    return score;
}

// 発火点の保全（提案5。設計: lv6-harass-design.md §13.4）：盤面 b の全列におじゃまを rows 段載せた仮の盤面で、
//   quiescence と同じ探し方（発火できる各列に同色を1〜3個）で起こせる最大連鎖の点。致死セルが埋まるなら 0。
static const int MAX_QDROP_KEEP = 3;
static int keepIgnitionScore(const BitBoard& b, int rows) {
    BitBoard ob = b;
    for (int c = 0; c < COLS; ++c)
        for (int i = 0; i < rows; ++i) {
            int row = calcDropRow(ob, c);
            if (row < 0) break;
            ob.set(c, row + HIDDEN, 6);
        }
    if (ob.get(2, HIDDEN) != 0) return 0;   // 降ったら窒息する
    int h[COLS];
    for (int c = 0; c < COLS; ++c) {
        h[c] = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; ++r) if (ob.get(c, r) != 0) h[c]++;
    }
    int xMin = 2, xMax = 2;
    for (int x = 3; x < COLS; ++x) { if (h[x] > 11) break; xMax++; }
    for (int x = 1; x >= 0; --x)  { if (h[x] > 11) break; xMin--; }
    int best = 0;
    for (int x = xMin; x <= xMax; ++x) {
        int dropMax = std::min(MAX_QDROP_KEEP, 12 - h[x]);
        for (uint8_t color = 1; color <= 5; ++color) {
            BitBoard plan = ob;
            bool trig = false;
            for (int i = 0; i < dropMax; ++i) {
                int row = calcDropRow(plan, x);
                if (row < 0) break;
                plan.set(x, row + HIDDEN, color);
                if (hasGroup4At(plan, x, row + HIDDEN, color)) { trig = true; break; }
            }
            if (!trig) continue;
            ChainResult chain = simulateChain(plan);
            if (chain.score > best) best = chain.score;
        }
    }
    return best;
}

// quiescence: 各列に同色を最大3個まで（4連結が出来るまで）落として連鎖を試し、
//   連鎖数・発火列高さ・必要追加ぷよ数(key)・伸長余地(chi) を q スコア化して最大値を返す。
//   原典 quiet.cpp の探索を bounded 列範囲でスカラ再現。
static const int MAX_QDROP = 3;
int calcQuiescenceEval(const BitBoard& b, const int heights[COLS], const EvalWeights& w,
                       int* outChainScore, int* outChainCount, MainSubInfo* outMainSub) {
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
        && w.qLink2Weight == 0 && w.qLink3Weight == 0 && w.qExcessWeight == 0
        && w.qJunkWeight == 0 && w.qSubWeight == 0 && w.qKeepWeight == 0 && !outMainSub) return 0;

    // ── 副砲・ゴミ（提案3 E2a/E2b。設計: lv6-harass-design.md §9.3）──
    //   どちらかの重みが非0のときだけ、各候補の「消えたぷよの元の位置」を追跡する（既定0なら従来と同じ速さ）。
    const bool trackPop = (w.qJunkWeight != 0 || w.qSubWeight != 0 || outMainSub);
    QuietPop pops[COLS * 5];
    int nPops = 0;

    // 発火可能な列範囲（11段以下まで）
    int xMin = 2, xMax = 2;
    for (int x = 3; x < COLS; ++x) { if (heights[x] > 11) break; xMax++; }
    for (int x = 1; x >= 0; --x)  { if (heights[x] > 11) break; xMin--; }

    int best = 0;
    bool found = false;
    int bestAnyScore = 0;   // 発火点の保全（K の損の形）：今起こせる最大連鎖の点（placed 1〜3）

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
            CellMask popped;
            ChainResult chain = simulateChain(sim, trackPop ? &popped : nullptr);
            if (chain.chains <= 0) continue;
            if (trackPop) pops[nPops++] = {popped, chain.score, chain.chains};
            if (chain.score > bestAnyScore) bestAnyScore = chain.score;

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
            // 途中段の余剰（提案3 E1）：途中段の同時消し・多連結は盤面の資源を使い切らずに消す＝
            //   盤面が埋まったときの段数を減らす（余剰1個≒ぷよ1個の損。最終段は数えない）。
            q += chain.excess * w.qExcessWeight;

            // ── 発火直前盤面(remain)の連結数（Ama eval.cpp:62-65 の remain link）──
            //   plan は key ぷよを落とした pop 前の盤面＝ama の quiet.remain に相当。
            //   発火直前の形に2/3連結がどれだけ仕込まれているか＝次連鎖の種を評価する。
            if (w.qLink2Weight != 0 || w.qLink3Weight != 0) {
                Link3Counts lc = getLink23(plan);
                q += lc.link2 * w.qLink2Weight;
                q += weightedLink3(lc, w.qLink3Weight, w.link3FacL, w.link3FacH, w.link3FacV);  // 3連結は形状別倍率
            }

            if (!found || q > best) { best = q; found = true; }
        }
    }
    int result = found ? best : 0;
    if (trackPop) result += calcSubJunkEval(b, w, pops, nPops, outMainSub);
    // 発火点の保全（提案5 K）：おじゃまが1段降った後に起こせる連鎖（おじゃま量）。
    //   正の重み＝降った後に残る量に価値をつける。負の重み＝降って失う量（今 − 降った後）を罰する。
    if (w.qKeepWeight != 0) {
        int after = keepIgnitionScore(b, w.qKeepRows > 0 ? w.qKeepRows : 1);
        int v = w.qKeepWeight > 0 ? after : std::max(0, bestAnyScore - after);
        result += (v / OJAMA_RATE) * w.qKeepWeight;
    }
    return result;
}
