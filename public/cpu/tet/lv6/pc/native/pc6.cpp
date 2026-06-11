// ─────────────────────────────────────────────
// pc6.cpp
// CPU6 用 パーフェクトクリア(全消し)探索 - cpu6.cpp とは完全に独立
//
// アルゴリズム: leftLine 追跡 DFS（sfinder PerfectClearNET 準拠・途中ライン消去対応）
//   - ブロック総数 B と手数 N から消す合計ライン数 H = (B + 4N) / 10 を決め、
//     leftLine = H を初期値として「残り消去ライン数」を追跡する。
//   - 各手番で現在ピース(またはホールド入替後のピース)を、残り leftLine 行の領域内に
//     置ける SRS 到達可能配置(getAllPlacements)すべてで試す。
//   - 配置のたびにライン消去(clearLines)を行い leftLine を減算。leftLine==0 で PC 成立。
//     → 途中でラインを消す手順も探索できる（PC の大半はこれを含む）。
//   - ピース順は queue 固定で並べ替えないため、分岐は (現在ピース配置数)+(hold ピース配置数)。
//   - 健全な枝刈りは validateRegion(列壁で区切った各区間の空セルが 4 の倍数か) と
//     leftLine 天井制約のみ。穴数(countRegionHoles)は探索順ヒューリスティックとしてのみ使用。
// ─────────────────────────────────────────────

#include <emscripten.h>
#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>

// 現在時刻(ms)。emscripten では performance.now() 相当、ネイティブ(テスト)では steady_clock。
#ifdef __EMSCRIPTEN__
static inline double nowMs() { return emscripten_get_now(); }
#else
#include <chrono>
static inline double nowMs() {
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now().time_since_epoch()).count();
}
#endif

const int COLS = 10;
const int ROWS = 25; // 内部 0(上)〜24(下)。JS側 y=-5〜19 に対応

struct GridBlock { int x, y; };

struct MinoData {
    GridBlock blocks[4];
    float pivotX, pivotY;
};

