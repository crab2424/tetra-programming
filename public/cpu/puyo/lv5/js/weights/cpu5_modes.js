// ─────────────────────────────────────────────
// cpu5_modes.js（モード別プロファイル＝build 基準値からの差分）
//   PuyoCPU5.prototype を拡張する（cpu5.js が class 本体、cpu5_weights.js が
//   _initWeights / setMode を定義済みであること）。
//
//   _modeProfiles() … build からの「差分だけ」を返す。setMode() が
//                     「build 基準値へ復帰 → ここの差分を上書き」する。
//
//   ★ 差分の値は2通りで書ける（適用は cpu5_weights.js の _applyModeGroup）:
//       ・数値        … その絶対値で上書きする。閾値系（fireChainCount など）に使う。
//       ・{ x: 倍率 }  … base値 × 倍率（四捨五入）で上書きする。評価重みに使う。
//                       ⇒ 倍率そのものが設計意図になり、base を変えても自動追従する
//                          （旧来の「絶対値 + 手計算した比率コメント」の陳腐化を防ぐ）。
//
//   ★ 各モードの狙い・由来（Ama 比など）は cpu5_weights.md「モードプロファイル」を参照。
//     native 探索は build と共通（searchBuildMode）＝モード差はこの重みだけで表現する。
//   ⚠️ 値はすべて暫定＝実機で要チューニング（[[feedback-versus-cpu-verification]]）。
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU5.prototype, {

    _modeProfiles() {
        return {
            // build：従来どおりの本線構築（基準値・差分なし）。相手がぷよ／ソロ時の既定。
            build: {},

            // vsTet：相手がテトのときの本線構築。
            //   ★ 2026-10-21 学習値（training/puyo-lv5/runs/vstet-001 第30世代の平均ベクトル。相手 テト CPU lv5）。
            //     検証 2000局でぷよ勝率 0.079（旧の手決め値）→ 0.324。lv5・lv6 共通（lv6 も lv5 の build 基準＋この差分）。
            //     設計: source_assets/memory/cpu/puyo/lv6-vstet-design.md §11。値はすべて絶対値（lv5 の build 基準を丸ごと上書き）。
            vsTet: {
                evalWeights: {
                    heightPenalty:     -27,
                    heightDiffPenalty: -47,
                    shapeWeight:       -47,
                    wellWeight:        -27,
                    bumpWeight:       -230,
                    qYWeight:           28,   // 発火点を高く積まない（1段の被弾で崩れにくく）
                    qKeyWeight:       -220,
                    qChiWeight:        128,
                    link2Weight:        16,
                    link3Weight:        78,
                    formWeight:          0,   // テンプレは使わない（持論 §5.1）
                    qLink2Weight:       50,
                    qLink3Weight:       99,
                    sideWeight:         46,
                    tearWeight:       -192,
                    wasteWeight:        -1,
                    link3FacL:          88,
                    link3FacH:          73,
                    link3FacV:         103,
                    puyosWeight:        20,   // ぷよ量が命（盤面の色ぷよが多いほど正）
                    height3Weight:     -74,   // 致死列(第3列)高さ>4 の超過分
                    qExcessWeight:     -84,
                    qJunkWeight:      -198,   // 連鎖に結びつかない無駄ぷよ（持論 §5.1.1）
                    qKeepWeight:         5,   // 発火点の保全 K：1段降った後に起こせる連鎖
                    qKeepDepth:          2,
                    qKeepRows:           1,
                },
                controlWeights: {
                    emergencyHeight:         8,
                    expChainWeight:       1873,
                    pruneChainScore:     18108,
                    fireChainCount:          7,   // 7連鎖で撃つ（≒テトの致死量。§3）
                    fireScoreThreshold:  78250,
                    growthFireForbidChains:  1,
                    emergencyFireMinRatio:  51,
                },
            },

            // fast：速攻型（「多少汚くても浅い連鎖を速く返す」。詳細: cpu5_weights.md）。
            fast: {
                evalWeights: {
                    qChainWeight: { x: 0.5 },    // 連鎖規模への執着を半減
                    qYWeight:     { x: 0.333 },  // 発火点を高く積まない（速攻の核）
                    qChiWeight:   { x: 0.55 },   // 伸長余地の重視を下げる
                    link2Weight:  { x: 0.5 },    // 2連結の価値を下げる
                    link3Weight:  { x: 0.5 },    // 3連結の価値を下げる
                    qLink2Weight: { x: 0.5 },    // remain の種仕込みを軽く
                    qLink3Weight: { x: 0.583 },  // remain の種仕込みを軽く
                    shapeWeight:  { x: 0.1 },    // 理想L字の強制をほぼ解除
                    wellWeight:   { x: 0.1 },    // 井戸ペナルティを緩和
                    bumpWeight:   { x: 0.05 },   // 凸ペナルティを大幅緩和（速く積む）
                    tearWeight:   { x: 0.4 },    // ちぎりを許容して速度優先
                    formWeight:   0,             // ama fast は form を持たない（build 専用）
                },
                controlWeights: {
                    fireChainCount:          3,  // 3連鎖以上が撃てれば発火（早撃ち）
                    fireScoreThreshold:   3000,  // 浅いが点の出る連鎖も拾う
                    growthFireForbidChains:  0,  // 速攻ではこぼし（小連鎖）を抑制しない
                    emergencyFireMinRatio:   0,  // 守るべき本線が無いので緊急発火を絞らない
                },
            },

            // fastVsTet：対テト時のカウンター速攻（fast とは独立した重み）。
            //   ★ 2026-10-21 学習値（runs/vstet-001 第30世代。vsTet と同じ出典）。値はすべて絶対値。
            //     カウンターの発動量・倍率（cpu5_worker_io.js COUNTER_*_VSTET）も同じ学習で 14個・×1.223。
            fastVsTet: {
                evalWeights: {
                    shapeWeight:        -1,
                    wellWeight:         -1,
                    bumpWeight:        -25,
                    qChainWeight:      350,
                    qYWeight:          319,
                    qChiWeight:         11,
                    link2Weight:         1,
                    link3Weight:         2,
                    formWeight:          0,
                    qLink2Weight:        2,
                    qLink3Weight:        7,
                    tearWeight:         -8,
                    puyosWeight:         0,
                    height3Weight:       0,
                },
                controlWeights: {
                    fireChainCount:          3,
                    fireScoreThreshold:   3000,
                    growthFireForbidChains:  1,
                    emergencyFireMinRatio:  88,
                },
            },
        };
    },
});
