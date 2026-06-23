// ─────────────────────────────────────────────
// eval/form.h — Ama 由来の「関係性 form テンプレート」（相対方式）
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/form.{h,cpp}
//
//   Ama を忠実に再現した相対方式（ラベル番号＋関係行列）で、
//   土台が左右にずれても評価できる。詳細は form.cpp 冒頭コメント参照。
//   （旧式の絶対行固定テンプレート eval/template は廃止済み。）
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"

// GTR/SGTR/FRON のうち最も一致するテンプレのスコアを返す（矛盾は -100、おじゃま混入時は 0）。
int calcAmaFormScore(const BitBoard& b, const int heights[COLS]);
