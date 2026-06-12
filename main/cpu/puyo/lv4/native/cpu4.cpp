// ─────────────────────────────────────────────
// cpu4.cpp — ぷよCPU lv4 Wasm エントリ
//   ビットボード (1マス3ビット) による高速探索。
//   JS から受け取った盤面・NEXT・重みを EvalWeights に展開し、
//   モード別探索（現状は build モードのみ）に振り分ける。
//
//   ★ファイル構成（ama-beam のディレクトリ構成を参考に分割）
//     def.h            … 盤面定数
//     core/bitboard    … BitBoard / 配置生成
//     core/chain       … 連鎖シミュレーション / 連鎖ポテンシャル
//     core/weights.h   … EvalWeights 構造体
//     eval/template    … 旧式テンプレート一致
//     eval/shape       … Ama 由来の形状ヘルパー + quiescence
//     eval/form        … Ama 由来の関係性 form テンプレート
//     eval/eval        … 評価値 + 報酬 + 統合 evaluateBoard
//     search/node.h    … SearchNode
//     build/build      … build（連鎖を組む）モードの探索
//     free/ fast/ allClear/ … 今後追加するモード用（現状は空）
// ─────────────────────────────────────────────
#include <emscripten.h>
#include <stdint.h>
#include <cstdlib>

#include "core/bitboard.h"
#include "core/weights.h"
#include "build/build.h"

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
    int* outResult,
    uint8_t* gtrPattern,
    uint8_t* keyPattern
) {
    for (int i = 0; i < 7; i++) outResult[i] = -1;

    EvalWeights w;
    // ── 報酬 (reward) ──
    w.chainBonus          = weightsArray[0];
    w.erasedBonus         = weightsArray[1];
    w.zenkeshiBonus       = weightsArray[6];
    w.chainPotentialBonus = weightsArray[7];
    w.templateBonus       = weightsArray[9];
    // ── 評価値 (eval) ──
    w.heightPenalty       = weightsArray[2];
    w.heightDiffPenalty   = weightsArray[3];
    w.flatBonus           = weightsArray[4];
    w.colorConnBonus      = weightsArray[5];
    // ── 制御パラメータ ──
    w.p1Weight            = weightsArray[8];
    w.ignitionThreshold   = weightsArray[10];
    w.emergencyHeight     = weightsArray[11];
    w.ignitionScoreThreshold = weightsArray[12];
    // ── Ama 由来の評価値 ──
    w.shapeWeight         = weightsArray[13];
    w.wellWeight          = weightsArray[14];
    w.bumpWeight          = weightsArray[15];
    w.qChainWeight        = weightsArray[16];
    w.qYWeight            = weightsArray[17];
    w.qKeyWeight          = weightsArray[18];
    w.qChiWeight          = weightsArray[19];
    w.link2Weight         = weightsArray[20];
    w.link3Weight         = weightsArray[21];
    // ── 期待連鎖スコア選択 ──
    w.expChainWeight      = weightsArray[22];
    w.knownNextCount      = weightsArray[23];

    w.formWeight          = weightsArray[24];

    w.expBranch           = weightsArray[25];
    w.expMaxDepth         = weightsArray[26];
    w.expBeamW            = weightsArray[27];

    w.mainMaxDepth        = weightsArray[28];
    w.mainBeamW           = weightsArray[29];

    BitBoard baseBoard;
    baseBoard.fromArray(boardData);

    // ★ 現状は build（連鎖を組む）モードのみ。
    //   今後 free / fast / allClear モードを追加する際はここで振り分ける。
    searchBuildMode(baseBoard, nextPairs, w, gtrPattern, keyPattern, outResult);
}

} // extern "C"
