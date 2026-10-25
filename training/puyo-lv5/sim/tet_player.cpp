// ─────────────────────────────────────────────
// sim/tet_player.cpp — テト CPU lv5 のプレイヤー（異種戦シミュのテト側）
//
//   本番の出どころ:
//     ・操作の組み立てと時間 … public/cpu/tet/lv5/cpu5.js buildActionQueue / processActionQueue / executeAction
//     ・設置・消去・攻撃     … public/game/tet/board.js secureMino, scoring.js Scoring
//     ・回転・T-spin         … public/game/tet/rotation.js tryRotate / checkTSpin
//     ・受け                 … public/game/tet/garbage.js offsetGarbage / applyGarbage
//   近似: 重力（Level 1 で 1000ms/段）・思考時間（150ms の待ちに隠れる前提）は無視する。
// ─────────────────────────────────────────────
#include "tet.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace tsim {

const int TET_LV5_WEIGHTS[TET_W_LEN] = {
    14,    // lineClear
    -40,   // hole
    -56,   // heightLimit
    -128,  // step3Plus
    4,     // flat
    3,     // step1Good
    -2,    // step1Bad
    -54,   // step2
    72,    // groundedBonus
    36,    // touchingBonus
    60,    // iWell
    -234,  // iWellOver
    -125,  // blocksOverHole
    500,   // line4
    68,    // downstackGood
    -3,    // downstackBad
    100,   // P1_WEIGHT * 100
    20,    // tsdShape
    -45,   // tsdShapeOver
    120,   // tsdFillBonus
    496,   // tssClear
    2560,  // tsdClear
    -6000, // tsdHolePenalty
    -50,   // pureHole
    20,    // comboBonus
    496,   // btbKeep
    -200,  // renCutPenalty
    -1000, // tsmMiniPenalty
    -360,  // tMinoNoClearPenalty
    30,    // tsdSetup
    -100,  // tsdSetupOver
    72,    // slopeBonus
    -36,   // slopePenalty
};

namespace {

struct PieceShape { int xy[8]; };
PieceShape g_shape[7][4];
bool g_shapeReady = false;

const PieceShape& shape(int type, int rot) {
    if (!g_shapeReady) {   // 起動直後に1回（tet_api の初期化で先に呼ぶ）
        for (int t = 0; t < 7; t++)
            for (int r = 0; r < 4; r++) pieceBlocks(t, r, g_shape[t][r].xy);
        g_shapeReady = true;
    }
    return g_shape[type][rot];
}

// garbage_router.ts tetGaugeToOjama
int gaugeToOjama(int g) {
    static const int table[18] = {0, 4, 5, 6, 8, 10, 13, 16, 20, 24, 28, 33, 38, 43, 49, 55, 61, 68};
    if (g < 18) return table[g];
    return (g * g - 21 * g + 204) / 2;
}

enum ActType { A_ROT_CW, A_ROT_CCW, A_LEFT, A_RIGHT, A_SOFT, A_MOVE_TO, A_MULTI_SOFT, A_HARD };
struct Act { ActType type; int arg; };

} // namespace

void initTetShapes() { shape(0, 0); }
int  tetGaugeToOjama(int gauge) { return gaugeToOjama(gauge); }

TetPlayer::TetPlayer(uint32_t seed) : rng(seed) {
    std::memset(rows, 0, sizeof rows);
    std::memcpy(weights, TET_LV5_WEIGHTS, sizeof weights);
}

int TetPlayer::nextType() {
    if (bag.empty()) {
        bag = {0, 1, 2, 3, 4, 5, 6};
        for (int i = 6; i > 0; i--) {
            int j = (int)std::floor(rng.next() * (i + 1));
            std::swap(bag[i], bag[j]);
        }
    }
    int t = bag.back();
    bag.pop_back();
    return t;
}

bool TetPlayer::valid(int type, int rot, int x, int y) const {
    const PieceShape& s = shape(type, rot);
    for (int i = 0; i < 4; i++) {
        int bx = s.xy[i * 2] + x, by = s.xy[i * 2 + 1] + y;
        if (bx < 0 || bx >= TCOLS || by < 0 || by >= TROWS) return false;
        if (rows[by] & (1 << bx)) return false;
    }
    return true;
}

