// ─────────────────────────────────────────────
// cpu1.cpp
// ぷよCPU lv1 - Web Worker + Wasm 版
// 6列×12行フィールドに対して全配置探索し，
// 最大3手（現在+NEXT2）で最善手を求める
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
// ★ おじゃまぷよ一斉落下システムのために隠し行領域を 2→5 に拡張
const int HIDDEN     = 5;  
const int TOTAL_ROWS = ROWS + HIDDEN; // 内部総行数 = 17

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Board : 内部盤面 (17行×6列)
// field[0..4] = 隠し行, field[5..16] = 表示行
// 値: 0=空, 1〜5=ぷよ色, 6=おじゃまぷよ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct Board {
    uint8_t cells[TOTAL_ROWS][COLS];

    Board() {
        memset(cells, 0, sizeof(cells));
    }

    // (col, row) への安全アクセス (row は表示行座標: 0=最上段表示行)
    // 内部インデックス = row + HIDDEN
    bool isEmpty(int col, int row) const {
        if (col < 0 || col >= COLS) return false;
        if (row >= ROWS) return false; // 下端超え = 空でない扱い（落下止め）
        int r = row + HIDDEN;
        if (r < 0) return true; // 上端外 = 空
        return cells[r][col] == 0;
    }

    uint8_t get(int col, int row) const {
        int r = row + HIDDEN;
        if (r < 0 || r >= TOTAL_ROWS || col < 0 || col >= COLS) return 0;
        return cells[r][col];
    }

    void set(int col, int row, uint8_t val) {
        int r = row + HIDDEN;
        if (r < 0 || r >= TOTAL_ROWS || col < 0 || col >= COLS) return;
        cells[r][col] = val;
    }

    // 列の「最初に埋まっているセルの表示行座標」を返す。
    // 全部空なら ROWS を返す。
    int topOfCol(int col) const {
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (cells[r][col] != 0) return r - HIDDEN;
        }
        return ROWS;
    }

    // 各列の高さ (埋まっているセル数) を返す
    int heightOfCol(int col) const {
        int h = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (cells[r][col] != 0) h++;
        }
        return h;
    }

    // 全消し判定
    bool isEmpty() const {
        for (int r = HIDDEN; r < TOTAL_ROWS; r++)
            for (int c = 0; c < COLS; c++)
                if (cells[r][c] != 0) return false;
        return true;
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 組ぷよ 1 手の配置情報
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 組ぷよは「軸ぷよ (pivot)」+ 「子ぷよ (child)」の 2 個
// rot: 0=上(child が 1 段上), 1=右(child が 1 列右),
//      2=下(child が 1 段下), 3=左(child が 1 列左)
// 実際の落下位置は calcDropRow で計算する
struct PairPlacement {
    int col;        // 軸ぷよの列
    int rot;        // 向き (0〜3)
    int pivotRow;   // 軸ぷよが落ちる表示行
    int childRow;   // 子ぷよが落ちる表示行
    int childCol;   // 子ぷよの列
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 落下行の計算
// ─ col の最下端の空き行を返す
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int calcDropRow(const Board& b, int col) {
    // ROWS-1 から上に向かって最初の空きを探す
    for (int row = ROWS - 1; row >= 0; row--) {
        if (b.isEmpty(col, row)) return row;
    }
    return -1; // 列が満杯（配置不可）
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 全配置の列挙
// ─ 軸ぷよの列 0〜5 × 向き 0〜3 を試す
// ─ ちぎれ（二段差）も自然に再現される
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static std::vector<PairPlacement> getAllPlacements(const Board& b) {
    // DC[rot], DR[rot]: 子ぷよのオフセット
    const int DC[4] = { 0,  1,  0, -1 };
    const int DR[4] = {-1,  0,  1,  0 };

    std::vector<PairPlacement> result;
    result.reserve(32);

    for (int col = 0; col < COLS; col++) {
        for (int rot = 0; rot < 4; rot++) {
            int cc = col + DC[rot]; // 子ぷよの列

            // 列範囲チェック
            if (cc < 0 || cc >= COLS) continue;

            // 軸ぷよの落下行
            int pr = calcDropRow(b, col);
            if (pr < 0) continue; // 軸列が満杯

            // rot=0 (子が上): 子ぷよは軸ぷよより 1 段上
            // rot=2 (子が下): 子ぷよは軸ぷよより 1 段下
            // rot=1,3       : 子ぷよは別列に独立落下（ちぎれあり）
            int cr;
            if (rot == 0) {
                // 縦置き上向き: 軸の 1 段上
                // 軸が ROWS-1 に落ちるなら子は ROWS-2 以上が必要
                if (pr == 0) continue; // 軸が最上段なら子を置けない
                cr = pr - 1;
                // 子の位置 (col, pr-1) が空かチェック
                if (!b.isEmpty(col, pr - 1)) continue;
            } else if (rot == 2) {
                // 縦置き下向き: 子は軸の 1 段下
                // 子の落下先 = col 列の最下端
                cr = calcDropRow(b, col);
                if (cr < 0) continue;
                // 子が接地した後、軸は 1 段上
                pr = cr - 1;
                if (pr < 0) continue; // 子が最上段で軸を置けない
                if (!b.isEmpty(col, pr)) continue;
            } else {
                // 横置き: 子ぷよは cc 列に独立落下
                cr = calcDropRow(b, cc);
                if (cr < 0) continue; // 子列が満杯
            }

            PairPlacement p;
            p.col      = col;
            p.rot      = rot;
            p.pivotRow = pr;
            p.childRow = cr;
            p.childCol = cc;
            result.push_back(p);
        }
    }
    return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 組ぷよを盤面に配置した新しい Board を返す
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static Board applyPlacement(const Board& b, const PairPlacement& p,
                             uint8_t pivotColor, uint8_t childColor) {
    Board nb = b;
    nb.set(p.col,      p.pivotRow, pivotColor);
    nb.set(p.childCol, p.childRow, childColor);
    return nb;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 連鎖処理（消去 → 落下 → 再消去）
// ─ 消去グループ数・消去ぷよ数・連鎖数を返す
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct ChainResult {
    int chains;       // 発生した連鎖数
    int totalErased;  // 消えた通常ぷよ総数
    int maxGroup;     // 1 グループあたりの最大消去数
};

static ChainResult simulateChain(Board& b) {
    ChainResult res = {0, 0, 0};

    // visited 配列 (内部行インデックスで管理)
    static bool visited[TOTAL_ROWS][COLS];

    while (true) {
        memset(visited, 0, sizeof(visited));
        std::vector<std::pair<int,int>> toErase; 
        std::vector<std::pair<int,int>> toEraseOjama; // おじゃま巻き込み用
        bool found = false;

        // 表示行 (HIDDEN 行目以降) のみ探索
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                if (visited[r][c]) continue;
                uint8_t color = b.cells[r][c];
                // 6(おじゃまぷよ) は探索の起点にしない
                if (color == 0 || color == 6) continue; 

                // BFS
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
                        if (nr < HIDDEN || nr >= TOTAL_ROWS) continue;
                        if (nc < 0 || nc >= COLS) continue;
                        if (visited[nr][nc]) continue;
                        if (b.cells[nr][nc] != color) continue;
                        visited[nr][nc] = true;
                        queue.push_back({nr, nc});
                    }
                }

                if ((int)group.size() >= 4) {
                    found = true;
                    if ((int)group.size() > res.maxGroup)
                        res.maxGroup = (int)group.size();
                    res.totalErased += (int)group.size();
                    for (auto& cell : group) toErase.push_back(cell);
                }
            }
        }

        if (!found) break;

        // 消去確定した通常ぷよの周囲のおじゃまぷよを巻き込む
        for (auto& cell : toErase) {
            const int dr[] = {-1, 1,  0, 0};
            const int dc[] = { 0, 0, -1, 1};
            for (int d = 0; d < 4; d++) {
                int nr = cell.first + dr[d];
                int nc = cell.second + dc[d];
                if (nr < HIDDEN || nr >= TOTAL_ROWS) continue;
                if (nc < 0 || nc >= COLS) continue;
                
                if (b.cells[nr][nc] == 6) {
                    std::pair<int,int> p = {nr, nc};
                    if (std::find(toEraseOjama.begin(), toEraseOjama.end(), p) == toEraseOjama.end()) {
                        toEraseOjama.push_back(p);
                    }
                }
            }
        }

        res.chains++;

        // ── 消去 ──
        for (auto& p : toErase) b.cells[p.first][p.second] = 0;
        for (auto& p : toEraseOjama) b.cells[p.first][p.second] = 0; 

        // ── 重力落下（列ごとに詰める） ──
        for (int c = 0; c < COLS; c++) {
            int write = TOTAL_ROWS - 1;
            for (int r = TOTAL_ROWS - 1; r >= 0; r--) {
                if (b.cells[r][c] != 0) {
                    b.cells[write][c] = b.cells[r][c];
                    if (write != r) b.cells[r][c] = 0;
                    write--;
                }
            }
            for (int r = 0; r <= write; r++) b.cells[r][c] = 0;
        }
    }

    return res;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 連鎖ポテンシャル計算
// ─ 現在の盤面をコピーして全配置を試し，
//   それぞれの連鎖数（消えないなら0）を記録，
//   その最大値を「連鎖ポテンシャル」として返す
// ─ 将来の盤面がどれだけ連鎖力を持っているかを推定する
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int calcChainPotential(const Board& b) {
    // ダミーカラー（全色を試す必要はなく、同色2個でグループが形成されやすい色1で代用）
    // ポテンシャルは連鎖数のみを見るため色の影響は限定的
    const uint8_t DUMMY_COLOR = 1;

    std::vector<PairPlacement> placements = getAllPlacements(b);
    int maxChains = 0;

    for (const auto& p : placements) {
        Board tmp = applyPlacement(b, p, DUMMY_COLOR, DUMMY_COLOR);
        ChainResult res = simulateChain(tmp);
        // ★ 各設置候補ごとに連鎖数（消えないなら0）を評価し最大値を保持
        if (res.chains > maxChains) {
            maxChains = res.chains;
        }
    }

    return maxChains;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 評価パラメータ (JS から渡される)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct EvalWeights {
    int chainBonus;          // 連鎖消去ボーナス
    int erasedBonus;         // 消去ぷよ数ボーナス（負値推奨）
    int heightPenalty;       // 高さペナルティ
    int heightDiffPenalty;   // 高さ差ペナルティ
    int flatBonus;           // 平坦ボーナス
    int colorConnBonus;      // 同色隣接ボーナス
    int zenkeshiBonus;       // 全消しボーナス
    int chainPotentialBonus; // 連鎖ポテンシャルボーナス
    int p1Weight;            // 1手目重み
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 盤面評価関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int evaluateBoard(const Board& b, const ChainResult& chain, const EvalWeights& w) {
    int score = 0;

    // ★ 連鎖消去ボーナス（連鎖数の2乗に比例させることで、多連鎖を圧倒的に優遇）
    // 例: 3連鎖なら 9 * w.chainBonus となり、爆発的にスコアが上がる
    if (chain.chains > 0) {
        score += (chain.chains * chain.chains) * w.chainBonus;
    }
    // 消したぷよ数によるペナルティ（無意味な1連鎖や暴発を防ぐため）
    score += chain.totalErased * w.erasedBonus;

    if (b.isEmpty()) score += w.zenkeshiBonus;

    int heights[COLS];
    for (int c = 0; c < COLS; c++) {
        heights[c] = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (b.cells[r][c] != 0) heights[c]++;
        }
    }

    // ★ ペナルティ強化：自滅するまで積み込むのを防ぐ
    // 左から3列目（インデックス2）の致命判定列
    if (heights[2] >= 8) {
        score += (heights[2] - 7) * w.heightPenalty; 
    }
    // 全体の高積みペナルティ（10段目以上でペナルティ）
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
            uint8_t col_val = b.cells[r][c];
            if (col_val == 0 || col_val == 6) continue; // おじゃまぷよは対象外
            
            if (c + 1 < COLS && b.cells[r][c+1] == col_val) connPairs++;
            if (r + 1 < TOTAL_ROWS && b.cells[r+1][c] == col_val) connPairs++;
        }
    }
    score += connPairs * w.colorConnBonus;

    // ★ 連鎖ポテンシャルボーナス（こちらも連鎖数の2乗に比例させる）
    // 盤面に残したときの将来の連鎖力
    int potential = calcChainPotential(b);
    if (potential > 0) {
        score += (potential * potential) * w.chainPotentialBonus;
    }

    return score;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 探索ノード（ビームサーチ用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct SearchNode {
    Board board;
    int accumulatedScore;
    int col1, rot1;
    int col2, rot2;
    int col3, rot3;
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
// ─────────────────────────────────────────────
EMSCRIPTEN_KEEPALIVE
void searchBestMovePuyoWasm(
    uint8_t* boardData,
    int pivotColor,  int childColor,
    int next1Pivot,  int next1Child,
    int next2Pivot,  int next2Child,
    int* weightsArray,
    int* outResult
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

    // ★ TOTAL_ROWS = 17 に合わせて復元
    Board baseBoard;
    int initialPuyoCount = 0; // ★ 追加: 初期盤面のぷよ数をカウント
    for (int r = 0; r < TOTAL_ROWS; r++) {
        for (int c = 0; c < COLS; c++) {
            baseBoard.cells[r][c] = boardData[r * COLS + c];
            // 表示領域（HIDDEN行以降）で、空(0)でないセル（おじゃまぷよ含む）をカウント
            if (r >= HIDDEN && baseBoard.cells[r][c] != 0) {
                initialPuyoCount++;
            }
        }
    }

    // ★ 追加: ぷよを積みすぎてゲームオーバーにならないための緊急回避
    // フィールドに存在するぷよの個数が半分(ROWS * COLS / 2 = 36)を超えた時、
    // erasedBonus を強制的に正の値にして、1連鎖でも積極的に消しに行くようにする
    if (initialPuyoCount > (ROWS * COLS) / 3) {
        if (w.erasedBonus <= 0) {
            w.erasedBonus = std::abs(w.erasedBonus) * 10;
            if (w.erasedBonus == 0) w.erasedBonus = 3; // 0の場合は適当な正の値を設定
        }
    }

    // ★ 各手で評価値上位を残す数（ビーム幅）
    const int BEAM_WIDTH = 4;

    // ─────────────────────────────────────────────
    // 1手目（現在ぷよ）
    // ─────────────────────────────────────────────
    std::vector<PairPlacement> placements1 = getAllPlacements(baseBoard);
    if (placements1.empty()) return;

    std::vector<SearchNode> nodes1;
    for (const auto& p1 : placements1) {
        Board board1 = applyPlacement(baseBoard, p1,
                                      (uint8_t)pivotColor, (uint8_t)childColor);
        ChainResult chain1 = simulateChain(board1);
        int score1Raw = evaluateBoard(board1, chain1, w);
        int score1    = score1Raw * w.p1Weight / 100; 

        SearchNode node;
        node.board = board1;
        node.accumulatedScore = score1;
        node.col1 = p1.col; node.rot1 = p1.rot;
        node.col2 = -1;     node.rot2 = -1;
        node.col3 = -1;     node.rot3 = -1;
        nodes1.push_back(node);
    }

    // 評価値上位4つを残す
    std::sort(nodes1.begin(), nodes1.end(), [](const SearchNode& a, const SearchNode& b) {
        return a.accumulatedScore > b.accumulatedScore;
    });
    if (nodes1.size() > BEAM_WIDTH) nodes1.resize(BEAM_WIDTH);

    // ─────────────────────────────────────────────
    // 2手目（NEXT1）
    // ─────────────────────────────────────────────
    std::vector<SearchNode> nodes2;
    for (const auto& node1 : nodes1) {
        std::vector<PairPlacement> placements2 = getAllPlacements(node1.board);
        if (placements2.empty()) {
            nodes2.push_back(node1);
            continue;
        }

        for (const auto& p2 : placements2) {
            Board board2 = applyPlacement(node1.board, p2,
                                          (uint8_t)next1Pivot, (uint8_t)next1Child);
            ChainResult chain2 = simulateChain(board2);
            int score2 = evaluateBoard(board2, chain2, w);

            SearchNode nextNode = node1;
            nextNode.board = board2;
            nextNode.accumulatedScore += score2; // スコアを累計
            nextNode.col2 = p2.col;
            nextNode.rot2 = p2.rot;
            nodes2.push_back(nextNode);
        }
    }

    // 評価値上位4つを残す
    std::sort(nodes2.begin(), nodes2.end(), [](const SearchNode& a, const SearchNode& b) {
        return a.accumulatedScore > b.accumulatedScore;
    });
    if (nodes2.size() > BEAM_WIDTH) nodes2.resize(BEAM_WIDTH);

    // ─────────────────────────────────────────────
    // 3手目（NEXT2）
    // ─────────────────────────────────────────────
    std::vector<SearchNode> nodes3;
    for (const auto& node2 : nodes2) {
        std::vector<PairPlacement> placements3 = getAllPlacements(node2.board);
        if (placements3.empty()) {
            nodes3.push_back(node2);
            continue;
        }

        for (const auto& p3 : placements3) {
            Board board3 = applyPlacement(node2.board, p3,
                                          (uint8_t)next2Pivot, (uint8_t)next2Child);
            ChainResult chain3 = simulateChain(board3);
            int score3 = evaluateBoard(board3, chain3, w);

            SearchNode nextNode = node2;
            nextNode.board = board3;
            nextNode.accumulatedScore += score3; // スコアを累計
            nextNode.col3 = p3.col;
            nextNode.rot3 = p3.rot;
            nodes3.push_back(nextNode);
        }
    }

    // 最終的なスコアでソート
    std::sort(nodes3.begin(), nodes3.end(), [](const SearchNode& a, const SearchNode& b) {
        return a.accumulatedScore > b.accumulatedScore;
    });

    // 一番評価値が高かったものを出力
    if (!nodes3.empty()) {
        const auto& bestNode = nodes3.front();
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