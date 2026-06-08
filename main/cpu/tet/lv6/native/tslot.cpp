#include "tslot.h"

// ★最適化：引数に const int heights[COLS] = nullptr を追加
bool isTSDShape(const Board& board, int cx, int cy, const int heights[COLS]) {
    if (cx < 1 || cx >= COLS - 1 || cy < 0 || cy >= ROWS - 1) return false;

    // ★最適化：盤面配列の直接参照をビット演算に置換
    if ((board.rows[cy] & (1<<cx)) || (board.rows[cy] & (1<<(cx-1))) || (board.rows[cy] & (1<<(cx+1))) || (board.rows[cy+1] & (1<<cx))) return false;

    auto isSolid = [&](int x, int y) {
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y < 0) return false;
        return (board.rows[y] & (1 << x)) != 0;
    };

    // ★最適化：TSDの地形が存在する高さのI-Wellチェックは、この関数の外（スキャン処理）で事前に1回だけ計算して除外するように変更

    if (!isSolid(cx - 1, cy + 1)) return false; // 左下の土台
    if (!isSolid(cx + 1, cy + 1)) return false; // 右下の土台
    if (!isSolid(cx - 2, cy + 1)) return false;
    if (!isSolid(cx + 2, cy + 1)) return false;

    bool leftRoof = (cy - 1 < 0) || (cx - 1 < 0) || (isSolid(cx-1, cy-1) && isSolid(cx-2, cy));
    bool rightRoof = (cy - 1 < 0) || (cx + 1 >= COLS) || (isSolid(cx+1, cy-1) && isSolid(cx+2, cy-1));
    if (!(leftRoof ^ rightRoof)) return false;

    if (cy - 1 >= 0) {
        if (leftRoof) {
            if (isSolid(cx, cy-1) || (cx + 1 < COLS && isSolid(cx+1, cy-1))) return false;
        } else {
            if (isSolid(cx, cy-1) || (cx - 1 >= 0 && isSolid(cx-1, cy-1))) return false;
        }
    }

    int clearCol1 = cx;
    int clearCol2 = leftRoof ? cx + 1 : cx - 1;

    // ★最適化：heights配列が渡されている場合はループを回さずO(1)で計算
    if (heights != nullptr) {
        if (heights[clearCol1] > ROWS - cy) return false;
        if (heights[clearCol2] > ROWS - cy) return false;
    } else {
        for (int y = 0; y < cy; y++) {
            if (board.rows[y] & (1<<clearCol1)) return false;
            if (board.rows[y] & (1<<clearCol2)) return false;
        }
    }

    return true;
}

// 原点 (ox,oy)=(cx-1, cy-2) に T(rot) を重ねて消去する。PRECALC_MINO_BLOCKS はテンプレ絶対座標(0..3)。
//   rot2(South): 水平バー(0,2)(1,2)(2,2)＋下バンプ(1,3) → cx=バー中心列/cy=バー行（既存TSD/TSS）。
//   rot1(East) : 縦バー(1,1)(1,2)(1,3)＋右バンプ(2,2) → cx=縦バー列/cy=バー中心行・ステム右。
//   rot3(West) : 縦バー(1,1)(1,2)(1,3)＋左バンプ(0,2) → cx=縦バー列/cy=バー中心行・ステム左。
// いずれも原点式 (cx-1, cy-2) が一致する（縦バーのテンプレ列=1, 中心行=2）。
int cutoutTSpin(Board& b, int cx, int cy, int rot) {
    const int ox = cx - 1, oy = cy - 2;
    for (int i = 0; i < 4; i++) {
        b.set(PRECALC_MINO_BLOCKS[2][rot][i].x + ox,
              PRECALC_MINO_BLOCKS[2][rot][i].y + oy);
    }
    return b.checkLineAndClear();
}

