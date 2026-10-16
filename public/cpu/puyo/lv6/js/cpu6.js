// ─────────────────────────────────────────────
// cpu6.js（ぷよCPU lv6 ＝ lv5 + 学習済み重み・隠し要素）
//
// ★ lv5（PuyoCPU5）を継承し、build の重みと対ぷよカウンター定数だけを
//   CMA-ES 学習（training/puyo-lv5）の結果に差し替えたもの。探索（wasm/worker）は lv5 と共通。
//   学習途中の重みを実機で lv5 と比べるための版＝lv5 本体には手を入れない。
//
//   出典: training/puyo-lv5/runs/build-001/best.json
//         （第20世代の平均ベクトル。定期評価＝現行lv5相手・別シード200×先後2局で勝率 0.58）
//
//   ★ 2026-10-15: 対戦判断「後打ちの活用」（VS_DECISION.p2）も有効にしている（lv5 は無効）。
//
//   モードごとの扱い（学習条件に合わせる）:
//     ・build              … 学習済み値
//     ・fast（カウンター）  … 学習中は lv5 の絶対値で固定していた（設計書 D2）→ lv5 と同じ値
//     ・vsTet / fastVsTet  … 学習対象外 → lv5 と同じ値（lv5 の build 基準から倍率をかける）
//
//   ⚠️ ロード順: lv5 の全ファイルが読み込み済みであること（CPU_CONFIGS の deps で保証）。
// ─────────────────────────────────────────────

window.PuyoCPU6 = class extends window.PuyoCPU5 {

    // 学習で変わった build の値（best.json の changed をそのまま写したもの）
    static TRAINED_BUILD = {
        evalWeights: {
            heightPenalty:        -6,   // lv5: -8
            heightDiffPenalty:   -36,   // lv5: -10
            shapeWeight:         -22,   // lv5: -10
            wellWeight:           -4,   // lv5: -10
            bumpWeight:         -160,   // lv5: -500
            qYWeight:            169,   // lv5: 120
            qKeyWeight:          -49,   // lv5: -30
            qChiWeight:            4,   // lv5: 20
            link2Weight:           5,   // lv5: 2
            link3Weight:          11,   // lv5: 4
            formWeight:           49,   // lv5: 80
            qLink2Weight:         18,   // lv5: 4
            qLink3Weight:         25,   // lv5: 12
            sideWeight:           35,   // lv5: 0
            tearWeight:          -56,   // lv5: -20
            wasteWeight:          -4,   // lv5: -2
            link3FacL:            81,   // lv5: 100
            link3FacH:            93,   // lv5: 100
            link3FacV:            21,   // lv5: 30
        },
        controlWeights: {
            expChainWeight:      1406,  // lv5: 1500
            pruneChainScore:     2574,  // lv5: 3000
            fireChainCount:        13,  // lv5: 12
            fireScoreThreshold: 108195, // lv5: 50000
            growthFireForbidChains: 3,  // lv5: 2
            emergencyFireMinRatio: 60,  // lv5: 70
            emergencyHardCol2:     12,  // lv5: 11
        },
    };

    // 対ぷよカウンターの定数（cpu5_worker_io.js _updateVersusCounterMode が参照）
    static TRAINED_COUNTER = {
        triggerVsPuyo: 9,     // lv5: 5（受け量がこれを超えたら fast へ）
        marginVsPuyo:  0.98,  // lv5: 1.0（カウンター発火スコアの倍率）
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
