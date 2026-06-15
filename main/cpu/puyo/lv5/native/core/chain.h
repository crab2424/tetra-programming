// ─────────────────────────────────────────────
// core/chain.h — 連鎖シミュレーションと連鎖ポテンシャル
//   ChainResult: 連鎖数・消去数・最大グループ・スコア。
//   PotentialInfo: 1手で発火させた場合に到達できる最大連鎖と発火点の安全性。
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"

struct ChainResult {
    int chains;
    int totalErased;
    int maxGroup;
    int score;
};

// 盤面 b を破壊的に連鎖させ、結果を返す（b は連鎖後の盤面になる）。
ChainResult simulateChain(BitBoard& b);

struct PotentialInfo {
    int maxChains;
    int maxScore;
    int triggerCol;
    int triggerRow;
    uint8_t triggerColor;
    bool isSafe;
};

// 各列に1個ずつ仮置きして最大の連鎖（スコア）を探し、発火点の安全性も判定する。
PotentialInfo calcChainPotential(const BitBoard& b);
