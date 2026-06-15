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

    EvalWeights w;
    // ── 報酬 (reward) ──
    w.chainBonus          = weightsArray[0];
    w.erasedBonus         = weightsArray[1];
    w.zenkeshiBonus       = weightsArray[4];
    w.chainPotentialBonus = weightsArray[5];
    // ── 評価値 (eval) ──
    w.heightPenalty       = weightsArray[2];
    w.heightDiffPenalty   = weightsArray[3];
    // ── 制御パラメータ ──
    w.p1Weight            = weightsArray[6];
    w.ignitionThreshold   = weightsArray[7];
    w.emergencyHeight     = weightsArray[8];
    w.ignitionScoreThreshold = weightsArray[9];
    // ── Ama 由来の評価値 ──
    w.shapeWeight         = weightsArray[10];
    w.wellWeight          = weightsArray[11];
    w.bumpWeight          = weightsArray[12];
    w.qChainWeight        = weightsArray[13];
    w.qYWeight            = weightsArray[14];
    w.qKeyWeight          = weightsArray[15];
    w.qChiWeight          = weightsArray[16];
    w.link2Weight         = weightsArray[17];
    w.link3Weight         = weightsArray[18];
    // ── 期待連鎖スコア選択 ──
    w.expChainWeight      = weightsArray[19];
    w.knownNextCount      = weightsArray[20];

    w.formWeight          = weightsArray[21];

    w.expBranch           = weightsArray[22];
    w.expMaxDepth         = weightsArray[23];
    w.expBeamW            = weightsArray[24];

    // ── quiescence remain link（核心②の remain link 評価）──
    w.qLink2Weight        = weightsArray[25];
    w.qLink3Weight        = weightsArray[26];

    // ── 致死列 side bias ──
    w.sideWeight          = weightsArray[27];

    // ── ちぎり(tear)ペナルティ ──
    w.tearWeight          = weightsArray[28];

    // ── Ama 由来の発火枝刈り（PRUNE）──
    w.pruneChainScore     = weightsArray[29];

    // ── Ama 型 eval（A/B切替フラグ＋waste ペナルティ）──
    w.amaEvalMode         = weightsArray[30];
    w.wasteWeight         = weightsArray[31];

    // ── 発火トリガ（ama型の「いつ撃つか」）──
    w.fireChainCount      = weightsArray[32];
    w.fireEmergency       = weightsArray[33];
    w.fireScoreThreshold  = weightsArray[34];
    w.growthFireForbidChains = weightsArray[35];
    w.emergencyFireMinRatio  = weightsArray[36];
    w.emergencyHardCol2      = weightsArray[37];

    w.link3FacL           = weightsArray[38];
    w.link3FacH           = weightsArray[39];
    w.link3FacV           = weightsArray[40];

    BitBoard baseBoard;
    baseBoard.fromArray(boardData);

    // ★ 現状は build（連鎖を組む）モードのみ。
    //   今後 free / fast / allClear モードを追加する際はここで振り分ける。
    searchBuildMode(baseBoard, nextPairs, w, outResult);
}

} // extern "C"
