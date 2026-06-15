// ─────────────────────────────────────────────
// core/node.h — ビーム探索のノード（全モード共通の基盤データ構造）
// ─────────────────────────────────────────────
#pragma once

#include <stdint.h>
#include "core/bitboard.h"

// 盤面ハッシュ（置換表＝同一盤面の重複除去に使う）。
//   BitBoard.cols[COLS]（uint64×6）を FNV-1a で素直に混ぜる。
//   層内の重複判定に十分な 64bit mix（ama Layer::add の rapidhash 相当を軽量化）。
inline uint64_t hashBoard(const BitBoard& b) {
    uint64_t h = 1469598103934665603ULL;   // FNV offset basis
    for (int c = 0; c < COLS; c++) {
        h ^= b.cols[c];
        h *= 1099511628211ULL;             // FNV prime
    }
    return h;
}

struct SearchNode {
    BitBoard board;
    int accumulatedScore;
    int col1, rot1;
    int col2, rot2;
    int col3, rot3;
    int firstMoveIndex;   // どの初手candidate由来か（期待連鎖スコア選択用。未使用時 -1）

    SearchNode() : accumulatedScore(0), col1(-1), rot1(-1), col2(-1), rot2(-1), col3(-1), rot3(-1), firstMoveIndex(-1) {}
};
