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
        this.placeDelay        =  20;

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
        const gs   = game ? game._gs : null;

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
