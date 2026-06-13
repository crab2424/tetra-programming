// ─────────────────────────────────────────────
// cpu4_weights.js（重み定義・weightsArray 組立）
//   PuyoCPU4.prototype を拡張する（cpu4.js が class 本体を定義済みであること）。
//
//   _initWeights()       … rewardWeights / evalWeights / controlWeights を初期化
//   _buildWeightsArray() … おじゃま数に応じた動的閾値を反映し、C++ 側に渡す Int32Array を組み立てる
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU4.prototype, {

    // ────────────────────────────────
    // ★ 評価パラメータの初期化
    //
    // 【報酬 (rewardWeights)】
    //   配置前後の盤面を比較し、配置後にのみ現れた変化に対して1回だけ加算する。
    //
    // 【評価値 (evalWeights)】
    //   配置後の盤面状態をそのまま毎ターン評価する。
    //
    // 【制御パラメータ (controlWeights)】
    //   発火閾値・緊急ラインなど、評価の振る舞いを制御するパラメータ。
    // ────────────────────────────────
    _initWeights() {
        this.rewardWeights = {
            chainBonus:           300,  // 発火時の基本ボーナス（C++側で連鎖の3乗倍などで増幅）
            erasedBonus:           10,  // 消去ぷよ数ボーナス
            zenkeshiBonus:        100,  // 全消しボーナス
            chainPotentialBonus:  200,  // ポテンシャル増加ボーナス（差分）
        };

        this.evalWeights = {
            heightPenalty:       -100,  // 高さペナルティ（毎ターン）
            heightDiffPenalty:     -8,  // 高さ差ペナルティ（毎ターン）

            // ── Ama 由来の評価値（参考: source_assets/puyoAI/ama-beam）──
            //   いずれも加算式・0で無効化可。実機で要チューニング。
            shapeWeight:           -8,  // 理想L字形からの偏差ペナルティ
            wellWeight:           -10,  // 井戸（両隣より低い列）ペナルティ
            bumpWeight:           -10,  // 凸（両隣より高い列）ペナルティ
            qChainWeight:          60,  // quiescence 連鎖ポテンシャル数
            qYWeight:              12,  // quiescence 発火列高さ（高く積める連鎖を評価）
            qKeyWeight:           -30,  // quiescence 必要追加ぷよ数
            qChiWeight:            20,  // quiescence 発火点の伸長余地
            link2Weight:            6,  // 2連結
            link3Weight:           30,  // 3連結（発火直前形に近く価値大）

            // ── quiescence 発火直前盤面(remain)の連結数（Ama eval.cpp:62-65）──
            //   発火直前の形に次連鎖の種がどれだけ仕込まれているかを評価。0で無効。
            //   暫定値（要チューニング）。Ama build 比(link_2:150/link_3:250)を qChain 縮尺に合わせて縮小。
            qLink2Weight:           4,  // quiescence remain の2連結
            qLink3Weight:          12,  // quiescence remain の3連結（次連鎖の種）

            // ── 致死列(第3列)bias（Ama eval.cpp:99-102）──
            //   max(左2列和,右3列和)-heights[2] に乗じる。正で「3列目を周囲より低く保つ」誘導。
            //   lv4 は別途 heights[2] の絶対ペナルティ(calcEvalScore冒頭)も持つので、これは相対的な補助。
            //   0 で無効（Ama build プロファイルも 0）。使う場合の目安は小さめの正値。
            sideWeight:             0,  // 致死列 side bias（0で無効）

            // ── ちぎり(tear)ペナルティ（Ama beam/eval.cpp:105 node.score.action += tear*w.tear）──
            //   横置きで2列に分かれてバラバラに落ちる配置に、配置時1回だけ加算（負＝ちぎり回避）。
            //   Ama build 比 -250 を lv4 の縮尺（link3 250→qLink3 12 ≒ 1/20）に合わせ小さく。
            //   ちぎりは連鎖構築上やむを得ない場合もあるので強くしすぎない。0 で無効。実機で要チューニング。
            tearWeight:           -20,  // ちぎりペナルティ（負。0で無効）

            // ── ama 型 eval の waste ペナルティ（amaEvalMode=1 のときのみ作用）──
            //   消したぷよ数(chain.totalErased)に乗じる小さな負値。組み途中の無駄な小発火を弱く抑制。
            //   ama beam/eval.cpp: node.score.action += waste * w.waste。強くしすぎると発火自体を嫌う。
            wasteWeight:           -2,  // ama型 waste ペナルティ（負）

            // ── Ama 関係性 form テンプレート（GTR/SGTR/FRON の相対マッチ）──
            //   0 で無効。Ama build は 50。
            formWeight:            50,  // 関係性 form 一致スコア
        };

        this.controlWeights = {
            p1Weight:             100,  // 1手目の重み係数
            ignitionThreshold:     10,  // 基本の発火閾値（おじゃまが少ない場合）
            ignitionScoreThreshold: 30000, // ★ 発火のスコア閾値
            emergencyHeight:       11,  // 緊急回避ライン

            // ── Ama search_multi 由来：期待連鎖スコア選択（核心①）──
            //   0 で無効（従来の累積eval最大選択）。正の値で、各初手が将来到達できる
            //   最大連鎖スコア（6本の擬似未来ツモ列で合算した期待値）を初手選択に上乗せする。
            //   ※有効時は擬似ツモ列の本数ぶん探索が重くなる（実機で遅延を要計測）。
            expChainWeight:        50,  // 期待連鎖スコアの重み（0で無効）

            // ── 期待連鎖スコア選択の探索コスト（速度調整。expChainWeight>0 のとき有効）──
            //   コストは概ね expBranch × expMaxDepth × 幅 に比例。小さくすると軽くなる。
            //   いずれも 0 で「従来の重い設定」(branch6 / depth8 / 幅テーパ12,8,6,5)。
            //   ≈15ms を狙うなら下記の軽量プリセットが目安（実機で要計測）。
            expBranch:             1,  // 擬似未来ツモ列の本数 1..6（0=6）
            expMaxDepth:           8,  // 期待連鎖探索の深さ 1..8（0=8）
            expBeamWidth:          10,  // depth>=1 のビーム幅（0=従来テーパ）

            // ── Ama 由来の発火枝刈り（PRUNE。参考: ama-beam beam.cpp PRUNE=5000）──
            //   連鎖スコアがこの値以上のノードは、連鎖を記録した上で次層に伝播させない（捨てる）。
            //   発火後の崩れた盤面でビーム枠を浪費せず「組み途中」の盤面に集中させる＝同じ幅で深く探れる。
            //   閾値が低すぎると小さな消えで枝が切れすぎ、高すぎると枝刈りがほぼ効かない（要実機チューニング）。
            //   0 で無効＝従来動作。期待連鎖スコア選択（expChainWeight>0）の探索でのみ作用する。
            pruneChainScore:      10,  // 発火枝刈り閾値（0=無効）

            // ── Ama 型 eval への A/B 切替（核心。参考: ama-beam beam/eval.cpp）──
            //   1 にすると evaluateBoard が calcRewardScore（発火報酬/−5000ペナルティ/chainPotential/
            //   緊急/全消し/おじゃま動的閾値）を一切使わず、構築品質(quiescence/shape/well/bump/link/
            //   side/form)＋waste だけでビームを駆動する。発火価値は expSum 経由で初手選択に集約。
            //   ★ama型を有効化するときは expChainWeight を高め（目安50〜）にし、pruneChainScore を
            //     有効値（目安5000）、wasteWeight を小さな負（目安-2）に設定すること。
            //   0 = 従来動作（完全不変）。緊急回避/全消し/おじゃま動的発火は ama 型では無効になる。
            amaEvalMode:           1,  // 0=現行eval / 1=ama型（構築品質のみで駆動）
        };

        // 後方互換のため旧 this.weights も参照可能にしておく（読み取り専用エイリアス）
        // weightsArray への組み立ては _buildWeightsArray() で行う
        this.weights = Object.assign({},
            this.rewardWeights,
            this.evalWeights,
            this.controlWeights
        );
    },

    // ★ おじゃま数（ojamaCount）と既知NEXT本数（knownNextCount）を受け取り、
    //   C++ 側 weightsArray[N] と対応する Int32Array を組み立てて返す。
    //
    // weightsArray のインデックス順は C++ 側の weightsArray[N] と対応している。
    // 順序: [0]chainBonus [1]erasedBonus [2]heightPenalty [3]heightDiffPenalty
    //       [4]zenkeshiBonus [5]chainPotentialBonus
    //       [6]p1Weight [7]ignitionThreshold [8]emergencyHeight
    //       [9]ignitionScoreThreshold
    //       [10]shape [11]well [12]bump [13]qChain [14]qY [15]qKey [16]qChi [17]link2 [18]link3
    //       [19]expChain [20]knownNextCount [21]form
    //       [22]expBranch [23]expMaxDepth [24]expBeamWidth
    //       [25]qLink2 [26]qLink3 [27]side [28]tear
    //       [29]pruneChainScore [30]amaEvalMode [31]wasteWeight
    _buildWeightsArray(ojamaCount, knownNextCount) {
        // ★ おじゃまぷよの数に応じて発火閾値を動的に変更
        let dynamicIgnitionThreshold = this.controlWeights.ignitionThreshold;
        let dynamicIgnitionScoreThreshold = this.controlWeights.ignitionScoreThreshold;
        if (ojamaCount >= 15) {
            dynamicIgnitionThreshold = 2; // 15個以上で2連鎖妥協
            dynamicIgnitionScoreThreshold = 320;
        } else if (ojamaCount >= 10) {
            dynamicIgnitionThreshold = 4; // 10個以上で4連鎖妥協
            dynamicIgnitionScoreThreshold = 2000;
        } else if (ojamaCount >= 5) {
            dynamicIgnitionThreshold = 6; // 5個以上で6連鎖妥協
            dynamicIgnitionScoreThreshold = 8000;
        }

        return new Int32Array([
            this.rewardWeights.chainBonus,                             // [0]
            this.rewardWeights.erasedBonus,                            // [1]
            this.evalWeights.heightPenalty,                            // [2]
            this.evalWeights.heightDiffPenalty,                        // [3]
            this.rewardWeights.zenkeshiBonus,                          // [4]
            this.rewardWeights.chainPotentialBonus,                    // [5]
            this.controlWeights.p1Weight,                              // [6]
            dynamicIgnitionThreshold,                                  // [7] ★ 動的閾値
            this.controlWeights.emergencyHeight,                       // [8]
            dynamicIgnitionScoreThreshold,                             // [9] ★ 動的スコア閾値
            this.evalWeights.shapeWeight,                             // [10]
            this.evalWeights.wellWeight,                              // [11]
            this.evalWeights.bumpWeight,                              // [12]
            this.evalWeights.qChainWeight,                           // [13]
            this.evalWeights.qYWeight,                               // [14]
            this.evalWeights.qKeyWeight,                             // [15]
            this.evalWeights.qChiWeight,                             // [16]
            this.evalWeights.link2Weight,                            // [17]
            this.evalWeights.link3Weight,                            // [18]
            this.controlWeights.expChainWeight,                      // [19] 期待連鎖スコア選択の重み
            knownNextCount,                                          // [20] 既知NEXT本数
            this.evalWeights.formWeight,                             // [21] 関係性 form テンプレート
            this.controlWeights.expBranch,                           // [22] 期待連鎖: 擬似ツモ本数
            this.controlWeights.expMaxDepth,                         // [23] 期待連鎖: 探索深さ
            this.controlWeights.expBeamWidth,                        // [24] 期待連鎖: ビーム幅
            this.evalWeights.qLink2Weight,                           // [25] quiescence remain の2連結
            this.evalWeights.qLink3Weight,                           // [26] quiescence remain の3連結
            this.evalWeights.sideWeight,                             // [27] 致死列 side bias
            this.evalWeights.tearWeight,                             // [28] ちぎりペナルティ
            this.controlWeights.pruneChainScore,                     // [29] 発火枝刈り閾値（0=無効）
            this.controlWeights.amaEvalMode,                         // [30] ama型eval切替（0/1）
            this.evalWeights.wasteWeight                             // [31] ama型 waste ペナルティ
        ]);
    },
});