// cpu5.js canDropStraightFromTo（場外は左右だけ見る。上の隠し段より上は空き扱い）
bool TetPlayer::canDrop(int type, int rot, int x, int y0, int y1) const {
    const PieceShape& s = shape(type, rot);
    for (int y = y0; y <= y1; y++) {
        for (int i = 0; i < 4; i++) {
            int bx = s.xy[i * 2] + x, by = s.xy[i * 2 + 1] + y;
            if (bx < 0 || bx >= TCOLS) return false;
            if (by >= 0 && by < TROWS && (rows[by] & (1 << bx))) return false;
        }
    }
    return true;
}

bool TetPlayer::tryRotate(int dir) {
    int to = (prot + (dir == 1 ? 1 : 3)) % 4;
    int k[10];
    kickTable(cur, prot, dir, k);
    for (int i = 0; i < 5; i++) {
        int nx = px + k[i * 2], ny = py + k[i * 2 + 1];
        if (valid(cur, to, nx, ny)) {
            px = nx; py = ny; prot = to;
            lastPoint5 = (i == 4);
            lastRot = true;
            return true;
        }
    }
    return false;
}

bool TetPlayer::spawn(int type) {
    cur = type;
    prot = 0;
    px = TCOLS / 2 - 2;
    py = (type == 0) ? 4 : 3;     // 本番 spawn(): I は y=-1、他は y=-2
    if (!valid(cur, prot, px, py)) {
        py -= 1;
        if (!valid(cur, prot, px, py)) return false;
    }
    lastRot = false;
    lastPoint5 = false;
    return true;
}

void TetPlayer::start(double t0) {
    std::memset(rows, 0, sizeof rows);
    queue.clear();
    bag.clear();
    for (int i = 0; i < 11; i++) queue.push_back(nextType());   // lifecycle.js：内部で11個
    hold = -1;
    canHold = true;
    ren = 0;
    b2b = false;
    dead = false;
    now = t0;
    int t = queue.front();
    queue.erase(queue.begin());
    queue.push_back(nextType());
    if (!spawn(t)) dead = true;
}

int TetPlayer::marginStep(double t) const {
    if (marginTimeMs < 0 || t < marginTimeMs) return -1;
    return std::min(5, (int)((t - marginTimeMs) / 32000.0));
}

int TetPlayer::stackHeight() const {
    for (int y = 0; y < TROWS; y++) if (rows[y]) return TROWS - y;
    return 0;
}

// rotation.js checkTSpin（3隅ルール。場外の上方は空き扱い）
int TetPlayer::checkTSpin() const {
    if (cur != 2 || !lastRot) return 0;
    int cx = px + 1, cy = py + 2;   // pivot (1,2) → Math.round(x + 0.5) = x+1, Math.round(y + 1.5) = y+2
    int cs[4][2] = {{cx - 1, cy - 1}, {cx + 1, cy - 1}, {cx - 1, cy + 1}, {cx + 1, cy + 1}};
    bool occ[4];
    for (int i = 0; i < 4; i++) {
        int x = cs[i][0], y = cs[i][1];
        occ[i] = x < 0 || x >= TCOLS || y >= TROWS || (y >= 0 && (rows[y] & (1 << x)));
    }
    int ab[2], cd[2];
    switch (prot) {
        case 0: ab[0] = 0; ab[1] = 1; cd[0] = 2; cd[1] = 3; break;
        case 1: ab[0] = 1; ab[1] = 3; cd[0] = 0; cd[1] = 2; break;
        case 2: ab[0] = 3; ab[1] = 2; cd[0] = 1; cd[1] = 0; break;
        default: ab[0] = 2; ab[1] = 0; cd[0] = 3; cd[1] = 1; break;
    }
    int abF = occ[ab[0]] + occ[ab[1]], cdF = occ[cd[0]] + occ[cd[1]];
    if (abF == 2 && cdF >= 1) return 1;
    if (cdF == 2 && abF >= 1) return lastPoint5 ? 1 : 2;
    return 0;
}

