#pragma once
#include "board.h"
#include "weights.h"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// eval: 盤面評価の本体
//
// ・evalBoardState   : 盤面の「現在の状態」を評価する（毎ステップ加算される評価値）
//                      穴・高さ・段差・TSD形状・Iウェル・下り坂など
// ・evalPlacementEvent: その1手を置いたことで発生したイベントを評価する（1回限りの報酬）
//                      ライン消去・Tスピン・BtB・コンボ・接地ボーナスなど
// ・estimateAttack    : その1手の概算火力（生存判定 pick_move 用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 配置後の盤面を見て「現在の盤面の良さ・悪さ」を返す（毎ステップ加算）。
int evalBoardState(const Board& b, const EvalWeights& w, int upcomingT, int* outMaxHeight = nullptr);

// その1手を置いたことで「今回だけ」発生したイベントを評価する（1回限り加算）。
//   afterBoard       : 配置＆ライン消去後の盤面
//   beforeClearBoard : 配置後・ライン消去前の盤面（downstack判定に使用）
//   linesCleared     : 消去ライン数 / isGrounded: 完全接地か / touchingCount: 接触ブロック数
//   tSpinType        : 0=なし 1=通常Tスピン 2=ミニ
//   ren              : 配置前のコンボ数 / backToBack: 配置前のBtB状態
//   droppedBlocks    : 置いたミノの4ブロック座標 / prevMaxHeight: 配置前の盤面最大高さ
int evalPlacementEvent(
    const Board& afterBoard,
    const Board& beforeClearBoard,
    int linesCleared, bool isGrounded, int touchingCount,
    int tSpinType, int ren, bool backToBack,
    const GridBlock* droppedBlocks,
    int prevMaxHeight,
    const EvalWeights& w
);

// その1手で相手へ送る火力(=自分の着弾おじゃまを相殺できる量)を概算する。
//   src/game/tet/scoring.js の「マージン未突入」固定テーブルに準拠（生存判定用の近似）。
int estimateAttack(int linesCleared, int tSpinType, bool b2bBefore, int renBefore);