// tst_twist / fin で見つけた縦置き T 候補の受理判定（CC: 4隅≥3埋まり かつ on_stack）。
//   CX,CY は CC座標の T 中心、east=true で East(rot1,ステム右)/false で West(rot3,ステム左)。
//   needCorner=false なら無条件採用（fin はシェイプ自体が妥当性を保証）。
static TSlotHit acceptHit(const Board& b, int CX, int CY, bool east, bool needCorner) {
    if (needCorner) {
        int corners = (occCC(b, CX-1, CY-1) ? 1 : 0) + (occCC(b, CX+1, CY-1) ? 1 : 0)
                    + (occCC(b, CX-1, CY+1) ? 1 : 0) + (occCC(b, CX+1, CY+1) ? 1 : 0);
        if (corners < 3) return { 0, 0, 0, false };
        // on_stack: 4セル{(CX,CY-1),(CX,CY),(CX,CY+1),(stemX,CY)} のいずれか直下(ccY-1)が埋まり
        int sx = east ? CX + 1 : CX - 1;
        bool onStack = occCC(b, CX, CY-2) || occCC(b, CX, CY-1) || occCC(b, CX, CY) || occCC(b, sx, CY-1);
        if (!onStack) return { 0, 0, 0, false };
    }
    return { CX, ROWS - 1 - CY, east ? 1 : 3, true };
}

// CC tst_twist_left(→West) / tst_twist_right(→East) を逐語移植（occCC で座標変換）。
TSlotHit detectTSTSlot(const Board& b, const int heights[COLS]) {
    // tst_twist_left: heights[x]=h1, heights[x+1]=h2, 中心 cc(x+2, h2-2), West
    for (int x = 0; x <= COLS - 3; x++) {
        int h1 = heights[x], h2 = heights[x+1];
        if (!(h1 <= h2)) continue;
        if (occCC(b, x-1, h2) != occCC(b, x-1, h2+1)) continue;
        if (!occCC(b, x+2, h2+1)) continue;
        if (occCC(b, x+2, h2)) continue;
        if (occCC(b, x+2, h2-1)) continue;
        if (occCC(b, x+1, h2-2)) continue;
        if (occCC(b, x+2, h2-2)) continue;
        if (occCC(b, x+2, h2-3)) continue;
        TSlotHit h = acceptHit(b, x+2, h2-2, false, true);
        if (h.found) return h;
    }
    // tst_twist_right: heights[x+1]=h1, heights[x+2]=h2, 中心 cc(x, h1-2), East
    for (int x = 0; x <= COLS - 3; x++) {
        int h1 = heights[x+1], h2 = heights[x+2];
        if (!(h2 <= h1)) continue;
        if (occCC(b, x+3, h1) != occCC(b, x+3, h1+1)) continue;
        if (!occCC(b, x, h1+1)) continue;
        if (occCC(b, x, h1)) continue;
        if (occCC(b, x, h1-1)) continue;
        if (occCC(b, x, h1-2)) continue;
        if (occCC(b, x+1, h1-2)) continue;
        if (occCC(b, x, h1-3)) continue;
        TSlotHit h = acceptHit(b, x, h1-2, true, true);
        if (h.found) return h;
    }
    return { 0, 0, 0, false };
}

// CC fin_left(→West) / fin_right(→East) を逐語移植。シェイプが妥当性を保証するため corner 判定なし。
TSlotHit detectFINSlot(const Board& b, const int heights[COLS]) {
    // fin_left: heights[x]=h1, heights[x+1]=h2, 中心 cc(x+3, h2-1), West
    for (int x = 0; x <= COLS - 4; x++) {
        int h1 = heights[x], h2 = heights[x+1];
        if (!(h1 <= h2 + 1)) continue;
        if (!occCC(b, x+2, h2+2)) continue;
        if (!occCC(b, x+3, h2+2)) continue;
        if (occCC(b, x+2, h2+1)) continue;
        if (occCC(b, x+3, h2+1)) continue;
        if (occCC(b, x+2, h2)) continue;
        if (occCC(b, x+3, h2)) continue;
        if (!occCC(b, x+4, h2)) continue;
        if (occCC(b, x+2, h2-1)) continue;
        if (occCC(b, x+3, h2-1)) continue;
        if (!occCC(b, x+2, h2-2)) continue;
        if (occCC(b, x+3, h2-2)) continue;
        if (!occCC(b, x+4, h2-2)) continue;
        return { x+3, ROWS - 1 - (h2-1), 3, true };
    }
    // fin_right: heights[x+2]=h1, heights[x+3]=h2, 中心 cc(x, h1-1), East
    for (int x = 0; x <= COLS - 4; x++) {
        int h1 = heights[x+2], h2 = heights[x+3];
        if (!(h2 <= h1 + 1)) continue;
        if (!occCC(b, x-1, h1)) continue;
        if (!occCC(b, x-1, h1-2)) continue;
        if (!occCC(b, x, h1+2)) continue;
        if (!occCC(b, x+1, h1+2)) continue;
        if (occCC(b, x, h1+1)) continue;
        if (occCC(b, x+1, h1+1)) continue;
        if (occCC(b, x, h1)) continue;
        if (occCC(b, x+1, h1)) continue;
        if (occCC(b, x, h1-1)) continue;
        if (occCC(b, x+1, h1-1)) continue;
        if (occCC(b, x, h1-2)) continue;
        if (!occCC(b, x+1, h1-2)) continue;
        return { x, ROWS - 1 - (h1-1), 1, true };
    }
    return { 0, 0, 0, false };
}

