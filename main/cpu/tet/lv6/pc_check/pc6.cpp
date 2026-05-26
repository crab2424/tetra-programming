// ─────────────────────────────────────────────
// pc6.cpp
// CPU6 用 パーフェクトクリア(全消し)探索 - cpu6.cpp とは完全に独立
//
// アルゴリズム: 矩形充填DFS
//   - ブロック総数 B と手数 N から目標高さ H = (B + 4N) / 10 を決め、
//     盤面最下段から H 行ぶんの矩形領域を「穴なし」で完全に埋める手順を探す。
//   - 各ステップで「最下段→左」の最初の空セルを必ず覆う配置のみを展開（分岐を抑制）。
//   - 配置は getAllPlacements による SRS 到達可能配置のみ（物理的に置ける手だけ）。
//   - HOLD は各手番で「そのまま置く / ホールドして入れ替えてから置く」の2系統で展開。
//   - ライン消去は途中で行わない（矩形が埋まりきった瞬間に全段消去 = PC 成立）。
// ─────────────────────────────────────────────

#include <emscripten.h>
#include <stdint.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>

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

// PC 探索用の軽量な配置情報（スコア・経路は不要）
struct PCPlacement {
    int rot, x, y;
    GridBlock blocks[4];
};

struct BFSState { int x, y, rot; };
struct ParentFlag { int8_t seen; };

// SRS 到達可能な「着地配置」を全列挙（cpu6.cpp の getAllPlacements を PC 用に簡略化）
std::vector<PCPlacement> getAllPlacements(const Board& baseBoard, int pieceType, int spawnY) {
    std::vector<PCPlacement> placements;
    placements.reserve(64);

    static bool visited[4][35][19];
    static bool placementFound[4][35][19];
    std::memset(visited, 0, sizeof(visited));
    std::memset(placementFound, 0, sizeof(placementFound));

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
        if (!isValidPlacement(baseBoard, startBlocks)) return placements;
    }

    static BFSState bfsQueue[3000];
    int qHead = 0, qTail = 0;
    bfsQueue[qTail++] = {spawnX, spawnY, initialRot};
    if (spawnY + 5 >= 0 && spawnY + 5 < 35 && spawnX + 4 >= 0 && spawnX + 4 < 19)
        visited[initialRot][spawnY + 5][spawnX + 4] = true;

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
                if (!placementFound[curr.rot][curr.y + 5][curr.x + 4]) {
                    placementFound[curr.rot][curr.y + 5][curr.x + 4] = true;
                    PCPlacement p;
                    p.rot = curr.rot; p.x = curr.x; p.y = curr.y;
                    for (int i = 0; i < 4; i++) {
                        p.blocks[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x;
                        p.blocks[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
                    }
                    placements.push_back(p);
                }
            }
        }

        auto tryPush = [&](int nx, int ny, int nrot) {
            if (ny + 5 >= 0 && ny + 5 < 35 && nx + 4 >= 0 && nx + 4 < 19) {
                if (!visited[nrot][ny + 5][nx + 4]) {
                    visited[nrot][ny + 5][nx + 4] = true;
                    bfsQueue[qTail++] = {nx, ny, nrot};
                }
            }
        };

        if (canMoveDown) tryPush(curr.x, curr.y + 1, curr.rot);

        GridBlock blocks_left[4];
        for (int i = 0; i < 4; i++) {
            blocks_left[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x - 1;
            blocks_left[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
        }
        if (isValidPlacement(baseBoard, blocks_left)) tryPush(curr.x - 1, curr.y, curr.rot);

        GridBlock blocks_right[4];
        for (int i = 0; i < 4; i++) {
            blocks_right[i].x = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].x + curr.x + 1;
            blocks_right[i].y = PRECALC_MINO_BLOCKS[pieceType][curr.rot][i].y + curr.y;
        }
        if (isValidPlacement(baseBoard, blocks_right)) tryPush(curr.x + 1, curr.y, curr.rot);

        for (int rotDir : {1, -1}) {
            int toRot = (curr.rot + (rotDir == 1 ? 1 : 3)) % 4;
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
                    tryPush(curr.x + kx, curr.y + ky, toRot);
                    break;
                }
            }
        }
    }
    return placements;
}

inline int getSpawnY(int type) { return type == 0 ? 4 : 3; }

// 矩形領域 [ROWS-H, ROWS-1] が完全に埋まっているか
inline bool isRegionFull(const Board& b, int H) {
    for (int y = ROWS - H; y < ROWS; y++)
        if (b.rows[y] != 0x3FF) return false;
    return true;
}

// 矩形領域内で「最下段→左」の最初の空セルを探す。空が無ければ false。
inline bool findLowestLeftEmpty(const Board& b, int H, int& outX, int& outY) {
    for (int y = ROWS - 1; y >= ROWS - H; y--) {
        if (b.rows[y] == 0x3FF) continue;
        for (int x = 0; x < COLS; x++) {
            if (((b.rows[y] >> x) & 1) == 0) { outX = x; outY = y; return true; }
        }
    }
    return false;
}

