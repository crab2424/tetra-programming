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
// ※ JS 側 weightsArray[N] との対応は末尾の weightsFromArray を参照。
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

    // ── 3連結の形状別倍率（百分率＝×100。base link3 / quiescence remain link3 の両方に共通で乗る）──
    //   3連結トリオミノは縦一直線/横一直線/L字の3種。形状で発火直前形としての価値が違うため細分化。
    //   weightedLink3() で link3Weight / qLink3Weight に乗じる。100=×1.0、60=×0.6。
    int link3FacL;      // [38] L字（折れ）の倍率（%）
    int link3FacH;      // [39] 横一直線の倍率（%）
    int link3FacV;      // [40] 縦一直線の倍率（%）

    // ── vsTet / fastVsTet 専用の評価値（build/fast プロファイルでは 0＝無効）──
    //   モード差は重みだけで表現する設計（native 探索は共通）に従い、calcEvalScore で
    //   常に計算するが weight==0 のときは寄与しない。対テト系プロファイルでのみ非0にする。
    int puyosWeight;    // [41] 盤面のぷよ量（おじゃま除く非空セル数）ボーナス（正＝多いほど良い）
    int height3Weight;  // [42] 致死列(第3列)のみの高さペナルティ。高さ>4 の超過分に乗じる（負）

    // ── 本線の資源効率（提案3。既定0＝無効）──
    int qExcessWeight;  // [43] quiescence の潜在連鎖の途中段の余剰（ChainResult::excess）1個あたり（負）
    int qJunkWeight;    // [44] ゴミ（本線にも副砲にも使わない色ぷよ）× 埋まり具合（色ぷよ÷72）1個あたり（負）。E2a
    int qSubWeight;     // [45] 副砲（本線と交わらず本線を落とさない連鎖）で送れるおじゃま1個あたり（正）。E2b

    // ── 催促・対応（H1/H2。既定0＝無効。設計: lv6-harass-design.md §9.4）──
    //   ★ [46] と [49] は「思考ごとの入力」：JS（cpu5_worker_io.js）／学習用シミュ（player.cpp decide）が
    //     相手の状態を見て、使う思考でだけ値を入れる（保存している重みそのものではない）。
    int harassMinScore;   // [46] H1 催促：今撃てる小連鎖の点がこれ以上なら撃つ候補（0=無効）。JS/sim が「個数×レート」で入れる
    int harassMaxChains;  // [47] H1 催促：撃つ連鎖の段数の上限
    int harassKeepPct;    // [48] H1 催促：撃った後の本線潜在（afterReach）が今の本線潜在のこの%以上のときだけ撃つ
    int counterKeepReach; // [49] H2 対応：カウンターで受け量を上回る候補のうち「撃った後の本線潜在」が最大の手を撃つ 1/0（0=従来＝点が最大）
    int harassMinReach;   // [50] H1 催促：撃った後の本線潜在の点がこれ以上のときだけ撃つ（相手に本線を吐かせても後打ちで勝てる量）。JS/sim が「個数×レート」で入れる
    //   counterKeepReach の値: 1=本線潜在が最大の手（同じなら点が大きい方）/ 2=同じなら点が小さい方 /
    //                          3=本線潜在が最大から 5% 以内の手のうち点が最小（相手の火力＋α で返す。§10.3）

    // ── 副砲・催促の本線条件（G1/G2。既定0＝条件なし。設計: lv6-harass-design.md §10.3）──
    int subMinMainChains; // [51] E2b（副砲）を足す本線 M の段数の下限。H1 も「撃った後の本線の段数」をこれ以上に
    int subMinMainPuyos;  // [52] E2b を足す本線 M の色ぷよ数の下限
    int subMinFill;       // [53] E2b を足す盤面の色ぷよ数の下限（埋まり具合＝それ以上の構築が難しい目安）

    // ── 発火点の保全（提案5 K。既定0＝無効。設計: lv6-harass-design.md §13.4）──
    int qKeepWeight;      // [54] おじゃまを qKeepRows 段載せた仮の盤面で起こせる最大連鎖のおじゃま量 1個あたり（正）。負＝降って失う量（今−降った後）1個あたりの罰
    int qKeepDepth;       // [55] K を掛けるビームの深さ（深さ < この値のノードだけ。0＝全部の深さ）
    int qKeepRows;        // [56] 載せるおじゃまの段数（0＝1段＝6個）

    // ── 地形優先の対応（T。既定0＝無効。設計: lv6-harass-design.md §13.5）──
    //   受け量が小さいカウンターの場面で、fast に入らず build の重みのまま、育成（受ける）・軽減・返すのうち
    //   「残りのおじゃまが降った後に起こせる連鎖」（地形の値）が最大の手を選ぶ。地形＞火力。
    //   ★ [57][59] は思考ごとの入力（JS cpu5_worker_io.js／sim player.cpp decide が入れる）。
    int counterTerrainOjama; // [57] 今の受け量（個）。0＝使わない
    int counterTerrainMax;   // [58] この個数以下の受け量で T を使う（保存値。0＝無効）
    int counterTerrainRate;  // [59] おじゃまのレート（撃った点 → 相殺する個数）

    // ── 相手を見て撃つ（提案1 P。既定0＝無効。設計: lv6-harass-design.md §13.6）──
    //   ★ [60] は思考ごとの入力（本番は worker が _ignitionScoreWasm で、sim は player.cpp decide が入れる）。
    int p1OppScore;       // [60] 相手のすぐ起こせる火力（相手の盤面に同色を1〜3個足して起こせる最大連鎖の点）
    int p1Alpha;          // [61] 目標発火は「撃つ点 ×100 ≥ p1Alpha × 相手の火力」のときだけ（%。0＝無効）

    // ── 対テト（lv6 のみ。既定0＝無効。設計: lv6-vstet-design.md §12）──
    //   ★ すべて思考ごとの入力（JS cpu5_worker_io.js／sim player.cpp decide が対テトの本線構築中にだけ入れる）。
    int killScore;        // [62] A：テトを倒せる点の目安（テトの残り段数→ライン→4個消し連鎖の点。0＝使わない）
    int killHoldPct;      // [63] A：目標に届いても、撃つ点 ×100 < killScore × この% なら撃たずに伸ばす（0＝保留しない）
    int killFire;         // [64] A：目標未満でも、今撃てる点 ≥ killScore なら撃つ 1/0
    int growthForbidStrict; // [65] B：育成こぼし抑制で band 内が全部こぼすとき、band を外してこぼさない手を探す 1/0（整地だけの1連鎖を撃たない）
    // ── T（地形優先の対応）の条件（§13。既定0＝従来の T と同じ）──
    int terrainMinChains; // [66] T で撃つ（返す・軽減）手の段数の下限（0＝条件なし）
    int terrainGainPct;   // [67] T で撃つのは、降った後の地形が育成（受ける）の地形をこの% 上回るときだけ（0＝上回れば撃つ）

    // ── 対テト §15（lv6 のみ。既定0＝無効。設計: lv6-vstet-design.md §15）──
    //   ちぎりの量＝段数＋1（ちぎると約 83ms×(段数+1) 遅れる）。連鎖が起きる配置（発火）は数えない。
    int tearTimeWeight;   // [68] 累積評価に「ちぎりの量 × この値」（負）。[28] tearWeight（0/1・発火も罰）とは別
    int tearChainCost;    // [69] 到達連鎖の巻き上げで「経路のちぎりの量の合計 × この値（点）」を引く（初手の絞り込みでも効かせる）
    //   発火点の側面（K の置き換え）：連鎖可能な発火点（組）ごとに、左右の列で開いている側面のマスを山なりの f(d) で数える。
    //   d＝隣の列の上端からの段（1＝上端のすぐ上）。f(d) = W × max(0, 100 − |d − peak| × fall) / 100。組の値は左右の大きい方。
    int sideKeepWeight;   // [70] W（正。0=無効）
    int sideKeepPeak;     // [71] 山の頂上の段（0=既定 2）
    int sideKeepFall;     // [72] 頂上から1段離れるごとに減らす %（0=既定 50）
    int sideKeepMinChains;// [73] この段数以上の連鎖を起こせる発火点だけ数える（0=既定 2）
    //   おじゃまを降らせる探索。★ [74..77] は思考ごとの入力（JS cpu5_worker_io.js／sim player.cpp decide が対テトのときだけ入れる）。
    int ojamaNow;         // [74] 初手を置いた後に降る量（ready まで残り 1手以内のおじゃま）
    int ojamaNext;        // [75] 2手目を置いた後に降る量（それ以外の届いているおじゃま。テトのゲージは入れない）
    int ojamaRate;        // [76] 相殺の換算レート（0=この仕組みを使わない）
    int ojamaWorst;       // [77] 1=初手（深さ0）だけ端数の全パターンの最悪で見る／0=固定の順

    // ── 対テト §17 D：危険度で妥協して撃つ（lv6 のみ。既定0＝無効。設計: lv6-vstet-design.md §17.3）──
    //   fire gate で、育成の初手の盤面（board0）に届いているおじゃま（[74]+[75]）を全部降らせた盤面を見る。[76] ojamaRate>0 のときだけ。
    //   危険なら 反撃 → 相殺 → 軽減 の順に撃つ手を探し、無ければ育成のまま。
    int dangerEmergAfter;  // [78] 1=緊急の判定（[8]・第3列9段・[37]）を降った後の盤面でも行う（今の盤面と OR）
    int dangerOjamaPct;    // [79] 降った後の おじゃま÷全ぷよ×100 ≥ この値なら危険（0=見ない）
    int dangerLossPct;     // [80] 降った後に撃てる連鎖の点が降る前よりこの%以上減るなら危険（0=見ない）
    int dangerMinIncoming; // [81] 危険と見るのは届いている量がこの個数以上のとき（0=1個）
    int dangerFireRatio;   // [82] 反撃：危険のとき、今撃てる最大 ≥ bestChain×この% なら撃てる最大を撃つ（0=撃たない）
    int dangerOffsetPct;   // [83] 相殺：点 ≥ 届いている量×レート×この% の手のうち、撃った後の本線（reachPot）が最も残る手（0=使わない）
    int dangerKeepPct;     // [84] 相殺・軽減の手は reachPot ≥ basePot×この% のものだけ（0=条件なし）
    int dangerReduce;      // [85] 軽減 1/0：全部は消せなくても、撃った後に残りが降った盤面が危険でなくなる手のうち本線が最も残る手

    // ── 対テト §17 E：発火点を縦に露出させる（lv6 のみ。既定0＝無効。設計: lv6-vstet-design.md §17.4）──
    //   盤面の全列におじゃまを exposeRows 個ずつ載せ、発火点の組 G を発火ぷよ exposeMaxKey 個までで撃てるか（＝1段降っても撃てるか）。
    int exposeWeight;      // [86] 1段降っても撃てる組（[73] 段以上・重複なし）ごとに +この値（累積評価）
    int buriedWeight;      // [87] 1段で撃てなくなる組ごとに +この値（負）
    int exposeReachPct;    // [88] 発火ぷよ1個の候補の組が1段で撃てなくなるなら、その点をこの%減らして potChain（到達連鎖）を求める
    int exposeRows;        // [89] 載せる段数（0=1）
    int exposeMaxKey;      // [90] 載せた後の発火ぷよの数の上限（0=2）

    // ── 対テト §18 F：見えている3手を重く・その先を軽く（lv6 のみ。既定0＝無効。設計: lv6-vstet-design.md §18.4・§18.8）──
    int farReachPct;       // [91] 4手目以降（depth ≥ 3）で見えた到達連鎖の点をこの%減らして巻き上げる（0=減らさない）
    int ojamaWorstDepth;   // [92] [77] の「端数の全パターンの最悪」を depth ≤ この値まで行う（0=初手だけ＝従来）
    int ojamaWorstByReach; // [93] 1=最悪のパターンを「降った後に撃てる連鎖（potChain）が最小」で選ぶ（同じなら評価値が最小）／0=評価値が最小
    // ── 対テト §18 G：撃たないと埋まるなら撃つ（安全な反撃。設計: §18.4・§18.8）──
    //   届いているおじゃま（[74]+[75]）を全部相殺できる手があるとき、育成の手の「安全な火力」＝端数の全パターンの最悪で、
    //   降った後の盤面で撃てる連鎖（埋まり具合が [96] 未満のときだけ）と、見えている NEXT 2つで実際に撃てる連鎖の大きい方、を求める。
    int safeFirePct;       // [94] 今撃てる最大 ×100 > 安全な火力 × この値 なら、相殺できる手のうち本線が最も残る手を撃つ（0=使わない）
    int safeMinIncoming;   // [95] G を見る届いている量の下限（個。0=1）
    int safeFillHeight;    // [96] 降った後の平均の高さがこれ以上なら「発火点が生きている」を安全と見ない（0=高さを見ない）
    // ── 対テト §18 G の条件の絞り込み（§18.11 案1・2。既定0＝今と同じ）──
    int safeKeepPct;       // [97] 案1：撃つ手が本線を残す＝撃った後の本線 reachPot ≥ 今の本線 basePot × この%。残さない手は [98] のときだけ撃つ（0=見ない）
    int safeLossPct;       // [98] 案1：本線を残さない手は、育成の手の安全な火力 < basePot × この% （放っておいても本線が埋まる）のときだけ撃つ
    int safeMinHeight;     // [99] 案2：届いている量を全部降らせた後の平均の高さがこれ以上のときだけ G を見る（0=見ない）
    int safeMinCol3;       // [100] 案2：同じく第3列の高さがこれ以上のときだけ（[99] と両方あればどちらか。0=見ない）
};

