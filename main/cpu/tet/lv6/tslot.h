#pragma once
#include "board.h"
#include "weights.h"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// tslot: Cold Clear 方式の T-slot 先読み評価（TSD/TSS/TST/FIN）
//
// 方針：盤面に「今まさに回し入れられる T-spin スロット」があるかを、実際に T を
//   仮想配置してライン消去をシミュレート(cutout)して判定する。消えたら盤面を更新し、
//   来るTの本数(upcomingT)を上限に「連続して何回 T-spin を入れられるか」を先読みする。
//   検出種別と優先順は Cold Clear standard.rs に準拠：
//     1. sky_tslot (= isTSDShape, South T による開けた TSD/TSS)
//     2. tst_twist (+3コーナー受理判定) — 縦置き T による TST
//     3. fin — 縦置き T によるフィン形 TST
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// CC座標(y上向き)⇔内部座標(y下向き)の橋渡し。CC board.occupied(x,ccy) と等価。
//   内部row = ROWS-1-ccy。壁(x範囲外)=true / 床(ccy<0→row≥ROWS)=true / 空(ccy大→row<0)=false。
inline bool occCC(const Board& b, int x, int ccy) { return b.has(x, ROWS - 1 - ccy); }

// 検出器が返す縦置き/横置き T の配置候補。barCol=Tの縦バー(または横バー中心)列、
//   midRow=内部行(縦バー中心行 or 横バー行)、rot=回転(1=East/3=West/2=South)。found=false で候補なし。
struct TSlotHit { int barCol; int midRow; int rot; bool found; };

// TSD地形(cx,cy)を判定する。heights が渡されれば clearCol チェックを O(1) 化する。
bool isTSDShape(const Board& board, int cx, int cy, const int heights[COLS] = nullptr);

// スロット (cx,cy) に T を仮想配置してライン消去し、消去数を返す。rot=2(South,既定)/1(East)/3(West)。
//   原点 (cx-1, cy-2)。South は cx=横バー中心列/cy=バー行、East/West は cx=縦バー列/cy=バー中心行。
int cutoutTSpin(Board& b, int cx, int cy, int rot = 2);

// CC tst_twist_left/right を移植。縦スロット＋天井で TST 可能な縦置き T 候補を返す。
//   発見後 CC と同じ「4隅のうち≥3埋まり かつ on_stack(直下に支え)」を満たすもののみ採用。
TSlotHit detectTSTSlot(const Board& b, const int heights[COLS]);

// CC fin_left/right を移植。フィン形オーバーハングの TST 用縦置き T 候補を返す。
TSlotHit detectFINSlot(const Board& b, const int heights[COLS]);

// 盤面 b（コピー受け取り）から、来るTの本数 maxIter を上限に T-spin チェーンを先読み評価する。
int evalTSlotChain(Board b, int maxIter, const EvalWeights& w);
