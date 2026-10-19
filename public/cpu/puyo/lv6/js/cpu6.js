// ─────────────────────────────────────────────
// cpu6.js（ぷよCPU lv6 ＝ lv5 + 学習済み重み・隠し要素）
//
// ★ lv5（PuyoCPU5）を継承し、build の重みと対ぷよカウンター定数だけを
//   CMA-ES 学習（training/puyo-lv5）の結果に差し替えたもの。探索（wasm/worker）は lv5 と共通。
//   学習途中の重みを実機で lv5 と比べるための版＝lv5 本体には手を入れない。
//
//   出典: training/puyo-lv5/runs/lv6-s-001/best.json（2026-10-20）
//         （前の lv6 に §10.4 の固定値（催促 H1・対応 H2・本線条件 G1）と §13 の構造（相手を見て撃つ P・地形優先の対応 T）を
//          固定で足した lv6s を初期値に、15次元に絞って相手プール opponents/pool-v3.json＋殿堂で学習した第20世代の平均ベクトル。
//          検証＝lv6s 相手 2000局で 0.534 [0.504, 0.565]、前の lv6 相手 0.526 [0.496, 0.557]、プール重み付き平均 0.553
//          （最悪 responder 0.416）、lv5 相手 0.831。設計: source_assets/memory/cpu/puyo/lv6-harass-design.md §13.7.1）
//   前の版: lv6-pool-001 第20世代（git 4bbab1b 時点）、lv6-h-001 第20世代（git 64e4e83）、lv6-e1-001 第15世代（git 0a31edf）、runs/build-001 第20世代（git 7ef7c6b）。
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

    static LOG_NAME = 'LV6';   // 思考ログの印
    // 重みの版（思考ログの ready 行に出す）。TRAINED_BUILD を差し替えたら出典の run/世代に合わせて書き換える
    static WEIGHTS_ID = 's-001/g20';

    // 学習で変わった build の値と固定値（best.json の policy のうち lv5 と違うもの）
    static TRAINED_BUILD = {
        evalWeights: {
            heightPenalty:        -21,   // lv5: -8
            heightDiffPenalty:   -47,   // lv5: -10
            shapeWeight:         -47,   // lv5: -10
            wellWeight:          -27,   // lv5: -10
            bumpWeight:         -239,   // lv5: -500
            qYWeight:            207,   // lv5: 120
            qChiWeight:           70,   // lv5: 20
            link2Weight:           1,   // lv5: 2
            link3Weight:          47,   // lv5: 4
            formWeight:           79,   // lv5: 80
            qLink2Weight:         25,   // lv5: 4
            qLink3Weight:         39,   // lv5: 12
            sideWeight:           46,   // lv5: 0
            tearWeight:         -84,   // lv5: -20
            wasteWeight:          -1,   // lv5: -2
            link3FacL:            88,   // lv5: 100
            link3FacH:            73,   // lv5: 100
            link3FacV:            103,   // lv5: 30
            qKeyWeight:            0,   // lv5: -30
            qExcessWeight:        -82,   // lv5: 0（途中段の余剰。提案3 E1）
            qJunkWeight:        -130,   // lv5: 0（ゴミ×埋まり具合。提案3 E2a）
            qSubWeight:           45,   // lv5: 0（副砲のおじゃま量。提案3 E2b）
            // 副砲・催促の本線条件 G1（固定値。§10.4）：本線が7連鎖・色ぷよ30個以上になってから副砲を評価し、催促も撃つ
            subMinMainChains:      7,   // lv5: 0
            subMinMainPuyos:      30,   // lv5: 0
        },
        controlWeights: {
            emergencyHeight:       10,  // lv5: 12
            expChainWeight:       1767,  // lv5: 1500
            pruneChainScore:     9552,  // lv5: 3000
            fireChainCount:        13,  // lv5: 12
            fireScoreThreshold: 200000, // lv5: 50000
            growthFireForbidChains: 4,  // lv5: 2
            emergencyFireMinRatio: 97,  // lv5: 70
            emergencyHardCol2:     12,  // lv5: 11
            // 催促 H1・対応 H2（固定値。§10.4。lv5: すべて 0＝無効）
            harassMinOjama:        12,  // 催促で送る最低のおじゃま個数
            harassMaxChains:        3,  // 催促の段数の上限
            harassKeepPct:          80,  // 撃った後に残す本線潜在（今の本線潜在に対する%）
            harassMinReach:       200,  // 撃った後に残す本線潜在（おじゃま個数）
            counterKeepReach:       1,  // カウンターは本線を最も残す手で返す
            // §13 の構造（固定値。lv5: 0＝無効）
            p1Alpha:              160,  // 相手を見て撃つ P：目標発火は「撃つ点 ≥ 160% × 相手のすぐ起こせる火力」のときだけ
            counterTerrainMax:     18,  // 地形優先の対応 T：受け量18個以下は fast に入らず、降った後の地形が最大の手（受ける・軽減・返す）
        },
    };

    // 対ぷよカウンターの定数（cpu5_worker_io.js _updateVersusCounterMode が参照）
    static TRAINED_COUNTER = {
        triggerVsPuyo: 5,     // lv5: 5（受け量がこれを超えたら fast へ）
        marginVsPuyo:  1.146, // lv5: 1.0（カウンター発火スコアの倍率）
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
