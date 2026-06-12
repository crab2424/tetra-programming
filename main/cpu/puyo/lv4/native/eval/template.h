// ─────────────────────────────────────────────
// eval/template.h — 旧式テンプレート一致スコア（絶対行固定・GTR/KEY）
//   関係性 form（eval/form.h）の前身。templateBonus>0 のときのみ機能する。
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"

// GTR/KEY パターンの一致スコアのうち大きい方を返す（templateBonus<=0 なら 0）。
int calcTemplateScore(const BitBoard& b, const uint8_t* gtrPattern, const uint8_t* keyPattern, int templateBonus);
