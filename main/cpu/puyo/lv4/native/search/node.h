// ─────────────────────────────────────────────
// search/node.h — ビーム探索のノード（全モード共通）
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"

struct SearchNode {
    BitBoard board;
    int accumulatedScore;
    int col1, rot1;
    int col2, rot2;
    int col3, rot3;
    int firstMoveIndex;   // どの初手candidate由来か（期待連鎖スコア選択用。未使用時 -1）

    SearchNode() : accumulatedScore(0), col1(-1), rot1(-1), col2(-1), rot2(-1), col3(-1), rot3(-1), firstMoveIndex(-1) {}
};
