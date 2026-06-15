// ─────────────────────────────────────────────
// cpu5_weights.js（重み定義・weightsArray 組立）
//   PuyoCPU5.prototype を拡張する（cpu5.js が class 本体を定義済みであること）。
//
//   _initWeights()       … rewardWeights / evalWeights / controlWeights を初期化
//   _buildWeightsArray() … C++ 側に渡す Int32Array を組み立てる
//
//   ★ 各重みの詳細な意味・由来・チューニング指針は cpu5_weights.md を参照。
//     JS には各値の末尾に1行の要約コメントだけを残す。
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU5.prototype, {

    // ★ 評価パラメータの初期化（3グループの詳細は cpu5_weights.md「重みの3グループ」）。
    //   報酬=配置で現れた変化に1回加算 / 評価値=配置後の盤面を毎ターン評価 / 制御=発火・緊急などの振る舞い。
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

            // ── Ama 由来の評価値（詳細: cpu5_weights.md）。加算式・0で無効化可 ──
            shapeWeight:          -10,  // 理想L字形からの偏差ペナルティ
            wellWeight:           -10,  // 井戸（両隣より低い列）ペナルティ
            bumpWeight:          -500,  // 凸（両隣より高い列）ペナルティ
            qChainWeight:         700,  // quiescence 連鎖ポテンシャル数
            qYWeight:             120,  // quiescence 発火列高さ（高く積める連鎖を評価）
            qKeyWeight:           -30,  // quiescence 必要追加ぷよ数
            qChiWeight:            20,  // quiescence 発火点の伸長余地
            link2Weight:            2,  // 2連結
            link3Weight:            4,  // 3連結（発火直前形に近く価値大）

            // ── quiescence remain の連結数（次連鎖の種。詳細: cpu5_weights.md）──
            qLink2Weight:           4,  // quiescence remain の2連結
            qLink3Weight:          12,  // quiescence remain の3連結（次連鎖の種）

            sideWeight:             0,  // 致死列(第3列) side bias（0で無効。詳細: cpu5_weights.md）

            tearWeight:           -20,  // ちぎりペナルティ（負。0で無効。詳細: cpu5_weights.md）

            wasteWeight:           -2,  // ama型 waste ペナルティ（負。amaEvalMode=1 のみ作用。詳細: cpu5_weights.md）

            formWeight:            50,  // 関係性 form 一致(GTR/SGTR/FRON)（0で無効。詳細: cpu5_weights.md）

            // ── 3連結の形状別倍率（百分率。link3Weight/qLink3Weight に共通で乗る。詳細: cpu5_weights.md）──
            link3FacL:            100,  // L字（折れ）  ×1.0
            link3FacH:            100,  // 横一直線      ×1.0
            link3FacV:             30,  // 縦一直線      ×0.6
        };

        this.controlWeights = {
            p1Weight:             100,  // 1手目の重み係数
            ignitionThreshold:     10,  // 発火閾値（旧eval=amaEvalMode=0専用。ama型では未参照。詳細: cpu5_weights.md）
            ignitionScoreThreshold: 1000, // 発火スコア閾値（旧eval専用。ama型では未参照。詳細: cpu5_weights.md）
            emergencyHeight:       12,  // 緊急回避ライン

            // ── 初手選択：連鎖スコア主体の「同点崩しband」（詳細: cpu5_weights.md）──
            expChainWeight:      1500,  // 同点崩しband（連鎖スコア単位。0=厳密連鎖最大）

            // ── 確定NEXTビームの探索コスト（速度調整。詳細: cpu5_weights.md）──
            expBranch:             1,  // ※未使用（擬似分岐撤去済み・配線のみ残置）
            expMaxDepth:           8,  // 確定NEXTビームの深さ 1..8（0=8）
            expBeamWidth:          10,  // depth>=1 のビーム幅（0=従来テーパ）

            pruneChainScore:     3000,  // 発火枝刈り(PRUNE)閾値（0=無効。詳細: cpu5_weights.md）

            // ── eval スコア関数の A/B 切替（核心。詳細: cpu5_weights.md）──
            amaEvalMode:           1,  // 1=ama型eval / 0=旧eval(calcRewardScore)。探索構造は不変

            // ── 発火トリガ（fire gate。「いつ撃つか」を初手選択直前で決める。詳細: cpu5_weights.md）──
            fireChainCount:       12,  // 目標連鎖数。今撃てる連鎖がこの段数以上で発火（0=無効）
            fireEmergency:         2,  // 緊急発火 1/0。盤面緊急時に出せる最大連鎖を即発火
            fireScoreThreshold:   50000,  // 和集合：この連鎖スコア以上なら段数未満でも発火（0=無効）
            growthFireForbidChains: 2,  // 育成こぼし抑制：発火を許す段数の下限を除外（0=無効/1=全こぼし禁止。詳細: cpu5_weights.md）

            // ── 緊急発火の発火対象制限（本線巻き込み防止。詳細: cpu5_weights.md）──
            emergencyFireMinRatio:  70,  // 緊急発火を許す潜在比(%)（0=無効＝無制限）
            emergencyHardCol2:      11,  // 窒息寸前の延命発火する致死列の高さ（0=最終手段なし）
        };

        // 後方互換のため旧 this.weights も参照可能にしておく（読み取り専用エイリアス）
        // weightsArray への組み立ては _buildWeightsArray() で行う
        this.weights = Object.assign({},
            this.rewardWeights,
            this.evalWeights,
            this.controlWeights
        );

        // ── モード別プロファイルの土台（詳細: cpu5_weights.md「モードプロファイル」）──
        //   ここまでの値を build の基準値として退避し、setMode() が「基準値へ復帰→差分上書き」する。
        this._buildBaseline = {
            rewardWeights:  Object.assign({}, this.rewardWeights),
            evalWeights:    Object.assign({}, this.evalWeights),
            controlWeights: Object.assign({}, this.controlWeights),
        };
        this.cpuMode = 'build';
    },

    // ★ モード別プロファイル（build からの差分上書き定義。詳細: cpu5_weights.md「モードプロファイル」）。
    //   build=基準（差分なし）/ fast=速攻型。JS 重みのみで表現し native 探索は build と共通（searchBuildMode）。
    //   ⚠️ 値はすべて暫定＝実機で要チューニング（[[feedback-versus-cpu-verification]]）。
    _modeProfiles() {
        return {
            // build：従来どおりの本線構築（基準値・差分なし）。相手がぷよ／ソロ時の既定。
            build: {},

            // vsTet：相手がテトのときの本線構築（詳細: cpu5_weights.md）。
            //   ★ まずはモード分岐のみ＝現状 build と同一（差分なし）。
            //     今後テト相手向け（おじゃま着弾の早さ・攻撃ゲージ特性）にチューニングする。
            vsTet: {},

            // fast：速攻型（「多少汚くても浅い連鎖を速く返す」。詳細: cpu5_weights.md）。
            fast: {
                evalWeights: {
                    qChainWeight:  350,  // 700 ×0.5：連鎖規模への執着を半減
                    qYWeight:       40,  // 120 ×0.27：発火点を高く積まない（速攻の核）
                    qChiWeight:     11,  // 20  ×0.54：伸長余地の重視を下げる
                    link2Weight:     1,  // 2   ×0.37
                    link3Weight:     2,  // 4   ×0.59
                    qLink2Weight:    2,  // 4   ×0.37：remain の種仕込みを軽く
                    qLink3Weight:    7,  // 12  ×0.59
                    shapeWeight:    -1,  // -10 ×0.08：理想L字の強制をほぼ解除
                    wellWeight:     -1,  // -10 ×0.05：井戸ペナルティを緩和
                    bumpWeight:    -25,  // -500×0.05：凸ペナルティを大幅緩和（速く積む）
                    tearWeight:     -8,  // -20 ×0.42：ちぎりを許容して速度優先
                    formWeight:      0,  // ama fast は form を持たない（build 専用）
                },
                controlWeights: {
                    fireChainCount:          3,  // 3連鎖以上が撃てれば発火（12→3：早撃ち）
                    fireScoreThreshold:   3000,  // 浅いが点の出る連鎖も拾う（50000→3000）
                    growthFireForbidChains:  0,  // 速攻ではこぼし（小連鎖）を抑制しない
                    emergencyFireMinRatio:   0,  // 守るべき本線が無いので緊急発火を絞らない
                },
            },
        };
    },

    // ★ CPU のモードを切り替える（build 基準値へ復帰してから差分を上書き）。
    //   例: cpuInstance.setMode('fast') / setMode('build')。
    //   未知のモード名は build へフォールバックする。
    setMode(mode) {
        if (!this._buildBaseline) this._initWeights();
        const profiles = this._modeProfiles();
        const known    = Object.prototype.hasOwnProperty.call(profiles, mode);
        const prof     = known ? profiles[mode] : profiles.build;

        this.rewardWeights  = Object.assign({}, this._buildBaseline.rewardWeights,  prof.rewardWeights  || {});
        this.evalWeights    = Object.assign({}, this._buildBaseline.evalWeights,    prof.evalWeights    || {});
        this.controlWeights = Object.assign({}, this._buildBaseline.controlWeights, prof.controlWeights || {});
        this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);

        this.cpuMode = known ? mode : 'build';
        return this.cpuMode;
    },

    // ★ 既知NEXT本数（knownNextCount）を受け取り、C++ 側 weightsArray[N] と対応する Int32Array を組み立てて返す。
    //   インデックス順は下の各行末 [N] と一致させること（全体表は cpu5_weights.md「weightsArray」）。
    //   発火閾値[7]/[9]の動的調整撤去の経緯も cpu5_weights.md を参照。
    _buildWeightsArray(knownNextCount) {
        return new Int32Array([
            this.rewardWeights.chainBonus,                             // [0]
            this.rewardWeights.erasedBonus,                            // [1]
            this.evalWeights.heightPenalty,                            // [2]
            this.evalWeights.heightDiffPenalty,                        // [3]
            this.rewardWeights.zenkeshiBonus,                          // [4]
            this.rewardWeights.chainPotentialBonus,                    // [5]
            this.controlWeights.p1Weight,                              // [6]
            this.controlWeights.ignitionThreshold,                     // [7] 旧eval(amaEvalMode=0)専用。ama型では未参照
            this.controlWeights.emergencyHeight,                       // [8]
            this.controlWeights.ignitionScoreThreshold,                // [9] 旧eval(amaEvalMode=0)専用。ama型では未参照
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
            this.controlWeights.emergencyHardCol2,                   // [37] 窒息寸前の延命発火 致死列高（0=なし）
            this.evalWeights.link3FacL,                              // [38] 3連結 L字の倍率(%)
            this.evalWeights.link3FacH,                              // [39] 3連結 横一直線の倍率(%)
            this.evalWeights.link3FacV                               // [40] 3連結 縦一直線の倍率(%)
        ]);
    },
});
