#pragma once
#include "board.h"
#include "weights.h"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// tslot: Cold Clear 方式の T-slot 先読み評価（TSD/TSS のみ）
//
// 方針：盤面に「今まさに回し入れられる TSD/TSS スロット」があるかを、実際に T を
//   仮想配置してライン消去をシミュレート(cutout)して判定する。消えたら盤面を更新し、
//   来るTの本数(upcomingT)を上限に「連続して何回 TSD を入れられるか」を先読みする。
//   TST は地形が崩れやすく能動的に狙わせない方針のため、ここでは検出しない
//   （TST が実際に発生した時の報酬は evalPlacementEvent の tstClear が担う）。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// TSD地形(cx,cy)を判定する。heights が渡されれば clearCol チェックを O(1) 化する。
bool isTSDShape(const Board& board, int cx, int cy, const int heights[COLS] = nullptr);

// TSD/TSS スロット (cx,cy) に T(South=rot2) を仮想配置してライン消去し、消去数を返す。
int cutoutTSpin(Board& b, int cx, int cy);

// 盤面 b（コピー受け取り）から、来るTの本数 maxIter を上限に TSD/TSS チェーンを先読み評価する。
int evalTSlotChain(Board b, int maxIter, const EvalWeights& w);
