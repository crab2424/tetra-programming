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
const int HIDDEN     = 2;  // 隠し行数
const int TOTAL_ROWS = ROWS + HIDDEN; // 内部総行数 = 14

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Board : 内部盤面 (14行×6列)
// field[0..1] = 隠し行, field[2..13] = 表示行
// 値: 0=空, 1〜5=ぷよ色
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
// 実際の落下位置は _calcDropRow で計算する
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
                if (!b.isEmpty(col, pr - 1)) {
                    // 軸ぷよがさらに上に積まれた場合を確認
                    // 実際には calcDropRow が最下空き行を返すので
                    // pr-1 が埋まっている = 置けない
                    continue;
                }
            } else if (rot == 2) {
                // 縦置き下向き: 子は軸の 1 段下
                // → 子が先に接地してから軸が乗る形
                // 子の落下先 = col 列の最下端
                cr = calcDropRow(b, col);
                if (cr < 0) continue;
                // 子が接地した後、軸は 1 段上
                pr = cr - 1;
                if (pr < 0) continue; // 子が最上段で軸を置けない
                if (!b.isEmpty(col, pr)) continue;
            } else {
                // 横置き: 子ぷよは cc 列に独立落下（ちぎれあり）
                cr = calcDropRow(b, cc);
                if (cr < 0) continue; // 子列が満杯
                // pr はすでに計算済み
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
    int totalErased;  // 消えたぷよ総数
    int maxGroup;     // 1 グループあたりの最大消去数
};

