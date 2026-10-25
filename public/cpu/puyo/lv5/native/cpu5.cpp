// ─────────────────────────────────────────────
// cpu5.cpp — ぷよCPU lv5 Wasm エントリ
//   ビットボード (1マス3ビット) による高速探索。
//   JS から受け取った盤面・NEXT・重みを EvalWeights に展開し、
//   モード別探索（現状は build モードのみ）に振り分ける。
//
//   ★ファイル構成（ama-beam のディレクトリ構成を参考に分割）
//     def.h            … 盤面定数
//     core/bitboard    … BitBoard / 配置生成
//     core/chain       … 連鎖シミュレーション / 連鎖ポテンシャル
//     core/weights.h   … EvalWeights 構造体
//     core/node.h      … SearchNode / 盤面ハッシュ（全モード共通）
//     eval/shape       … Ama 由来の形状ヘルパー + quiescence
//     eval/form        … Ama 由来の関係性 form テンプレート
//     eval/eval        … 評価値 + 報酬 + 統合 evaluateBoard
//     build/build      … build（連鎖を組む）モードの探索
//     ※ モード一覧と追加手順は native/MODES.md を参照（現状は build のみ）
// ─────────────────────────────────────────────
#include <emscripten.h>
#include <stdint.h>
#include <cstdlib>

#include "core/bitboard.h"
#include "core/weights.h"
#include "build/build.h"
#include "eval/shape.h"

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Wasm エクスポート
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) { free(ptr); }

EMSCRIPTEN_KEEPALIVE
void searchBestMovePuyoWasm(
    uint8_t* boardData,
    int* nextPairs,
    int* weightsArray,
    int* outResult
) {
    for (int i = 0; i < 20; i++) outResult[i] = -1;   // [0..6]=着手結果 / [7..19]=デバッグ統計

    // weightsArray[N] → EvalWeights の対応は core/weights.h の weightsFromArray（学習用シミュと共通）。
    EvalWeights w = weightsFromArray(weightsArray);

    BitBoard baseBoard;
    baseBoard.fromArray(boardData);

    // ★ 現状は build（連鎖を組む）モードのみ。
    //   今後 free / fast / allClear モードを追加する際はここで振り分ける。
    searchBuildMode(baseBoard, nextPairs, w, outResult);
}

// 盤面（boardBuffer と同じ形）に同色を1〜3個足して起こせる最大連鎖の点。
//   提案1 P の「相手のすぐ起こせる火力」（weightsArray[60]）。worker が相手の盤面で呼ぶ。
EMSCRIPTEN_KEEPALIVE
int ignitionScoreWasm(uint8_t* boardData) {
    BitBoard b;
    b.fromArray(boardData);
    return ignitionAfterOjama(b, 0);
}

} // extern "C"
