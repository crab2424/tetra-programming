// ─────────────────────────────────────────────
// cpu4_worker_io.js（Worker / Wasm 連携）
//   PuyoCPU4.prototype を拡張する（cpu4.js が class 本体を定義済みであること）。
//
//   _requestCalculation()  … 盤面/NEXT/重みをバッファ化して Worker へ postMessage
//   _handleWorkerResult()  … Wasm の探索結果を受け取り、bestMoveData 反映・着手開始
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU4.prototype, {

    // precompute=true のときは「これから出るペア(nextQueue[0])」を現ペアとして探索する
    // （spawnAnim 時点の前倒し計算）。falling 時の通常計算では pivotColor/childColor を使う。
    _requestCalculation(precompute = false) {
        if (!this.workerReady || this.isCalculating) return;

        const game = this.game;
        if (!game || game.state !== 'playing') return;

        this.isCalculating = true;

        const TOTAL_ROWS = 17;
        const COLS       = 6;
        const boardBuffer = new Uint8Array(TOTAL_ROWS * COLS);

        for (let r = 0; r < TOTAL_ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                boardBuffer[r * COLS + c] = game.field[r][c] || 0;
            }
        }

        const nextPairs = new Int32Array(20);
        const q = game.nextQueue || [];

        // ★ 現ペアとNEXT列の起点。
        //   precompute（spawnAnim/着手前）：まだ _spawnPuyo していないので現ペア＝nextQueue[0]、
        //     以降のNEXTは nextQueue[1..]（queueOffset=1）。
        //   通常（falling/操作中）：現ペア＝pivotColor/childColor、NEXTは nextQueue[0..]（queueOffset=0）。
        let curPair, queueOffset;
        if (precompute && q[0]) {
            curPair     = q[0];
            queueOffset = 1;
        } else {
            curPair     = [game.pivotColor, game.childColor];
            queueOffset = 0;
        }

        nextPairs[0] = curPair[0];
        nextPairs[1] = curPair[1];

        // ★ 実際に見えているNEXTの本数（現在ペアを除く）。
        //   ※ かつて「ここから先は擬似未来ツモで分岐する」境界に使う想定だったが、TETLABO は
        //     内部20NEXTを確定保持するため擬似分岐機構は撤去済み。C++ 側は weightsArray[20] に
        //     渡るものの参照しない（cpu4.cpp で w.knownNextCount に代入されるだけのデッド配線）。
        //     現状は単に未充足NEXTをダミー埋めするためのカウンタとしてのみ機能する。
        let knownNextCount = 0;
        for (let i = 0; i < 9; i++) {
            const qp = q[i + queueOffset];
            if (qp) {
                nextPairs[(i + 1) * 2]     = qp[0];
                nextPairs[(i + 1) * 2 + 1] = qp[1];
                if (knownNextCount === i) knownNextCount = i + 1; // 先頭から連続して既知の本数
            } else {
                nextPairs[(i + 1) * 2]     = (i % 4) + 1;
                nextPairs[(i + 1) * 2 + 1] = ((i + 1) % 4) + 1;
            }
        }

        // ★ 着手予測オーバーレイ(test)が探索と同じペアで描けるよう、使った3手分の色を控える。
        //   precompute 時は pivotColor/childColor がまだ前ツモのままなので、game から読ませない。
        this._estimateColors = [
            [nextPairs[0], nextPairs[1]],
            [nextPairs[2], nextPairs[3]],
            [nextPairs[4], nextPairs[5]],
        ];

        // ★ VERSUS 限定：相手が放った連鎖のグロス着弾量（今降ってくるおじゃま総量）を受け取り、
        //   build（本線構築）／fast（カウンター速攻）を自動で切り替える。
        //   ※ 受け量＝表示予告(相殺後・internal除外)ではなく garbageQueue 全量（internal含む）。
        const incomingGross = this._getIncomingOjamaGross();
        this._incomingOjamaGross = incomingGross;
        this._updateVersusCounterMode(incomingGross);

        // ★ weightsArray を組み立てる（cpu4_weights.js）。発火制御はモード/カウンター側へ移行済み。
        const weightsArray = this._buildWeightsArray(knownNextCount);

        this.worker.postMessage({
            type:           'calculate',
            boardBuffer:    boardBuffer,
            nextPairs:      nextPairs,
            weightsArray:   weightsArray
        });
    },

    _handleWorkerResult(res) {
        this.isCalculating = false;

        if (res[0] === -1) {
            console.warn('PuyoCPU: 配置候補なし');
            // 候補なしフォールバック（中央へ素直に落とす）。前倒し計算で falling 前に来た場合も
            // bestMoveData として保持し、着手は _tryStartExecution（falling 限定）に委ねる。
            this.bestMoveData = { col1: 2, rot1: 0, score: 0, col2: -1, rot2: 0, col3: -1, rot3: 0 };
            this._tryStartExecution();
            return;
        }

        // ★ 選択初手への到達操作列(path)を復号する（res[27..29] に 3bit×10/int で packing）。
        //   コード 1=左 2=右 4=回転CW 5=回転CCW（0=終端）。BFS(getAllPlacements)が出した
        //   実機到達経路で、_buildActionQueue がこれを再生して「上部回し」を実現する。
        const path = [];
        if (res.length >= 30) {
            outer:
            for (let w = 0; w < 3; w++) {
                const packed = res[27 + w];
                for (let s = 0; s < 10; s++) {
                    const code = (packed >> (s * 3)) & 0x7;
                    if (code === 0) break outer; // 終端
                    path.push(code);
                }
            }
        }

        // ★ 直近の「理論上いま組める最大潜在連鎖スコア」(res[12]=bestChain) を控える。
        //   VERSUS のカウンター判定で「自分が相殺できるおじゃま量(カバー量)」へ換算するのに使う。
        if (res.length > 12) this._lastBestChain = res[12] || 0;

        this.bestMoveData = {
            col1: res[0], rot1: res[1],
            score: res[2],
            col2: res[3], rot2: res[4],
            col3: res[5], rot3: res[6],
            path: path,
        };

        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = this.bestMoveData.score;

        if (this.game.currentMode === 'test') {
            this._renderEstimatePlace();
        }

        // falling 中なら即着手。前倒し計算で falling 前に結果が来た場合は、
        // _updateLoop が falling 突入時に _tryStartExecution を呼んで着手する。
        this._tryStartExecution();
    },

    // ───────────────────────────────────────────────
    // ★ VERSUS：相手が放った連鎖のグロス着弾量（今降ってくるおじゃま総量）を受け取る。
    //   this.game（＝CPU自身の盤面）の garbageQueue が、相手が sendGarbage で送ってきた
    //   おじゃまをそのまま保持している。表示予告は「相殺後・internal(stage1)除外」だが、
    //   ここでは internal も含めた“これから自分に降ってくる総量”を返す（相手の実火力に相当）。
    //   自分が相殺/着弾で消化すると garbageQueue が減るので、この値も自然に減っていく。
    //   ※ VERSUS 以外（ソロ/テスト）では 0。
    _getIncomingOjamaGross() {
        const game = this.game;
        if (!game || !game.isVersusMode) return 0;
        const q = game.garbageQueue;
        if (!q || q.length === 0) return 0;
        let total = 0;
        for (const g of q) {
            if (g && g.amount > 0) total += g.amount;
        }
        return total;
    },

    // ★ VERSUS：受け取ったグロス着弾量に応じて build ↔ fast(カウンター) を切り替える。
    //   方針（ユーザー要望「相手発火→受けおじゃま量を逆算→上回る連鎖で返す」）:
    //     ・受け量が一定個数（COUNTER_TRIGGER_OJAMA）を超えたら fast(カウンター)へ。
    //       ※ かつては「受け量 > 自分の潜在連鎖カバー」で判定していたが、カバー量の素となる
    //         bestChain は“まだ撃っていない潜在連鎖スコア”ゆえ育成中は過大評価され、
    //         coverage が受け量を恒常的に上回って実質カウンターが発動しなかった。
    //         よって受け量そのもののしきい値判定に変更（カバー量は表示の参考値としてのみ残す）。
    //     ・カウンター時は発火目標を「受け量を上回る連鎖」に設定（fireChainCount=0＝段数では撃たず、
    //       受け量超えスコアだけを発火条件にする）。盤面が緊急になれば fast プロファイルの
    //       emergencyFireMinRatio=0 により出せる最大連鎖を緊急発火する。
    //   ヒステリシス：一度カウンターに入ったら受け量が尽きる(0)まで継続し、build へ戻る。
    //   ※ VERSUS 以外では何もしない（手動 setMode を尊重）。
    //   ※ ゲーム側仕様：1回に降るおじゃまは最大30個（ojama.js limit=30）。受け量はキュー総量なので
    //     30 を超えうるが、しきい値はその範囲内の小さな値で十分。
    _updateVersusCounterMode(incomingGross) {
        const game = this.game;
        if (!game || !game.isVersusMode) return;

        // カウンター発動の受け量しきい値（これ「を超えたら」発動）。
        const COUNTER_TRIGGER_OJAMA = 5;

        const rate = game.vsOjamaRate ?? (window.PConfig ? PConfig.ojamaRate : 70);

        // 自分が今いつでも組める最大潜在連鎖で相殺できるおじゃま量（カバー量）。
        //   ※ 判定には使わず、コンソール表示の参考値としてのみ算出する。
        const coverScore = this._lastBestChain || 0;
        const coverage   = Math.floor(coverScore / rate);

        let wantCounter;
        if (this._counterActive) {
            wantCounter = incomingGross > 0;                       // 受け量が尽きるまで継続
        } else {
            wantCounter = incomingGross > COUNTER_TRIGGER_OJAMA;   // しきい値超えで発動
        }

        const prevMode = this.cpuMode;

        if (wantCounter) {
            if (this.cpuMode !== 'fast') this.setMode('fast');
            this._counterActive = true;
            // ★ カウンター閾値：発火スコア閾値を「受け量を上回る連鎖」に設定する。
            //   おじゃま量 incomingGross+1 個ぶんの連鎖スコア = (incomingGross+1) × rate。
            //   段数トリガ(fireChainCount)は切り、この受け量超えスコアだけを発火条件にする。
            this.controlWeights.fireChainCount     = 0;
            this.controlWeights.fireScoreThreshold = (incomingGross + 1) * rate;
            this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);
        } else {
            if (this.cpuMode !== 'build') this.setMode('build');
            this._counterActive = false;
        }

        // ── コンソール表示：モードが実際に切り替わっているか／カウンター閾値を可視化 ──
        //   受け量がある間（またはカウンター継続中・切替発生時）は毎手ログを出す。
        //   受け量0で build のときは静かにする（ログのスパム防止）。
        const modeChanged = (prevMode !== this.cpuMode);
        if (incomingGross > 0 || this._counterActive || modeChanged) {
            const thr      = this.controlWeights.fireScoreThreshold;
            const thrOjama = rate > 0 ? Math.floor(thr / rate) : 0;
            const tag      = modeChanged ? `★切替 ${prevMode} → ${this.cpuMode}` : `mode=${this.cpuMode}`;
            console.log(
                `[cpu4 versus] ${tag}｜受け量=${incomingGross}個(発動>${COUNTER_TRIGGER_OJAMA}) / 自カバー(参考)=${coverage}個` +
                (this.cpuMode === 'fast'
                    ? `｜カウンター発火閾値=${thr}点(≒${thrOjama}個＝受け量超えで発火)`
                    : `｜発火閾値=${thr}点(標準)`)
            );
        }
    },

    // bestMoveData があり、操作可能(falling)かつ未着手なら着手を開始する。
    // 前倒し計算（spawnAnim 中に結果到着）では falling になるまで着手を保留する。
    _tryStartExecution() {
        if (!this.isAutoPlay || !this.isActive || !this.bestMoveData) return;
        if (!this.game || this.game.isPaused) return;
        if (this.game._gs !== 'falling') return;
        if (this.isExecutingAction) return;
        this._executeMove(this.bestMoveData.col1, this.bestMoveData.rot1, this.bestMoveData.path);
    },
});
