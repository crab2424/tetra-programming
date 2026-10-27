// ─────────────────────────────────────────────
// sim/tet_api.cpp — テト側の C ABI（Python ctypes から呼ぶ）
//   tet_solo_run    … テト CPU lv5 のひとり用（毎秒ミノ数・攻撃量を測る。おじゃまを定期的に入れることもできる）
//   tet_trace_cases … 探索の入出力を残す（本番 wasm との一致テスト tests/test_tet_parity.py 用）
//   tet_solo_run_lv / tet_trace_cases_lv … 上の2つのレベル指定版（lv4/5/6・重みの差し替え）
//   tet_vs_run      … テト同士の対戦（lv4/5/6 の総当たり・重みの A/B）。設計: source_assets/memory/cpu/tet/lv5-terrain-design.md §4
// ─────────────────────────────────────────────
#include "tet.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <thread>
#include <vector>

using namespace tsim;

namespace {

template <class F>
void parallelFor(int n, int nThreads, F fn) {
    if (nThreads <= 0) nThreads = (int)std::max(1u, std::thread::hardware_concurrency());
    nThreads = std::min(nThreads, std::max(1, n));
    std::atomic<int> next(0);
    auto worker = [&]() {
        for (int i; (i = next.fetch_add(1)) < n;) fn(i);
    };
    if (nThreads == 1) { worker(); return; }
    std::vector<std::thread> ts;
    for (int t = 0; t < nThreads; t++) ts.emplace_back(worker);
    for (auto& t : ts) t.join();
}

// おじゃまを定期的に入れながら1局（garbageEvery<=0 なら入れない）
void runSolo(TetPlayer& p, int maxPieces, double maxMs, int garbageEvery, int garbageLines) {
    p.start(0);
    int n = 0;
    while (!p.dead && n < maxPieces && p.now < maxMs) {
        if (garbageEvery > 0 && n > 0 && n % garbageEvery == 0) p.pushGarbageLines(garbageLines, p.now);
        if (p.step() < 0) break;
        n++;
    }
}

// ── 地形の指標（設計 lv5-terrain-design.md §1.3）──
//   穴＝上にブロックがある空きマス。ただし T-slot として成立している4マス（cpu5.cpp isTSDShape と同じ形）は除く。
static bool tSolid(const uint16_t* r, int x, int y) {
    if (x < 0 || x >= TCOLS || y >= TROWS) return true;
    if (y < 0) return false;
    return (r[y] >> x) & 1;
}
static int terrainHoles(const uint16_t* r) {
    uint16_t ts[TROWS] = {0};
    for (int cy = 1; cy < TROWS - 1; cy++)
        for (int cx = 1; cx < TCOLS - 1; cx++) {
            if (tSolid(r, cx, cy) || tSolid(r, cx - 1, cy) || tSolid(r, cx + 1, cy) || tSolid(r, cx, cy + 1)) continue;
            if (!(tSolid(r, cx - 1, cy + 1) && tSolid(r, cx + 1, cy + 1) && tSolid(r, cx - 2, cy + 1) && tSolid(r, cx + 2, cy + 1))) continue;
            bool L = tSolid(r, cx - 1, cy - 1) && tSolid(r, cx - 2, cy);
            bool R = tSolid(r, cx + 1, cy - 1) && tSolid(r, cx + 2, cy - 1);
            if (L == R) continue;
            ts[cy] |= (uint16_t)(7 << (cx - 1));
            ts[cy + 1] |= (uint16_t)(1 << cx);
        }
    int h = 0;
    uint16_t above = 0;
    for (int y = 0; y < TROWS; y++) {
        h += __builtin_popcount(above & ~r[y] & ~ts[y] & 0x3FF);
        above |= r[y];
    }
    return h;
}
static void terrainHeights(const uint16_t* r, int hs[TCOLS]) {
    for (int x = 0; x < TCOLS; x++) {
        hs[x] = 0;
        for (int y = 0; y < TROWS; y++) if ((r[y] >> x) & 1) { hs[x] = TROWS - y; break; }
    }
}

int g_clysThinkMs = 100, g_clysWidth = 500, g_clysBranch = 3;
double g_thinkScaleLv[64], g_pcScaleLv[64];
bool g_scaleInit = [] { for (int i = 0; i < 64; i++) g_thinkScaleLv[i] = g_pcScaleLv[i] = 1.0; return true; }();

// ★Phase 0（lv6-learning-design.md）：席ごとの探索設定。-1 は変えない（[0]=全員の既定、[1]=A、[2]=B）
struct SideCfg { int queueLen = -1, clysThink = -1, clysWidth = -1, clysBranch = -1, clysNext = -1, clysDepth = -1,
                 lv6Width = -1, lv6Depth = -1, lv6Next = -1; };
SideCfg g_sideCfg[3];
void applySide(TetPlayer& p, const SideCfg& c) {
    if (c.queueLen > 0) p.queueLen = c.queueLen;
    if (c.clysThink > 0) p.clysThinkMs = c.clysThink;
    if (c.clysWidth > 0) p.clysWidth = c.clysWidth;
    if (c.clysBranch > 0) p.clysBranch = c.clysBranch;
    if (c.clysNext > 0) p.clysNext = c.clysNext;
    if (c.clysDepth > 0) p.clysDepth = c.clysDepth;
    if (c.lv6Width > 0) p.lv6Width = c.lv6Width;
    if (c.lv6Depth > 0) p.lv6Depth = c.lv6Depth;
    if (c.lv6Next > 0) p.lv6Next = c.lv6Next;
}

void setup(TetPlayer& p, int level, const int* w, int wLen) {
    p.setLevel(level);
    p.clysThinkMs = g_clysThinkMs; p.clysWidth = g_clysWidth; p.clysBranch = g_clysBranch;
    applySide(p, g_sideCfg[0]);
    if (level >= 0 && level < 64) { p.thinkScale = g_thinkScaleLv[level]; p.pcThinkScale = g_pcScaleLv[level]; }
    if (w && wLen > 0) {
        int n = std::min(wLen, tetWeightsLen(p.weightLevel()));
        std::memcpy(p.weights, w, sizeof(int) * n);
    }
}

void writeSolo(const TetPlayer& p, int marginTimeMs, double* o) {
    const TetStats& s = p.st;
    o[0] = s.pieces; o[1] = p.now; o[2] = s.lines; o[3] = s.tspins; o[4] = s.tsMini; o[5] = s.tetrises;
    o[6] = s.pcs; o[7] = s.b2bs; o[8] = s.maxRen; o[9] = (double)s.gaugeSent; o[10] = (double)s.ojamaSent;
    o[11] = (double)s.tetAttack; o[12] = s.teleports; o[13] = s.routeInstant; o[14] = s.routePath; o[15] = s.routeFull;
    o[16] = s.noMove; o[17] = s.holds; o[18] = p.dead ? 1 : 0; o[19] = s.garbageLinesTaken;
    double mt = marginTimeMs < 0 ? 1e18 : marginTimeMs;
    long long ojPre = 0;
    for (const auto& e : p.sends) if (e.t < mt) ojPre += e.ojama;
    int piecesPre = 0;
    for (const auto& e : p.locks) if (e.t < mt) piecesPre++;
    o[20] = (double)ojPre; o[21] = std::min(p.now, mt); o[22] = piecesPre; o[23] = p.stackHeight();
}

// ── テト同士の1局 ──
//   runMatchVsTet（player.cpp）と同じく「設置の時刻」をイベントにする。ツモは両者共通（versus.js tumoRng）。
//   同時刻は aFirst の側を先に置く（呼び出し側で先後を入れ替えて打ち消す）。
struct TvtResult { int winner; double ms; };
TvtResult runTvt(TetPlayer& a, TetPlayer& b, double maxMs, bool aFirst) {
    a.vsTet = b.vsTet = true;
    a.onSendTet = [&](double t, int n, const std::vector<int>& h) { b.receiveFromTet(n, h, t); };
    b.onSendTet = [&](double t, int n, const std::vector<int>& h) { a.receiveFromTet(n, h, t); };
    a.start(0);
    b.start(0);
    TvtResult r{-1, 0};
    while (true) {
        if (!a.dead && !a.planned()) a.plan();
        if (!b.dead && !b.planned()) b.plan();
        if (a.dead || b.dead) {   // HOLD で出したミノが出せない（plan の中で死亡）
            r.winner = (a.dead && b.dead) ? -1 : a.dead ? 1 : 0;
            r.ms = std::max(a.now, b.now);
            break;
        }
        double ta = a.plannedT(), tb = b.plannedT();
        bool aTurn = aFirst ? (ta <= tb) : (ta < tb);
        double now = aTurn ? ta : tb;
        if (now > maxMs) { r.winner = -1; r.ms = now; break; }
        TetPlayer& p = aTurn ? a : b;
        TetPlayer& o = aTurn ? b : a;
        p.commit();
        if (p.dead) {
            // 同じ時刻に相手も置くなら、それも済ませてから判定する
            if (!o.dead && o.planned() && o.plannedT() <= now) o.commit();
            r.winner = o.dead ? -1 : (aTurn ? 1 : 0);
            r.ms = now;
            break;
        }
    }
    return r;
}

} // namespace