// JS 側 weightsArray[N]（cpu5_weights.js _buildWeightsArray）→ EvalWeights。
//   wasm エントリ（cpu5.cpp）と学習用ネイティブシミュ（training/puyo-lv5）の両方が使う単一の対応表。
//   weightsArray は 101 要素（[0..100]）。
inline EvalWeights weightsFromArray(const int* weightsArray) {
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
    // ── vsTet / fastVsTet 専用評価値（build/fast では 0）──
    w.puyosWeight         = weightsArray[41];
    w.height3Weight       = weightsArray[42];
    // ── 本線の資源効率（提案3）──
    w.qExcessWeight       = weightsArray[43];
    w.qJunkWeight         = weightsArray[44];
    w.qSubWeight          = weightsArray[45];
    // ── 催促・対応（H1/H2）──
    w.harassMinScore      = weightsArray[46];
    w.harassMaxChains     = weightsArray[47];
    w.harassKeepPct       = weightsArray[48];
    w.counterKeepReach    = weightsArray[49];
    w.harassMinReach      = weightsArray[50];
    // ── 副砲・催促の本線条件（G1/G2）──
    w.subMinMainChains    = weightsArray[51];
    w.subMinMainPuyos     = weightsArray[52];
    w.subMinFill          = weightsArray[53];
    // ── 発火点の保全（提案5 K）──
    w.qKeepWeight         = weightsArray[54];
    w.qKeepDepth          = weightsArray[55];
    w.qKeepRows           = weightsArray[56];
    // ── 地形優先の対応（T）──
    w.counterTerrainOjama = weightsArray[57];
    w.counterTerrainMax   = weightsArray[58];
    w.counterTerrainRate  = weightsArray[59];
    // ── 相手を見て撃つ（提案1 P）──
    w.p1OppScore          = weightsArray[60];
    w.p1Alpha             = weightsArray[61];
    // ── 対テト（A 倒せるか・B 整地だけの1連鎖）──
    w.killScore           = weightsArray[62];
    w.killHoldPct         = weightsArray[63];
    w.killFire            = weightsArray[64];
    w.growthForbidStrict  = weightsArray[65];
    // ── T の条件（§13）──
    w.terrainMinChains    = weightsArray[66];
    w.terrainGainPct      = weightsArray[67];
    // ── 対テト §15（ちぎりの時間・発火点の側面・おじゃまを降らせる探索）──
    w.tearTimeWeight      = weightsArray[68];
    w.tearChainCost       = weightsArray[69];
    w.sideKeepWeight      = weightsArray[70];
    w.sideKeepPeak        = weightsArray[71];
    w.sideKeepFall        = weightsArray[72];
    w.sideKeepMinChains   = weightsArray[73];
    w.ojamaNow            = weightsArray[74];
    w.ojamaNext           = weightsArray[75];
    w.ojamaRate           = weightsArray[76];
    w.ojamaWorst          = weightsArray[77];
    // ── 対テト §17 D 危険度で妥協して撃つ・E 発火点を縦に露出 ──
    w.dangerEmergAfter    = weightsArray[78];
    w.dangerOjamaPct      = weightsArray[79];
    w.dangerLossPct       = weightsArray[80];
    w.dangerMinIncoming   = weightsArray[81];
    w.dangerFireRatio     = weightsArray[82];
    w.dangerOffsetPct     = weightsArray[83];
    w.dangerKeepPct       = weightsArray[84];
    w.dangerReduce        = weightsArray[85];
    w.exposeWeight        = weightsArray[86];
    w.buriedWeight        = weightsArray[87];
    w.exposeReachPct      = weightsArray[88];
    w.exposeRows          = weightsArray[89];
    w.exposeMaxKey        = weightsArray[90];
    // ── 対テト §18 F 見えている3手を重く・G 撃たないと埋まるなら撃つ ──
    w.farReachPct         = weightsArray[91];
    w.ojamaWorstDepth     = weightsArray[92];
    w.ojamaWorstByReach   = weightsArray[93];
    w.safeFirePct         = weightsArray[94];
    w.safeMinIncoming     = weightsArray[95];
    w.safeFillHeight      = weightsArray[96];
    w.safeKeepPct         = weightsArray[97];
    w.safeLossPct         = weightsArray[98];
    w.safeMinHeight       = weightsArray[99];
    w.safeMinCol3         = weightsArray[100];
    return w;
}
