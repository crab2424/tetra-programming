// ─────────────────────────────────────────────
// core/bitboard.cpp — 配置候補の生成・適用
// ─────────────────────────────────────────────
#include "core/bitboard.h"
#include <cstring>

int calcDropRow(const BitBoard& b, int col) {
    for (int row = ROWS - 1; row >= 0; row--) {
        if (b.isEmpty(col, row)) return row;
    }
    return -1;
}

// ─────────────────────────────────────────────
// getAllPlacements — 経路シミュレーション(BFS)で「到達可能な」配置だけを列挙する。
//
//   ★ 旧実装は各列を真上から落とす最大22通りを機械的に出すだけで、到達経路（高い壁を
//     越えて横移動・回転で目的の col/rot に入れるか）を一切見ていなかった。そのため
//     到達不能な手を含み、かつ実行系(_buildActionQueue)が「回転→移動」固定だったため
//     上部での「回し」が出せなかった。
//
//   本実装はゲーム本体 src/game/puyo/input.js の _tryMove / _tryRotate を忠実に再現した
//   BFS で spawn(列2/rot0) から到達できる (rot,col) を列挙し、各配置に spawn からの
//   操作列 path[] を持たせる（実行系はこれを再生する）。方針:
//     - 庇下が無いので下方遷移(ソフトドロップ)は持たず、spawn 行付近での横移動・回転のみ。
//       着地は従来どおり各列 calcDropRow（ちぎり反映）で一意に決める＝最後に1回落とす。
//     - ★ 横移動/回転の到達判定は「ピースが半マス下がった位置(py=pr+0.5)にいる」前提の
//       canPlace（pr と pr+1 の2行チェック＝実機 _canPlace の小数 py 再現）で行う。
//       連続落下中に壁/盤面へ弾かれ実機では通れない経路を除外するため。spawn の窒息判定
//       だけは実機 spawn(pivotY=-0.5≒1行) に合わせ canPlaceGrid(1行)のまま。
//     - 持ち上げ(回転)で pr<0 に出た状態からの横移動は禁止（配列上端より上での自由
//       スライドを防ぐ＝塞がり判定の破綻防止）。
//     - クイックターン(縦向きで通常回転＋壁蹴り失敗時の180°)は入力2回ぶん＝回転コードを
//       2個 path に積む単一エッジで再現。
//   座標系: BFS は盤面配列インデックス pr（0=最上段, hidden=0..4, 可視=5..16, 床=TOTAL_ROWS）
//           で動く（ゲーム _canPlaceGrid と同座標）。着地計算だけは従来の可視座標
//           (row 0..11, b.isEmpty) を使う（applyPlacement が +HIDDEN する前提）。
// ─────────────────────────────────────────────
std::vector<PairPlacement> getAllPlacements(const BitBoard& b) {
    const int DC[4] = { 0,  1,  0, -1 };
    const int DR[4] = {-1,  0,  1,  0 };

    std::vector<PairPlacement> result;
    result.reserve(32);

    // ── ゲーム本体 _canPlaceGrid と等価のセル空判定（内部行 r 基準）──
    auto cellEmpty = [&](int c, int r) -> bool {
        if (c < 0 || c >= COLS) return false;
        if (r >= TOTAL_ROWS) return false;   // 床（ゲーム: pr >= PConfig.rows）
        if (r < 0) return true;              // 配列上端より上は空扱い（_getCell undefined 相当）
        return b.get(c, r) == 0;
    };
    auto canPlaceGrid = [&](int pc, int pr, int rot) -> bool {
        int cc = pc + DC[rot], cr = pr + DR[rot];
        if (pc < 0 || pc >= COLS) return false;
        if (cc < 0 || cc >= COLS) return false;
        if (pr >= TOTAL_ROWS) return false;
        if (cr >= TOTAL_ROWS) return false;
        return cellEmpty(pc, pr) && cellEmpty(cc, cr);
    };

    // ── 半マス下げた到達判定（実機 input.js _canPlace の小数 py 再現）──
    //   実機はピースが連続落下する都合上、横移動/回転は整数行ぴったりではなく小数 py で
    //   発生する。_canPlace(py) は py=pr+0.5 のとき floor=pr と ceil=pr+1 の2行が
    //   ともに空でないと不可。BFS を「常にピースが半マス下がった位置(py=pr+0.5)にいる」
    //   前提に変えることで、落下中に壁/盤面へ弾かれて実機では通れない経路を除外する。
    auto canPlace = [&](int pc, int pr, int rot) -> bool {
        return canPlaceGrid(pc, pr, rot) && canPlaceGrid(pc, pr + 1, rot);
    };

    // ── BFS バッファ（単スレッド wasm 前提の static。毎回 memset）──
    const int PR_OFF = 8;
    const int PR_RANGE = 20;              // pr ∈ [-8, 11]
    static bool visited[4][20][COLS];
    static bool reached[4][COLS];         // (rot,col) を初到達で配置候補化済みか
    struct PInfo { int8_t rot, pr, col, act, dbl; };
    static PInfo parent[4][20][COLS];
    std::memset(visited, 0, sizeof(visited));
    std::memset(reached, 0, sizeof(reached));

    auto idxOK = [&](int pr) { return (pr + PR_OFF) >= 0 && (pr + PR_OFF) < PR_RANGE; };

    const int SPAWN_PR = 0, SPAWN_COL = 2, SPAWN_ROT = 0;
    if (!canPlaceGrid(SPAWN_COL, SPAWN_PR, SPAWN_ROT)) return result; // 窒息＝候補なし

    struct QNode { int rot, pr, col; };
    static QNode queue[4 * 20 * COLS];
    int qh = 0, qt = 0;
    visited[SPAWN_ROT][SPAWN_PR + PR_OFF][SPAWN_COL] = true;
    parent[SPAWN_ROT][SPAWN_PR + PR_OFF][SPAWN_COL] = { -1, -1, -1, 0, 0 };
    queue[qt++] = { SPAWN_ROT, SPAWN_PR, SPAWN_COL };

    auto tryPush = [&](int nrot, int npr, int ncol,
                       int prot, int ppr, int pcol, int act, int dbl) {
        if (ncol < 0 || ncol >= COLS) return;
        if (!idxOK(npr)) return;
        if (visited[nrot][npr + PR_OFF][ncol]) return;
        visited[nrot][npr + PR_OFF][ncol] = true;
        parent[nrot][npr + PR_OFF][ncol] =
            { (int8_t)prot, (int8_t)ppr, (int8_t)pcol, (int8_t)act, (int8_t)dbl };
        queue[qt++] = { nrot, npr, ncol };
    };

    // 到達状態 (rot,pr,col) から spawn までの操作列を parent 逆引きで構築（正順で out へ）
    auto buildPath = [&](int rot, int pr, int col, uint8_t* out) -> int {
        uint8_t tmp[64]; int n = 0;
        int tr = rot, tp = pr, tc = col;
        while (true) {
            PInfo& pi = parent[tr][tp + PR_OFF][tc];
            if (pi.rot < 0) break;                       // spawn に到達
            if (n < 63) tmp[n++] = pi.act;
            if (pi.dbl && n < 63) tmp[n++] = pi.act;      // クイックターン＝同コード2個
            tr = pi.rot; tp = pi.pr; tc = pi.col;
        }
        int m = 0;                                        // 逆順 tmp → 正順 out
        for (int i = n - 1; i >= 0 && m < MAX_PATH; i--) out[m++] = tmp[i];
        return m;
    };

    while (qh < qt) {
        QNode cur = queue[qh++];
        int rot = cur.rot, pr = cur.pr, col = cur.col;

        // ── (rot,col) を初到達で配置候補化（着地は従来ロジック＝可視座標 row 0..11）──
        if (!reached[rot][col]) {
            reached[rot][col] = true;
            int cc = col + DC[rot];
            if (cc >= 0 && cc < COLS) {
                int lpr = calcDropRow(b, col);
                bool ok = (lpr >= 0);
                int lcr = -1;
                if (ok) {
                    if (rot == 0) {
                        if (lpr == 0) ok = false;
                        else { lcr = lpr - 1; if (!b.isEmpty(col, lpr - 1)) ok = false; }
                    } else if (rot == 2) {
                        lcr = lpr;
                        lpr = lcr - 1;
                        if (lpr < 0 || !b.isEmpty(col, lpr)) ok = false;
                    } else {
                        lcr = calcDropRow(b, cc);
                        if (lcr < 0) ok = false;
                    }
                }
                if (ok) {
                    PairPlacement p;
                    p.col = col; p.rot = rot;
                    p.pivotRow = lpr; p.childRow = lcr; p.childCol = cc;
                    p.pathLen = buildPath(rot, pr, col, p.path);
                    result.push_back(p);
                }
            }
        }

        // ── 横移動（pr>=0 のみ。持ち上げで pr<0 に出た状態からの自由スライドを防ぐ）──
        if (pr >= 0) {
            if (canPlace(col - 1, pr, rot)) tryPush(rot, pr, col - 1, rot, pr, col, 1, 0);
            if (canPlace(col + 1, pr, rot)) tryPush(rot, pr, col + 1, rot, pr, col, 2, 0);
        }

        // ── 回転（実機 _tryRotate を再現。dir=+1:CW(act4) / dir=-1:CCW(act5)）──
        for (int dir = 1; dir >= -1; dir -= 2) {
            int act = (dir == 1) ? 4 : 5;
            bool isVertical = (rot == 0 || rot == 2);
            int newRot = ((rot + dir) % 4 + 4) % 4;
            bool success = false;

            if (newRot == 2 && !isVertical) {
                // 横→下化：同行→ダメなら上1段持ち上げ
                if (canPlace(col, pr, newRot)) {
                    tryPush(newRot, pr, col, rot, pr, col, act, 0); success = true;
                } else if (canPlace(col, pr - 1, newRot)) {
                    tryPush(newRot, pr - 1, col, rot, pr, col, act, 0); success = true;
                }
            } else {
                if (canPlace(col, pr, newRot)) {
                    tryPush(newRot, pr, col, rot, pr, col, act, 0); success = true;
                } else {
                    for (int kick = -1; kick <= 1; kick += 2) {       // 壁蹴り ±1列
                        if (canPlace(col + kick, pr, newRot)) {
                            tryPush(newRot, pr, col + kick, rot, pr, col, act, 0);
                            success = true; break;
                        }
                    }
                }
            }

            // ── クイックターン（縦向きで通常回転＋壁蹴り失敗時。入力2回ぶん＝act を2個積む）──
            if (!success && isVertical) {
                int qtRot = ((rot + 2) % 4 + 4) % 4;
                if (rot == 0) {
                    if (canPlace(col, pr - 1, qtRot)) tryPush(qtRot, pr - 1, col, rot, pr, col, act, 1);
                } else { // rot == 2
                    if (canPlace(col, pr, qtRot)) tryPush(qtRot, pr, col, rot, pr, col, act, 1);
                }
            }
        }
    }

    return result;
}

BitBoard applyPlacement(const BitBoard& b, const PairPlacement& p, uint8_t pivotColor, uint8_t childColor) {
    BitBoard nb = b;
    nb.set(p.col,      p.pivotRow + HIDDEN, pivotColor);
    nb.set(p.childCol, p.childRow + HIDDEN, childColor);
    return nb;
}

int placementTear(const PairPlacement& p) {
    // 横置き（pivot と child が別列：rot 1/3）で、2列の着地行が違うときちぎり。
    // 縦置き（rot 0/2、childCol==col）は着地行が連続するのでちぎらない。
    return (p.childCol != p.col && p.pivotRow != p.childRow) ? 1 : 0;
}
