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

// isTSDShape が保証する空きセル {(cx-1,cy),(cx,cy),(cx+1,cy),(cx,cy+1)} に一致する向き。
// PRECALC_MINO_BLOCKS はテンプレート絶対座標(0..3)。T rot2 は水平バー(0,2)(1,2)(2,2)＋下バンプ(1,3)。
// これを上記スロットへ重ねる原点は (ox,oy)=(cx-1, cy-2)。
int cutoutTSpin(Board& b, int cx, int cy) {
    const int rot = 2; // South（下向きT）
    const int ox = cx - 1, oy = cy - 2;
    for (int i = 0; i < 4; i++) {
        b.set(PRECALC_MINO_BLOCKS[2][rot][i].x + ox,
              PRECALC_MINO_BLOCKS[2][rot][i].y + oy);
    }
    return b.checkLineAndClear();
}

// 各反復で最初に見つかった TSD/TSS スロットへ T を仮想配置:
//   0ライン = スロットは出来ているが両脇がまだ埋まっていない（建設途中）→ tSlotReady 加点して終了
//   1ライン = TSS 実行可能 → tSlotTss 加点して終了（TSS後の連鎖は稀なため打ち切り）
//   2ライン = TSD 実行可能 → tSlotTsd 加点し、消去後盤面で次のTへ継続
int evalTSlotChain(Board b, int maxIter, const EvalWeights& w) {
    int score = 0;
    for (int iter = 0; iter < maxIter; iter++) {
        uint32_t cols[COLS]; int heights[COLS];
        calcHeights(b, cols, heights); // cutout で盤面が変わるため毎回算出

        int foundCx = -1, foundCy = -1;
        for (int cy = 1; cy < ROWS - 1 && foundCx < 0; cy++) {
            for (int cx = 1; cx < COLS - 1; cx++) {
                if (isTSDShape(b, cx, cy, heights)) { foundCx = cx; foundCy = cy; break; }
            }
        }
        if (foundCx < 0) break; // スロットなし

        int lines = cutoutTSpin(b, foundCx, foundCy);
        if (lines >= 2)      { score += w.tSlotTsd; continue; } // TSD：消去後盤面で次へ
        else if (lines == 1) { score += w.tSlotTss; break; }    // TSS
        else                 { score += w.tSlotReady; break; }  // 建設途中（まだ消えない）
    }
    return score;
}
