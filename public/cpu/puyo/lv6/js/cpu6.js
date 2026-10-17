// ─────────────────────────────────────────────
// cpu6.js（ぷよCPU lv6 ＝ lv5 + 学習済み重み・隠し要素）
//
// ★ lv5（PuyoCPU5）を継承し、build の重みと対ぷよカウンター定数だけを
//   CMA-ES 学習（training/puyo-lv5）の結果に差し替えたもの。探索（wasm/worker）は lv5 と共通。
//   学習途中の重みを実機で lv5 と比べるための版＝lv5 本体には手を入れない。
//
//   出典: training/puyo-lv5/runs/lv6-h-001/best.json（2026-10-17）
//         （lv6-e1-001 版を初期値に、lv6＋催促 H1・対応 H2 を相手として、ゴミ・副砲の評価と H1/H2 を加えた
//          37 次元で再学習した第20世代の平均ベクトル。検証＝lv6h 相手 2000局で 0.543 [0.512, 0.574]、
//          旧 lv6 相手 600局で 0.567 / 0.517、lv5 相手 600局で 0.775。催促は学習で事実上オフになった）
//   前の版: lv6-e1-001 第15世代（git 0a31edf）、その前: runs/build-001 第20世代（git 7ef7c6b）。
//
//   ★ 2026-10-15: 対戦判断「後打ちの活用」（VS_DECISION.p2）も有効にしている（lv5 は無効）。
//
//   モードごとの扱い（学習条件に合わせる）:
//     ・build              … 学習済み値（各版は1つ前の lv6 の値を初期値にして学習した）
//     ・fast（カウンター）  … 学習中は lv5 の絶対値で固定していた（設計書 D2）→ lv5 と同じ値
//     ・vsTet / fastVsTet  … 学習対象外 → lv5 と同じ値（lv5 の build 基準から倍率をかける）
//
//   ⚠️ ロード順: lv5 の全ファイルが読み込み済みであること（CPU_CONFIGS の deps で保証）。
// ─────────────────────────────────────────────