// 配置が「穴」を作らないか（各ブロック直下が 床/既存ブロック/自分自身 のいずれか）
inline bool isSolidPlacement(const Board& b, const GridBlock blocks[4]) {
    for (int i = 0; i < 4; i++) {
        int bx = blocks[i].x, by = blocks[i].y;
        int sy = by + 1;
        if (sy >= ROWS) continue;            // 床に接地 → OK
        if (b.has(bx, sy)) continue;          // 既存ブロックの上 → OK
        bool selfSupport = false;             // 同一ピースのブロックが直下にある → OK
        for (int j = 0; j < 4; j++) {
            if (blocks[j].x == bx && blocks[j].y == sy) { selfSupport = true; break; }
        }
        if (!selfSupport) return false;       // 直下が空 → 穴を作る
    }
    return true;
}

// ── PC 探索 DFS ──
// 手順は最大 N 手。queue は [current, next0..nextK]、holdPiece は別管理。
// 各手番: そのまま置く(useHold=0) / ホールド入替後に置く(useHold=1)。
struct PCResultMove { int minoType, rot, x, y, useHold; };

static int   g_queue[16];
static int   g_qlen = 0;
static int   g_N = 0;
static int   g_H = 0;
static int   g_nodeBudget = 0; // 探索ノード上限（暴走防止）
static std::vector<PCResultMove> g_seq;

// canHoldNow: この手番でホールドが使えるか（配置後は常に true に戻る）
bool pcDfs(const Board& board, int curPiece, int holdPiece, int nextIdx, int placed, bool canHoldNow) {
    if (g_nodeBudget <= 0) return false;
    g_nodeBudget--;

    if (isRegionFull(board, g_H)) return true; // PC 成立
    if (placed >= g_N) return false;
    if (curPiece < 0) return false;

    int cx, cy;
    if (!findLowestLeftEmpty(board, g_H, cx, cy)) return true; // 空無し = 充填完了

    // 共通: ある配置候補を試すラムダ（配置後の次手番は常に canHold=true）
    auto tryPlace = [&](int piece, int useHold, int nCur, int nHold, int nNext) -> bool {
        std::vector<PCPlacement> places = getAllPlacements(board, piece, getSpawnY(piece));
        for (auto& p : places) {
            // (cx,cy) を覆うか
            bool covers = false;
            for (int i = 0; i < 4; i++)
                if (p.blocks[i].x == cx && p.blocks[i].y == cy) { covers = true; break; }
            if (!covers) continue;
            // 領域内（上にはみ出さない）か
            bool inRegion = true;
            for (int i = 0; i < 4; i++)
                if (p.blocks[i].y < ROWS - g_H) { inRegion = false; break; }
            if (!inRegion) continue;
            Board nb = board;
            for (int i = 0; i < 4; i++) nb.set(p.blocks[i].x, p.blocks[i].y);

            g_seq.push_back({piece, p.rot, p.x, p.y, useHold});
            if (pcDfs(nb, nCur, nHold, nNext, placed + 1, true)) return true;
            g_seq.pop_back();
        }
        return false;
    };

    // 系統A: そのまま現在ピースを置く
    if (tryPlace(curPiece, 0, (nextIdx < g_qlen ? g_queue[nextIdx] : -1), holdPiece, nextIdx + 1))
        return true;

    // 系統B: ホールド入替後に置く（この手番でホールド可能な場合のみ）
    if (canHoldNow) {
        int placePiece, newHold, newNext, afterCur;
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
        if (placePiece >= 0) {
            afterCur = (newNext < g_qlen ? g_queue[newNext] : -1);
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
// outResult  : [0]=見つかった手数N(0=失敗), [1..N]=パック済みの各手
//   pack: bit0-2 minoType / bit3-4 rot / bit5-8 x / bit9-13 y / bit14 useHold
EMSCRIPTEN_KEEPALIVE
void searchPerfectClearWasm(
    uint8_t* board, int* pieces, int holdType, int canHold,
    int maxDepth, int* outResult
) {
    ensurePrecalc();

    for (int i = 0; i < 16; i++) outResult[i] = 0;

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
        if ((B + 4 * N) % 10 != 0) continue;
        int H = (B + 4 * N) / 10;
        if (H > ROWS) continue;
        if (H < minH) continue; // 既存スタックが目標高さより高い → 不可能
        if (B == 0 && N != 10) continue; // 空盤面は4ラインPC(N=10)のみ

        g_N = N;
        g_H = H;
        g_nodeBudget = (B == 0) ? 500000 : 200000;
        g_seq.clear();

        int firstPiece = g_queue[0];
        bool found = pcDfs(baseBoard, firstPiece, holdType, 1, 0, canHold != 0);

        if (found) {
            int cnt = (int)g_seq.size();
            outResult[0] = cnt;
            for (int i = 0; i < cnt && i < 15; i++) {
                PCResultMove& m = g_seq[i];
                int packed = (m.minoType & 0x7)
                        | ((m.rot & 0x3) << 3)
                        | ((m.x & 0xF) << 5)
                        | ((m.y & 0x1F) << 9)
                        | ((m.useHold & 0x1) << 14);
                outResult[1 + i] = packed;
            }
            return;
        }
    }
    // 見つからなかった
    outResult[0] = 0;
}

} // extern "C"
