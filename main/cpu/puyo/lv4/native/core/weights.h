// ─────────────────────────────────────────────
// core/weights.h — 評価パラメータ構造体
//
// 【報酬 (reward)】
//   配置前後の盤面を比較し、配置後にのみ現れた変化に対して1回だけ加算する。
//   chainBonus, erasedBonus, zenkeshiBonus, chainPotentialBonus
//
// 【評価値 (eval)】
//   配置後の盤面状態をそのまま毎ターン評価する。
//   heightPenalty, heightDiffPenalty
//
// 【制御パラメータ】
//   p1Weight, ignitionThreshold, emergencyHeight, ignitionScoreThreshold
//
// ※ JS 側 weightsArray[N] との対応は cpu4.cpp の searchBestMovePuyoWasm を参照。
// ─────────────────────────────────────────────
#pragma once

struct EvalWeights {
    // ── 報酬 (reward) ──
    int chainBonus;           // 発火連鎖ボーナス（1手限り）
    int erasedBonus;          // 消去ぷよ数ボーナス（1手限り）
    int zenkeshiBonus;        // 全消しボーナス（1手限り）
    int chainPotentialBonus;  // 連鎖ポテンシャル増加ボーナス（差分）

    // ── 評価値 (eval) ──
    int heightPenalty;        // 高さペナルティ（毎ターン）
    int heightDiffPenalty;    // 高さ差ペナルティ（毎ターン）

    // ── 制御パラメータ ──
    int p1Weight;
    int ignitionThreshold;
    int emergencyHeight;
    int ignitionScoreThreshold;

    // ── Ama 由来の評価値（毎ターン・加算式・0で無効化可能）──
    // 参考: source_assets/puyoAI/ama-beam/ai/search/beam/eval.cpp
    int shapeWeight;    // [10] 理想L字形(左3列高/右3列低)からの偏差ペナルティ（負）
    int wellWeight;     // [11] 井戸(両隣より低い列)の深さペナルティ（負）
    int bumpWeight;     // [12] 凸(両隣より高い列)ペナルティ（負）
    int qChainWeight;   // [13] quiescence: 連鎖ポテンシャル数ボーナス（正）
    int qYWeight;       // [14] quiescence: 発火列の高さボーナス（正＝高く積める連鎖を評価）
    int qKeyWeight;     // [15] quiescence: 発火に必要な追加ぷよ数ペナルティ（負）
    int qChiWeight;     // [16] quiescence: 発火点の左右伸長余地ボーナス（正）
    int link2Weight;    // [17] 2連結ボーナス（正）
    int link3Weight;    // [18] 3連結ボーナス（正・発火直前形に近く価値大）
    // quiescence の発火直前盤面(remain)の連結数（核心②の remain link 評価。Ama eval.cpp:62-65）
    int qLink2Weight;   // [27] quiescence remain の2連結ボーナス（正）
    int qLink3Weight;   // [28] quiescence remain の3連結ボーナス（正・次連鎖の種）
    // 致死列(第3列)bias（Ama eval.cpp:99-102。max(左2,右3)-h[2] に乗じる。正で致死列を低く保つ誘導）
    int sideWeight;     // [29] 致死列 side bias の重み（Ama build は 0）
    // ちぎり(tear)ペナルティ（Ama beam/eval.cpp:105 node.score.action += tear*w.tear）。
    // 横置きで2列に分かれて落ちる配置に対し、配置時1回だけ加算（負＝ちぎり回避誘導）。
    int tearWeight;     // [30] ちぎりペナルティの重み（負。0で無効）

    // ── Ama search_multi 由来：期待連鎖スコア選択（核心①）──
    // 参考: source_assets/puyoAI/ama-beam/ai/search/beam/beam.cpp
    int expChainWeight; // [19] 期待連鎖スコア選択の重み（0で無効＝従来の累積eval選択）
    int knownNextCount; // [20] 既知のNEXTペア数（現在ペアを除く。擬似未来ツモの分岐開始位置）

    // ── Ama form 由来：関係性テンプレート（相対方式・毎ターン・0で無効化）──
    // 参考: source_assets/puyoAI/ama-beam/ai/search/beam/form.cpp
    int formWeight;     // [21] 関係性 form 一致スコアの重み（Ama build プロファイルは 50）

    // ── 期待連鎖スコア選択の速度調整（JSから設定。0=従来の重い設定）──
    int expBranch;      // [22] 擬似未来ツモ列の本数 1..6（0=6）。小さいほど軽い
    int expMaxDepth;    // [23] 期待連鎖探索の深さ 1..8（0=8）。小さいほど軽い
    int expBeamW;       // [24] depth>=1 のビーム幅（0=従来テーパ12/8/6/5）。小さいほど軽い

    // ── 通常ビーム探索(searchBestMove)の速度調整（expChainWeight==0 のとき動く本命経路）──
    int mainMaxDepth;   // [25] 確定先読みの深さ 1..10（0=10）。小さいほど軽い（50ms対策の主レバー）
    int mainBeamW;      // [26] depth>=1 のビーム幅（0=従来テーパ8/6/4）。小さいほど軽い
};
