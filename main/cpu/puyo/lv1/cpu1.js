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
        
        // ★ CPU lv1 向けの遅延設定
        this.thinkDelay        = 600;      // 思考時間（動き出すまでの待機 ms）
        this.actionDelay       = 250;      // 左右移動・回転の待機時間 (ms)
        this.placeDelay        = 400;      // 接地から固定までの待機時間 (ms)

        this.originalGravity   = null;     // 高速落下時の重力退避用
        this.lastDropTime      = null;     // 高速落下時の dt 計算用

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

        // ────────────────────────────────
        // ★ CPU操作時のPauseキー監視
        // ────────────────────────────────
        this._pauseListener = (e) => {
            if (!this.isActive) return;
            
            const gamePage = document.getElementById('game-page');
            const versusPage = document.getElementById('versus-page');
            if (!(gamePage && gamePage.classList.contains('active')) &&
                !(versusPage && versusPage.classList.contains('active'))) {
                return;
            }
            
            const ks = (typeof loadKeys === 'function') ? loadKeys() : {};
            const pauseKey = ks.pause ? ks.pause.code : 'Escape';
            
            if (e.code === pauseKey) {
                e.preventDefault();
                if (!this.game.isVersusMode) {
                    if (typeof this.game._onPauseKey === 'function') {
                        this.game._onPauseKey();
                    }
                }
            }
        };
    }

    // ══════════════════════════════════════════════
    // 外部 API
    // ══════════════════════════════════════════════

    start() {
        this.isActive = true;
        this._initEstimateContainer(); 
        document.addEventListener('keydown', this._pauseListener);
        this._updateLoop();
    }

    stop() {
        this.isActive          = false;
        this.bestMoveData      = null;
        this.isExecutingAction = false;
        this.actionQueue       = [];
        this.lastDropTime      = null;
        
        this._restoreGravity(); // 中断時も確実に重力を元に戻す

        document.removeEventListener('keydown', this._pauseListener);

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
                this.lastDropTime      = null; // 新しいぷよに切り替わったらリセット
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

        const TOTAL_ROWS = 17; 
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
            this.estimateContainer.style.width = '320px';
            this.estimateContainer.style.height = '656px'; 
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

        if (!this.isActive || !this.bestMoveData || this.game.isVersusMode) return;

        const simField = Array.from({ length: 17 }, (_, r) => [...this.game.field[r]]);

        const steps = [
            { col: this.bestMoveData.col1, rot: this.bestMoveData.rot1, colors: [this.game.pivotColor, this.game.childColor], name: 'step1' },
            { col: this.bestMoveData.col2, rot: this.bestMoveData.rot2, colors: this.game.nextQueue[0] || [0,0], name: 'step2' },
            { col: this.bestMoveData.col3, rot: this.bestMoveData.rot3, colors: this.game.nextQueue[1] || [0,0], name: 'step3' }
        ];

        for (const step of steps) {
            if (step.col === -1) continue;
            
            const res = this._simulateDrop(simField, step.col, step.rot);
            if (!res) continue;

            this._createEstimatePuyo(res.pivotCol, res.pivotRow, step.colors[0], step.name);
            this._createEstimatePuyo(res.childCol, res.childRow, step.colors[1], step.name);

            simField[res.pivotRow][res.pivotCol] = step.colors[0];
            simField[res.childRow][res.childCol] = step.colors[1];
        }
    }

    _simulateDrop(field, pc, rot) {
        const DC = [0, 1, 0, -1];
        const cc = pc + DC[rot];

        if (pc < 0 || pc >= 6 || cc < 0 || cc >= 6) return null;

        const getDropRow = (c) => {
            for (let r = 16; r >= 0; r--) {
                if (field[r][c] === 0) return r;
            }
            return -1;
        };

        let pr, cr;
        if (rot === 0) { 
            pr = getDropRow(pc);
            if (pr < 0) return null;
            cr = pr - 1;
            if (cr < 0 || field[cr][pc] !== 0) return null;
        } else if (rot === 2) { 
            cr = getDropRow(pc);
            if (cr < 0) return null;
            pr = cr - 1;
            if (pr < 0 || field[pr][pc] !== 0) return null;
        } else { 
            pr = getDropRow(pc);
            cr = getDropRow(cc);
            if (pr < 0 || cr < 0) return null;
        }

        return { pivotCol: pc, pivotRow: pr, childCol: cc, childRow: cr };
    }

    _createEstimatePuyo(col, row, color, stepClass) {
        if (row < 0 || col < 0 || col >= 6) return;

        const scaleX = 320 / 192;
        const scaleY = 656 / 384;

        const dispWidth = 32 * scaleX;
        const dispHeight = 32 * scaleY;

        const displayRow = row - 5; 

        const opacityMap = { 'step1': 0.8, 'step2': 0.5, 'step3': 0.3 };
        const zIndexMap = { 'step1': '6', 'step2': '5', 'step3': '4' };
        
        const COLORS = ['#e74c3c', '#3498db', '#9b59b6', '#2ecc71', '#f1c40f'];
        const bgColor = COLORS[color - 1] || '#fff';

        const div = document.createElement('div');
        div.className = `cpu-estimate-puyo ${stepClass}`;
        div.style.position = 'absolute';
        
        div.style.width = `${dispWidth}px`;
        div.style.height = `${dispHeight}px`;
        div.style.left = `${col * dispWidth}px`;
        div.style.top = `${displayRow * dispHeight}px`;
        
        div.style.borderRadius = '50%';
        div.style.backgroundColor = bgColor;
        div.style.opacity = opacityMap[stepClass];
        div.style.zIndex = zIndexMap[stepClass];
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
        }, this.thinkDelay);
    }

    _buildActionQueue(targetCol, targetRot) {
        const queue = [];
        const game  = this.game;

        const startCol = game.pivotX;
        const startRot = game.targetRot;

        // ① 回転
        const rotDiff = ((targetRot - startRot) % 4 + 4) % 4;
        if (rotDiff === 1) queue.push({ type: 'rotateCW' });
        else if (rotDiff === 2) { queue.push({ type: 'rotateCW' }); queue.push({ type: 'rotateCW' }); }
        else if (rotDiff === 3) queue.push({ type: 'rotateCCW' });

        // ② 移動 (1マスずつ)
        const moveDiff = targetCol - startCol;
        const moveType = moveDiff > 0 ? 'moveRight' : 'moveLeft';
        for (let i = 0; i < Math.abs(moveDiff); i++) {
            queue.push({ type: moveType });
        }

        // ③ 高速落下
        queue.push({ type: 'softDropUntilLock' });

        return queue;
    }

    _processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            this._restoreGravity();
            return;
        }

        if (this.game.isPaused || this.game.state === 'paused') {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this._processActionQueue();
            }, 100);
            return;
        }

        if (this.game._gs !== 'falling') {
            this.isExecutingAction = false;
            this._restoreGravity();
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
                // ★ 高速落下中のみ重力(自然落下)タイマーをリセットし続ける
                if (this.game.fallTimer !== undefined) this.game.fallTimer = 0;
                if (this.game.dropTimer !== undefined) this.game.dropTimer = 0;
                
                // テト側で呼ばれた場合の考慮
                if (this.originalGravity === null && this.game.gravity !== undefined) {
                    this.originalGravity = this.game.gravity;
                    this.game.gravity = 0; 
                }

                // dt 計算用の初期化（ループ開始時）
                if (!this.lastDropTime) {
                    this.lastDropTime = performance.now();
                    this.actionQueue.unshift(action);
                    delayTime = 0; 
                    break; // 初回は時間を記録して即座に抜ける（次のフレームで処理）
                }

                // 前回のフレームからの経過時間を計算
                let now = performance.now();
                let dt = now - this.lastDropTime;
                if (dt > 100) dt = 16.6; // 最大遅延のガード
                this.lastDropTime = now;

                const limitY = this.game._calcLimitY(this.game.pivotX, this.game.pivotY, this.game.targetRot);
                
                if (this.game.pivotY < limitY) {
                    // ★ プレイヤー操作の softDrop と同じ落下計算 (dt / PConfig.dropSpeedFast)
                    const dropSpeedFast = 500 ;
                    const dropDist = dt / dropSpeedFast;
                    
                    this.game.pivotY = Math.min(this.game.pivotY + dropDist, limitY);
                    
                    this.game.scoreFloat += dropDist;
                    if (this.game.scoreFloat >= 1) {
                        let add = Math.floor(this.game.scoreFloat);
                        this.game.score += add;
                        this.game.scoreFloat -= add;
                        if(typeof this.game._addDropScore === 'function') {
                            this.game._addDropScore(add);
                        }
                        this.game._updateScoreDisplay();
                    }
                    
                    this.actionQueue.unshift(action); // 継続
                } else {
                    // 完全に接地したらループ終了
                    this.lastDropTime = null;
                    this._restoreGravity();
                }
                break;
        }

        if (!isFinalAction) {
            if (this.actionQueue.length > 0) {
                const nextAction = this.actionQueue[0];
                // ★ 高速落下が継続中の場合は requestAnimationFrame を使って 60fps ベースで滑らかに呼び出す
                if (action.type === 'softDropUntilLock' && nextAction && nextAction.type === 'softDropUntilLock') {
                    requestAnimationFrame(() => {
                        if (this.isActive && this.isAutoPlay) this._processActionQueue();
                    });
                } else {
                    // 回転や移動は規定のディレイを使用
                    setTimeout(() => {
                        if (this.isActive && this.isAutoPlay) this._processActionQueue();
                    }, delayTime);
                }
            } else {
                this._restoreGravity(); // キューが空になったら確実に重力を戻す
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

    // ★ 一時的にゼロにした重力を復元するヘルパー
    _restoreGravity() {
        if (this.originalGravity !== null && this.game) {
            this.game.gravity = this.originalGravity;
            this.originalGravity = null;
        }
    }

    _forceLock() {
        this._restoreGravity();
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