// garbage.js offsetGarbage（ready → 未 ready の順。internal も区別しない）
static int offsetQueue(std::vector<TGarbage>& q, int amount) {
    for (int pass = 0; pass < 2 && amount > 0; pass++) {
        for (auto& g : q) {
            if (amount <= 0) break;
            if (g.ready != (pass == 0) || g.amount <= 0) continue;
            int take = std::min(g.amount, amount);
            g.amount -= take;
            amount -= take;
            if ((int)g.holes.size() > g.amount) g.holes.erase(g.holes.begin(), g.holes.end() - g.amount);
        }
    }
    q.erase(std::remove_if(q.begin(), q.end(), [](const TGarbage& g) { return g.amount <= 0; }), q.end());
    return amount;
}

std::vector<int> TetPlayer::holesFor(int lines) {
    // garbage_router.ts buildGarbageHoles（1段目ランダム、以降 holeRate% で同じ列）
    std::vector<int> holes;
    int prev = -1;
    for (int i = 0; i < lines; i++) {
        int h;
        if (prev < 0) h = (int)std::floor(rng.next() * TCOLS);
        else if (rng.next() < holeRatePercent / 100.0) h = prev;
        else h = (prev + (int)std::floor(rng.next() * (TCOLS - 1)) + 1) % TCOLS;
        holes.push_back(h);
        prev = h;
    }
    return holes;
}

void TetPlayer::pushGarbageLines(int lines, double readyAt) {
    TGarbage g;
    g.id = nextGarbageId_++;
    g.amount = lines;
    g.ready = false;
    g.readyAt = readyAt;
    g.internalUntil = 0;
    g.holes = holesFor(lines);
    garbageQueue.push_back(g);
}

int TetPlayer::receiveFromPuyo(int lines, double now) {
    TGarbage g;
    g.id = nextGarbageId_++;
    g.amount = lines;
    g.ready = false;
    g.readyAt = 1e18;              // 送り手の連鎖終了（confirmFromPuyo）まで ready にならない
    g.internalUntil = now + 500.0; // stage1（非表示）
    g.holes = holesFor(lines);
    garbageQueue.push_back(g);
    st.linesReceived += lines;
    return g.id;
}

void TetPlayer::confirmFromPuyo(const std::vector<int>& ids) {
    for (int id : ids)
        for (auto& g : garbageQueue)
            if (g.id == id) g.ready = true;
}

// garbage.js applyGarbage（異種戦＝1回の設置で最大7ライン）
void TetPlayer::applyGarbage() {
    std::vector<TGarbage> readyG, rest;
    for (auto& g : garbageQueue) {
        bool internal = now < g.internalUntil;
        if (g.ready && !internal) readyG.push_back(g); else rest.push_back(g);
    }
    if (readyG.empty()) return;
    garbageQueue = rest;
    const int limit = 7;
    int dropped = 0;
    for (size_t j = 0; j < readyG.size(); j++) {
        TGarbage& g = readyG[j];
        int dropCount = 0;
        for (int i = 0; i < g.amount; i++) {
            if (dropped >= limit) break;
            for (int y = 0; y < TROWS - 1; y++) rows[y] = rows[y + 1];   // 最上段より上へ押し出された分は消える（本番は見えない段に残るが判定に効かない）
            int hole = (i < (int)g.holes.size()) ? g.holes[i] : (int)std::floor(rng.next() * TCOLS);
            rows[TROWS - 1] = (uint16_t)(0x3FF & ~(1 << hole));
            dropCount++;
            dropped++;
        }
        if (dropCount < g.amount) {
            TGarbage r = g;
            r.amount = g.amount - dropCount;
            r.holes = g.holes.size() > (size_t)dropCount ? std::vector<int>(g.holes.begin() + dropCount, g.holes.end()) : std::vector<int>();
            r.ready = true;
            garbageQueue.insert(garbageQueue.begin(), r);
            for (size_t k = j + 1; k < readyG.size(); k++) garbageQueue.push_back(readyG[k]);
            break;
        }
    }
    st.garbageLinesTaken += dropped;
}

