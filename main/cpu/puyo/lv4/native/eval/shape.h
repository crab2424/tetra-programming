// ─────────────────────────────────────────────
// eval/shape.h — Ama 由来の盤面形状ヘルパー（スカラ移植）
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/eval.cpp / quiet.cpp
//   SIMD/threadは移植せず、現lv4のスカラbitboardで同等の評価を再現する。
// ─────────────────────────────────────────────
#pragma once

#include "core/bitboard.h"
#include "core/weights.h"

// 理想L字形 coef={1,1,1,-1,-1,-1}（左3列高・右3列低＝GTR土台）からの高さ偏差
int getShape(const int heights[COLS]);

// 井戸の深さ（両隣より低い列の落差合計）。端列は片隣のみで判定。
int getWell(const int heights[COLS]);

// 凸（両隣より高い列の突出合計）
int getBump(const int heights[COLS]);

// 2連結・3連結の数を数える（連結成分サイズで分類。おじゃま除外）。
void getLink23(const BitBoard& b, int& link2, int& link3);

// 致死列(第3列=heights[2])bias: max(左2列和, 右3列和) - heights[2]。
//   大きいほど3列目が周囲より低い＝致死列を低く保てている（Ama eval.cpp:99-102）。
int getSide(const int heights[COLS]);

// quiescence: 各列に同色を最大3個まで落として連鎖を試し、qスコアの最大値を返す。
int calcQuiescenceEval(const BitBoard& b, const int heights[COLS], const EvalWeights& w);
