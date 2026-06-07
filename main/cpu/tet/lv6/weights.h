#pragma once
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// weights: 評価関数の重みパラメータ束（JS側 weightsArray[N] と位置対応）
//   ※メンバ順は weightsArray のインデックスと一致させること。
//     重み追加は必ず末尾に足す（途中挿入はアライメント破壊）。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
struct EvalWeights {
    int lineClear, hole, heightLimit, step3Plus, flat;
    int step1Good, step1Bad, step2, groundedBonus, touchingBonus;
    int iWell, iWellOver, blocksOverHole;
    int line4, downstackGood, downstackBad;
    int p1Weight;
    int tSlotTsd, tSlotReady, tSlotTss; // ★Phase2: 旧tsdShape[17]/tsdShapeOver[18]/tsdFillBonus[19]を改名・再利用
    int tssClear, tsdClear, tsdHolePenalty, pureHole; // ★Phase2: tsdHolePenalty[22]は現在未使用
    int comboBonus;
    int btbKeep;
    int renCutPenalty;
    int tsmMiniPenalty;
    int tMinoNoClearPenalty;
    int tsdSetup;
    int tsdSetupOver;
    int slopeBonus;          // ★追加：ゆるやかな下り坂のボーナス
    int slopePenalty;        // ★追加：ゆるやかな下り坂を満たさないペナルティ
    int centerDip;           // ★追加：凹みが中央(列3~6)にあると正、端にあると負のスコア（初期値50）
    int tstClear;            // ★Phase1追加：TST(3ライン T-spin)消去ボーナス [34]（旧fireを置換）
    int b2bHold;             // ★追加[35]：配置後もBtBを保持している盤面への静的ボーナス（CC back_to_back相当）
};
