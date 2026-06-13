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
int evaluateBoard(
    const BitBoard& postBoard,
    const ChainResult& chain,
    const EvalWeights& w,
    const PotentialInfo& prePot,
    bool isEmergencyPre
);
