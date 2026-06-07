// Phase2 T-slot 幾何の単体テスト（ネイティブ実行）
// build: g++ -std=c++17 -O2 test_tslot.cpp -o /tmp/test_tslot && /tmp/test_tslot
#include <cstdio>
#include "cpu6.cpp"

static int g_pass = 0, g_fail = 0;
static void check(const char* name, int got, int want) {
    bool ok = (got == want);
    printf("[%s] %s  got=%d want=%d\n", ok ? "PASS" : "FAIL", name, got, want);
    if (ok) g_pass++; else g_fail++;
}

// row23=cy, row24=cy+1（最下段）。cx=4 の左屋根TSDを土台に構築するヘルパ。
static void fillRow(Board& b, int y, std::initializer_list<int> cols) {
    for (int x : cols) b.set(x, y);
}

int main() {
    ensurePrecalc();

    EvalWeights w{};
    w.tSlotTsd = 300; w.tSlotReady = 250; w.tSlotTss = 150;

    const int cy = 23; // cy+1=24=最下段

    // ── ケース1: 2ライン消去(TSD)が成立するスロット ──
    {
        Board b;
        fillRow(b, 23, {0,1,2,6,7,8,9}); // cx-1,cx,cx+1=3,4,5 を空ける
        fillRow(b, 24, {0,1,2,3,5,6,7,8,9}); // cx=4 を空ける
        b.set(3, 22); // 左屋根 (cx-1,cy-1)
        // 検証用にコピーへ cutout
        Board t = b; uint32_t cc[COLS]; int hh[COLS]; calcHeights(t, cc, hh);
        bool found = isTSDShape(t, 4, cy, hh);
        check("case1.isTSDShape", found ? 1 : 0, 1);
        int lines = cutoutTSpin(t, 4, cy);
        check("case1.cutout_lines", lines, 2);
        check("case1.chain_score", evalTSlotChain(b, 1, w), w.tSlotTsd);
    }

    // ── ケース2: スロットは出来ているが両脇未充填 → 0ライン(tSlotReady) ──
    {
        Board b;
        fillRow(b, 23, {2,6,7,8,9});        // col0,1 も空け、T(3,4,5)入れても満杯にしない
        fillRow(b, 24, {2,3,5,6,7,8,9});    // col0,1 空け、T(4)入れても満杯にしない
        b.set(3, 22);                        // 左屋根
        Board t = b; uint32_t cc[COLS]; int hh[COLS]; calcHeights(t, cc, hh);
        check("case2.isTSDShape", isTSDShape(t, 4, cy, hh) ? 1 : 0, 1);
        int lines = cutoutTSpin(t, 4, cy);
        check("case2.cutout_lines", lines, 0);
        check("case2.chain_score", evalTSlotChain(b, 1, w), w.tSlotReady);
    }

    // ── ケース3: スロットなし(平坦な低い盤面) → 0点 ──
    {
        Board b;
        fillRow(b, 24, {0,1,2,3,4,5,6,7,8,9}); // 最下段だけ満杯…は消えるので1段空け
        Board b2; fillRow(b2, 24, {0,1,2,3}); // 端に少しだけ
        check("case3.chain_score", evalTSlotChain(b2, 1, w), 0);
    }

    // ── ケース4: upcomingT=0 を模擬（maxIter=0）→ チェーン評価されない ──
    {
        Board b;
        fillRow(b, 23, {0,1,2,6,7,8,9});
        fillRow(b, 24, {0,1,2,3,5,6,7,8,9});
        b.set(3, 22);
        check("case4.maxIter0", evalTSlotChain(b, 0, w), 0);
    }

    printf("\n==== %d passed, %d failed ====\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
