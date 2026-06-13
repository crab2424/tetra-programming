// ─────────────────────────────────────────────
// build/build.h — 「build（連鎖を組む）」モードの探索
//   現行 lv4 の本命戦略。大連鎖を構築し、発火条件を満たしたら発火する。
//   内部で 2 経路を持つ：
//     - expChainWeight != 0 … Ama search_multi 由来の期待連鎖スコア選択
//     - expChainWeight == 0 … 確定NEXTを使った通常ビーム探索（本命）
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