window.PuyoCPU6 = class extends window.PuyoCPU5 {

    // 学習で変わった build の値（best.json の policy のうち lv5 と違うもの。qKeyWeight は lv5 と同じ -30 に戻った）
    static TRAINED_BUILD = {
        evalWeights: {
            heightPenalty:        -2,   // lv5: -8
            heightDiffPenalty:   -35,   // lv5: -10
            shapeWeight:         -45,   // lv5: -10
            wellWeight:          -15,   // lv5: -10
            bumpWeight:         -239,   // lv5: -500
            qYWeight:            187,   // lv5: 120
            qChiWeight:           57,   // lv5: 20
            link2Weight:           3,   // lv5: 2
            link3Weight:          45,   // lv5: 4
            formWeight:           96,   // lv5: 80
            qLink2Weight:         32,   // lv5: 4
            qLink3Weight:         21,   // lv5: 12
            sideWeight:           45,   // lv5: 0
            tearWeight:         -100,   // lv5: -20
            wasteWeight:          -6,   // lv5: -2
            link3FacL:            83,   // lv5: 100
            link3FacH:            82,   // lv5: 100
            link3FacV:             0,   // lv5: 30
            qExcessWeight:       -62,   // lv5: 0（途中段の余剰。提案3 E1）
            qJunkWeight:        -111,   // lv5: 0（ゴミ×埋まり具合。提案3 E2a）
            qSubWeight:           16,   // lv5: 0（副砲のおじゃま量。提案3 E2b）
        },
        controlWeights: {
            emergencyHeight:       10,  // lv5: 12
            expChainWeight:       997,  // lv5: 1500
            pruneChainScore:     2145,  // lv5: 3000
            fireChainCount:        14,  // lv5: 12
            fireScoreThreshold: 150135, // lv5: 50000
            growthFireForbidChains: 4,  // lv5: 2
            emergencyFireMinRatio: 96,  // lv5: 70
            emergencyHardCol2:     12,  // lv5: 11
            // 催促 H1・対応 H2（lv5: すべて 0＝無効）。H1 は 2連鎖で13個以上が条件のため、ほぼ撃たない
            harassMinOjama:        13,  // 催促で送る最低のおじゃま個数
            harassMaxChains:        2,  // 催促の段数の上限
            harassKeepPct:         84,  // 撃った後に残す本線潜在（今の本線潜在に対する%）
            harassMinReach:       222,  // 撃った後に残す本線潜在（おじゃま個数）
            counterKeepReach:       1,  // カウンターは本線を最も残す手で返す
        },
    };

    // 対ぷよカウンターの定数（cpu5_worker_io.js _updateVersusCounterMode が参照）
    static TRAINED_COUNTER = {
        triggerVsPuyo: 3,     // lv5: 5（受け量がこれを超えたら fast へ）
        marginVsPuyo:  1.207, // lv5: 1.0（カウンター発火スコアの倍率）
    };

    // 対戦判断（cpu5_worker_io.js が参照。lv5 は未設定＝従来どおり）
    //   p2 = 後打ちの活用（設計: source_assets/memory/cpu/puyo/lv5-vs-decision-design.md §2）。
    //   相手ぷよの連鎖中は、撃たない手が相手の連鎖終了より前に終わる限り build の重みで伸ばし、
    //   今撃てる最大が受け量×fireIfPct% に届いたら撃つ／間に合わなくなったら撃てる最大を撃つ。
    static VS_DECISION = {
        p2: {
            minIncoming: 30,   // 待つのは相手の発火中連鎖で届く量がこれ以上のとき（個）
            fireIfPct:  110,   // 今撃てる最大 ≥ 受け量×この% なら待たずに撃つ
            safetyMs:   200,   // 締切の余裕（ms）
            turnMs:     560,   // 撃たない1手の所要時間の見積もり（spawnAnim〜着地振動〜fixWait5f, ms）
        },
    };

    _initWeights() {
        super._initWeights();
        // lv5 の build 基準を控える（build 以外のモードはこれを基準にして lv5 と同じ値にする）
        this._lv5Baseline = this._buildBaseline;

        const t = this.constructor.TRAINED_BUILD;
        this.evalWeights    = Object.assign({}, this.evalWeights,    t.evalWeights);
        this.controlWeights = Object.assign({}, this.controlWeights, t.controlWeights);
        this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);
        this._buildBaseline = {
            rewardWeights:  Object.assign({}, this.rewardWeights),
            evalWeights:    Object.assign({}, this.evalWeights),
            controlWeights: Object.assign({}, this.controlWeights),
        };
        this._counterOverrides = this.constructor.TRAINED_COUNTER;
        this._vsDecision = this.constructor.VS_DECISION;
    }

    // ── 高速落下で設置モード（隠し・準備画面の 7 / Shift+7）──
    //   softDropOnly が真のとき、クイックドロップ（即置き）を使わず、移動・回転のあと
    //   高速落下キーを押しっぱなしにして着地・固定まで落とす（人が操作するのと同じ縛り）。
    _startQuickDrop() {
        if (!this.softDropOnly) return super._startQuickDrop();
        if (!this.isActive || !this.isAutoPlay) { this.isExecutingAction = false; return; }
        if (this.game.isPaused || this.game.state === 'paused') {
            setTimeout(() => { if (this.isActive && this.isAutoPlay) this._startQuickDrop(); }, 100);
            return;
        }
        if (this.game._gs !== 'falling') { this.isExecutingAction = false; return; }

        const key = this.game._keyMap.softDrop;
        this._softKey = key;
        this.game._keys[key] = true;
        const poll = () => {
            // 固定された（_gs が falling 以外）／停止された時点でキーを離す
            if (!this.isActive || !this.isAutoPlay || this.game._gs !== 'falling') {
                this._releaseSoftKey();
                setTimeout(() => { this.isExecutingAction = false; }, this.placeDelay);
                return;
            }
            setTimeout(poll, 16);
        };
        poll();
    }

    _releaseSoftKey() {
        if (this._softKey != null && this.game && this.game._keys) this.game._keys[this._softKey] = false;
        this._softKey = null;
    }

    stop() {
        this._releaseSoftKey();
        return super.stop();
    }

    setMode(mode) {
        const known = Object.prototype.hasOwnProperty.call(this._modeProfiles(), mode);
        if (!known || mode === 'build') return super.setMode(mode);
        // build 以外は lv5 の基準値から差分をかける（＝lv5 と同じ重み）
        const trained = this._buildBaseline;
        this._buildBaseline = this._lv5Baseline;
        try {
            return super.setMode(mode);
        } finally {
            this._buildBaseline = trained;
        }
    }
};
