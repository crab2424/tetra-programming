// ─────────────────────────────────────────────
// eval/form.h — Ama 由来の「関係性 form テンプレート」（相対方式）
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/form.{h,cpp}
//
//   旧 template.h は「絶対行(TEMPLATE_TOP_ROW=8)固定＋色グループ」方式。
//   こちらは Ama を忠実に再現した相対方式（ラベル番号＋関係行列）で、
//   土台が左右にずれても評価できる。詳細は form.cpp 冒頭コメント参照。
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"

// GTR/SGTR/FRON のうち最も一致するテンプレのスコアを返す（矛盾は -100、おじゃま混入時は 0）。
int calcAmaFormScore(const BitBoard& b, const int heights[COLS]);