// board.js secureMino ＋ scoring.js Scoring（相手がぷよのとき）
void TetPlayer::lockPiece(double t) {
    for (auto& g : garbageQueue) if (!g.ready && t >= g.readyAt) g.ready = true;   // 猶予タイマー
    const PieceShape& s = shape(cur, prot);
    bool allOutside = true;
    for (int i = 0; i < 4; i++) if (s.xy[i * 2 + 1] + py >= THIDDEN) allOutside = false;

    int tspin = checkTSpin();   // 1=tspin 2=mini
    for (int i = 0; i < 4; i++) {
        int bx = s.xy[i * 2] + px, by = s.xy[i * 2 + 1] + py;
        if (by >= 0 && by < TROWS) rows[by] |= (uint16_t)(1 << bx);
    }
    int lines = 0;
    {
        int w = TROWS - 1;
        for (int y = TROWS - 1; y >= 0; y--) {
            if (rows[y] == 0x3FF) lines++;
            else rows[w--] = rows[y];
        }
        for (; w >= 0; w--) rows[w] = 0;
    }
    int renForCalc = ren;
    bool isBtBAction = lines > 0 && (lines == 4 || tspin != 0);
    bool b2bTrig = isBtBAction && b2b;
    bool pc = true;
    for (int y = 0; y < TROWS; y++) if (rows[y]) { pc = false; break; }

    // Scoring：B2B・REN の更新と内部火力（generatedGarbage）
    if (isBtBAction) b2b = true;
    else if (lines > 0) b2b = false;
    if (lines > 0) ren++; else ren = 0;

    int ms = marginStep(t);
    int gen = 0;
    if (ms < 0) {
        if (pc) gen = 10;
        else if (lines > 0) {
            if (tspin == 1) gen = lines * 2;
            else gen = (lines == 2) ? 1 : (lines == 3) ? 2 : (lines == 4) ? 4 : 0;
            if (b2bTrig) gen += 1;
            int r = renForCalc;
            gen += (r == 2 || r == 3) ? 1 : (r == 4 || r == 5) ? 2 : (r == 6 || r == 7) ? 3 : (r >= 8 && r <= 12) ? 4 : (r >= 13) ? 5 : 0;
        }
    } else {
        static const int L[4][6] = {{0, 0, 1, 1, 1, 2}, {1, 1, 2, 2, 3, 4}, {2, 2, 3, 4, 5, 6}, {4, 5, 5, 6, 8, 10}};
        static const int TS[3][6] = {{2, 2, 3, 4, 5, 6}, {4, 5, 5, 6, 8, 10}, {6, 7, 8, 10, 12, 16}};
        static const int BTB[6] = {1, 1, 2, 2, 3, 4};
        static const int PCB[6] = {12, 13, 14, 15, 16, 18};
        static const int REN[6] = {0, 0, 0, 1, 1, 1};
        if (pc) gen = PCB[ms];
        else if (lines > 0) {
            if (tspin == 1) gen = TS[std::min(lines, 3) - 1][ms];
            else gen = L[std::min(lines, 4) - 1][ms];
            if (b2bTrig) gen += BTB[ms];
            int r = renForCalc;
            int rb = (r == 2 || r == 3) ? 1 : (r == 4 || r == 5) ? 2 : (r == 6 || r == 7) ? 3 : (r >= 8 && r <= 12) ? 4 : (r >= 13) ? 5 : 0;
            if (rb > 0) gen += rb + REN[ms];
        }
    }

    // 対ぷよ用ゲージ（board.js isOpponentPuyo の分岐）
    int puyoAtk = 0;
    if (lines > 0) {
        static const int renTable[20] = {0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5};
        int renVal = renForCalc >= 20 ? 5 : renTable[renForCalc];
        if (pc) {
            static const int PPC[6] = {7, 7, 8, 9, 10, 12};
            puyoAtk = ms < 0 ? 6 : PPC[ms];
        } else if (ms < 0) {
            if (tspin == 1) puyoAtk = (lines == 1) ? 2 : (lines == 2) ? 3 : (lines == 3) ? 5 : 0;
            else puyoAtk = (lines == 2) ? 1 : (lines == 3) ? 2 : (lines == 4) ? 4 : 0;
            if (b2bTrig) puyoAtk += 1;
            puyoAtk += renVal;
        } else {
            static const int PL[4][6] = {{0, 0, 1, 1, 1, 2}, {1, 1, 2, 2, 3, 4}, {2, 2, 3, 4, 5, 6}, {4, 5, 5, 6, 8, 10}};
            static const int PT[3][6] = {{2, 2, 3, 4, 5, 6}, {3, 3, 4, 5, 6, 8}, {4, 5, 5, 6, 8, 10}};
            static const int PB[6] = {1, 1, 2, 2, 3, 4};
            static const int PR[6] = {0, 0, 1, 1, 1, 1};
            if (tspin == 1) puyoAtk = PT[std::min(lines, 3) - 1][ms];
            else puyoAtk = PL[std::min(lines, 4) - 1][ms];
            if (b2bTrig) puyoAtk += PB[ms];
            if (renForCalc >= 2) renVal += PR[ms];
            puyoAtk += renVal;
        }
        // 相殺用の内部火力を対ぷよ REN 追加ボーナス基準に揃え直す（本番も同値＝差し替えなし）
    }
    releaseAttack(t, lines > 0, puyoAtk, gen);

    // 集計
    st.pieces++;
    st.lines += lines;
    if (tspin == 1 && lines > 0) st.tspins++;
    if (tspin == 2 && lines > 0) st.tsMini++;
    if (lines == 4) st.tetrises++;
    if (pc) st.pcs++;
    if (b2bTrig) st.b2bs++;
    st.maxRen = std::max(st.maxRen, ren);
    st.tetAttack += gen;
    if (keepLog) locks.push_back({t, cur, lines, tspin, pc, b2bTrig, renForCalc, puyoAtk, gen});

    if (allOutside) { dead = true; return; }   // Lock Out

    // 次のミノの直前に、届いているおじゃまを適用（DAMAGE ON CLEAR が ON なら消去時も）
    now = t;
    if (damageOnClear || lines == 0) applyGarbage();

    // popMino
    int nt = queue.front();
    queue.erase(queue.begin());
    queue.push_back(nextType());
    canHold = true;
    if (!spawn(nt)) dead = true;
}

