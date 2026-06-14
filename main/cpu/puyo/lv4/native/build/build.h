// ─────────────────────────────────────────────
// build/build.h — 「build（連鎖を組む）」モードの探索
//   現行 lv4 の本命戦略。確定NEXT(TETLABO内部20本)を1本のビームで深く読み、
//   各初手の到達連鎖スコア(quiescence潜在＋実発火)を巻き上げて
//   「連鎖スコア主体・base同点崩し」で初手を選ぶ（Ama search_multi 由来・確定NEXT版）。
//
//   ※ 他モード（free / fast / allClear）は今後 native/<mode>/ に追加予定。
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"
#include "core/weights.h"

// build モードの最善手を探索し、outResult[0..6] に書き込む。
//   outResult: [0]col1 [1]rot1 [2]score [3]col2 [4]rot2 [5]col3 [6]rot3
void searchBuildMode(
    const BitBoard& baseBoard,
    int* nextPairs,
    const EvalWeights& w,
    int* outResult
);
