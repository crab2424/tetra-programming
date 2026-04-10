// ─────────────────────────────────────────────
// cpu1.js
// ぷよCPU lv1 - Web Worker + Wasm 連携版
// PuyoGame インスタンスを受け取り，自動操作を行う
// ─────────────────────────────────────────────

window.PuyoCPU = class {
    constructor(gameInstance) {
        this.game = gameInstance;

        // ────────────────────────────────
        // ★ 評価パラメータ
        // ────────────────────────────────
        this.weights = {
            chainBonus:        500,
            erasedBonus:        20,
            heightPenalty:     -30,
            heightDiffPenalty:  -8,
            holePenalty:       -60,
            flatBonus:           5,
            colorConnBonus:     12,
            zenkeshiBonus:     100,
            p1Weight:           70,
        };

        // ────────────────────────────────
        // 内部状態
        // ────────────────────────────────
        this.isActive          = false;
        this.isAutoPlay        = true;
        this.isCalculating     = false;
        this.currentPairKey    = null; 
        this.bestMoveData      = null; 

        // アクション実行制御
        this.isExecutingAction = false;
        this.actionQueue       = [];
        this.actionDelay       = 80;  // 各アクション間の待機時間 (ms)
        this.placeDelay        = 120; // 設置（固定）前の待機時間 (ms)

        // ────────────────────────────────
        // Web Worker 初期化
        // ────────────────────────────────
        this.workerReady = false;
        this.worker = new Worker('cpu/puyo/lv1/cpu_worker1.js');

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('🚀 Wasm PuyoCPU Worker Ready!');
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this._handleWorkerResult(e.data.result);
            }
        };

        this.worker.onerror = (err) => {
            console.error('❌ PuyoCPU Worker Error:', err.message, err.filename, err.lineno);
        };
    }

    // ══════════════════════════════════════════════
    // 外部 API
    // ══════════════════════════════════════════════

    start() {
        this.isActive = true;
        this._initEstimateContainer(); // ★ 予想手表示用コンテナの初期化
        this._updateLoop();
    }

    stop() {
        this.isActive          = false;
        this.bestMoveData      = null;
        this.isExecutingAction = false;
        this.actionQueue       = [];
        
        // ★ 予想手表示のクリア
        if (this.estimateContainer) {
            this.estimateContainer.innerHTML = '';
        }

        if (this.worker) {
            this.worker.terminate();
            this.worker      = null;
            this.workerReady = false;
        }
    }

    // ══════════════════════════════════════════════
    // メインループ
    // ══════════════════════════════════════════════

    _updateLoop() {
        if (!this.isActive) return;

        const game = this.game;

        if (game._gs === 'falling') {
            const key = `${game.pivotColor}_${game.childColor}_${game.pivotX.toFixed(1)}_${game.pivotY.toFixed(1)}`;
            if (key !== this.currentPairKey) {
                this.currentPairKey    = key;
                this.isExecutingAction = false;
                this.actionQueue       = [];
                this.bestMoveData      = null;
                this._requestCalculation();
            }
        }

        requestAnimationFrame(() => this._updateLoop());
    }

    // ══════════════════════════════════════════════
    // Wasm へ計算を依頼
    // ══════════════════════════════════════════════

    _requestCalculation() {
        if (!this.workerReady || this.isCalculating) return;

        const game = this.game;
        if (!game || game.state !== 'playing') return;

        this.isCalculating = true;

        const TOTAL_ROWS = 14; 
        const COLS       = 6;
        const boardBuffer = new Uint8Array(TOTAL_ROWS * COLS);
        for (let r = 0; r < TOTAL_ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                boardBuffer[r * COLS + c] = game.field[r][c] || 0;
            }
        }

        const pivotColor = game.pivotColor;
        const childColor = game.childColor;
        const next1 = game.nextQueue[0] || [1, 1];
        const next2 = game.nextQueue[1] || [1, 1];

        const weightsArray = new Int32Array([
            this.weights.chainBonus,
            this.weights.erasedBonus,
            this.weights.heightPenalty,
            this.weights.heightDiffPenalty,
            this.weights.holePenalty,
            this.weights.flatBonus,
            this.weights.colorConnBonus,
            this.weights.zenkeshiBonus,
            this.weights.p1Weight,
        ]);

        this.worker.postMessage({
            type:        'calculate',
            boardBuffer: boardBuffer,
            pivotColor:  pivotColor,
            childColor:  childColor,
            next1Pivot:  next1[0],
            next1Child:  next1[1],
            next2Pivot:  next2[0],
            next2Child:  next2[1],
            weightsArray: weightsArray,
        });
    }

    // ══════════════════════════════════════════════
    // Worker からの結果受信
    // ══════════════════════════════════════════════

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

        // スコア表示の更新（画面上にDOMが存在する場合）
        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = this.bestMoveData.score;

        // ★ 予想手表示の描画
        if (this.game.currentMode === 'test') {
            this._renderEstimatePlace();
        }

        // 自動プレイ時は直ちに実行
        if (this.isAutoPlay && this.isActive && !this.game.isPaused) {
            if (!this.isExecutingAction) {
                this._executeMove(this.bestMoveData.col1, this.bestMoveData.rot1);
            }
        }
    }

    // ══════════════════════════════════════════════
    // 予想手（Estimate）の表示
    // ══════════════════════════════════════════════

    _initEstimateContainer() {
        const canvasId = this.game.canvasPrefix ? `${this.game.canvasPrefix}-puyo-main-canvas` : 'puyo-main-canvas';
        const canvas = document.getElementById(canvasId);
        if (!canvas || !canvas.parentNode) return;

        let containerId = `${canvasId}-estimate-overlay`;
        this.estimateContainer = document.getElementById(containerId);

        if (!this.estimateContainer) {
            this.estimateContainer = document.createElement('div');
            this.estimateContainer.id = containerId;
            this.estimateContainer.style.position = 'absolute';
            this.estimateContainer.style.top = '0';
            this.estimateContainer.style.left = '0';
            this.estimateContainer.style.width = '320px'; // ぷよCanvasの幅
            this.estimateContainer.style.height = '656px'; // ぷよCanvasの高さ
            this.estimateContainer.style.pointerEvents = 'none'; 
            this.estimateContainer.style.zIndex = '15'; 
            this.estimateContainer.style.overflow = 'hidden'; 
            canvas.parentNode.appendChild(this.estimateContainer);
        }
    }

    _renderEstimatePlace() {
        if (!this.estimateContainer) this._initEstimateContainer();
        if (!this.estimateContainer) return;
        this.estimateContainer.innerHTML = '';

        // 対戦時やデータが存在しない場合は表示しない
        if (!this.isActive || !this.bestMoveData || this.game.isVersusMode) return;

        // シミュレーション用の盤面コピー（内部行 0〜13）
        const simField = Array.from({ length: 14 }, (_, r) => [...this.game.field[r]]);

        const steps = [
            { col: this.bestMoveData.col1, rot: this.bestMoveData.rot1, colors: [this.game.pivotColor, this.game.childColor], name: 'step1' },
            { col: this.bestMoveData.col2, rot: this.bestMoveData.rot2, colors: this.game.nextQueue[0] || [0,0], name: 'step2' },
            { col: this.bestMoveData.col3, rot: this.bestMoveData.rot3, colors: this.game.nextQueue[1] || [0,0], name: 'step3' }
        ];

        for (const step of steps) {
            if (step.col === -1) continue;
            
            // 落下位置を計算
            const res = this._simulateDrop(simField, step.col, step.rot);
            if (!res) continue;

            // 描画
            this._createEstimatePuyo(res.pivotCol, res.pivotRow, step.colors[0], step.name);
            this._createEstimatePuyo(res.childCol, res.childRow, step.colors[1], step.name);

            // シミュレーション盤面に反映（連鎖の消去まではやらず、単に積み上げるだけ）
            simField[res.pivotRow][res.pivotCol] = step.colors[0];
            simField[res.childRow][res.childCol] = step.colors[1];
        }
    }

    _simulateDrop(field, pc, rot) {
        const DC = [0, 1, 0, -1];
        const cc = pc + DC[rot];

        if (pc < 0 || pc >= 6 || cc < 0 || cc >= 6) return null;

        const getDropRow = (c) => {
            for (let r = 13; r >= 0; r--) {
                if (field[r][c] === 0) return r;
            }
            return -1;
        };

        let pr, cr;
        if (rot === 0) { // 子が上
            pr = getDropRow(pc);
            if (pr < 0) return null;
            cr = pr - 1;
            if (cr < 0 || field[cr][pc] !== 0) return null;
        } else if (rot === 2) { // 子が下
            cr = getDropRow(pc);
            if (cr < 0) return null;
            pr = cr - 1;
            if (pr < 0 || field[pr][pc] !== 0) return null;
        } else { // 横置き
            pr = getDropRow(pc);
            cr = getDropRow(cc);
            if (pr < 0 || cr < 0) return null;
        }

        return { pivotCol: pc, pivotRow: pr, childCol: cc, childRow: cr };
    }

    _createEstimatePuyo(col, row, color, stepClass) {
        if (row < 0 || col < 0 || col >= 6) return;

        // 内部行(0〜13)から表示行(-2〜11)へ変換。0未満の行は画面外
        const displayRow = row - 2; 
        const cellSize = 32;

        const opacityMap = { 'step1': 0.8, 'step2': 0.5, 'step3': 0.3 };
        const zIndexMap = { 'step1': '6', 'step2': '5', 'step3': '4' };
        
        const COLORS = ['#e74c3c', '#2ecc71', '#3498db', '#f1c40f', '#9b59b6'];
        const bgColor = COLORS[color - 1] || '#fff';

        const div = document.createElement('div');
        div.className = `cpu-estimate-puyo ${stepClass}`;
        div.style.position = 'absolute';
        div.style.width = `${cellSize}px`;
        div.style.height = `${cellSize}px`;
        div.style.borderRadius = '50%';
        div.style.backgroundColor = bgColor;
        div.style.opacity = opacityMap[stepClass];
        div.style.zIndex = zIndexMap[stepClass];
        div.style.left = `${col * cellSize}px`;
        div.style.top = `${displayRow * cellSize}px`;
        div.style.boxSizing = 'border-box';
        div.style.border = '2px solid rgba(255,255,255,0.5)';
        
        this.estimateContainer.appendChild(div);
    }

    // ══════════════════════════════════════════════
    // 操作実行
    // ══════════════════════════════════════════════

    _executeMove(targetCol, targetRot) {
        if (!this.isActive || !this.isAutoPlay) return;
        if (this.isExecutingAction) return;

        this.isExecutingAction = true;
        this.actionQueue = this._buildActionQueue(targetCol, targetRot);

        setTimeout(() => {
            this._processActionQueue();
        }, this.actionDelay);
    }

    _buildActionQueue(targetCol, targetRot) {
        const queue = [];
        const game  = this.game;

        const startCol = game.pivotX;
        const startRot = game.targetRot;

        // 1. 回転
        const rotDiff = ((targetRot - startRot) % 4 + 4) % 4;
        if (rotDiff === 1) queue.push({ type: 'rotateCW' });
        else if (rotDiff === 2) { queue.push({ type: 'rotateCW' }); queue.push({ type: 'rotateCW' }); }
        else if (rotDiff === 3) queue.push({ type: 'rotateCCW' });

        // 2. 横移動
        const moveDiff = targetCol - startCol;
        const moveType = moveDiff > 0 ? 'moveRight' : 'moveLeft';
        for (let i = 0; i < Math.abs(moveDiff); i++) {
            queue.push({ type: moveType });
        }

        // 3. 高速落下（ソフトドロップ長押し）
        queue.push({ type: 'softDropUntilLock' });

        return queue;
    }

    _processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            return;
        }

        // ★ Pauseが有効化されている場合は待機して再チェックする
        if (this.game.isPaused || this.game.state === 'paused') {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this._processActionQueue();
            }, 100);
            return;
        }

        if (this.game._gs !== 'falling') {
            this.isExecutingAction = false;
            return;
        }

        const action = this.actionQueue.shift();
        let delayTime = this.actionDelay;
        let isFinalAction = false;

        switch (action.type) {
            case 'rotateCW':
                this.game._tryRotate(1);
                break;
            case 'rotateCCW':
                this.game._tryRotate(-1);
                break;
            case 'moveLeft':
                this.game._tryMove(-1);
                break;
            case 'moveRight':
                this.game._tryMove(1);
                break;
            case 'softDropUntilLock':
                // ★ 高速落下の長押し制御（重力の12倍速想定）
                const limitY = this.game._calcLimitY(this.game.pivotX, this.game.pivotY, this.game.targetRot);
                const step = 0.5; // なめらかに落とすための移動量
                const dropInterval = (500 / 12) * step; // 約20.8msごとの遅延

                if (this.game.pivotY < limitY) {
                    this.game.pivotY = Math.min(this.game.pivotY + step, limitY);
                    this.game.scoreFloat += step;
                    
                    if (this.game.scoreFloat >= 1) {
                        let add = Math.floor(this.game.scoreFloat);
                        this.game.score += add;
                        this.game.scoreFloat -= add;
                        this.game._updateScoreDisplay();
                    }
                    
                    // まだ接地していないので、同じアクションをキューの先頭に戻す
                    this.actionQueue.unshift(action);
                    delayTime = dropInterval;
                } else {
                    // 接地したら固定処理へ移行
                    this._forceLock();
                    isFinalAction = true;
                }
                break;
        }

        // 次のアクションへの移行
        if (!isFinalAction) {
            if (this.actionQueue.length > 0) {
                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) this._processActionQueue();
                }, delayTime);
            } else {
                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                }, this.placeDelay);
            }
        } else {
            this.isExecutingAction = false;
        }
    }

    _forceLock() {
        if (!this.isActive) return;
        if (this.game._gs !== 'falling') return;

        const limitY = this.game._calcLimitY(
            this.game.pivotX,
            this.game.pivotY,
            this.game.targetRot
        );
        this.game.pivotY = limitY;
        this.game.lockTimer = 99999; 
    }
};