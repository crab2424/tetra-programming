// ─────────────────────────────────────────────
// cpu4_worker_io.js（Worker / Wasm 連携）
//   PuyoCPU4.prototype を拡張する（cpu4.js が class 本体を定義済みであること）。
//
//   _requestCalculation()  … 盤面/NEXT/重みをバッファ化して Worker へ postMessage
//   _handleWorkerResult()  … Wasm の探索結果を受け取り、bestMoveData 反映・着手開始
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU4.prototype, {

    _requestCalculation() {
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

        nextPairs[0] = game.pivotColor;
        nextPairs[1] = game.childColor;

        // ★ 実際に見えているNEXTの本数（現在ペアを除く）。
        //   期待連鎖スコア選択で「ここから先は擬似未来ツモで分岐する」境界として使う。
        let knownNextCount = 0;
        for (let i = 0; i < 9; i++) {
            if (game.nextQueue && game.nextQueue[i]) {
                nextPairs[(i + 1) * 2]     = game.nextQueue[i][0];
                nextPairs[(i + 1) * 2 + 1] = game.nextQueue[i][1];
                if (knownNextCount === i) knownNextCount = i + 1; // 先頭から連続して既知の本数
            } else {
                nextPairs[(i + 1) * 2]     = (i % 4) + 1;
                nextPairs[(i + 1) * 2 + 1] = ((i + 1) % 4) + 1;
            }
        }

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
            if (this.isAutoPlay && this.isActive && !this.game.isPaused) {
                this._executeMove(2, 0);
            }
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

        if (this.isAutoPlay && this.isActive && !this.game.isPaused) {
            if (!this.isExecutingAction) {
                this._executeMove(this.bestMoveData.col1, this.bestMoveData.rot1);
            }
        }
    },
});