static ChainResult simulateChain(Board& b) {
    ChainResult res = {0, 0, 0};

    // visited 配列 (内部行インデックスで管理)
    static bool visited[TOTAL_ROWS][COLS];

    while (true) {
        // ── BFS で同色 4 個以上のグループを探す ──
        memset(visited, 0, sizeof(visited));
        std::vector<std::pair<int,int>> toErase; // (内部行, 列)
        bool found = false;

        // 表示行 (HIDDEN 行目以降) のみ探索
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                if (visited[r][c]) continue;
                uint8_t color = b.cells[r][c];
                if (color == 0) continue;

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

        res.chains++;

        // ── 消去 ──
        for (auto& [r, c] : toErase) b.cells[r][c] = 0;

        // ── 重力落下（列ごとに詰める） ──
        for (int c = 0; c < COLS; c++) {
            int write = TOTAL_ROWS - 1;
            for (int r = TOTAL_ROWS - 1; r >= HIDDEN; r--) {
                if (b.cells[r][c] != 0) {
                    b.cells[write][c] = b.cells[r][c];
                    if (write != r) b.cells[r][c] = 0;
                    write--;
                }
            }
            // write+1 から HIDDEN まで空にする（念のため）
            for (int r = HIDDEN; r <= write; r++) b.cells[r][c] = 0;
        }
    }

    return res;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 評価パラメータ (JS から渡される)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct EvalWeights {
    int chainBonus;       // [0] 連鎖数ボーナス（×連鎖数）
    int erasedBonus;      // [1] 消去ぷよ数ボーナス（×消去数）
    int heightPenalty;    // [2] 最高段数ペナルティ（×段数, 通常負値）
    int heightDiffPenalty;// [3] 列間高さ差ペナルティ（×差合計, 通常負値）
    int holePenalty;      // [4] 穴（ぷよの下の空き）ペナルティ（×個数, 通常負値）
    int flatBonus;        // [5] 平坦ボーナス（隣接列高さ差0ごと加算）
    int colorConnBonus;   // [6] 同色隣接ペア数ボーナス
    int zenkeshiBonus;    // [7] 全消しボーナス
    int p1Weight;         // [8] 1手目スコアの重み (パーセント, e.g. 70 → 0.7倍)
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 盤面評価関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int evaluateBoard(const Board& b, const ChainResult& chain, const EvalWeights& w) {
    int score = 0;

    // ── 連鎖・消去ボーナス ──
    score += chain.chains   * w.chainBonus;
    score += chain.totalErased * w.erasedBonus;

    // ── 全消しボーナス ──
    if (b.isEmpty()) score += w.zenkeshiBonus;

    // ── 列高さ集計 ──
    int heights[COLS];
    for (int c = 0; c < COLS; c++) {
        heights[c] = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (b.cells[r][c] != 0) heights[c]++;
        }
    }

    int maxH = 0;
    for (int c = 0; c < COLS; c++) if (heights[c] > maxH) maxH = heights[c];

    // ── 最大高さペナルティ ──
    score += maxH * w.heightPenalty;

    // ── 高さ差・平坦ボーナス ──
    for (int c = 0; c < COLS - 1; c++) {
        int diff = std::abs(heights[c] - heights[c+1]);
        score += diff * w.heightDiffPenalty;
        if (diff == 0) score += w.flatBonus;
    }

    // ── 穴ペナルティ（埋まっているぷよの下にある空きセル数） ──
    int holes = 0;
    for (int c = 0; c < COLS; c++) {
        bool foundPuyo = false;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (b.cells[r][c] != 0) foundPuyo = true;
            else if (foundPuyo) holes++;
        }
    }
    score += holes * w.holePenalty;

    // ── 同色隣接ペア数ボーナス（横・縦） ──
    int connPairs = 0;
    for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
        for (int c = 0; c < COLS; c++) {
            uint8_t col_val = b.cells[r][c];
            if (col_val == 0) continue;
            // 右隣
            if (c + 1 < COLS && b.cells[r][c+1] == col_val) connPairs++;
            // 下隣
            if (r + 1 < TOTAL_ROWS && b.cells[r+1][c] == col_val) connPairs++;
        }
    }
    score += connPairs * w.colorConnBonus;

    return score;
}

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
//
// 引数:
//   boardData   : uint8_t[14*6] = field[row][col] (内部行順, 0=空 1〜5=色)
//   pivotColor  : 現在の軸ぷよ色 (1〜5)
//   childColor  : 現在の子ぷよ色 (1〜5)
//   next1Pivot  : NEXT1 軸ぷよ色
//   next1Child  : NEXT1 子ぷよ色
//   next2Pivot  : NEXT2 軸ぷよ色
//   next2Child  : NEXT2 子ぷよ色
//   weightsArray: int32[9] = EvalWeights
//   outResult   : int32[7] 出力バッファ
//     [0] = 最善手の軸ぷよ列 (0〜5), -1 = 探索失敗
//     [1] = 最善手の向き (0〜3)
//     [2] = 評価スコア
//     [3] = 2手目の軸ぷよ列 (-1 = なし)
//     [4] = 2手目の向き
//     [5] = 3手目の軸ぷよ列 (-1 = なし)
//     [6] = 3手目の向き
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
    // 出力初期化
    for (int i = 0; i < 7; i++) outResult[i] = -1;

    // ── EvalWeights 構築 ──
    EvalWeights w;
    w.chainBonus        = weightsArray[0];
    w.erasedBonus       = weightsArray[1];
    w.heightPenalty     = weightsArray[2];
    w.heightDiffPenalty = weightsArray[3];
    w.holePenalty       = weightsArray[4];
    w.flatBonus         = weightsArray[5];
    w.colorConnBonus    = weightsArray[6];
    w.zenkeshiBonus     = weightsArray[7];
    w.p1Weight          = weightsArray[8];

    // ── 盤面復元 (内部行順: row0=隠し行0, row1=隠し行1, row2〜13=表示行) ──
    Board baseBoard;
    for (int r = 0; r < TOTAL_ROWS; r++)
        for (int c = 0; c < COLS; c++)
            baseBoard.cells[r][c] = boardData[r * COLS + c];

    // ── 1手目の全配置を列挙 ──
    std::vector<PairPlacement> placements1 = getAllPlacements(baseBoard);
    if (placements1.empty()) {
        // 配置不可（ゲームオーバー相当）
        return;
    }

    int bestTotalScore  = -100000000;
    int best1Col        = -1;
    int best1Rot        = -1;
    int best2Col        = -1;
    int best2Rot        = -1;
    int best3Col        = -1;
    int best3Rot        = -1;

    // ── 1手目ループ ──
    for (const auto& p1 : placements1) {
        Board board1 = applyPlacement(baseBoard, p1,
                                      (uint8_t)pivotColor, (uint8_t)childColor);
        ChainResult chain1 = simulateChain(board1);
        int score1Raw = evaluateBoard(board1, chain1, w);
        int score1    = score1Raw * w.p1Weight / 100; // p1Weight は % 単位

        // ── 2手目の全配置を列挙 ──
        std::vector<PairPlacement> placements2 = getAllPlacements(board1);

        if (placements2.empty()) {
            // 2手目が置けない場合は 1 手目だけで評価
            int total = score1;
            if (total > bestTotalScore) {
                bestTotalScore = total;
                best1Col = p1.col; best1Rot = p1.rot;
                best2Col = -1;    best2Rot = -1;
                best3Col = -1;    best3Rot = -1;
            }
            continue;
        }

        for (const auto& p2 : placements2) {
            Board board2 = applyPlacement(board1, p2,
                                          (uint8_t)next1Pivot, (uint8_t)next1Child);
            ChainResult chain2 = simulateChain(board2);
            int score2 = evaluateBoard(board2, chain2, w);

            // ── 3手目の全配置を列挙 ──
            std::vector<PairPlacement> placements3 = getAllPlacements(board2);

            if (placements3.empty()) {
                int total = score1 + score2;
                if (total > bestTotalScore) {
                    bestTotalScore = total;
                    best1Col = p1.col; best1Rot = p1.rot;
                    best2Col = p2.col; best2Rot = p2.rot;
                    best3Col = -1;     best3Rot = -1;
                }
                continue;
            }

            for (const auto& p3 : placements3) {
                Board board3 = applyPlacement(board2, p3,
                                              (uint8_t)next2Pivot, (uint8_t)next2Child);
                ChainResult chain3 = simulateChain(board3);
                int score3 = evaluateBoard(board3, chain3, w);

                int total = score1 + score2 + score3;
                if (total > bestTotalScore) {
                    bestTotalScore = total;
                    best1Col = p1.col; best1Rot = p1.rot;
                    best2Col = p2.col; best2Rot = p2.rot;
                    best3Col = p3.col; best3Rot = p3.rot;
                }
            }
        }
    }

    // ── 結果格納 ──
    outResult[0] = best1Col;
    outResult[1] = best1Rot;
    outResult[2] = bestTotalScore;
    outResult[3] = best2Col;
    outResult[4] = best2Rot;
    outResult[5] = best3Col;
    outResult[6] = best3Rot;
}

} // extern "C"