void TetPlayer::releaseAttack(double t, bool cleared, int puyoAtk, int tetAtk) {
    if (cleared) {
        int canceled = 0, remain = tetAtk;
        if (!garbageQueue.empty() && tetAtk > 0) {
            remain = offsetQueue(garbageQueue, tetAtk);
            canceled = tetAtk - remain;
        }
        pendingInternal += remain;
        pendingAttack += std::max(0, puyoAtk - canceled);
    } else {
        int canceled = 0;
        if (!garbageQueue.empty() && pendingInternal > 0) {
            int before = pendingInternal;
            pendingInternal = offsetQueue(garbageQueue, pendingInternal);
            canceled = before - pendingInternal;
        }
        int send = std::max(0, pendingAttack - canceled);
        if (send > 0) {
            int oj = gaugeToOjama(send);
            st.gaugeSent += send;
            st.ojamaSent += oj;
            sends.push_back({t, send, oj});
            if (onSend) onSend(t, oj);
        }
        pendingAttack = 0;
        pendingInternal = 0;
    }
}

double TetPlayer::step() {
    double t = plan();
    if (t < 0) return -1;
    commit();
    return dead ? -1 : t;
}

void TetPlayer::commit() {
    if (!hasPlan_) return;
    hasPlan_ = false;
    lockPiece(lockT_);
    now = lockT_ + (planNoMove_ ? 0.0 : T_HARDDROP_MS);
}

