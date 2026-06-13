// ─────────────────────────────────────────────
// cpu4.js（エントリ / Core・Lifecycle）
// ぷよCPU lv4 - Web Worker + Wasm 連携版
//
// ★ファイル分割について（プロトタイプ拡張パターン）
//   PuyoCPU4 は責務ごとに複数ファイルへ分割されている。
//   本ファイルが class 本体（constructor / start / stop / _updateLoop）を定義し、
//   以下のファイルが Object.assign(PuyoCPU4.prototype, {...}) でメソッドを追加する：
//     - cpu4_weights.js    … _initWeights / _buildWeightsArray（重み定義・動的閾値・配列組立）
//     - cpu4_worker_io.js  … _requestCalculation / _handleWorkerResult（Worker/Wasm 連携）
//     - cpu4_estimate.js   … 着手予測オーバーレイ描画（test モード）
//     - cpu4_action.js     … 操作エミュレーション（移動・回転・ソフトドロップ）
//
//   ⚠️ ロード順: 本ファイル（class 定義）を必ず先頭に。残りは順不同で prototype を拡張する。
//      読み込みは src/app/modes.js の CPU_CONFIGS（src 配列）と cpu_loader.js が担当。
// ─────────────────────────────────────────────

window.PuyoCPU4 = class {
    constructor(gameInstance) {
        this.game = gameInstance;

        // ★ 評価パラメータ・テンプレートの初期化（cpu4_weights.js）
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
        this.placeDelay        =  80;

        this.originalGravity   = null;
        this.lastDropTime      = null;
        this._softDropRafId    = null;

        this.workerReady = false;
        this.worker = new Worker('cpu/puyo/lv4/wasm/cpu_worker4.js?v=13');

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('🚀 Wasm PuyoCPU4 Worker Ready!');
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

        if (game._gs === 'falling') {
            if (!this.hasCalculatedForCurrentPiece && this.workerReady && !this.isCalculating && game && game.state === 'playing') {
                this.hasCalculatedForCurrentPiece = true;

                this.isExecutingAction = false;
                this.actionQueue       = [];
                this.bestMoveData      = null;
                this.lastDropTime      = null;
                this._requestCalculation();
            }
        } else {
            this.hasCalculatedForCurrentPiece = false;
        }

        requestAnimationFrame(() => this._updateLoop());
    }
};
