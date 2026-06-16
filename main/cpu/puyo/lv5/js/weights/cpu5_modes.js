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

            // vsTet：相手がテトのときの本線構築（詳細: cpu5_weights.md）。
            //   ★ まずはモード分岐のみ＝現状 build と同一（差分なし）。
            //     今後テト相手向け（おじゃま着弾の早さ・攻撃ゲージ特性）にチューニングする。
            vsTet: {
                evalWeights: {
                    qChainWeight: { x: 0.5 },    // 連鎖規模への執着を半減
                    qYWeight:     { x: 2.0 },    // 発火点を高く積む（速攻の核）
                    qChiWeight:   { x: 1.0 },    // 伸長余地の重視
                    link2Weight:  { x: 0.8 },    // 2連結の価値を下げる
                    link3Weight:  { x: 1.5 },    // 3連結の価値を上げる
                    qLink2Weight: { x: 1.2 },    // remain の種仕込みを軽く
                    qLink3Weight: { x: 1.4 },    // remain の種仕込みを軽く
                    shapeWeight:  { x: 0.1 },    // 理想L字の強制をほぼ解除
                    wellWeight:   { x: 0.1 },    // 井戸ペナルティを緩和
                    bumpWeight:   { x: 0.05 },   // 凸ペナルティを大幅緩和（速く積む）
                    tearWeight:   { x: 2.0 },    // ちぎりを許容して速度優先
                    link3FacL:    { x: 1.0 },    // L字（折れ）  
                    link3FacH:    { x: 1.0 },    // 横一直線      
                    link3FacV:    { x: 4.0 },    // 縦一直線
                    formWeight:   0,             // vstet は form を持たない（build 専用）
                    // ── vsTet 専用評価値（base=0 なので絶対値で指定。要実機チューニング）──
                    puyosWeight:   10,           // 盤面のぷよ量（おじゃま除く）が多いほど正
                    height3Weight: -100,         // 致死列(第3列)高さ>4 の超過分にペナルティ（負）
                },
                controlWeights: {
                    fireChainCount:          7,  // 7連鎖以上が撃てれば発火（早撃ち）
                    fireScoreThreshold:   5000,  // 浅いが点の出る連鎖も拾う
                    growthFireForbidChains:  1,  // 速攻ではこぼし（小連鎖）を抑制しない
                    emergencyFireMinRatio:   0,  // 守るべき本線が無いので緊急発火を絞らない
                },},

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
            //   ★ fast から派生させず完全に独立した差分にする＝fast を変えても vsTet へ波及しない。
            //     対テトはおじゃま着弾が早い／攻撃ゲージ特性が異なるため、ここを個別に詰める。
            //   ⚠️ 初期値は現行 fast と同値のスタート地点。実機で要チューニング
            //      （[[feedback-versus-cpu-verification]]）。
            fastVsTet: {
                evalWeights: {
                    qChainWeight: { x: 0.5 },    // 連鎖規模への執着を半減
                    qYWeight:     { x: 5.0 },    // 発火点を高く積む（速攻の核）
                    qChiWeight:   { x: 0.55 },   // 伸長余地の重視を下げる
                    link2Weight:  { x: 2.5 },    // 2連結の価値を上げる
                    link3Weight:  { x: 2.5 },    // 3連結の価値を上げる
                    qLink2Weight: { x: 0.5 },    // remain の種仕込みを軽く
                    qLink3Weight: { x: 2.583 },  // remain の種仕込みを重く
                    shapeWeight:  { x: 0.1 },    // 理想L字の強制をほぼ解除
                    wellWeight:   { x: 0.1 },    // 井戸ペナルティを緩和
                    bumpWeight:   { x: 0.05 },   // 凸ペナルティを大幅緩和（速く積む）
                    tearWeight:   { x: 2.4 },    // ちぎりを許容して速度優先
                    formWeight:   0,             // form を持たない（build 専用）
                    // ── fastVsTet 専用評価値（base=0 なので絶対値で指定。要実機チューニング）──
                    puyosWeight:    2,           // 盤面のぷよ量（おじゃま除く）が多いほど正
                    height3Weight: -100,         // 致死列(第3列)高さ>4 の超過分にペナルティ（負）
                },
                controlWeights: {
                    fireChainCount:          3,  // 3連鎖以上が撃てれば発火（早撃ち）
                    fireScoreThreshold:   3000,  // 浅いが点の出る連鎖も拾う
                    growthFireForbidChains:  0,  // 速攻ではこぼし（小連鎖）を抑制しない
                    emergencyFireMinRatio:   0,  // 守るべき本線が無いので緊急発火を絞らない
                },
            },
        };
    },
});