double TetPlayer::plan() {
    if (dead) return -1;
    if (hasPlan_) return lockT_;
    for (int guard = 0; guard < 3; guard++) {
        // ── 探索（cpu5.js onMinoSpawned）──
        SearchCase sc;
        for (int i = 0; i < 250; i++) sc.board[i] = (rows[i / 10] >> (i % 10)) & 1;
        sc.cur = cur;
        sc.hold = hold;
        for (int i = 0; i < 5; i++) sc.next[i] = queue[i];
        sc.canHold = canHold ? 1 : 0;
        sc.ren = ren;
        sc.b2b = b2b ? 1 : 0;
        cpuSearch(sc.board, sc.cur, sc.hold, sc.next, sc.canHold, weights, sc.ren, sc.b2b, sc.out);
        if (traceCases) traceCases->push_back(sc);
        const int* res = sc.out;

        if (res[0] == -1) {
            // 置き場所が無い：出現から 700ms 後にその場でハードドロップ（出現 = now − 150）
            st.noMove++;
            double t = now - T_HARDDROP_MS + T_NOMOVE_MS;
            int d = 0;
            while (valid(cur, prot, px, py + 1)) { py++; d++; }
            if (d > 0) lastRot = false;
            hasPlan_ = true; planNoMove_ = true; lockT_ = t;
            return t;
        }
        if (res[0] == 1) {
            // HOLD：45ms 後に HOLD、その 45ms 後に次の executeAction
            st.holds++;
            canHold = false;
            if (hold < 0) {
                hold = cur;
                int nt = queue.front();
                queue.erase(queue.begin());
                queue.push_back(nextType());
                if (!spawn(nt)) { dead = true; return -1; }
            } else {
                int h = hold;
                hold = cur;
                if (!spawn(h)) { dead = true; return -1; }
            }
            canHold = false;
            now += 2 * T_ACTION_MS;
            continue;
        }

        // ── 操作列を組み立てる（cpu5.js buildActionQueue）──
        int bId = res[3], bRot = res[4], bX = res[5], bY = res[6], bTs = res[12];
        std::vector<int> path;
        for (int i = 0; i < 64; i++) {
            int a = (res[36 + i / 10] >> ((i % 10) * 3)) & 7;
            if (a == 0) break;
            path.push_back(a);
        }
        const int startX = px, startY = py, startRot = prot;
        std::vector<Act> q;

        // 経路を盤面上で再生して各時点の位置を求める
        struct S { int x, y, rot; };
        std::vector<S> states{{px, py, prot}};
        {
            int sx = px, sy = py, sr = prot;
            bool slr = lastRot, slp = lastPoint5;
            for (int a : path) {
                if (a == 1) { if (valid(cur, prot, px - 1, py)) px--; }
                else if (a == 2) { if (valid(cur, prot, px + 1, py)) px++; }
                else if (a == 3) { if (valid(cur, prot, px, py + 1)) py++; }
                else if (a == 4) tryRotate(1);
                else if (a == 5) tryRotate(-1);
                else if (a == 6) break;
                states.push_back({px, py, prot});
            }
            px = sx; py = sy; prot = sr; lastRot = slr; lastPoint5 = slp;
        }
        int bestI = -1;
        for (int i = (int)states.size() - 1; i >= 1; i--) {
            const S& s = states[i];
            if (!canDrop(bId, s.rot, s.x, startY, s.y)) continue;
            bool rotTop = canDrop(bId, s.rot, startX, startY, startY);
            bool moveTop = true;
            int stp = s.x > startX ? 1 : -1;
            for (int tx = startX; tx != s.x + stp; tx += stp)
                if (!canDrop(bId, s.rot, tx, startY, startY)) { moveTop = false; break; }
            if (rotTop && moveTop) { bestI = i; break; }
        }
        auto checkInstant = [&](int r) {
            if (!canDrop(bId, r, startX, startY, startY)) return false;
            int stp = bX > startX ? 1 : -1;
            for (int tx = startX; tx != bX + stp; tx += stp)
                if (!canDrop(bId, r, tx, startY, startY)) return false;
            return canDrop(bId, r, bX, startY, bY);
        };
        bool skipInstant = false;
        if (bTs > 0 && b2b) {
            // getClearedLines：p1 の位置に置いたら揃う段があるか
            const PieceShape& s = shape(bId, bRot);
            uint16_t tmp[TROWS];
            std::memcpy(tmp, rows, sizeof tmp);
            for (int i = 0; i < 4; i++) {
                int by = s.xy[i * 2 + 1] + bY;
                if (by >= 0 && by < TROWS) tmp[by] |= (uint16_t)(1 << (s.xy[i * 2] + bX));
            }
            for (int y = 0; y < TROWS; y++) if (tmp[y] == 0x3FF) { skipInstant = true; break; }
        }
        auto pushRot = [&](int from, int to) {
            int diff = (to - from + 4) % 4;
            if (diff == 1) q.push_back({A_ROT_CW, 0});
            else if (diff == 2) { q.push_back({A_ROT_CW, 0}); q.push_back({A_ROT_CW, 0}); }
            else if (diff == 3) q.push_back({A_ROT_CCW, 0});
        };
        auto pushPath = [&](size_t from) {
            bool sd = false;
            int sdY = -1;
            for (size_t j = from; j < path.size(); j++) {
                int a = path[j];
                if (a == 3) { sd = true; sdY = states[j + 1].y; continue; }
                if (sd) { q.push_back({A_MULTI_SOFT, sdY}); sd = false; }
                if (a == 1) q.push_back({A_LEFT, 0});
                else if (a == 2) q.push_back({A_RIGHT, 0});
                else if (a == 4) q.push_back({A_ROT_CW, 0});
                else if (a == 5) q.push_back({A_ROT_CCW, 0});
                else if (a == 6) q.push_back({A_HARD, 0});
            }
            if (sd) q.push_back({A_MULTI_SOFT, sdY});
        };

        if (path.empty()) {
            st.routeInstant++;
            q.push_back({A_MOVE_TO, bX});
            q.push_back({A_HARD, 0});
        } else if (!skipInstant && checkInstant(bRot)) {
            st.routeInstant++;
            int targetRot = bRot;
            if ((bId == 0 || bId == 1 || bId == 5 || bId == 6) && (bRot == 2 || bRot == 0) && checkInstant(startRot))
                targetRot = startRot;
            pushRot(startRot, targetRot);
            if (bX != startX) q.push_back({A_MOVE_TO, bX});
            q.push_back({A_HARD, 0});
        } else if (bestI > 0) {
            st.routePath++;
            const S& s = states[bestI];
            pushRot(startRot, s.rot);
            if (s.x != startX) q.push_back({A_MOVE_TO, s.x});
            if (s.y - startY > 0) q.push_back({A_MULTI_SOFT, s.y});
            pushPath((size_t)bestI);
        } else {
            st.routeFull++;
            pushPath(0);
        }

        // ── 実行（cpu5.js processActionQueue）──
        double t = now + T_ACTION_MS;   // executeAction の setTimeout
        for (size_t i = 0; i < q.size(); i++) {
            const Act& a = q[i];
            switch (a.type) {
                case A_ROT_CW:  tryRotate(1);  t += T_ACTION_MS; break;
                case A_ROT_CCW: tryRotate(-1); t += T_ACTION_MS; break;
                case A_LEFT:  if (valid(cur, prot, px - 1, py)) px--; t += T_ACTION_MS; break;
                case A_RIGHT: if (valid(cur, prot, px + 1, py)) px++; t += T_ACTION_MS; break;
                case A_SOFT:  if (valid(cur, prot, px, py + 1)) py++; t += T_ACTION_MS; break;
                case A_MOVE_TO: {
                    while (true) {
                        t += T_ACTION_MS;
                        if (px == a.arg) break;
                        int stp = px < a.arg ? 1 : -1;
                        int prev = px;
                        if (valid(cur, prot, px + stp, py)) px += stp;
                        if (px == a.arg) break;
                        if (prev == px) { px = a.arg; st.teleports++; break; }   // 本番の癖：塞がれたら目標へ
                    }
                    break;
                }
                case A_MULTI_SOFT:
                    while (py < a.arg && valid(cur, prot, px, py + 1)) { py++; t += T_SOFTDROP_MS; }
                    break;
                case A_HARD: {
                    int d = 0;
                    while (valid(cur, prot, px, py + 1)) { py++; d++; }
                    if (d > 0) lastRot = false;
                    hasPlan_ = true; planNoMove_ = false; lockT_ = t;
                    return t;
                }
            }
        }
        // ハードドロップが無い操作列（本番では起きない想定）：その場で置く
        hasPlan_ = true; planNoMove_ = false; lockT_ = t;
        return t;
    }
    return -1;
}

} // namespace tsim
