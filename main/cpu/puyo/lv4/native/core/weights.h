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
    int qLink2Weight;   // [25] quiescence remain の2連結ボーナス（正）
    int qLink3Weight;   // [26] quiescence remain の3連結ボーナス（正・次連鎖の種）
    // 致死列(第3列)bias（Ama eval.cpp:99-102。max(左2,右3)-h[2] に乗じる。正で致死列を低く保つ誘導）
    int sideWeight;     // [27] 致死列 side bias の重み（Ama build は 0）
    // ちぎり(tear)ペナルティ（Ama beam/eval.cpp:105 node.score.action += tear*w.tear）。
    // 横置きで2列に分かれて落ちる配置に対し、配置時1回だけ加算（負＝ちぎり回避誘導）。
    int tearWeight;     // [28] ちぎりペナルティの重み（負。0で無効）

    // ── Ama search_multi 由来：期待連鎖スコア選択（核心①）──
    // 参考: source_assets/puyoAI/ama-beam/ai/search/beam/beam.cpp
    int expChainWeight; // [19] 期待連鎖スコア選択の重み（0で無効＝従来の累積eval選択）
    int knownNextCount; // [20] ※未使用（擬似未来ツモ分岐の撤去で死んだ配線。代入のみ・どこも参照しない）

    // ── Ama form 由来：関係性テンプレート（相対方式・毎ターン・0で無効化）──
    // 参考: source_assets/puyoAI/ama-beam/ai/search/beam/form.cpp
    int formWeight;     // [21] 関係性 form 一致スコアの重み（Ama build プロファイルは 50）

    // ── 期待連鎖スコア選択の速度調整（JSから設定。0=従来の重い設定）──
    int expBranch;      // [22] 擬似未来ツモ列の本数 1..6（0=6）。小さいほど軽い
    int expMaxDepth;    // [23] 期待連鎖探索の深さ 1..8（0=8）。小さいほど軽い
    int expBeamW;       // [24] depth>=1 のビーム幅（0=従来テーパ12/8/6/5）。小さいほど軽い

    // ── Ama 由来の発火枝刈り（PRUNE）──
    //   連鎖スコアがこの値以上のノードは、連鎖を記録した上で次層に伝播させない（捨てる）。
    //   発火後の崩れた盤面でビーム枠を浪費せず「組み途中」の盤面に集中させる＝同じ幅で深く探れる。
    //   0 で無効＝従来動作。原典: source_assets/puyoAI/ama-beam/ai/search/beam/beam.cpp PRUNE=5000
    int pruneChainScore; // [29] 発火枝刈り閾値（0=無効）

    // ── Ama 型 eval（発火価値を eval から分離するA/B切替フラグ）──
    //   1 のとき evaluateBoard は calcRewardScore（発火報酬/−5000ペナルティ/chainPotential/緊急/
    //   全消し/動的閾値）を呼ばず、構築品質(calcEvalScore)＋waste のみでビームを駆動する。
    //   発火価値は chainTarget（quiescence潜在＋実発火の巻き上げ）経由で初手選択に集約する＝ama 方式。
    //   0 で従来動作（完全不変）。原典: source_assets/puyoAI/ama-beam/ai/search/beam/eval.cpp
    int amaEvalMode;     // [30] 0=現行eval / 1=ama型（構築品質のみで駆動）
    int wasteWeight;     // [31] ama型: 消したぷよ数への小ペナルティ（負。ama waste 相当）

    // ── 発火トリガ（ama型の「いつ撃つか」。育成選択の直前に判定する fire gate）──
    //   ama型(amaEvalMode=1)はビームを「撃たずに育てる」器として使うため、別途
    //   発火基準を持たないと無限に積み続ける（ama-main の gaze/TRIGGER 相当が無い）。
    //   各初手を「今そのまま置いたら実発火する連鎖（depth0 の simulateChain）」で測り、
    //   下記いずれかが成立したら『今撃てる最大連鎖の初手』を選ぶ。
    int fireChainCount;  // [32] 目標連鎖数。今撃てる連鎖がこの段数以上なら発火（0=目標発火 無効）
    int fireEmergency;   // [33] 緊急発火 1/0。盤面が緊急(emergencyHeight到達/致死列高)なら出せる最大連鎖を即発火
    int fireScoreThreshold; // [34] 目標発火の和集合条件：今撃てる連鎖スコアがこの値以上なら段数未満でも発火（0=スコア条件 無効）
    int growthFireForbidChains; // [35] 育成こぼし抑制：今そのまま置くとこの段数「以上」を発火する初手を育成選択から除外（0=無効/1=全こぼし禁止/2=1連鎖まで許容…）。全候補が該当する時はフィルタ無しで再選択
    int emergencyFireMinRatio;  // [36] 緊急発火の潜在比ガード(%)：今撃てる最大連鎖が本線潜在(bestChain)のこの割合以上の時だけ緊急発火（0=無効＝従来どおり無制限）。部分発火で本線を巻き込むのを防ぐ
    int emergencyHardCol2;      // [37] 窒息寸前の延命発火：致死列(第3列)がこの段数以上なら[36]の比ガードを無視して出せる最大連鎖を即発火（0=無効＝最終手段なし）
};
