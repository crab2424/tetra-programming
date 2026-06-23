// ─────────────────────────────────────────────
// eval/eval.h — 盤面評価の統合エントリ
//   報酬（1手限り）と評価値（毎ターン）を合算して返す。
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"
#include "core/chain.h"
#include "core/weights.h"

// 配置後の盤面・連鎖結果から、報酬＋評価値の合算スコアを返す。
//   postBoard: 配置後の盤面
//   prePot:    配置前のポテンシャル（呼び出し側で計算済み）
//   isEmergencyPre: 配置前の盤面で判定した緊急事態フラグ
//   outPotChainScore != nullptr のとき、配置後盤面の「今撃てば出る最大連鎖スコア」
//     （quiescence 由来）を書き出す。探索側の発火価値巻き上げ(chainTarget)に使う。
//   outPotChainCount != nullptr のとき、その潜在連鎖スコアに対応する『段数』も書き出す
//     （デバッグの期待連鎖数表示用）。
int evaluateBoard(
    const BitBoard& postBoard,
    const ChainResult& chain,
    const EvalWeights& w,
    const PotentialInfo& prePot,
    bool isEmergencyPre,
    int* outPotChainScore = nullptr,
    int* outPotChainCount = nullptr
);