// 各反復で CC 優先順(sky→tst+corner→fin)に最初に見つかったスロットへ T を仮想配置:
//   0ライン = スロットは出来ているが両脇がまだ埋まっていない（建設途中）→ tSlotReady 加点して終了
//   1ライン = TSS 実行可能 → tSlotTss 加点して終了（TSS後の連鎖は稀なため打ち切り）
//   2ライン = TSD 実行可能 → tSlotTsd 加点し、消去後盤面で次のTへ継続
//   3ライン = TST 実行可能 → tSlotTst 加点し、消去後盤面で次のTへ継続（CC: Tspin3 で Some(board) 継続）
int evalTSlotChain(Board b, int maxIter, const EvalWeights& w, bool tComing) {
    int score = 0;
    for (int iter = 0; iter < maxIter; iter++) {
        uint32_t cols[COLS]; int heights[COLS];
        calcHeights(b, cols, heights); // cutout で盤面が変わるため毎回算出

        // 1. sky_tslot 相当（South T による開けた TSD/TSS）。
        //    ★最適化: 全セル走査の代わりに列高さウィンドウ候補のみ評価(forEachTSDSlot)。
        //    元実装(cy外/cx内ループ)と同じ「最上(min cy)・同cyなら最左(min cx)」のスロットを選ぶ。
        int barCol = -1, midRow = ROWS, rot = 2;
        int slotType = 0; // 0=sky(TSD), 1=tst_twist, 2=fin（建設途中加点の重み選択に使用）
        forEachTSDSlot(b, heights, [&](int cx, int cy) {
            if (cy < midRow || (cy == midRow && (barCol < 0 || cx < barCol))) { midRow = cy; barCol = cx; }
        });
        if (barCol < 0) midRow = -1;
        // 2. tst_twist（+3コーナー受理）による縦置き TST
        if (barCol < 0) {
            TSlotHit h = detectTSTSlot(b, heights);
            if (h.found) { barCol = h.barCol; midRow = h.midRow; rot = h.rot; slotType = 1; }
        }
        // 3. fin による縦置き TST
        if (barCol < 0) {
            TSlotHit h = detectFINSlot(b, heights);
            if (h.found) { barCol = h.barCol; midRow = h.midRow; rot = h.rot; slotType = 2; }
        }
        if (barCol < 0) break; // スロットなし

        int lines = cutoutTSpin(b, barCol, midRow, rot);
        if (lines >= 3)      { score += w.tSlotTst; continue; } // TST：消去後盤面で次へ
        else if (lines == 2) { score += w.tSlotTsd; continue; } // TSD：消去後盤面で次へ
        else if (lines == 1) { score += w.tSlotTss; break; }    // TSS
        else {                                                   // 建設途中（まだ消えない）：スロット種別ごとに加点を分離
            // ★TST/FIN の建設途中加点は「実際にTが来る(tComing)」時のみ有効化。
            //   Tが来ないのに投機的にオーバーハングを建てて地形を崩すのを防ぐ。sky/TSDは従来通り常時。
            int readyW;
            if (slotType == 1)      readyW = tComing ? w.tSlotReadyTst : 0;
            else if (slotType == 2) readyW = tComing ? w.tSlotReadyFin : 0;
            else                    readyW = w.tSlotReady;        // slotType==0: sky/TSD
            score += readyW;
            break;
        }
    }
    return score;
}
