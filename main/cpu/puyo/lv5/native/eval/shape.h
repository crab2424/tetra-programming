// ─────────────────────────────────────────────
// eval/shape.h — Ama 由来の盤面形状ヘルパー（スカラ移植）
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/eval.cpp / quiet.cpp
//   SIMD/threadは移植せず、現lv5のスカラbitboardで同等の評価を再現する。
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

// 2連結数 + 3連結を「形状別」に分類したカウント（連結成分サイズで分類・おじゃま除外）。
//   3連結トリオミノは『縦一直線 / 横一直線 / L字(折れ)』の3種しか存在しない。
//   発火直前形としての価値が形状で異なるため、3連結だけ細分化して数える。
struct Link3Counts {
    int link2;  // 2連結の数
    int l3L;    // 3連結：L字（折れ）
    int l3H;    // 3連結：横一直線（同一行に3個）
    int l3V;    // 3連結：縦一直線（同一列に3個）
};
Link3Counts getLink23(const BitBoard& b);

// 形状別3連結カウントに base 重みを乗じた合計（整数百分率で丸め）。
//   facL/facH/facV は L字/横一直線/縦一直線の倍率（百分率＝×100。JS から実行時設定）。
//   カウントを先に集約してから1回だけ /100 する＝丸め誤差を最小化。
//   base link3 と quiescence remain link3 の両系統が同じ係数を共有する。
inline int weightedLink3(const Link3Counts& lc, int link3Weight,
                         int facL, int facH, int facV) {
    return (lc.l3L * facL + lc.l3H * facH + lc.l3V * facV) * link3Weight / 100;
}

// 致死列(第3列=heights[2])bias: max(左2列和, 右3列和) - heights[2]。
//   大きいほど3列目が周囲より低い＝致死列を低く保てている（Ama eval.cpp:99-102）。
int getSide(const int heights[COLS]);

// quiescence: 各列に同色を最大3個まで落として連鎖を試し、qスコアの最大値を返す。
//   outChainScore != nullptr のとき、発火候補(col×color)の中で実際に到達した
//   連鎖スコアの最大値（＝「今撃てば出る最大連鎖スコア」）も書き出す。
//   ※ qスコア(best)は重み付き評価の最大、outChainScore は生の連鎖スコアの最大で、
//     別々に追跡する（argmax が一致するとは限らない）。発火価値の巻き上げ用。
//   outChainCount != nullptr のとき、その最大連鎖スコアに対応する連鎖『段数』も書き出す
//   （デバッグの「期待連鎖数」表示用。outChainScore の argmax と同じ候補の chains）。
int calcQuiescenceEval(const BitBoard& b, const int heights[COLS], const EvalWeights& w,
                       int* outChainScore = nullptr, int* outChainCount = nullptr);
