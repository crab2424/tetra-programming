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
            chainBonus:           100,  // 発火時の基本ボーナス（C++側で連鎖の3乗倍などで増幅）
            erasedBonus:           10,  // 消去ぷよ数ボーナス
            zenkeshiBonus:        100,  // 全消しボーナス
            chainPotentialBonus:  200,  // ポテンシャル増加ボーナス（差分）
        };

        this.evalWeights = {
            heightPenalty:         -8,  // 高さペナルティ（毎ターン）
            heightDiffPenalty:    -10,  // 高さ差ペナルティ（毎ターン）

            // ── Ama 由来の評価値（参考: source_assets/puyoAI/ama-beam）──
            //   いずれも加算式・0で無効化可。実機で要チューニング。
            shapeWeight:          -80,  // 理想L字形からの偏差ペナルティ
            wellWeight:           -10,  // 井戸（両隣より低い列）ペナルティ
            bumpWeight:          -500,  // 凸（両隣より高い列）ペナルティ
            qChainWeight:         700,  // quiescence 連鎖ポテンシャル数
            qYWeight:             120,  // quiescence 発火列高さ（高く積める連鎖を評価）
            qKeyWeight:           -30,  // quiescence 必要追加ぷよ数
            qChiWeight:            20,  // quiescence 発火点の伸長余地
            link2Weight:            2,  // 2連結
            link3Weight:            4,  // 3連結（発火直前形に近く価値大）

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
            ignitionScoreThreshold: 1000, // ★ 発火のスコア閾値
            emergencyHeight:       12,  // 緊急回避ライン

            // ── 初手選択：連鎖スコア主体の「同点崩しband」（旧 expChainWeight を流用）──
            //   選択は「到達連鎖スコア chainTarget 最大」が主体（Ama「最終選択は連鎖スコア」）。
            //   このbandは “到達連鎖が最大値からこの差(連鎖スコア単位)以内なら base(構築品質)で選ぶ”
            //   許容幅。0=厳密に連鎖最大のみ（同値は最初の候補）。大きいほど構築品質寄りになる。
            //   ★ TETLABO は内部20NEXT確定保持のため擬似未来ツモ列は不要＝1本の確定NEXTビーム。
            expChainWeight:      1500,  // 同点崩しband（連鎖スコア単位。0=厳密連鎖最大）

            // ── 確定NEXTビームの探索コスト（速度調整）──
            //   コストは概ね expMaxDepth × 幅 に比例。小さくすると軽くなる。
            //   expBranch は擬似分岐撤去により未使用（後方互換のため配線のみ残置）。
            expBranch:             1,  // ※未使用（擬似分岐撤去済み）
            expMaxDepth:           8,  // 確定NEXTビームの深さ 1..8（0=8）
            expBeamWidth:          10,  // depth>=1 のビーム幅（0=従来テーパ）

            // ── Ama 由来の発火枝刈り（PRUNE。参考: ama-beam beam.cpp PRUNE=5000）──
            //   連鎖スコアがこの値以上のノードは、連鎖を記録した上で次層に伝播させない（捨てる）。
            //   発火後の崩れた盤面でビーム枠を浪費せず「組み途中」の盤面に集中させる＝同じ幅で深く探れる。
            //   閾値が低すぎると小さな消えで枝が切れすぎ、高すぎると枝刈りがほぼ効かない（要実機チューニング）。
            //   0 で無効＝従来動作。期待連鎖スコア選択（expChainWeight>0）の探索でのみ作用する。
            pruneChainScore:     3000,  // 発火枝刈り閾値（0=無効）

            // ── eval スコア関数の A/B 切替（核心。参考: ama-beam beam/eval.cpp）──
            //   ★この値が切り替えるのは evaluateBoard 内の「1ノードの盤面スコア関数」だけ。
            //     探索構造（確定NEXTビーム／chainTarget 巻き上げ／後述の fire gate）は
            //     main 経路削除（commit ba18423）以降このフラグに依存せず常に走る。
            //   1 = ama型：calcRewardScore（発火報酬/−5000ペナルティ/chainPotential/緊急/全消し/
            //     おじゃま動的閾値）を使わず、構築品質(quiescence/shape/well/bump/link/side/form)＋
            //     waste だけでスコアリング。発火価値は chainTarget 経由で初手選択に集約。
            //   0 = 旧 eval：calcRewardScore を使う。ただし“従来動作”ではなく「ama探索＋旧eval」の
            //     ハイブリッドになる（旧 main 探索は削除済み）。基本は 1 運用。
            //   ★ama型(1)では expChainWeight を高め（目安50〜）、pruneChainScore を有効値（目安5000）、
            //     wasteWeight を小さな負（目安-2）に設定すること。
            amaEvalMode:           1,  // 1=ama型eval / 0=旧eval(calcRewardScore)。探索構造は不変

            // ── 発火トリガ（fire gate。「いつ撃つか」を初手選択直前で決める）──
            //   ※ amaEvalMode に依存せず常に作用する（build.cpp の初手選択末尾で無条件実行）。
            //   ama型evalは「撃たずに育てる」器なので、これが無いと無限に積み続ける。
            //   初手選択の直前に「今そのまま置けば実発火する連鎖（depth0）」で各初手を測り、
            //   ① 今撃てる連鎖が fireChainCount 段以上、または ② fireEmergency かつ盤面緊急、
            //   のとき『今撃てる最大連鎖の初手』を選ぶ（①は目標段数を満たす中で最大）。
            //   fireChainCount=0 で目標発火を無効化（緊急発火だけにできる）。
            fireChainCount:        8,  // 目標連鎖数。今撃てる連鎖がこの段数以上で発火（0=無効）
            fireEmergency:         2,  // 緊急発火 1/0。盤面緊急時に出せる最大連鎖を即発火
            //   ③ 和集合条件：今撃てる連鎖スコアがこの値以上なら段数未満でも発火（0=無効）。
            //   段数だけだと「段数は浅いが点数の大きい連鎖」を撃ち逃すための補完。
            fireScoreThreshold:   30000,  // 目標発火のスコア閾値（連鎖スコア単位。0=スコア条件 無効）
            // ── 育成こぼし抑制 ──
            //   「育成（撃たず）」と判定された手でも、置いた瞬間に小連鎖を巻き込む（無駄消し）ことがある。
            //   今そのまま置くとこの段数「以上」を発火する初手を育成選択から除外する。
            //   0=無効（従来どおり） / 1=こぼし全面禁止 / 2=1連鎖こぼしまで許容 / 3=2連鎖まで許容 …
            //   band内の全候補がこぼす場合はフィルタを外して再選択する（必ず手は残る）。
            growthFireForbidChains: 2,  // 育成手が発火を許す段数の下限を除外（0=無効/1=全こぼし禁止）

            // ── 緊急発火の発火対象制限（本線を巻き込む部分発火の防止）──
            //   緊急回避(②)は無条件に「今撃てる最大連鎖」を撃つが、本線が未完成だと部分連鎖や
            //   横の暴発で組み上げた本線を巻き込んで壊す。これを潜在比でガードする。
            //   (a) 潜在比ガード：今撃てる最大連鎖が本線潜在(bestChain)のこの割合以上＝本線がほぼ
            //       完成している時のみ緊急発火を許す。0=無効（従来どおり無制限）。
            //       連鎖スコアは段数に対し超線形なので、70 で「本線の最大潜在から約1連鎖以内」が目安。
            emergencyFireMinRatio:  70,  // 緊急発火を許す潜在比(%)（0=無効＝無制限）
            //   (b) 窒息寸前の延命：致死列(第3列)がこの段数以上なら比ガードを無視して延命発火（最終手段）。
            //       可視12段で窒息=12。既定11＝窒息1歩手前。0=最終手段なし（比ガードを常に適用）。
            emergencyHardCol2:      11,  // 延命発火する致死列の高さ（0=最終手段なし）
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
    //       [32]fireChainCount [33]fireEmergency [34]fireScoreThreshold [35]growthFireForbidChains
    //       [36]emergencyFireMinRatio [37]emergencyHardCol2
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
            this.evalWeights.wasteWeight,                            // [31] ama型 waste ペナルティ
            this.controlWeights.fireChainCount,                      // [32] 発火トリガ: 目標連鎖数（0=無効）
            this.controlWeights.fireEmergency,                       // [33] 発火トリガ: 緊急発火 0/1
            this.controlWeights.fireScoreThreshold,                  // [34] 発火トリガ: スコア閾値（和集合。0=無効）
            this.controlWeights.growthFireForbidChains,              // [35] 育成こぼし抑制: 発火段数の除外下限（0=無効）
            this.controlWeights.emergencyFireMinRatio,               // [36] 緊急発火の潜在比ガード(%)（0=無効）
            this.controlWeights.emergencyHardCol2                    // [37] 窒息寸前の延命発火 致死列高（0=なし）
        ]);
    },
});
