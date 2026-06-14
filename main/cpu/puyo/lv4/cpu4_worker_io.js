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
        let ojamaCount = 0; // ★ おじゃまぷよの数をカウント
        const boardBuffer = new Uint8Array(TOTAL_ROWS * COLS);

        for (let r = 0; r < TOTAL_ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                boardBuffer[r * COLS + c] = game.field[r][c] || 0;
                if (boardBuffer[r * COLS + c] === 6) {
                    ojamaCount++; // ★ 6はおじゃまぷよ
                }
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

        // ★ おじゃま数に応じた動的閾値を反映した weightsArray を組み立てる（cpu4_weights.js）
        const weightsArray = this._buildWeightsArray(ojamaCount, knownNextCount);

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

        this.bestMoveData = {
            col1: res[0], rot1: res[1],
            score: res[2],
            col2: res[3], rot2: res[4],
            col3: res[5], rot3: res[6],
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

    // bestMoveData があり、操作可能(falling)かつ未着手なら着手を開始する。
    // 前倒し計算（spawnAnim 中に結果到着）では falling になるまで着手を保留する。
    _tryStartExecution() {
        if (!this.isAutoPlay || !this.isActive || !this.bestMoveData) return;
        if (!this.game || this.game.isPaused) return;
        if (this.game._gs !== 'falling') return;
        if (this.isExecutingAction) return;
        this._executeMove(this.bestMoveData.col1, this.bestMoveData.rot1);
    },
});