extern "C" {

int tet_out_len() { return 24; }

// 思考時間のモデル化（setTetModelThink）と clys の設定。スレッドを立てる前に呼ぶこと
void tet_set_model_think(int on, double scale) { setTetModelThink(on != 0, scale); }
// レベル（setup に渡す番号。26=lv6+PC など）ごとの思考時間の倍率。scale はビーム等、pcScale は PC 探索
void tet_set_think_scale(int level, double scale, double pcScale) {
    if (level < 0 || level >= 64) return;
    g_thinkScaleLv[level] = scale > 0 ? scale : 1.0;
    g_pcScaleLv[level] = pcScale > 0 ? pcScale : 1.0;
}
void tet_set_clys(int thinkMs, int width, int branch) {
    if (thinkMs > 0) g_clysThinkMs = thinkMs;
    if (width > 0) g_clysWidth = width;
    if (branch > 0) g_clysBranch = branch;
}

// レベルの操作時間を差し替える（0 以下なら本番の値）。スレッドを立てる前に呼ぶこと
// lv6 の新しい探索を1回だけ呼ぶ（tests/test_lv6n_parity.py。引数・出力は lv6_wasm.cpp の lv6Search と同じ）
void tet_lv6n_search(const uint8_t* board, const int* queue, int nQueue, int hold, int bagAfter, int b2b, int ren,
                     int incoming, const int* weights, int nWeights, int width, int depth, int thinkMs, int* out,
                     int outLen) {
    cpuSearchLv6n(board, queue, nQueue, hold, bagAfter, b2b, ren, incoming, weights, nWeights, width, depth, thinkMs,
                  out, outLen);
}

// 席ごとの探索設定（side 0=全員 1=A 2=B）。値 -1 は変えない。reset=1 でその席の設定を消してから入れる
void tet_set_side(int side, int reset, int queueLen, int clysThink, int clysWidth, int clysBranch, int clysNext,
                  int clysDepth, int lv6Width, int lv6Depth, int lv6Next) {
    if (side < 0 || side > 2) return;
    SideCfg& c = g_sideCfg[side];
    if (reset) c = SideCfg();
    auto put = [](int& dst, int v) { if (v > 0) dst = v; };
    put(c.queueLen, queueLen); put(c.clysThink, clysThink); put(c.clysWidth, clysWidth); put(c.clysBranch, clysBranch);
    put(c.clysNext, clysNext); put(c.clysDepth, clysDepth); put(c.lv6Width, lv6Width); put(c.lv6Depth, lv6Depth);
    put(c.lv6Next, lv6Next);
}
void tet_set_level_timing(int level, double actionMs, double harddropMs) { setTetLevelTiming(level, actionMs, harddropMs); }

// out[g*24 + k]：
//  0 pieces 1 時間ms 2 lines 3 tspins 4 tsMini 5 tetrises 6 pcs 7 b2bs 8 maxRen
//  9 gaugeSent 10 ojamaSent 11 tetAttack 12 teleports 13 routeInstant 14 routePath 15 routeFull
// 16 noMove 17 holds 18 dead 19 garbageTaken 20 マージン前の ojama 21 マージン前の時間ms 22 マージン前の pieces 23 最終の高さ
void tet_solo_run(int nGames, const uint32_t* seeds, int maxPieces, double maxMs, int marginTimeMs,
                  int garbageEvery, int garbageLines, int nThreads, double* out) {
    initTetShapes();
    parallelFor(nGames, nThreads, [&](int g) {
        TetPlayer p(seeds[g]);
        p.marginTimeMs = marginTimeMs;
        p.keepLog = true;
        runSolo(p, maxPieces, maxMs, garbageEvery, garbageLines);
        double* o = out + (size_t)g * 24;
        const TetStats& s = p.st;
        o[0] = s.pieces; o[1] = p.now; o[2] = s.lines; o[3] = s.tspins; o[4] = s.tsMini; o[5] = s.tetrises;
        o[6] = s.pcs; o[7] = s.b2bs; o[8] = s.maxRen; o[9] = (double)s.gaugeSent; o[10] = (double)s.ojamaSent;
        o[11] = (double)s.tetAttack; o[12] = s.teleports; o[13] = s.routeInstant; o[14] = s.routePath; o[15] = s.routeFull;
        o[16] = s.noMove; o[17] = s.holds; o[18] = p.dead ? 1 : 0; o[19] = s.garbageLinesTaken;
        double mt = marginTimeMs < 0 ? 1e18 : marginTimeMs;
        long long ojPre = 0;
        for (const auto& e : p.sends) if (e.t < mt) ojPre += e.ojama;
        int piecesPre = 0;
        for (const auto& e : p.locks) if (e.t < mt) piecesPre++;
        o[20] = (double)ojPre; o[21] = std::min(p.now, mt); o[22] = piecesPre; o[23] = p.stackHeight();
    });
}

// 1局を回して探索の入出力を buf に書く。1件 = 盤面250 + cur,hold,next×5,canHold,ren,b2b(10) + 出力43 = 303 int
int tet_trace_cases(uint32_t seed, int maxPieces, int garbageEvery, int garbageLines, int* buf, int maxCases) {
    initTetShapes();
    TetPlayer p(seed);
    std::vector<TetPlayer::SearchCase> cases;
    p.traceCases = &cases;
    runSolo(p, maxPieces, 1e18, garbageEvery, garbageLines);
    int n = std::min((int)cases.size(), maxCases);
    for (int i = 0; i < n; i++) {
        const auto& c = cases[i];
        int* o = buf + (size_t)i * 303;
        for (int k = 0; k < 250; k++) o[k] = c.board[k];
        o[250] = c.cur; o[251] = c.hold;
        for (int k = 0; k < 5; k++) o[252 + k] = c.next[k];
        o[257] = c.canHold; o[258] = c.ren; o[259] = c.b2b;
        for (int k = 0; k < TET_OUT_LEN; k++) o[260 + k] = c.out[k];
    }
    return n;
}

// シミュが持っている各レベルの既定の重み（本番 JS と一致するかを tests/test_tet_parity.py が確かめる）。長さを返す
int tet_default_weights(int level, int* out) {
    int n = tetWeightsLen(level);
    std::memcpy(out, tetDefaultWeights(level), sizeof(int) * n);
    return n;
}

// レベル指定のひとり用（出力は tet_solo_run と同じ 24 列）。weights=nullptr ならそのレベルの本番の重み
void tet_solo_run_lv(int level, const int* weights, int wLen, int nGames, const uint32_t* seeds, int maxPieces,
                     double maxMs, int marginTimeMs, int garbageEvery, int garbageLines, int nThreads, double* out) {
    initTetShapes();
    parallelFor(nGames, nThreads, [&](int g) {
        TetPlayer p(seeds[g]);
        setup(p, level, weights, wLen);
        p.marginTimeMs = marginTimeMs;
        p.keepLog = true;
        runSolo(p, maxPieces, maxMs, garbageEvery, garbageLines);
        writeSolo(p, marginTimeMs, out + (size_t)g * 24);
    });
}

// レベル指定の trace。1件 = 盤面250 + cur,hold,next×8,canHold,ren,b2b,incoming(14) + 出力43 = 307 int
int tet_case_len_lv() { return 307; }
int tet_trace_cases_lv(int level, uint32_t seed, int maxPieces, int garbageEvery, int garbageLines, int* buf, int maxCases) {
    initTetShapes();
    TetPlayer p(seed);
    p.setLevel(level);
    std::vector<TetPlayer::SearchCase> cases;
    p.traceCases = &cases;
    runSolo(p, maxPieces, 1e18, garbageEvery, garbageLines);
    int n = std::min((int)cases.size(), maxCases);
    for (int i = 0; i < n; i++) {
        const auto& c = cases[i];
        int* o = buf + (size_t)i * 307;
        for (int k = 0; k < 250; k++) o[k] = c.board[k];
        o[250] = c.cur; o[251] = c.hold;
        for (int k = 0; k < 8; k++) o[252 + k] = c.next[k];
        o[260] = c.canHold; o[261] = c.ren; o[262] = c.b2b; o[263] = c.incoming;
        for (int k = 0; k < TET_OUT_LEN; k++) o[264 + k] = c.out[k];
    }
    return n;
}

// 与えた局面（tet_trace_cases_lv の 307 int 形式）で探索だけを回し、out[i*43] に書く。weights=nullptr ならそのレベルの既定。
//   新旧 lv5 の突き合わせ（既定の重みで探索結果が一致するか）に使う。
void tet_search_cases_lv(int level, const int* weights, int wLen, int nCases, const int* cases, int nThreads, int* out) {
    initTetShapes();
    int w[TET_W_MAX] = {0};
    std::memcpy(w, tetDefaultWeights(level), sizeof(int) * tetWeightsLen(level));
    if (weights) std::memcpy(w, weights, sizeof(int) * std::min(wLen, tetWeightsLen(level)));
    parallelFor(nCases, nThreads, [&](int i) {
        const int* c = cases + (size_t)i * 307;
        uint8_t board[250];
        for (int k = 0; k < 250; k++) board[k] = (uint8_t)c[k];
        int next[8];
        for (int k = 0; k < 8; k++) next[k] = c[252 + k];
        int* o = out + (size_t)i * TET_OUT_LEN;
        if (level == 4) cpuSearchLv4(board, c[250], c[251], next, c[260], w, o);
        else if (level == 6) cpuSearchLv6(board, c[250], c[251], next, c[260], w, c[261], c[262], c[263], o);
        else if (level == 5) cpuSearchLv5(board, c[250], c[251], next, c[260], w, c[261], c[262], o);
        else cpuSearch(board, c[250], c[251], next, c[260], w, c[261], c[262], o);
    });
}

// レベル指定のひとり用で地形を測る（設計 §1.3）。out[g*TERRAIN_LEN + k]：
//   0 設置数 1 穴の合計 2 穴3つ以上の局面数 3 凸凹（隣の列の高さ差の合計）の合計 4 穴を作った手（消去・せり上がり無しで穴が増えた）
//   5 T-spin（消去あり） 6 4-LINES 7 消去ライン 8 火力（テト用ライン） 9 dead 10 最大高さの合計 11 時間ms
//   12 段差3以上の箇所の合計 13 T-spin mini（消去あり）
static const int TERRAIN_LEN = 14;
int tet_terrain_len() { return TERRAIN_LEN; }
void tet_terrain_lv(int level, const int* weights, int wLen, int nGames, const uint32_t* seeds, int maxPieces,
                    int garbageEvery, int garbageLines, int nThreads, double* out) {
    initTetShapes();
    parallelFor(nGames, nThreads, [&](int g) {
        TetPlayer p(seeds[g]);
        setup(p, level, weights, wLen);
        p.marginTimeMs = -1;
        p.start(0);
        double* o = out + (size_t)g * TERRAIN_LEN;
        for (int k = 0; k < TERRAIN_LEN; k++) o[k] = 0;
        int prevHoles = 0, n = 0;
        while (!p.dead && n < maxPieces) {
            if (garbageEvery > 0 && n > 0 && n % garbageEvery == 0) p.pushGarbageLines(garbageLines, p.now);
            int lines0 = p.st.lines, ts0 = p.st.tspins, tm0 = p.st.tsMini, gt0 = p.st.garbageLinesTaken;
            if (p.step() < 0) break;
            n++;
            int hl = terrainHoles(p.rows);
            int hs[TCOLS];
            terrainHeights(p.rows, hs);
            int bump = 0, step3 = 0, mh = 0;
            for (int x = 0; x < TCOLS; x++) mh = std::max(mh, hs[x]);
            for (int x = 0; x < TCOLS - 1; x++) {
                int d = std::abs(hs[x] - hs[x + 1]);
                bump += d;
                if (d >= 3) step3++;
            }
            bool cleared = p.st.lines > lines0;
            o[0] += 1; o[1] += hl; o[2] += (hl >= 3); o[3] += bump; o[10] += mh; o[12] += step3;
            if (hl > prevHoles && !cleared && p.st.garbageLinesTaken == gt0) o[4] += 1;
            o[5] += p.st.tspins - ts0;
            o[13] += p.st.tsMini - tm0;
            prevHoles = hl;
        }
        o[6] = p.st.tetrises; o[7] = p.st.lines; o[8] = (double)p.st.tetAttack; o[9] = p.dead ? 1 : 0; o[11] = p.now;
    });
}

// テト同士の対戦。1シードにつき席（乱数と同時刻の先後）を入れ替えて2局。
//   wA/wB=nullptr なら各レベルの本番の重み。out[(i*2+k)*TVT_LEN + j]（k=0: A が席0・同時刻で先、k=1: A が席1・B が先）
//   0 winner(0=A 1=B -1=引き分け) 1 ms
//   2+ A の集計 TVT_SIDE 列、2+TVT_SIDE+ B の集計：
//     pieces lines tspins tsMini tetrises pcs b2bs maxRen tetAttack tetSent linesReceived garbageTaken holds dead finalHeight routeMiss
//     tss tsd tst pcSearches pcFound pcAborted pcMoves pcSearchMs thinkMs waitMs maxSpike（clys 比較 §6）
//     ren1 ren2to5 ren6plus renAtk（REN の長さ。lv6-style-design.md）
static const int TVT_SIDE = 35;
int tet_vs_len() { return 2 + 2 * TVT_SIDE; }
void tet_vs_run(int lvA, const int* wA, int wLenA, int lvB, const int* wB, int wLenB, int nSeeds, const uint32_t* seeds,
                double maxMs, int marginTimeMs, int holeRatePercent, double jitterMs, int sharedTumo, int nThreads,
                double* out) {
    initTetShapes();
    const int L = 2 + 2 * TVT_SIDE;
    parallelFor(nSeeds * 2, nThreads, [&](int job) {
        int i = job / 2, k = job % 2;
        uint32_t s = seeds[i];
        // 席の乱数（ツモ・送る穴・揺らぎ）。sharedTumo=1 は本番 VERSUS と同じく両者共通のツモ、0 は別のツモ。
        //   k=1 の局は A と B の席の乱数を入れ替える（同時刻の先後も入れ替える）＝同じシードで条件を左右対称にする。
        //   同時刻の設置はまず起きないので、先後だけ入れ替えると2局が同じ展開になる（2026-10-25 実測）。
        uint32_t tumo0 = s, tumo1 = sharedTumo ? s : s ^ 0x9e3779b9u;
        uint32_t hole0 = s * 2654435761u + 1u, hole1 = s * 2246822519u + 2u;
        if (k == 1) { std::swap(tumo0, tumo1); std::swap(hole0, hole1); }
        TetPlayer a(tumo0, hole0), b(tumo1, hole1);
        setup(a, lvA, wA, wLenA);
        setup(b, lvB, wB, wLenB);
        applySide(a, g_sideCfg[1]);
        applySide(b, g_sideCfg[2]);
        a.marginTimeMs = b.marginTimeMs = marginTimeMs;
        a.holeRatePercent = b.holeRatePercent = holeRatePercent;
        a.jitterMs = b.jitterMs = jitterMs;
        TvtResult r = runTvt(a, b, maxMs, k == 0);
        double* o = out + (size_t)job * L;
        o[0] = r.winner; o[1] = r.ms;
        const TetPlayer* ps[2] = {&a, &b};
        for (int side = 0; side < 2; side++) {
            const TetPlayer& p = *ps[side];
            const TetStats& st = p.st;
            double* q = o + 2 + side * TVT_SIDE;
            q[0] = st.pieces; q[1] = st.lines; q[2] = st.tspins; q[3] = st.tsMini; q[4] = st.tetrises; q[5] = st.pcs;
            q[6] = st.b2bs; q[7] = st.maxRen; q[8] = (double)st.tetAttack; q[9] = (double)st.tetSent;
            q[10] = (double)st.linesReceived; q[11] = st.garbageLinesTaken; q[12] = st.holds; q[13] = p.dead ? 1 : 0;
            q[14] = p.stackHeight(); q[15] = st.routeMiss;
            q[16] = st.tss; q[17] = st.tsd; q[18] = st.tst; q[19] = st.pcSearches; q[20] = st.pcFound;
            q[21] = st.pcAborted; q[22] = st.pcMoves; q[23] = st.pcSearchMs; q[24] = st.thinkMs; q[25] = st.waitMs;
            q[26] = st.maxSpike;
            q[27] = st.ren1; q[28] = st.ren2to5; q[29] = st.ren6plus; q[30] = (double)st.renAtk;
            q[31] = (double)st.nodes;
            q[32] = st.tsPred; q[33] = st.tsPredMiss; q[34] = st.tsUnpred;
        }
    });
}

// PC 探索の時間を測る（tet_trace_cases_lv の 307 int 形式の局面。pieces = cur＋next8＋next8 を繰り返して11本）。
//   ブロック数が偶数の局面だけ探索し、out_ms[i] に時間（ms）、found[i] に手数（奇数の局面は -1）。wasm との速度比較用
void tet_pc_time_cases(int nCases, const int* cases, double* outMs, int* found) {
    for (int i = 0; i < nCases; i++) {
        const int* c = cases + (size_t)i * 307;
        uint8_t board[250];
        int B = 0;
        for (int k = 0; k < 250; k++) { board[k] = (uint8_t)c[k]; B += board[k]; }
        if (B % 2) { outMs[i] = 0; found[i] = -1; continue; }
        int pieces[11];
        pieces[0] = c[250];
        for (int k = 0; k < 10; k++) pieces[k + 1] = c[252 + (k % 8)];
        int out[256];
        auto t0 = std::chrono::steady_clock::now();
        cpuSearchPC6(board, pieces, c[251], c[260], 10, B == 0 ? 300 : 100, out);
        outMs[i] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        found[i] = out[0];
    }
}

} // extern "C"
