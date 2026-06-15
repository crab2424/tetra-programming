// ─────────────────────────────────────────────
// cpu5.js（エントリ / Core・Lifecycle）
// ぷよCPU lv5 - Web Worker + Wasm 連携版
//
// ★ファイル分割について（プロトタイプ拡張パターン）
//   PuyoCPU5 は責務ごとに複数ファイルへ分割されている。
//   本ファイルが class 本体（constructor / start / stop / _updateLoop）を定義し、
//   以下のファイルが Object.assign(PuyoCPU5.prototype, {...}) でメソッドを追加する。
//   ディレクトリは weights/（重み）と core/（本体・I/O）に分かれる：
//     - weights/cpu5_weights.js … _initWeights / setMode / _buildWeightsArray（重み定義・配列組立）
//     - weights/cpu5_modes.js   … _modeProfiles（モード別の差分＝build からの上書き）
//     - core/cpu5_worker_io.js  … _requestCalculation / _handleWorkerResult（Worker/Wasm 連携）
//     - core/cpu5_estimate.js   … 着手予測オーバーレイ描画（test モード）
//     - core/cpu5_action.js     … 操作エミュレーション（移動・回転・ソフトドロップ）
//
//   ⚠️ ロード順: 本ファイル（class 定義）を必ず先頭に。次に cpu5_weights.js →
//      cpu5_modes.js（setMode が _modeProfiles を参照）。残りは順不同で prototype を拡張する。
//      読み込みは src/app/modes.js の CPU_CONFIGS（src 配列）と cpu_loader.js が担当。
// ─────────────────────────────────────────────

window.PuyoCPU5 = class {
    constructor(gameInstance) {
        this.game = gameInstance;

        // ★ 評価パラメータ・テンプレートの初期化（cpu5_weights.js）
        this._initWeights();

        this.isActive          = false;
        this.isAutoPlay        = true;
        this.isCalculating     = false;
        this.hasCalculatedForCurrentPiece = false;
        this.bestMoveData      = null;
        this.isExecutingAction = false;
        this.actionQueue       = [];

        this.thinkDelay        = 100;
        this.actionDelay       =  50;
        this.placeDelay        =  20;

        this.originalGravity   = null;
        this.lastDropTime      = null;
        this._softDropRafId    = null;

        this.workerReady = false;
        this.worker = new Worker('cpu/puyo/lv5/wasm/cpu_worker5.js?v=35');

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('🚀 Wasm PuyoCPU5 Worker Ready!');
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this._handleWorkerResult(e.data.result);
            }
        };
    }

    start() {
        this.isActive = true;
        this.hasCalculatedForCurrentPiece = false;
        this._initEstimateContainer();
        this._updateLoop();
    }

    stop() {
        this.isActive          = false;
        this.bestMoveData      = null;
        this.isExecutingAction = false;
        this.actionQueue       = [];
        this.lastDropTime      = null;
        this.hasCalculatedForCurrentPiece = false;

        if (this._softDropRafId !== null) {
            cancelAnimationFrame(this._softDropRafId);
            this._softDropRafId = null;
        }

        this._restoreGravity();

        if (this.estimateContainer) {
            this.estimateContainer.innerHTML = '';
        }

        if (this.worker) {
            this.worker.terminate();
            this.worker      = null;
            this.workerReady = false;
        }
    }

    _updateLoop() {
        if (!this.isActive) return;

        const game = this.game;
        const gs   = game ? game._gs : null;

        // ★ VERSUS：相手ぷよの「発火中連鎖」を毎フレーム監視し、全段打ち切り時の総おじゃま量を保持する。
        //   おじゃまは1段ごとに即送信される(engine.js)ため、CPUの自ツモ単位の計算だけでは
        //   連鎖を盤面上で捕まえられず（読む頃には解決済み）予測量が常に0になる。毎RAFで推定し、
        //   連鎖中は不変＝全段量となる値(_estimateOpponentPuyoChainOjama)を _oppChainFull に控える。
        //   連鎖が終われば 0 に戻る（attackScore が %rate でリセットされ推定が0になる）。
        if (game && game.isVersusMode && this.workerReady) {
            const opp = (typeof this._getOpponentGame === 'function') ? this._getOpponentGame() : null;
            if (opp && (opp instanceof PuyoGame) && opp.chainCount > 0) {
                const estimated = this._estimateOpponentPuyoChainOjama(opp);
                this._oppChainFull = Math.max(this._oppChainFull || 0, estimated || 0);
            } else {
                this._oppChainFull = 0;
            }
        } else {
            this._oppChainFull = 0;
        }

        // ★ 前倒し計算（操作を軽くする）：
        //   spawnAnim は「前ツモの連鎖解決＋おじゃま着弾が完了し、盤面が確定した」状態。
        //   ここから falling 中は盤面が変化しないため、次に出るペア(nextQueue[0])で
        //   先行して探索しておく。falling 突入時には結果が揃っているので、ぷよ出現と
        //   探索レイテンシのスパイクが重ならず操作がスムーズになる。
        if (gs === 'spawnAnim') {
            if (!this.hasCalculatedForCurrentPiece && this.workerReady && !this.isCalculating && game.state === 'playing') {
                this.hasCalculatedForCurrentPiece = true;
                this._beginCalculation(true); // precompute: nextQueue[0] を現ペアとして探索
            }
        } else if (gs === 'falling') {
            // フォールバック：何らかの理由で前倒しできていなければ falling でここで計算する
            if (!this.hasCalculatedForCurrentPiece && this.workerReady && !this.isCalculating && game.state === 'playing') {
                this.hasCalculatedForCurrentPiece = true;
                this._beginCalculation(false);
            }
            // 前倒し計算の結果が既に揃っていれば、falling 突入後に着手を開始する
            this._tryStartExecution();
        } else if (gs !== 'spawn') {
            // 着手完了〜次の spawnAnim までのフェーズ（fix/erase/drop 等）でフラグをリセット。
            // ※ spawn は spawnAnim→falling の同期遷移中の一瞬なので除外（前倒しフラグを保持する）
            this.hasCalculatedForCurrentPiece = false;
        }

        requestAnimationFrame(() => this._updateLoop());
    }

    // 新規計算を開始する前に着手状態をクリアしてから _requestCalculation を呼ぶ。
    _beginCalculation(precompute) {
        this.isExecutingAction = false;
        this.actionQueue       = [];
        this.bestMoveData      = null;
        this.lastDropTime      = null;
        this._requestCalculation(precompute);
    }
};
