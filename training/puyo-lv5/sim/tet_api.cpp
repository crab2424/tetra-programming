// ─────────────────────────────────────────────
// sim/tet_api.cpp — テト側の C ABI（Python ctypes から呼ぶ）
//   tet_solo_run    … テト CPU lv5 のひとり用（毎秒ミノ数・攻撃量を測る。おじゃまを定期的に入れることもできる）
//   tet_trace_cases … 探索の入出力を残す（本番 wasm との一致テスト tests/test_tet_parity.py 用）
// ─────────────────────────────────────────────
#include "tet.h"

#include <algorithm>
#include <atomic>
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

} // namespace

extern "C" {

int tet_out_len() { return 24; }

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

} // extern "C"
