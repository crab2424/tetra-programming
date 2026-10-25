// ─────────────────────────────────────────────
// tests/test_ojama.cpp — おじゃまの相殺・送信・着弾のシナリオテスト（ojama.js の仕様どおりか）
//   ビルドと実行: bash tests/run_cpp_tests.sh
// ─────────────────────────────────────────────
#include "sim.h"
#include <cstdio>
#include <cstring>

namespace sim {
struct SimTest {
    static void offset(Player& p, int amount, Player* opp, double now) { p.applyOffset(amount, opp, now); }
    static bool gen(Player& p, double now) { p.t_ = now; return p.generateOjama(); }
    static std::vector<int>& sent(Player& p) { return p.sentThisTurn_; }
};
}
using namespace sim;

static int fails = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("✗ %s:%d %s\n", __FILE__, __LINE__, #cond); fails++; } } while (0)

static Garbage G(int id, int amount, bool ready, double until) { return Garbage{id, amount, ready, until}; }

int main() {
    static int zero[PP_LEN] = {};
    PolicyParams pp = PolicyParams::fromPacked(zero);
    GameSettings gs;

    // 1. 相殺は ready → 未 ready の順。相殺しきれば何も送らない
    {
        Player a(pp, gs, 1), b(pp, gs, 2);
        a.garbageQueue = {G(1, 5, false, 0), G(2, 10, true, 0)};
        SimTest::offset(a, 12, &b, 1000);
        CHECK(a.garbageQueue.size() == 1 && a.garbageQueue[0].id == 1 && a.garbageQueue[0].amount == 3);
        CHECK(b.garbageQueue.empty());
    }
    // 2. 相殺しきれない分は相手へ（stage1: internal 500ms・未 ready）。送ったIDを控える
    {
        Player a(pp, gs, 1), b(pp, gs, 2);
        a.garbageQueue = {G(1, 5, true, 0)};
        SimTest::offset(a, 8, &b, 1000);
        CHECK(a.garbageQueue.empty());
        CHECK(b.garbageQueue.size() == 1 && b.garbageQueue[0].amount == 3);
        CHECK(!b.garbageQueue[0].ready && b.garbageQueue[0].internalUntil == 1500);
        CHECK(SimTest::sent(a).size() == 1);
        b.confirmGarbage(SimTest::sent(a));   // 送り手の連鎖終了で ready
        CHECK(b.garbageQueue[0].ready);
    }
    // 3. 着弾は ready かつ internal 明けのみ、1回最大30個（残りは次の手番）
    {
        Player a(pp, gs, 1);
        a.garbageQueue = {G(1, 40, true, 0)};
        CHECK(SimTest::gen(a, 1000));
        CHECK(a.garbageQueue.size() == 1 && a.garbageQueue[0].amount == 10);
        int oj = 0;
        for (int r = 0; r < TOTAL_ROWS; r++) for (int c = 0; c < COLS; c++) oj += a.field.v[r][c] == 6;
        CHECK(oj == 30);
        for (int c = 0; c < COLS; c++) CHECK(a.field.v[TOTAL_ROWS - 1][c] == 6 && a.field.v[TOTAL_ROWS - 5][c] == 6);
        CHECK(a.stats.ojamaReceived == 30);
    }
    // 4. internal 中（受信から 500ms 未満）と未 ready は降らない
    {
        Player a(pp, gs, 1);
        a.garbageQueue = {G(1, 6, true, 1500), G(2, 6, false, 0)};
        CHECK(!SimTest::gen(a, 1000));
        CHECK(a.queueSum() == 12);
        CHECK(SimTest::gen(a, 1500));          // internal 明け
        CHECK(a.queueSum() == 6);
    }
    // 5. 端数は重複しない列に1個ずつ（6個=1段、8個=1段+2列）
    {
        Player a(pp, gs, 1);
        a.garbageQueue = {G(1, 8, true, 0)};
        CHECK(SimTest::gen(a, 1000));
        int bottom = 0, second = 0;
        for (int c = 0; c < COLS; c++) { bottom += a.field.v[TOTAL_ROWS - 1][c] == 6; second += a.field.v[TOTAL_ROWS - 2][c] == 6; }
        CHECK(bottom == 6 && second == 2);
    }
    // 6. マージンタイム（96秒から16秒ごとに 52,34,...,1）
    {
        Player a(pp, gs, 1);
        CHECK(a.rateAt(0) == 70 && a.rateAt(95999) == 70);
        CHECK(a.rateAt(96000) == 52 && a.rateAt(112000) == 34 && a.rateAt(1e9) == 1);
    }

    std::printf(fails == 0 ? "✅ ojama scenarios passed\n" : "❌ %d failures\n", fails);
    return fails ? 1 : 0;
}
