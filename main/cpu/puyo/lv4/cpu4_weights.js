// ─────────────────────────────────────────────
// cpu4_weights.js（重み定義・テンプレート・weightsArray 組立）
//   PuyoCPU4.prototype を拡張する（cpu4.js が class 本体を定義済みであること）。
//
//   _initWeights()       … rewardWeights / evalWeights / controlWeights / TEMPLATE_PATTERNS を初期化
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
            templateBonus:        0,  // テンプレート一致ボーナス（差分）
        };

        this.evalWeights = {
            heightPenalty:       -100,  // 高さペナルティ（毎ターン）
            heightDiffPenalty:     -8,  // 高さ差ペナルティ（毎ターン）
            flatBonus:              0,  // 平坦ボーナス（毎ターン）
            colorConnBonus:         0,  // 同色隣接ボーナス（毎ターン）

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

            // ── Ama 関係性 form テンプレート（GTR/SGTR/FRON の相対マッチ）──
            //   旧 templateBonus(絶対行固定)の上位版。0 で無効。Ama build は 50。
            //   ※純粋に Ama 方式へ寄せたい場合は rewardWeights.templateBonus を 0 にする。
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
            expChainWeight:        2,  // 期待連鎖スコアの重み（0で無効）

            // ── 期待連鎖スコア選択の探索コスト（速度調整。expChainWeight>0 のとき有効）──
            //   コストは概ね expBranch × expMaxDepth × 幅 に比例。小さくすると軽くなる。
            //   いずれも 0 で「従来の重い設定」(branch6 / depth8 / 幅テーパ12,8,6,5)。
            //   ≈15ms を狙うなら下記の軽量プリセットが目安（実機で要計測）。
            expBranch:             1,  // 擬似未来ツモ列の本数 1..6（0=6）
            expMaxDepth:           6,  // 期待連鎖探索の深さ 1..8（0=8）
            expBeamWidth:          5,  // depth>=1 のビーム幅（0=従来テーパ）

            // ── 通常ビーム探索の速度調整（expChainWeight==0 のときの本命経路）──
            //   NEXTは内部で20本確定しているため擬似ツモ分岐は不要。これは現在ペア＋NEXT9本=
            //   10ペアを使う純粋な確定先読み。約50ms→軽量化の主レバーはこの深さ。
            //   いずれも 0 で従来設定（深さ10 / 幅テーパ10,8,6,4）。
            //   node実測の目安: d10≈55ms / d8≈40 / d6≈28 / d6w4≈22 / d5w4≈18 / d4w4≈13。
            //   強さ重視なら深さ/幅を上げる（実機で要計測）。
            mainMaxDepth:          5,  // 確定先読みの深さ 1..10（0=10）。約15ms狙いで5
            mainBeamWidth:         4,  // depth>=1 のビーム幅（0=従来テーパ8,6,4）
        };

        // 後方互換のため旧 this.weights も参照可能にしておく（読み取り専用エイリアス）
        // weightsArray への組み立ては _buildWeightsArray() で行う
        this.weights = Object.assign({},
            this.rewardWeights,
            this.evalWeights,
            this.controlWeights
        );

        this.TEMPLATE_PATTERNS = {
            'gtr': [
                4, 4, 4, 0, 0, 0,  // 盤面の上から数えて一番上の行は空洞（GTRは下3段で組むため）
                2, 1, 3, 4, 6, 6,
                2, 2, 1, 3, 4, 4,
                1, 1, 3, 4, 6, 6
            ],
            'key': [
                1, 2, 3, 4, 5, 0,
                2, 3, 4, 5, 1, 0,
                1, 2, 3, 4, 5, 0,
                1, 2, 3, 4, 5, 0,
            ],
        };
    },

    // ★ おじゃま数（ojamaCount）と既知NEXT本数（knownNextCount）を受け取り、
    //   C++ 側 weightsArray[N] と対応する Int32Array を組み立てて返す。
    //
    // weightsArray のインデックス順は C++ 側の weightsArray[N] と対応している。
    // 順序: [0]chainBonus [1]erasedBonus [2]heightPenalty [3]heightDiffPenalty
    //       [4]flatBonus [5]colorConnBonus [6]zenkeshiBonus [7]chainPotentialBonus
    //       [8]p1Weight [9]templateBonus [10]ignitionThreshold [11]emergencyHeight
    //       [12]ignitionScoreThreshold
    //       [13]shape [14]well [15]bump [16]qChain [17]qY [18]qKey [19]qChi [20]link2 [21]link3
    //       [22]expChain [23]knownNextCount [24]form
    //       [25]expBranch [26]expMaxDepth [27]expBeamWidth
    //       [28]mainMaxDepth [29]mainBeamWidth
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
            this.evalWeights.flatBonus,                                // [4]
            this.evalWeights.colorConnBonus,                           // [5]
            this.rewardWeights.zenkeshiBonus,                          // [6]
            this.rewardWeights.chainPotentialBonus,                    // [7]
            this.controlWeights.p1Weight,                              // [8]
            this.templateActive ? this.rewardWeights.templateBonus : 0,// [9]
            dynamicIgnitionThreshold,                                  // [10] ★ 動的閾値
            this.controlWeights.emergencyHeight,                       // [11]
            dynamicIgnitionScoreThreshold,                             // [12] ★ 動的スコア閾値
            this.evalWeights.shapeWeight,                             // [13]
            this.evalWeights.wellWeight,                              // [14]
            this.evalWeights.bumpWeight,                              // [15]
            this.evalWeights.qChainWeight,                           // [16]
            this.evalWeights.qYWeight,                               // [17]
            this.evalWeights.qKeyWeight,                             // [18]
            this.evalWeights.qChiWeight,                             // [19]
            this.evalWeights.link2Weight,                            // [20]
            this.evalWeights.link3Weight,                            // [21]
            this.controlWeights.expChainWeight,                      // [22] 期待連鎖スコア選択の重み
            knownNextCount,                                          // [23] 既知NEXT本数
            this.evalWeights.formWeight,                             // [24] 関係性 form テンプレート
            this.controlWeights.expBranch,                           // [25] 期待連鎖: 擬似ツモ本数
            this.controlWeights.expMaxDepth,                         // [26] 期待連鎖: 探索深さ
            this.controlWeights.expBeamWidth,                        // [27] 期待連鎖: ビーム幅
            this.controlWeights.mainMaxDepth,                        // [28] 通常ビーム: 探索深さ
            this.controlWeights.mainBeamWidth                        // [29] 通常ビーム: ビーム幅
        ]);
    },
});