// cpu6.cpp と同一のミノ定義
const MinoData MINO_TEMPLATES[7] = {
    {{{0,1},{1,1},{2,1},{3,1}}, 1.5f, 1.5f}, // I
    {{{1,1},{2,1},{1,2},{2,2}}, 1.5f, 1.5f}, // O
    {{{1,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f}, // T
    {{{0,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f}, // J
    {{{2,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f}, // L
    {{{1,1},{2,1},{0,2},{1,2}}, 1.0f, 2.0f}, // S
    {{{0,1},{1,1},{1,2},{2,2}}, 1.0f, 2.0f}  // Z
};

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

// ビットボード（cpu6.cpp と同形式）
class Board {
public:
    uint16_t rows[ROWS];
    Board() { for (int y = 0; y < ROWS; y++) rows[y] = 0; }

    inline bool has(int x, int y) const {
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y < 0) return false;
        return (rows[y] & (1 << x)) != 0;
    }
    inline void set(int x, int y) {
        if (x >= 0 && x < COLS && y >= 0 && y < ROWS) rows[y] |= (1 << x);
    }
    // 揃った行(==0x3FF)を消去し、上の行を下へ詰める。消したライン数を返す。
    inline int clearLines() {
        int cnt = 0;
        for (int y = ROWS - 1; y >= 0; ) {
            if (rows[y] == 0x3FF) {
                for (int yy = y; yy > 0; yy--) rows[yy] = rows[yy - 1];
                rows[0] = 0;
                cnt++;            // 同じ行に上から落ちてきた内容を再チェック
            } else {
                y--;
            }
        }
        return cnt;
    }
};

bool isValidPlacement(const Board& b, const GridBlock blocks[4]) {
    for (int i = 0; i < 4; i++) {
        const auto& blk = blocks[i];
        if (blk.x < 0 || blk.x >= COLS || blk.y >= ROWS ||
            (blk.y >= 0 && ((b.rows[blk.y] >> blk.x) & 1))) return false;
    }
    return true;
}

// ── SRS 壁蹴りテーブル（cpu6.cpp と同一）──
const int KICK_I_CW[4][5][2] = {
    {{0,0}, {-2,0}, {1,0}, {-2,1}, {1,-2}},
    {{0,0}, {-1,0}, {2,0}, {-1,-2}, {2,1}},
    {{0,0}, {2,0}, {-1,0}, {2,-1}, {-1,2}},
    {{0,0}, {1,0}, {-2,0}, {1,2}, {-2,-1}}
};
const int KICK_I_CCW[4][5][2] = {
    {{0,0}, {-1,0}, {2,0}, {-1,-2}, {2,1}},  // 0→3
    {{0,0}, {2,0}, {-1,0}, {2,-1}, {-1,2}},  // 1→0
    {{0,0}, {1,0}, {-2,0}, {1,2}, {-2,-1}},  // 2→1
    {{0,0}, {-2,0}, {1,0}, {-2,1}, {1,-2}}   // 3→2
};
const int KICK_OTHER_CW[4][5][2] = {
    {{0,0}, {-1,0}, {-1,-1}, {0,2}, {-1,2}},
    {{0,0}, {1,0}, {1,1}, {0,-2}, {1,-2}},
    {{0,0}, {1,0}, {1,-1}, {0,2}, {1,2}},
    {{0,0}, {-1,0}, {-1,1}, {0,-2}, {-1,-2}}
};
const int KICK_OTHER_CCW[4][5][2] = {
    {{0,0}, {1,0}, {1,-1}, {0,2}, {1,2}},    // 0→3
    {{0,0}, {1,0}, {1,1}, {0,-2}, {1,-2}},   // 1→0
    {{0,0}, {-1,0}, {-1,-1}, {0,2}, {-1,2}}, // 2→1
    {{0,0}, {-1,0}, {-1,1}, {0,-2}, {-1,-2}} // 3→2
};

// PC 探索用の配置情報（到達経路 path を保持）
//   path: アクションID列 1=左 2=右 3=SD 4=CW 5=CCW 6=HD（cpu6.cpp と同一規約）
struct PCPlacement {
    int rot, x, y;
    GridBlock blocks[4];
    uint8_t path[64];
    int pathLength;
};

struct BFSState { int x, y, rot; };
// drop: この辺で action を何回出力するか（softdrop の一括降下は drop=落下行数、それ以外は1）
struct ParentInfo { int8_t x, y, rot, action, drop; };

// SRS 到達可能な「着地配置」を全列挙（cpu6.cpp の getAllPlacements を PC 用に簡略化）
// ★高速化: 結果は呼び出し側が用意した placements に書き込み、毎回のヒープ確保を避ける。
void getAllPlacements(const Board& baseBoard, int pieceType, int spawnY,
                      std::vector<PCPlacement>& placements) {
    placements.clear();
    if (placements.capacity() < 64) placements.reserve(64);

    // ★高速化: 毎回の memset/初期化を避けるため世代スタンプ方式。
    //   visitedGen/placedGen/parentGen が現世代 g_gen と一致するセルのみ「有効」。
    //   呼び出し毎に g_gen++ するだけで全配列を実質クリアできる（初期化コスト O(1)）。
    static int visitedGen[4][35][19];   // BSS で 0 初期化（g_gen は 1 から始まるので未訪問扱い）
    static int placedGen[4][35][19];
    static int parentGen[4][35][19];
    static ParentInfo parent[4][35][19];
    static int g_gen = 0;
    g_gen++;

    int spawnX = COLS / 2 - 2;
    int initialRot = 0;

    GridBlock startBlocks[4];
    for (int i = 0; i < 4; i++) {
        startBlocks[i].x = PRECALC_MINO_BLOCKS[pieceType][initialRot][i].x + spawnX;
        startBlocks[i].y = PRECALC_MINO_BLOCKS[pieceType][initialRot][i].y + spawnY;
    }
    if (!isValidPlacement(baseBoard, startBlocks)) {
        spawnY -= 1;
        for (int i = 0; i < 4; i++)
            startBlocks[i].y = PRECALC_MINO_BLOCKS[pieceType][initialRot][i].y + spawnY;
        if (!isValidPlacement(baseBoard, startBlocks)) return;
    }

    // スタック上端（最も高い既存ブロックの行）。これより上は全セル空。
    int topY = ROWS;
    for (int y = 0; y < ROWS; y++) if (baseBoard.rows[y] != 0) { topY = y; break; }

    static BFSState bfsQueue[3000];
    int qHead = 0, qTail = 0;
    bfsQueue[qTail++] = {spawnX, spawnY, initialRot};
    if (spawnY + 5 >= 0 && spawnY + 5 < 35 && spawnX + 4 >= 0 && spawnX + 4 < 19)
        visitedGen[initialRot][spawnY + 5][spawnX + 4] = g_gen;

    while (qHead < qTail) {
        BFSState curr = bfsQueue[qHead++];

        GridBlock blocks_down[4];
        for (int i = 0; i < 4; i++) {
            blocks_down[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x;
            blocks_down[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y + 1;
        }
        bool canMoveDown = isValidPlacement(baseBoard, blocks_down);

        if (!canMoveDown) {
            if (curr.y + 5 >= 0 && curr.y + 5 < 35 && curr.x + 4 >= 0 && curr.x + 4 < 19) {
                if (placedGen[curr.rot][curr.y + 5][curr.x + 4] != g_gen) {
                    placedGen[curr.rot][curr.y + 5][curr.x + 4] = g_gen;
                    PCPlacement p;
                    p.rot = curr.rot; p.x = curr.x; p.y = curr.y;
                    for (int i = 0; i < 4; i++) {
                        p.blocks[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x;
                        p.blocks[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
                    }
                    // 親を辿って到達経路 path を復元（逆順 → 反転 → 末尾に HD=6）
                    uint8_t path[64];
                    int pathLen = 0;
                    int tx = curr.x, ty = curr.y, tr = curr.rot;
                    while (true) {
                        if (ty + 5 < 0 || ty + 5 >= 35 || tx + 4 < 0 || tx + 4 >= 19) break;
                        if (parentGen[tr][ty + 5][tx + 4] != g_gen) break; // 親なし（開始点）
                        ParentInfo& pi = parent[tr][ty + 5][tx + 4];
                        // softdrop の一括降下(drop>1)は同じ '3' を drop 回出力（反転後も連続するため順序は不問）
                        for (int k = 0; k < pi.drop && pathLen < 63; k++) path[pathLen++] = (uint8_t)pi.action;
                        tx = pi.x; ty = pi.y; tr = pi.rot;
                    }
                    for (int i = 0; i < pathLen / 2; i++) {
                        uint8_t t = path[i];
                        path[i] = path[pathLen - 1 - i];
                        path[pathLen - 1 - i] = t;
                    }
                    path[pathLen++] = 6; // harddrop
                    for (int i = 0; i < pathLen; i++) p.path[i] = path[i];
                    p.pathLength = pathLen;
                    placements.push_back(p);
                }
            }
        }

        auto tryPush = [&](int nx, int ny, int nrot, int action, int drop) {
            if (ny + 5 >= 0 && ny + 5 < 35 && nx + 4 >= 0 && nx + 4 < 19) {
                if (visitedGen[nrot][ny + 5][nx + 4] != g_gen) {
                    visitedGen[nrot][ny + 5][nx + 4] = g_gen;
                    parent[nrot][ny + 5][nx + 4] = { (int8_t)curr.x, (int8_t)curr.y, (int8_t)curr.rot, (int8_t)action, (int8_t)drop };
                    parentGen[nrot][ny + 5][nx + 4] = g_gen;
                    bfsQueue[qTail++] = {nx, ny, nrot};
                }
            }
        };

        // ★高速化: スタック上端より上の「全空の空中」だけ一気に落とす（フリーフォール畳み込み）。
        //   上端より上は全セル空なので横移動は spawn 面と等価＝ロスレス。
        //   スタック上端に達したら通常の1段降下に戻し、占有領域の tuck/cave 配置の網羅性を保つ。
        if (canMoveDown) {
            // piece の最下ブロックの相対 y
            int maxRelY = 0;
            for (int i = 0; i < 4; i++)
                if (PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y > maxRelY)
                    maxRelY = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y;
            // 全ブロックが topY より上に収まる最大の y（= topY - maxRelY - 1）
            int target = topY - maxRelY - 1;
            if (target > curr.y) {
                tryPush(curr.x, target, curr.rot, 3, target - curr.y); // 空中を一気に softdrop
            } else {
                tryPush(curr.x, curr.y + 1, curr.rot, 3, 1);           // スタック近傍は1段ずつ
            }
        }

        GridBlock blocks_left[4];
        for (int i = 0; i < 4; i++) {
            blocks_left[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x - 1;
            blocks_left[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
        }
        if (isValidPlacement(baseBoard, blocks_left)) tryPush(curr.x - 1, curr.y, curr.rot, 1, 1); // left

        GridBlock blocks_right[4];
        for (int i = 0; i < 4; i++) {
            blocks_right[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x + 1;
            blocks_right[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
        }
        if (isValidPlacement(baseBoard, blocks_right)) tryPush(curr.x + 1, curr.y, curr.rot, 2, 1); // right

        for (int rotDir : {1, -1}) {
            int toRot = (curr.rot + (rotDir == 1 ? 1 : 3)) % 4;
            int actionId = (rotDir == 1) ? 4 : 5; // 4=CW 5=CCW
            bool isI = (pieceType == 0);
            const int (*table)[2] = isI ? (rotDir == 1 ? KICK_I_CW[curr.rot] : KICK_I_CCW[curr.rot])
                                        : (rotDir == 1 ? KICK_OTHER_CW[curr.rot] : KICK_OTHER_CCW[curr.rot]);
            for (int i = 0; i < 5; i++) {
                int kx = table[i][0];
                int ky = table[i][1];
                GridBlock blocks_rot[4];
                for (int j = 0; j < 4; j++) {
                    blocks_rot[j].x = PRECALC_MINO_BLOCKS[pieceType][toRot][j].x + curr.x + kx;
                    blocks_rot[j].y = PRECALC_MINO_BLOCKS[pieceType][toRot][j].y + curr.y + ky;
                }
                if (isValidPlacement(baseBoard, blocks_rot)) {
                    tryPush(curr.x + kx, curr.y + ky, toRot, actionId, 1);
                    break;
                }
            }
        }
    }
}

inline int getSpawnY(int type) { return type == 0 ? 4 : 3; }

// ── sfinder の isWallBetween 相当 ──────────────────────────────
// 目標矩形内のすべての行で「列 x-1 か列 x の少なくとも一方が埋まっている」なら壁あり。
// 壁があるとき、ピースは x-1 列と x 列をまたいで置けないので領域が独立する。
inline bool isWallBetween(const Board& b, int x, int H) {
    for (int y = ROWS - H; y < ROWS; y++) {
        bool leftEmpty  = ((b.rows[y] >> (x - 1)) & 1) == 0;
        bool rightEmpty = ((b.rows[y] >> x) & 1) == 0;
        if (leftEmpty && rightEmpty) return false;
    }
    return true;
}

// ── sfinder の validate() 相当 ────────────────────────────────
// 目標矩形を列方向の壁で区切り、各区間の空セル数が 4 の倍数でなければ PC 不可。
// 配置後に呼び出してブランチを早期枝刈りする。
inline bool validateRegion(const Board& b, int H) {
    int sum = 0;
    for (int y = ROWS - H; y < ROWS; y++)
        if ((b.rows[y] & 1) == 0) sum++;

    for (int x = 1; x < COLS; x++) {
        int colEmpty = 0;
        for (int y = ROWS - H; y < ROWS; y++)
            if (((b.rows[y] >> x) & 1) == 0) colEmpty++;

        if (isWallBetween(b, x, H)) {
            if (sum % 4 != 0) return false;
            sum = colEmpty;
        } else {
            sum += colEmpty;
        }
    }
    return sum % 4 == 0;
}

// ── sfinder の calcScore 相当 ─────────────────────────────────
// 目標領域内のホール数（埋まったセルより下にある空セル）を返す。
// 少ないほど良い配置なので昇順ソートに使う。
inline int countRegionHoles(const Board& b, int H) {
    int holes = 0;
    for (int x = 0; x < COLS; x++) {
        bool covered = false;
        for (int y = ROWS - H; y < ROWS; y++) {
            if ((b.rows[y] >> x) & 1) covered = true;
            else if (covered) holes++;
        }
    }
    return holes;
}

// ── PC 探索 DFS（途中ライン消去対応・sfinder 準拠）──
// queue は [current, next0..nextK]、holdPiece は別管理でピース順は固定（並べ替えない）。
// 各手番で「現在ピース」または「ホールド入替後のピース」を、残り leftLine 行の領域内に
// 置ける全配置で試す。配置のたびにライン消去を行い、leftLine が 0 になれば PC 成立。
//
// 健全な枝刈りは validateRegion(パリティ%4) と leftLine 天井制約のみ。
// 「最下段左の必須被覆」「穴のハード枝刈り」は途中消去があると正しさを壊すため使わない
// （穴数 countRegionHoles は探索順のヒューリスティックとしてのみ使用）。
struct PCResultMove {
    int minoType, rot, x, y, useHold;
    uint8_t path[64];
    int pathLength;
};

static int   g_queue[16];
static int   g_qlen = 0;
static int   g_N = 0;
static int   g_nodeBudget = 0; // 探索ノード上限（暴走防止）
static std::vector<PCResultMove> g_seq;

// ── ウォールクロックのタイムアウト ──
static double g_deadlineMs = 0;    // この時刻を過ぎたら打ち切り
static int    g_timeCheckCtr = 0;  // 時刻取得は重いので一定ノード毎に確認
static bool   g_timedOut = false;
inline bool pcTimeUp() {
    if (g_timedOut) return true;
    if (++g_timeCheckCtr >= 512) {
        g_timeCheckCtr = 0;
        if (nowMs() >= g_deadlineMs) g_timedOut = true;
    }
    return g_timedOut;
}

// leftLine: PC 成立までに消す必要が残っているライン数。0 で成立。
// canHoldNow: この手番でホールドが使えるか（配置後は常に true に戻る）
bool pcDfs(const Board& board, int curPiece, int holdPiece, int nextIdx, int placed, int leftLine, bool canHoldNow) {
    if (leftLine == 0) return true;   // PC 成立
    if (g_nodeBudget <= 0 || pcTimeUp()) return false;
    g_nodeBudget--;
    if (placed >= g_N) return false;
    if (curPiece < 0) return false;

    int ceil = ROWS - leftLine;       // この行(y)より上(小さいy)には置けない

    // 共通: ある配置候補を試すラムダ（配置後の次手番は常に canHold=true）
    // ★高速化: 配置リストは深さ毎の静的プールを再利用（毎ノードのヒープ確保を回避）。
    //   深さ placed のノードは placePool[placed] を使い、再帰は placed+1 を使うため衝突しない。
    static std::vector<PCPlacement> placePool[16];

    auto tryPlace = [&](int piece, int useHold, int nCur, int nHold, int nNext) -> bool {
        if (piece < 0) return false;
        std::vector<PCPlacement>& places = placePool[placed < 16 ? placed : 15];
        getAllPlacements(board, piece, getSpawnY(piece), places);

        // path を保持するため PCPlacement へのポインタも持つ（places は本ラムダ内で生存）
        struct Cand { Board nb; const PCPlacement* p; int cleared, score; };
        std::vector<Cand> cands;
        cands.reserve(places.size());

        auto makeMove = [&](const PCPlacement& p) -> PCResultMove {
            PCResultMove m{ piece, p.rot, p.x, p.y, useHold, {}, p.pathLength };
            for (int i = 0; i < p.pathLength && i < 64; i++) m.path[i] = p.path[i];
            return m;
        };

        for (auto& p : places) {
            // 残り領域（天井 ceil 以上＝下方）に収まるか。はみ出すと残せず PC 不可。
            bool inRegion = true;
            for (int i = 0; i < 4; i++)
                if (p.blocks[i].y < ceil) { inRegion = false; break; }
            if (!inRegion) continue;

            Board nb = board;
            for (int i = 0; i < 4; i++) nb.set(p.blocks[i].x, p.blocks[i].y);

            int cleared = nb.clearLines();
            int nextLeft = leftLine - cleared;
            if (nextLeft < 0) continue;  // 念のため

            if (nextLeft == 0) {
                // この手で PC 成立 → 記録して即終了
                g_seq.push_back(makeMove(p));
                return true;
            }

            if (placed + 1 >= g_N) continue;              // 手数を使い切り未達
            // sfinder validate() 相当: 列壁で区切った各区間の空セルが 4 の倍数でなければ枝刈り
            if (!validateRegion(nb, nextLeft)) continue;

            // sfinder calcScore 相当: ホール数の少ない配置を優先して試す（ソート用のみ）
            cands.push_back({nb, &p, cleared, countRegionHoles(nb, nextLeft)});
        }

        std::sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) {
            return a.score < b.score;
        });

        for (auto& c : cands) {
            g_seq.push_back(makeMove(*c.p));
            if (pcDfs(c.nb, nCur, nHold, nNext, placed + 1, leftLine - c.cleared, true)) return true;
            g_seq.pop_back();
        }
        return false;
    };

    // 系統A: そのまま現在ピースを置く
    if (tryPlace(curPiece, 0, (nextIdx < g_qlen ? g_queue[nextIdx] : -1), holdPiece, nextIdx + 1))
        return true;

    // 系統B: ホールド入替後に置く（この手番でホールド可能な場合のみ）
    if (canHoldNow) {
        int placePiece, newHold, newNext;
        if (holdPiece < 0) {
            // ホールドが空 → 現在ピースを格納し、次のピースを引いて置く
            placePiece = (nextIdx < g_qlen ? g_queue[nextIdx] : -1);
            newHold = curPiece;
            newNext = nextIdx + 1;
        } else {
            // ホールド済みピースと入替
            placePiece = holdPiece;
            newHold = curPiece;
            newNext = nextIdx;
        }
        // 重複除去(sfinder 準拠): 置くピースが現在ピースと同種なら系統A と等価なので省略
        if (placePiece >= 0 && placePiece != curPiece) {
            int afterCur = (newNext < g_qlen ? g_queue[newNext] : -1);
            if (tryPlace(placePiece, 1, afterCur, newHold, newNext + 1))
                return true;
        }
    }
    return false;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) { free(ptr); }

// ── エントリポイント ──
// board      : 250byte (25行×10列、JS と同形式)
// pieces     : 11個 [current, next0..next9]
// holdType   : -1=なし, 0..6
// canHold    : 0/1 (0 のときはホールド系統を使わない)
// maxDepth   : 探索する最大手数(<=10)
// outResult  : 256 int 確保すること。可変長レイアウト:
//   [0] = 見つかった手数 N (0=失敗)
//   以降、各手ごとに：
//     header 1個: bit0-2 minoType / bit3-4 rot / bit5-8 (x+2) / bit9-13 y /
//                 bit14 useHold / bit15-20 pathLength
//     path  ceil(pathLength/10) 個: 3bit×アクションID(1=左2=右3=SD4=CW5=CCW6=HD)を
//           1 int に 10 個ずつ詰める
//   ※ x は負値(最小 -2)を取りうるため +2 オフセットで格納(JS側で -2)
// maxTimeMs : 探索のウォールクロック上限(ms)。超過したら none(N=0) を返す。0以下なら無制限。
EMSCRIPTEN_KEEPALIVE
void searchPerfectClearWasm(
    uint8_t* board, int* pieces, int holdType, int canHold,
    int maxDepth, int maxTimeMs, int* outResult
) {
    ensurePrecalc();

    // タイムアウト初期化
    g_timedOut = false;
    g_timeCheckCtr = 0;
    g_deadlineMs = (maxTimeMs > 0) ? (nowMs() + maxTimeMs) : 1e18;

    const int OUT_INTS = 256;
    for (int i = 0; i < OUT_INTS; i++) outResult[i] = 0;

    Board baseBoard;
    int B = 0; // 既存ブロック総数
    for (int i = 0; i < 250; i++) {
        if (board[i]) { baseBoard.set(i % 10, i / 10); B++; }
    }

    // 矩形を上にはみ出している最上段（充填の最低必要高さ）
    int topFilledRow = ROWS; // 何も無ければ ROWS
    for (int y = 0; y < ROWS; y++) {
        if (baseBoard.rows[y] != 0) { topFilledRow = y; break; }
    }
    int minH = (topFilledRow == ROWS) ? 0 : (ROWS - topFilledRow);

    // queue 構築
    g_qlen = 0;
    for (int i = 0; i < 11; i++) g_queue[g_qlen++] = pieces[i];

    // 手数 N を昇順に試す（少ない手数のPCを優先）
    for (int N = 1; N <= maxDepth; N++) {
        if (N > g_qlen) break;            // 手数に対しピース数が不足
        if ((B + 4 * N) % 10 != 0) continue;
        int H = (B + 4 * N) / 10;         // この PC で消す合計ライン数 = 初期 leftLine
        if (H > ROWS) continue;
        if (H < minH) continue; // 既存スタックが目標高さより高い → 不可能

        g_N = N;
        g_nodeBudget = (B == 0) ? 800000 : 300000;
        g_seq.clear();

        int firstPiece = g_queue[0];
        bool found = pcDfs(baseBoard, firstPiece, holdType, 1, 0, H, canHold != 0);

        if (found) {
            int cnt = (int)g_seq.size();
            outResult[0] = cnt;
            int idx = 1; // 書き込み位置
            for (int i = 0; i < cnt; i++) {
                PCResultMove& m = g_seq[i];
                int pl = m.pathLength; if (pl > 63) pl = 63;
                int need = 1 + (pl + 9) / 10; // header + path ints
                if (idx + need > OUT_INTS) break; // バッファ保護（通常起こらない）

                outResult[idx++] = (m.minoType & 0x7)
                        | ((m.rot & 0x3) << 3)
                        | (((m.x + 2) & 0xF) << 5)   // x は負値あり → +2 オフセット
                        | ((m.y & 0x1F) << 9)
                        | ((m.useHold & 0x1) << 14)
                        | ((pl & 0x3F) << 15);
                int base = idx;
                int pints = (pl + 9) / 10;
                for (int k = 0; k < pints; k++) outResult[base + k] = 0;
                for (int k = 0; k < pl; k++)
                    outResult[base + k / 10] |= (m.path[k] & 0x7) << ((k % 10) * 3);
                idx += pints;
            }
            return;
        }

        if (g_timedOut) break; // 時間切れ → これ以上大きい N（より重い）は試さず none
    }
    // 見つからなかった（または時間切れ）
    outResult[0] = 0;
}

} // extern "C"
