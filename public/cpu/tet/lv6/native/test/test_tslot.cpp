// Phase2 T-slot 幾何の単体テスト（ネイティブ実行）
// build (native/test/ から実行): g++ -std=c++17 -O2 -I.. test_tslot.cpp ../common.cpp ../board.cpp ../tslot.cpp -o /tmp/test_tslot && /tmp/test_tslot
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include "common.h"
#include "board.h"
#include "weights.h"
#include "tslot.h"

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
    w.tSlotTsd = 300; w.tSlotReady = 250; w.tSlotTss = 150; w.tSlotTst = 500;

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

    // ── ケース5: TST(3ライン消去) — tst_twist_left(West/rot3) ──
    //   縦スロット=col5、ステム=col4(int22に穴)、天井オーバーハング=(5,19)。
    //   消去行=int21,22,23。Tバー(5,21)(5,22)(5,23)＋ステム(4,22)で3ライン成立。
    {
        Board b;
        fillRow(b, 21, {0,1,2,3,4,6,7,8,9}); // col5を空ける
        fillRow(b, 22, {0,1,2,3,6,7,8,9});   // col4,5を空ける（col4=ステム穴）
        fillRow(b, 23, {0,1,2,3,4,6,7,8,9}); // col5を空ける
        b.set(5, 19);                         // 天井オーバーハング
        uint32_t cc[COLS]; int hh[COLS]; calcHeights(b, cc, hh);
        TSlotHit ht = detectTSTSlot(b, hh);
        check("tst.found",  ht.found ? 1 : 0, 1);
        check("tst.barCol", ht.barCol, 5);
        check("tst.rot",    ht.rot, 3);
        check("tst.midRow", ht.midRow, 22);
        Board t = b;
        check("tst.cutout_lines", cutoutTSpin(t, ht.barCol, ht.midRow, ht.rot), 3);
        check("tst.chain_score",  evalTSlotChain(b, 1, w), w.tSlotTst);
    }

    // ── ケース6: FIN(2ライン消去) — fin_left(West/rot3) ──
    //   高さウィンドウ=col2,3(h2=col3=2)、シェイプ=col4,5,6。縦スロット=col5、ステム=col4。
    //   天井=(4,20)(5,20)、フィン=(4,24)、右壁=(6,22)(6,24)。消去行=int23,24で2ライン。
    {
        Board b;
        fillRow(b, 23, {0,1,2,3,6,7,8,9});     // col4,5を空ける
        fillRow(b, 24, {0,1,2,3,4,6,7,8,9});   // col5を空ける（col4=フィン, col6=右壁）
        b.set(4, 20); b.set(5, 20);             // 天井オーバーハング
        b.set(6, 22);                            // 右壁の中段
        uint32_t cc[COLS]; int hh[COLS]; calcHeights(b, cc, hh);
        TSlotHit hf = detectFINSlot(b, hh);
        check("fin.found",  hf.found ? 1 : 0, 1);
        check("fin.barCol", hf.barCol, 5);
        check("fin.rot",    hf.rot, 3);
        check("fin.midRow", hf.midRow, 23);
        Board t = b;
        check("fin.cutout_lines", cutoutTSpin(t, hf.barCol, hf.midRow, hf.rot), 2);
    }

    // ── ケース7: TST(3ライン) — tst_twist_right(East/rot1) ──
    //   East 版（ステム右）。縦スロット=col4、ステム=col5(int22に穴)、天井=(4,19)。rot1 cutout 経路を検証。
    {
        Board b;
        fillRow(b, 21, {0,1,2,3,5,6,7,8,9}); // col4を空ける
        fillRow(b, 22, {0,1,2,3,6,7,8,9});   // col4,5を空ける（col5=ステム穴）
        fillRow(b, 23, {0,1,2,3,5,6,7,8,9}); // col4を空ける
        b.set(4, 19);                         // 天井オーバーハング
        uint32_t cc[COLS]; int hh[COLS]; calcHeights(b, cc, hh);
        TSlotHit ht = detectTSTSlot(b, hh);
        check("tstR.found",  ht.found ? 1 : 0, 1);
        check("tstR.barCol", ht.barCol, 4);
        check("tstR.rot",    ht.rot, 1);
        check("tstR.midRow", ht.midRow, 22);
        Board t = b;
        check("tstR.cutout_lines", cutoutTSpin(t, ht.barCol, ht.midRow, ht.rot), 3);
        check("tstR.chain_score",  evalTSlotChain(b, 1, w), w.tSlotTst);
    }

    // ── ケース8: TSD最適化の等価性 — forEachTSDSlot が全セル走査と完全一致するか ──
    //   ランダム盤面 2000 通りで「全(cx,cy)を isTSDShape した集合」と「forEachTSDSlot が返す集合」を比較。
    {
        srand(12345);
        int mismatches = 0;
        for (int trial = 0; trial < 2000; trial++) {
            Board b;
            for (int y = ROWS - 12; y < ROWS; y++)
                for (int x = 0; x < COLS; x++)
                    if (rand() % 100 < 55) b.set(x, y);
            uint32_t cc[COLS]; int hh[COLS]; calcHeights(b, cc, hh);
            bool bf[COLS][ROWS] = {}; bool opt[COLS][ROWS] = {};
            for (int cx = 1; cx < COLS - 1; cx++)
                for (int cy = 1; cy < ROWS - 1; cy++)
                    if (isTSDShape(b, cx, cy, hh)) bf[cx][cy] = true;
            forEachTSDSlot(b, hh, [&](int cx, int cy) { if (cy >= 0 && cy < ROWS) opt[cx][cy] = true; });
            for (int cx = 0; cx < COLS; cx++)
                for (int cy = 0; cy < ROWS; cy++)
                    if (bf[cx][cy] != opt[cx][cy]) mismatches++;
        }
        check("tsdOpt.equivalence_mismatches", mismatches, 0);
    }

    printf("\n==== %d passed, %d failed ====\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
