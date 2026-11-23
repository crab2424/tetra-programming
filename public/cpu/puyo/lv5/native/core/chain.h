// ─────────────────────────────────────────────
// core/chain.h — 連鎖シミュレーションと連鎖ポテンシャル
//   ChainResult: 連鎖数・消去数・最大グループ・スコア・途中段の余剰。
//   PotentialInfo: 1手で発火させた場合に到達できる最大連鎖と発火点の安全性。
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"

// VS 設定の消去数（CONNECT。v2.6.2 A）。setEraseCount で worker が探索の前に入れる。既定 4
extern int g_eraseCount;
// VS 設定の連鎖縛り（CHAIN MIN。0=OFF）。縛り未満の連鎖は火力 0 なので、fire gate が緊急以外では撃たない（build.cpp）
extern int g_chainMin;

struct ChainResult {
    int chains;
    int totalErased;
    int maxGroup;
    int score;
    int excess;      // 途中段の余剰＝最終段以外の各段で 4 個を超えて消えた数の合計（同時消し・多連結の資源ロス）
};

// 盤面のマス集合（絶対行 r・列 c のマスを bit r*COLS+c で表す。TOTAL_ROWS*COLS=102 ≤ 128）。
struct CellMask {
    uint64_t lo = 0, hi = 0;
    inline void set(int r, int c) { int i = r * COLS + c; if (i < 64) lo |= 1ULL << i; else hi |= 1ULL << (i - 64); }
    inline bool test(int r, int c) const { int i = r * COLS + c; return i < 64 ? (lo >> i) & 1 : (hi >> (i - 64)) & 1; }
    inline CellMask operator&(const CellMask& o) const { CellMask m; m.lo = lo & o.lo; m.hi = hi & o.hi; return m; }
    inline bool any() const { return (lo | hi) != 0; }
    inline int count() const { return __builtin_popcountll(lo) + __builtin_popcountll(hi); }
};

// 盤面 b を破壊的に連鎖させ、結果を返す（b は連鎖後の盤面になる）。
//   popped を渡すと、連鎖で消えたぷよ（巻き込んだおじゃまを含む）を「連鎖前の位置」で記録する
//   （副砲の判定用。nullptr なら追跡しない＝従来と同じ速さ）。
ChainResult simulateChain(BitBoard& b, CellMask* popped = nullptr);

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
