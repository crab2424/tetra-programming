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
//     ・vsTet / fastVsTet  … lv5 の build 基準＋cpu5_modes.js の差分＋VS_TET の重み（重み調整パネルのモード別の値はさらにその上）
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

    // 対テト（異種戦）の判断と vsTet の追加の重み（cpu5_worker_io.js が参照。lv5 は未設定＝従来どおり）
    //   設計: source_assets/memory/cpu/puyo/lv6-vstet-design.md §10（持論 §5.1 の構造。既定0＝今と同じ）。
    //   学習用シミュ training/puyo-lv5/sim/player.cpp decide の X_VT_* と同じ判断。
    static VS_TET = {
        // vsTet（本線）・fastVsTet（カウンター）の重みに上書きする値（lv5 の cpu5_modes.js の上に lv6 だけ載せる）。
        //   2026-10-22 学習値（runs/vstet-003 第50世代。検証 2000局で 0.520＝本番 vstet-001 の 0.324 から。lv6-vstet-design.md §15.9）
        vsTetWeights: {   // evalWeights の名前
            heightPenalty: -7, bumpWeight: -75, qYWeight: 168, qKeyWeight: -267, qChiWeight: 49,
            link2Weight: 54, link3Weight: 111, qLink2Weight: 42, qLink3Weight: 111, tearWeight: -138,
            puyosWeight: 45, height3Weight: -268, qExcessWeight: -16, qJunkWeight: -118,
            qKeepWeight: 0,                                      // K は発火点の側面で置き換え（§15.2）
            tearTimeWeight: -133, tearChainCost: 1275,           // §15.1 ちぎりの時間
            sideKeepWeight: 42, sideKeepPeak: 2, sideKeepFall: 83, sideKeepMinChains: 2,   // §15.2 発火点の側面
            // §17 E 発火点を縦に露出（2026-10-22）：全列に2段載せても発火ぷよ2個までで撃てない発火点は、到達連鎖の点を 50% 減らす。
            //   A/B（600局）で 0.485→0.593（lv6-vstet-design.md §17.10.2）。評価値に足す exposeWeight / buriedWeight は効かなかったので 0。
            exposeWeight: 0, buriedWeight: 0, exposeReachPct: 50, exposeRows: 2, exposeMaxKey: 0,
        },
        vsTetControl: {   // controlWeights の名前
            expChainWeight: 248, pruneChainScore: 18038, fireChainCount: 9, fireScoreThreshold: 123647,
            emergencyFireMinRatio: 40, emergencyHardCol2: 12,
            // §17 D 危険度で妥協して撃つ（2026-10-22。既定0＝今と同じ。届いているおじゃまを全部降らせた盤面で判定し、反撃→相殺→軽減）
            dangerEmergAfter: 0, dangerOjamaPct: 0, dangerLossPct: 0, dangerMinIncoming: 0,
            dangerFireRatio: 0, dangerOffsetPct: 0, dangerKeepPct: 0, dangerReduce: 0,
            // §18 F 見えている3手を重く（2026-10-23。既定0＝今と同じ）：4手目以降で見えた到達連鎖をこの%減らす
            farReachPct: 50,
            // §18 G 撃たないと埋まるなら撃つ（2026-10-23。既定0＝今と同じ）：届いている量を全部相殺できる手があり、
            //   育成の手の「安全な火力」（端数の最悪で、降った後に撃てる連鎖／見えている NEXT 2つで撃てる連鎖）より今撃てる方が大きいなら撃つ
            safeFirePct: 0, safeMinIncoming: 0, safeFillHeight: 0,
            // §18.11 G の条件の絞り込み（2026-10-24。既定0＝今と同じ）：本線そのものを撃つのは本線が埋まるときだけ（Keep/Loss）・盤面の高さの下限（MinHeight/MinCol3）
            safeKeepPct: 0, safeLossPct: 0, safeMinHeight: 0, safeMinCol3: 0,
            // §18 H1 テトのゲージへの構え（2026-10-24。既定0＝今と同じ）：ゲージが standbyMinOjama 個以上なら、育成の手を置いた後、
            //   見えている NEXT（standbyDepth 手まで）で（届いた量＋ゲージ）×レート×standbyPct% を撃てる手を選ぶ（到達連鎖 standbyKeepPct% まで譲る・危険なら standbyDangerPct%）
            standbyMinOjama: 0, standbyPct: 0, standbyDepth: 0, standbyKeepPct: 0, standbyDangerPct: 0,
        },
        fastVsTetWeights: { qYWeight: 16 },
        fastVsTetControl: { emergencyFireMinRatio: 89 },
        counterTrigger: 13,      // 対テトのカウンター発動量（0=lv5 共通の COUNTER_TRIGGER_OJAMA_VSTET）
        counterMargin:  0.834,   // 対テトのカウンター倍率（0=lv5 共通の COUNTER_MARGIN_VSTET）
        keepReach:   0,   // ② カウンターでも本線を残す手で返す（H2。0=使わない / 1..3 は counterKeepReach と同じ）
        decayStartS: 0,   // ③ この経過秒から本線の目標発火を下げる（0=下げない）
        decayStepS:  0,   // ③ 何秒ごとに1段下げるか（0=10秒）
        decayMin:    0,   // ③ 下げる下限の段数（0=3）
        counterPct:  0,   // ④ カウンターの発火点＝受け量×レート×この%（0=従来の (受け量+1)×レート×1.3）
        queueOnly:   0,   // ④ ↑の受け量に相手のゲージ（まだ届いていない分）を入れない 1/0
        // §12（2026-10-21）
        killPct:     0,   // A 撃って倒せるか：倒すのに要るライン×この% を目安にする（0=使わない）
        killHoldPct: 0,   // A 目標に届いても、目安×この% に足りなければ撃たずに伸ばす（0=保留しない）
        killFire:    0,   // A 目標未満でも、今撃てる最大で倒せるなら撃つ 1/0
        strict:      0,   // B 整地だけの1連鎖を撃たない（こぼさない手を band の外まで探す）1/0
        // §13（2026-10-21）受ける／返す／軽減の区別（対テト版の地形優先の対応）
        terrainMax:   0,  // 受け量 1〜この個数は、受ける・返す・軽減のうち降った後の地形が最大の手（0=使わない）
        terrainQueue: 0,  // ↑の受け量にテトのゲージ換算（まだ届いていない分）を入れない 1/0
        terrainMinChains: 0,  // 撃つ（返す・軽減）手の段数の下限（0=条件なし）
        terrainGainPct:   0,  // 撃つのは降った後の地形が受ける（育成）より この% 上回るときだけ（0=上回れば撃つ）
        // §15（2026-10-21）おじゃまを降らせる探索（ちぎりの時間・発火点の側面は vsTetWeights の
        //   tearTimeWeight / tearChainCost / sideKeepWeight / sideKeepPeak / sideKeepFall / sideKeepMinChains で入れる）
        ojamaSearch: 1,   // 1=届いているおじゃまを探索の盤面に降らせる（テトのゲージは入れない）
        ojamaWorst:  1,   // 1=初手だけ端数の全パターンの最悪で見る（0=固定の順）
        ojamaTurnMs: 0,   // ready まで残りこの ms 以内なら初手の後に降る、それ以外は2手目の後（0=560）
        // §18 F（2026-10-23。既定0＝今と同じ）
        ojamaWorstDepth:   0,   // ojamaWorst の「端数の全パターンの最悪」を見る深さ（0=初手だけ。2=見えている3手すべて）
        ojamaWorstByReach: 0,   // 1=最悪のパターンを「降った後に撃てる連鎖が最小」で選ぶ（0=評価値が最小）
        // §18 H2 後打ち（2026-10-24。既定0＝今と同じ）：1=カウンターの入り・発火点を届いた分（キュー）だけで見る（ゲージは H1 の構えだけ）
        counterTriggerQueueOnly: 0,
        // §18 W-a 待機（2026-10-24。既定0＝待たない。実機確認用）：カウンターで撃つ手で、テトのゲージの換算が waitMinGauge 個以上なら、
        //   quickDrop だけを止めてゲージが届くまで待つ（上限 waitMaxMs、0=1500ms。自然に固定したらそこまで）。ユーザーの回答では 20（ゲージ 8）
        waitMinGauge: 20,
        waitMaxMs:    0,
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
        this._vsTet = this.constructor.VS_TET;
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
            const r = super.setMode(mode);
            // 対テトの本線・カウンターに VS_TET の重みを上書きする（空なら lv5 と同じ）
            const vt = this.constructor.VS_TET || {};
            const ew = mode === 'vsTet' ? vt.vsTetWeights : mode === 'fastVsTet' ? vt.fastVsTetWeights : null;
            const cw = mode === 'vsTet' ? vt.vsTetControl : mode === 'fastVsTet' ? vt.fastVsTetControl : null;
            if ((ew && Object.keys(ew).length) || (cw && Object.keys(cw).length)) {
                this.evalWeights    = Object.assign({}, this.evalWeights, ew);
                this.controlWeights = Object.assign({}, this.controlWeights, cw);
                this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);
            }
            this._applyModeOverrides(r);   // 重み調整パネルでこのモードに変えた値は VS_TET より後に載せる
            return r;
        } finally {
            this._buildBaseline = trained;
        }
    }
};
