// ─────────────────────────────────────────────
// cpu5_weights.js（重み定義・weightsArray 組立）
//   PuyoCPU5.prototype を拡張する（cpu5.js が class 本体を定義済みであること）。
//
//   _initWeights()       … rewardWeights / evalWeights / controlWeights を初期化
//   setMode()            … build 基準値へ復帰 → モード差分を上書き
//   _buildWeightsArray() … C++ 側に渡す Int32Array を組み立てる
//
//   ★ モード別差分（build からの上書き）の定義は cpu5_modes.js（同 weights/）。
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

            formWeight:            80,  // 関係性 form 一致(GTR/SGTR/FRON)（0で無効。詳細: cpu5_weights.md）

            // ── 3連結の形状別倍率（百分率。link3Weight/qLink3Weight に共通で乗る。詳細: cpu5_weights.md）──
            link3FacL:            100,  // L字（折れ）  ×1.0
            link3FacH:            100,  // 横一直線      ×1.0
            link3FacV:             30,  // 縦一直線      ×0.6

            // ── vsTet / fastVsTet 専用（build/fast 基準は 0＝無効。値は cpu5_modes.js で上書き）──
            //   ★ base が 0 のため、モード差分は { x:倍率 } ではなく絶対値で書くこと（0×倍率=0）。
            puyosWeight:            0,  // 盤面のぷよ量（おじゃま除く）ボーナス（正）。詳細: cpu5_weights.md
            height3Weight:          0,  // 致死列(第3列)高さ>4 の超過ペナルティ（負）。詳細: cpu5_weights.md

            // ── 本線の資源効率（提案3。0＝無効。lv5 は使わない。詳細: cpu5_weights.md）──
            //   ★ base が 0 のため、モード差分は { x:倍率 } ではなく絶対値で書くこと（0×倍率=0）。
            qExcessWeight:          0,  // 潜在連鎖の途中段の余剰（同時消し・多連結）1個あたり（負）
            qJunkWeight:            0,  // ゴミ（本線にも副砲にも使わない色ぷよ）×埋まり具合 1個あたり（負）。E2a
            qSubWeight:             0,  // 副砲（本線と交わらず本線を落とさない連鎖）のおじゃま1個あたり（正）。E2b
            // ── 副砲・催促の本線条件（G1/G2。0＝条件なし。lv6-harass-design.md §10.3）──
            subMinMainChains:       0,  // E2b を足す本線の段数の下限（H1 の「撃った後の本線の段数」にも使う）
            subMinMainPuyos:        0,  // E2b を足す本線の色ぷよ数の下限
            subMinFill:             0,  // E2b を足す盤面の色ぷよ数の下限（埋まり具合）
            // ── 発火点の保全（提案5 K。0＝無効。lv6-harass-design.md §13.4）──
            qKeepWeight:            0,  // おじゃまを1段載せた仮の盤面で起こせる最大連鎖のおじゃま量 1個あたり（正）
            qKeepDepth:             0,  // K を掛けるビームの深さ（深さ < この値だけ。0＝全部の深さ）
            qKeepRows:              0,  // 載せるおじゃまの段数（0＝1段）
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

            // ── 催促・対応（H1/H2。0＝無効。lv5 は使わない。詳細: cpu5_weights.md）──
            //   ★ base が 0 のため、モード差分は { x:倍率 } ではなく絶対値で書くこと（0×倍率=0）。
            //   ★ 実際に wasm へ渡すかは cpu5_worker_io.js が思考ごとに決める（_harassMinScore / _counterKeepReachOn）。
            harassMinOjama:         0,  // H1 催促：今撃てる小連鎖がこのおじゃま個数以上なら撃つ候補（0=無効）
            harassMaxChains:        0,  // H1 催促：撃つ連鎖の段数の上限
            harassKeepPct:          0,  // H1 催促：撃った後の本線潜在が今の本線潜在のこの%以上のときだけ撃つ
            counterKeepReach:       0,  // H2 対応：カウンターは本線を最も残す手で返す（0=点が最大の手 / 1=本線最大・同点は点大 / 2=同点は点小 / 3=本線最大から5%以内で点最小）
            harassMinReach:         0,  // H1 催促：撃った後の本線潜在がこのおじゃま個数以上のときだけ撃つ
            // ── 地形優先の対応（T。0＝無効。lv6-harass-design.md §13.5）──
            counterTerrainMax:      0,  // 受け量がこの個数以下のカウンターは fast に入らず、降った後の地形が最大の手（受ける・軽減・返す）を選ぶ
            // ── 相手を見て撃つ（提案1 P。0＝無効。lv6-harass-design.md §13.6）──
            p1Alpha:                0,  // 目標発火は「撃つ点 ≥ p1Alpha% × 相手のすぐ起こせる火力」のときだけ（届かなければ保留して伸ばす）
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

    // ★ build 基準値へ差分グループを適用する内部ヘルパー。
    //   差分の値の書き方は2通り（詳細: cpu5_modes.js 冒頭・cpu5_weights.md「モードプロファイル」）:
    //     ・数値          … その絶対値で上書き（閾値系: fireChainCount:3 など）
    //     ・{ x: 倍率 }    … base値 × 倍率を四捨五入して上書き（評価重み: { x:0.5 } など）。
    //                        base が変われば追従し、倍率がそのまま設計意図になる（コメント陳腐化を防ぐ）。
    _applyModeGroup(baseGroup, diffGroup) {
        const out = Object.assign({}, baseGroup);
        for (const key in (diffGroup || {})) {
            const v = diffGroup[key];
            if (v && typeof v === 'object' && typeof v.x === 'number') {
                out[key] = Math.round((baseGroup[key] || 0) * v.x);
            } else {
                out[key] = v;
            }
        }
        return out;
    },

    // ★ CPU のモードを切り替える（build 基準値へ復帰してから差分を上書き）。
    //   例: cpuInstance.setMode('fast') / setMode('build')。
    //   差分定義は _modeProfiles()（cpu5_modes.js）。未知のモード名は build へフォールバックする。
    setMode(mode) {
        if (!this._buildBaseline) this._initWeights();
        const profiles = this._modeProfiles();
        const known    = Object.prototype.hasOwnProperty.call(profiles, mode);
        const prof     = known ? profiles[mode] : profiles.build;

        this.rewardWeights  = this._applyModeGroup(this._buildBaseline.rewardWeights,  prof.rewardWeights);
        this.evalWeights    = this._applyModeGroup(this._buildBaseline.evalWeights,    prof.evalWeights);
        this.controlWeights = this._applyModeGroup(this._buildBaseline.controlWeights, prof.controlWeights);
        this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);

        this.cpuMode = known ? mode : 'build';
        this._applyModeOverrides(this.cpuMode);
        return this.cpuMode;
    },

    // ★ 重み調整パネルでモード（vsTet / fastVsTet）ごとに変えた値を、組み上がった重みへ名前で上書きする。
    //   setMode の最後に呼ぶ（lv6 は VS_TET を載せた後にもう一度呼ぶ）。何度呼んでも同じ結果。
    _applyModeOverrides(mode) {
        const ov = this._modeOverrides && this._modeOverrides[mode];
        if (!ov) return;
        let hit = false;
        for (const k in ov) {
            const g = (k in this.controlWeights) ? 'controlWeights' : (k in this.rewardWeights) ? 'rewardWeights' : 'evalWeights';
            if (!hit) { this.rewardWeights = Object.assign({}, this.rewardWeights); this.evalWeights = Object.assign({}, this.evalWeights); this.controlWeights = Object.assign({}, this.controlWeights); hit = true; }
            this[g][k] = ov[k];
        }
        if (hit) this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);
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
            this.evalWeights.link3FacV,                              // [40] 3連結 縦一直線の倍率(%)
            this.evalWeights.puyosWeight,                            // [41] vsTet/fastVsTet 専用: ぷよ量ボーナス（buildは0）
            this.evalWeights.height3Weight,                          // [42] vsTet/fastVsTet 専用: 致死列高さ>4 ペナルティ（buildは0）
            this.evalWeights.qExcessWeight,                          // [43] 潜在連鎖の途中段の余剰ペナルティ（0=無効）
            this.evalWeights.qJunkWeight,                            // [44] ゴミ×埋まり具合のペナルティ（0=無効）
            this.evalWeights.qSubWeight,                             // [45] 副砲のおじゃま量ボーナス（0=無効）
            this._harassMinScore || 0,                               // [46] H1 催促の最低点（思考ごと。0=撃たない）
            this.controlWeights.harassMaxChains,                     // [47] H1 催促の段数上限
            this.controlWeights.harassKeepPct,                       // [48] H1 撃った後に残す本線潜在(%)
            this._counterKeepReachOn || 0,                           // [49] H2 カウンターで本線を残す手を選ぶ（思考ごと。0..3）
            this._harassMinReachScore || 0,                          // [50] H1 撃った後に残す本線潜在の点（思考ごと）
            this.evalWeights.subMinMainChains || 0,                  // [51] G1 副砲・催促の本線段数の下限（0=条件なし）
            this.evalWeights.subMinMainPuyos || 0,                   // [52] G1 副砲の本線色ぷよ数の下限
            this.evalWeights.subMinFill || 0,                        // [53] G2 副砲の埋まり具合の下限
            this.evalWeights.qKeepWeight || 0,                       // [54] K 発火点の保全（1段降った後のおじゃま量。0=無効）
            this.evalWeights.qKeepDepth || 0,                        // [55] K を掛けるビームの深さ（0=全部）
            this.evalWeights.qKeepRows || 0,                         // [56] K で載せるおじゃまの段数（0=1段）
            this._terrainOjama || 0,                                 // [57] T 地形優先の対応：今の受け量（思考ごと。0=使わない）
            this.controlWeights.counterTerrainMax || 0,              // [58] T を使う受け量の上限（0=無効）
            this._terrainRate || 0,                                  // [59] T のおじゃまレート（思考ごと）
            0,                                                       // [60] P 相手のすぐ起こせる火力（worker が相手の盤面から入れる）
            this._p1Alpha || 0,                                      // [61] P 目標発火の相手比（%。思考ごと。0=無効）
            this._vtKillScore || 0,                                  // [62] A 対テト：倒せる点の目安（思考ごと。lv6 のみ）
            this._vtKillHoldPct || 0,                                // [63] A 対テト：倒せないなら目標でも撃たない（%）
            this._vtKillFire || 0,                                   // [64] A 対テト：目標未満でも倒せるなら撃つ 1/0
            this._vtStrict || 0,                                     // [65] B 対テト：整地だけの1連鎖を撃たない 1/0
            this._terrainMinChains || 0,                             // [66] T で撃つ手の段数の下限（思考ごと。lv6 の対テトのみ）
            this._terrainGainPct || 0,                               // [67] T で撃つのは地形が受けるより % 上回るときだけ
            // ── 対テト §15（lv6-vstet-design.md §15。既定0＝無効）──
            this.evalWeights.tearTimeWeight || 0,                    // [68] ちぎりの量（段数+1）×この値（発火は数えない）
            this.evalWeights.tearChainCost || 0,                     // [69] 到達連鎖から「経路のちぎりの量×この点」を引く
            this.evalWeights.sideKeepWeight || 0,                    // [70] 発火点の側面（K の置き換え）の重み
            this.evalWeights.sideKeepPeak || 0,                      // [71] 側面の山の頂上の段（0=2）
            this.evalWeights.sideKeepFall || 0,                      // [72] 側面の頂上から1段ごとに減らす %（0=50）
            this.evalWeights.sideKeepMinChains || 0,                 // [73] 側面を数える発火点の連鎖段数の下限（0=2）
            this._ojamaNow || 0,                                     // [74] 初手の後に降るおじゃま（思考ごと。lv6 の対テトのみ）
            this._ojamaNext || 0,                                    // [75] 2手目の後に降るおじゃま（思考ごと）
            this._ojamaRate || 0,                                    // [76] おじゃまを降らせる探索の相殺レート（0=使わない）
            this._ojamaWorst || 0,                                   // [77] 初手だけ端数の全パターンの最悪で見る 1/0
            // ── 対テト §17 D 危険度で妥協して撃つ（lv6-vstet-design.md §17.3。既定0＝無効。lv6 の VS_TET.vsTetControl）──
            this.controlWeights.dangerEmergAfter || 0,               // [78] 緊急の判定を降った後の盤面でも行う 1/0
            this.controlWeights.dangerOjamaPct || 0,                 // [79] 降った後のおじゃまの割合（%）がこれ以上なら危険
            this.controlWeights.dangerLossPct || 0,                  // [80] 降った後に撃てる連鎖の点がこの%以上減るなら危険
            this.controlWeights.dangerMinIncoming || 0,              // [81] 危険と見る届いている量の下限（個。0=1）
            this.controlWeights.dangerFireRatio || 0,                // [82] 反撃：今撃てる最大 ≥ 到達連鎖の最大×この% なら撃つ
            this.controlWeights.dangerOffsetPct || 0,                // [83] 相殺：届いている量×レート×この% 以上の点で本線が最も残る手
            this.controlWeights.dangerKeepPct || 0,                  // [84] 相殺・軽減は撃った後の本線が今のこの%以上の手だけ
            this.controlWeights.dangerReduce || 0,                   // [85] 軽減：撃った後に危険でなくなる手 1/0
            // ── 対テト §17 E 発火点を縦に露出（§17.4。既定0＝無効。lv6 の VS_TET.vsTetWeights）──
            this.evalWeights.exposeWeight || 0,                      // [86] 1段降っても撃てる発火点の組ごとに +この値
            this.evalWeights.buriedWeight || 0,                      // [87] 1段で撃てなくなる組ごとに +この値（負）
            this.evalWeights.exposeReachPct || 0,                    // [88] 1段で埋まる発火点の点をこの%減らして到達連鎖を求める
            this.evalWeights.exposeRows || 0,                        // [89] 載せる段数（0=1）
            this.evalWeights.exposeMaxKey || 0                       // [90] 載せた後の発火ぷよの数の上限（0=2）
        ]);
    },

    // ─────────────────────────────────────────────
    // ★ 重み調整パネル（public/app/cpu_weights_panel.js。CPU TEST 用）の口。
    //   パネルは build の基準値を「この CPU の既定値＋変えた値」に置き換え、setMode で今のモードに組み直す。
    //   vsTet / fastVsTet は基準値でなく、組み上がったモードの値へ名前で上書きする（applyModeValues。下の方）。
    //   weightsArray は手ごとに組み立て直す（_requestCalculation）ので、次の思考から効く。
    //   値は名前→値の平たい形でやり取りする（3グループの名前は重複しない）。
    // ─────────────────────────────────────────────
    _flatBuild(b) {
        return Object.assign({}, b.rewardWeights, b.evalWeights, b.controlWeights);
    },

    // 既定の build の値。lv: 'LV5' / 'LV6' / 省略＝この CPU の既定。出せないときは null。
    //   初めて呼ばれた時点の基準値を既定として控える（パネルが値を変える前に必ず呼ぶ）。
    getBuildDefaults(lv) {
        if (!this._defaultBuildBaseline) this._defaultBuildBaseline = this._buildBaseline;
        const lv5 = this._lv5Baseline || this._defaultBuildBaseline;   // lv6 は lv5 の基準を _lv5Baseline に控えている
        if (!lv || lv === this.constructor.LOG_NAME) return this._flatBuild(this._defaultBuildBaseline);
        if (lv === 'LV5') return this._flatBuild(lv5);
        const C = window.PuyoCPU6;
        if (lv === 'LV6' && C && C.TRAINED_BUILD) {
            const t = C.TRAINED_BUILD;
            return Object.assign(this._flatBuild(lv5), t.rewardWeights, t.evalWeights, t.controlWeights);
        }
        return null;
    },

    // 今の build の値（名前→値）
    getBuildValues() {
        this.getBuildDefaults();
        return this._flatBuild(this._buildBaseline);
    },

    // build の値を「既定値＋values（名前→値。知らない名前・数でない値は無視）」にして今のモードで組み直す。
    //   返り値＝既定と違う値の { 名前: { from, to } }。思考ログが「この手から変えた重み」を出すのに使う。
    applyBuildValues(values) {
        this.getBuildDefaults();
        const def = this._defaultBuildBaseline;
        const next = {}, changed = {};
        for (const g of ['rewardWeights', 'evalWeights', 'controlWeights']) {
            next[g] = Object.assign({}, def[g]);
            for (const k in next[g]) {
                if (!values || !Object.prototype.hasOwnProperty.call(values, k)) continue;
                const v = Number(values[k]);
                if (!Number.isFinite(v)) continue;
                next[g][k] = Math.round(v);
                if (next[g][k] !== def[g][k]) changed[k] = { from: def[g][k], to: next[g][k] };
            }
        }
        this._buildBaseline = next;
        this.setMode(this.cpuMode);
        this._buildChanged = changed;
        this._noteWeightsChanged();
        return changed;
    },

    // 思考ログに出す「既定と違う値」（build はそのままの名前、モード別は「vsTet.名前」）と、効き始めの記録
    _noteWeightsChanged() {
        const all = Object.assign({}, this._buildChanged);
        for (const m in (this._modeChanged || {})) {
            for (const k in this._modeChanged[m]) all[`${m}.${k}`] = this._modeChanged[m][k];
        }
        this._weightsRev = (this._weightsRev || 0) + 1;   // _requestCalculation が「この思考から効く」を記録する
        this._weightsChanged = all;
    },

    // ── モード別（vsTet / fastVsTet）の値。build と違い、組み上がったモードの値へ名前で上書きする ──
    //   既定＝今の build 基準からそのモードを組んだ値（lv6 は lv5 基準＋cpu5_modes.js＋VS_TET）。パネルの上書きは含めない。
    //   3グループの形で返す（パネルが並べ分けに使う）。今の重み・モードは崩さない。
    getModeDefaultsGrouped(mode) {
        this.getBuildDefaults();
        if (mode === 'build') {
            const d = this._defaultBuildBaseline;
            return { rewardWeights: Object.assign({}, d.rewardWeights), evalWeights: Object.assign({}, d.evalWeights), controlWeights: Object.assign({}, d.controlWeights) };
        }
        const save = {
            rewardWeights: this.rewardWeights, evalWeights: this.evalWeights, controlWeights: this.controlWeights,
            weights: this.weights, cpuMode: this.cpuMode, _modeOverrides: this._modeOverrides,
        };
        this._modeOverrides = null;
        try {
            this.setMode(mode);
            return { rewardWeights: this.rewardWeights, evalWeights: this.evalWeights, controlWeights: this.controlWeights };
        } finally {
            Object.assign(this, save);
        }
    },

    getModeDefaults(mode) {
        return this._flatBuild(this.getModeDefaultsGrouped(mode));
    },

    // 今のモード別の値（既定＋パネルの上書き）
    getModeValues(mode) {
        if (mode === 'build') return this.getBuildValues();
        return Object.assign(this.getModeDefaults(mode), this._modeOverrides && this._modeOverrides[mode]);
    },

    // モード別の値を「既定値＋values（名前→値。知らない名前・数でない値は無視）」にする。今のモードが同じならすぐ組み直す。
    //   返り値＝既定と違う値の { 名前: { from, to } }。
    applyModeValues(mode, values) {
        if (mode === 'build') return this.applyBuildValues(values);
        const def = this.getModeDefaults(mode);
        const ov = {}, changed = {};
        for (const k in def) {
            if (!values || !Object.prototype.hasOwnProperty.call(values, k)) continue;
            const v = Number(values[k]);
            if (!Number.isFinite(v) || Math.round(v) === def[k]) continue;
            ov[k] = Math.round(v);
            changed[k] = { from: def[k], to: ov[k] };
        }
        this._modeOverrides = Object.assign({}, this._modeOverrides, { [mode]: ov });
        this._modeChanged = Object.assign({}, this._modeChanged, { [mode]: changed });
        this.setMode(this.cpuMode);
        this._noteWeightsChanged();
        return changed;
    },

    // 学習の best.json の policy.build と同じ並び（62個）。[46][49][50] は保存値
    //   （思考ごとの換算前。training/puyo-lv5/tools/export_weights.mjs と同じ）。
    getBuildPolicyArray() {
        this.getBuildDefaults();
        const b = this._buildBaseline;
        const a = Array.from(this._buildWeightsArray.call(
            { rewardWeights: b.rewardWeights, evalWeights: b.evalWeights, controlWeights: b.controlWeights }, 9));
        const cw = b.controlWeights;
        a[46] = cw.harassMinOjama || 0;
        a[49] = cw.counterKeepReach || 0;
        a[50] = cw.harassMinReach || 0;
        a[61] = cw.p1Alpha || 0;
        return a;
    },

    // policy.build の添字 → 重みの名前（名前の無い添字は null。[20] は既知NEXT本数）。
    //   名前ごとに違う印の値を入れて _buildWeightsArray を通し、並びを手で写さずに求める。
    getBuildPolicyNames() {
        this.getBuildDefaults();
        const def = this._defaultBuildBaseline, names = [], probe = {};
        const MARK = 1000000;
        for (const g of ['rewardWeights', 'evalWeights', 'controlWeights']) {
            probe[g] = {};
            for (const k in def[g]) { probe[g][k] = MARK + names.length; names.push(k); }
        }
        const a = Array.from(this._buildWeightsArray.call(probe, -1));
        const out = a.map(v => (v >= MARK && v < MARK + names.length) ? names[v - MARK] : null);
        out[46] = 'harassMinOjama';
        out[49] = 'counterKeepReach';
        out[50] = 'harassMinReach';
        out[61] = 'p1Alpha';
        return out;
    },
});
