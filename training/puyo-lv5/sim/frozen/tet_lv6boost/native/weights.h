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
    int tSlotTst;            // ★Phase3追加[36]：T-slot先読みチェーンで TST(3ライン)スロットを発見した時の加点（CC tslot[3]相当）
    int tSlotReadyFin;       // ★追加[37]：fin スロットの建設途中(0ライン)加点。tSlotReady[18](sky/TSD用)から分離
    int tSlotReadyTst;       // ★追加[38]：tst_twist スロットの建設途中(0ライン)加点。tSlotReady[18]から分離（TST能動化用に独立チューニング）
    // ★lv6 強化（参考AI: Cold Clear 2 / clys。設計 source_assets/memory/cpu/tet/lv6-boost-design.md §3）
    //   すべて 0 で無効＝従来と探索結果が完全一致する。
    int actCost;             // [39] B1 操作時間：回転・横移動 1回あたり（イベント報酬）
    int sdCost;              // [40] B1 操作時間：ソフトドロップが要る置き方の固定コスト
    int sdRowCost;           // [41] B1 操作時間：ソフトドロップ 1段あたり
    int holeAboveWell;       // [42] B2 1=一番低い列の表面より下の穴（ゴミの穴）を穴・汚さとして数えない（clys hole_a）
    int rowTrans;            // [43] B3 row transitions（横方向の埋まり/空きの切り替わり、壁含む）1回あたり
    int covered;             // [44] B4 cell coveredness（穴ごとの上に積まれた段数、上限 coverMax）1段あたり
    int coverMax;            // [45] B4 coveredness の1穴あたりの上限
    int wasteI;              // [46] B5 I を 4-LINES 以外に使った手（clys waste_I）
    int comboAtk;            // [47] B6 REN の火力ボーナス 1 あたり（高さに関係なく。CC2 combo_attack）
    int visitSelect;         // [48] B8 1=初手を「各深さでビームに残った子孫の数」で選ぶ（clys visit）
    int bumpSq;              // [49] B9 Σ(高さ差)²（差≥3 のみ、clys bump）
    // ★相殺外し（clys is_tankable 相当。設計 source_assets/memory/cpu/tet/lv6-tankable-design.md）。0 で無効。
    int tankH;               // [50] 着弾おじゃまがある時、初手後の「中央列の高さ＋incoming−火力」がこれ以上の手は守りが要る手とみなす
    int tankLook;            // [51] 守りが要る手でも、その枝が 2〜(1+tankLook) 手目に TSD 以上か 4-LINES を撃つなら受けてよい（0=例外なし）
    // ★REN 偏重の是正と通常探索での PC（設計 source_assets/memory/cpu/tet/lv6-style-design.md）。0 で無効。
    int renDangerH;          // [52] >0 のとき、comboAtk を満額にするのは「配置前の高さ＋incoming ≥ これ」の危険時だけ（平時は comboAtkCalm）
    int comboAtkCalm;        // [53] 平時の REN の火力ボーナス 1 あたり（renDangerH>0 のときだけ使う）
    int pcClear;             // [54] パーフェクトクリア（消去後に盤面が空）の報酬。生存判定の火力にも PC 分を足す
};
