// ─────────────────────────────────────────────
// cpu3.js
// ぷよCPU lv3 - Web Worker + Wasm 連携版
// 発火閾値・緊急回避の高さをパラメータとして追加
// ─────────────────────────────────────────────

window.PuyoCPU3 = class {
    constructor(gameInstance) {
        this.game = gameInstance;

        // ────────────────────────────────
        // ★ 評価パラメータ
        // ────────────────────────────────
        this.weights = {
            chainBonus:           200,  // 発火時の基本ボーナス（C++側で連鎖の3乗倍などで増幅）
            erasedBonus:           10,  
            heightPenalty:       -200,
            heightDiffPenalty:     -8,
            flatBonus:             20,
            colorConnBonus:        80,
            zenkeshiBonus:        100,
            chainPotentialBonus:   50,  // ポテンシャルの基本ボーナス
            p1Weight:             100,  
            templateBonus:        500,  
            ignitionThreshold:      7,  // 基本の発火閾値（おじゃまが少ない場合）
            emergencyHeight:       10,  // 緊急回避ライン
        };

        this.TEMPLATE_PATTERNS = {
            'gtr': [
                0, 0, 0, 0, 0, 0,  // 盤面の上から数えて一番上の行は空洞（GTRは下3段で組むため）
                2, 1, 3, 6, 6, 6, 
                2, 2, 1, 3, 6, 6,
                1, 1, 3, 6, 6, 6
            ],
            'key': [
                1, 2, 3, 4, 5, 0,
                2, 3, 4, 5, 1, 0,
                1, 2, 3, 4, 5, 0,
                1, 2, 3, 4, 5, 0,
            ],
        };

        this.isActive          = false;
        this.isAutoPlay        = true;
        this.isCalculating     = false;
        this.hasCalculatedForCurrentPiece = false; 
        this.bestMoveData      = null; 
        this.isExecutingAction = false;
        this.actionQueue       = [];
        
        this.templateActive    = true; // テンプレを1プレイ1回に制限するためのフラグ
        this.lastPuyoCount     = 0;    // 盤面のぷよ数を監視して発火を検知
        
        this.thinkDelay        = 400;      
        this.actionDelay       = 150;      
        this.placeDelay        = 200;      

        this.originalGravity   = null;     
        this.lastDropTime      = null;     
        this._softDropRafId    = null;

        this.workerReady = false;
        this.worker = new Worker('cpu/puyo/lv3/cpu_worker3.js');

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('🚀 Wasm PuyoCPU3 Worker Ready!');
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this._handleWorkerResult(e.data.result);
            }
        };
    }

    start() {
        this.isActive = true;
        this.hasCalculatedForCurrentPiece = false;
        this.templateActive = true; 
        this.lastPuyoCount = 0;
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

    _requestCalculation() {
        if (!this.workerReady || this.isCalculating) return;

        const game = this.game;
        if (!game || game.state !== 'playing') return;

        this.isCalculating = true;

        const TOTAL_ROWS = 17; 
        const COLS       = 6;
        let currentPuyoCount = 0;
        let ojamaCount = 0; // ★ おじゃまぷよの数をカウント
        const boardBuffer = new Uint8Array(TOTAL_ROWS * COLS);
        
        for (let r = 0; r < TOTAL_ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                boardBuffer[r * COLS + c] = game.field[r][c] || 0;
                if (boardBuffer[r * COLS + c] !== 0) {
                    currentPuyoCount++;
                    if (boardBuffer[r * COLS + c] === 6) {
                        ojamaCount++; // ★ 6はおじゃまぷよ
                    }
                }
            }
        }

        // ぷよが減った（連鎖で消えた）場合は、テンプレ構築を完全に終了する
        if (currentPuyoCount < this.lastPuyoCount - 2) {
            this.templateActive = false;
        }
        this.lastPuyoCount = currentPuyoCount;

        const nextPairs = new Int32Array(20);
        
        nextPairs[0] = game.pivotColor;
        nextPairs[1] = game.childColor;
        
        for (let i = 0; i < 9; i++) {
            if (game.nextQueue && game.nextQueue[i]) {
                nextPairs[(i + 1) * 2]     = game.nextQueue[i][0];
                nextPairs[(i + 1) * 2 + 1] = game.nextQueue[i][1];
            } else {
                nextPairs[(i + 1) * 2]     = (i % 4) + 1;
                nextPairs[(i + 1) * 2 + 1] = ((i + 1) % 4) + 1;
            }
        }

        const gtrPattern    = this.TEMPLATE_PATTERNS['gtr'];
        const keyPattern    = this.TEMPLATE_PATTERNS['key'];
        const gtrBuffer     = new Uint8Array(24);
        const keyBuffer     = new Uint8Array(24);
        
        for (let i = 0; i < 24; i++) {
            gtrBuffer[i] = gtrPattern[i];
            keyBuffer[i]   = keyPattern[i];
        }

        // ★ おじゃまぷよの数に応じて発火閾値を動的に変更
        let dynamicIgnitionThreshold = this.weights.ignitionThreshold;
        if (ojamaCount >= 15) {
            dynamicIgnitionThreshold = 2; // 15個以上で2連鎖妥協
        } else if (ojamaCount >= 10) {
            dynamicIgnitionThreshold = 4; // 10個以上で4連鎖妥協
        } else if (ojamaCount >= 5) {
            dynamicIgnitionThreshold = 6; // 5個以上で6連鎖妥協
        }

        const weightsArray = new Int32Array([
            this.weights.chainBonus,
            this.weights.erasedBonus,
            this.weights.heightPenalty,
            this.weights.heightDiffPenalty,
            this.weights.flatBonus,
            this.weights.colorConnBonus,
            this.weights.zenkeshiBonus,
            this.weights.chainPotentialBonus, 
            this.weights.p1Weight,            
            this.templateActive ? this.weights.templateBonus : 0,  
            dynamicIgnitionThreshold,         // ★ 基本値の代わりに動的閾値を渡す
            this.weights.emergencyHeight      
        ]);

        this.worker.postMessage({
            type:           'calculate',
            boardBuffer:    boardBuffer,
            nextPairs:      nextPairs,      
            weightsArray:   weightsArray,
            gtrBuffer:      gtrBuffer,   
            keyBuffer:      keyBuffer       
        });
    }

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

        const rotDiff = ((targetRot - startRot) % 4 + 4) % 4;
        if (rotDiff === 1) queue.push({ type: 'rotateCW' });
        else if (rotDiff === 2) { queue.push({ type: 'rotateCW' }); queue.push({ type: 'rotateCW' }); }
        else if (rotDiff === 3) queue.push({ type: 'rotateCCW' });

        const moveDiff = targetCol - startCol;
        const moveType = moveDiff > 0 ? 'moveRight' : 'moveLeft';
        for (let i = 0; i < Math.abs(moveDiff); i++) {
            queue.push({ type: moveType });
        }

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
                this._startSoftDropLoop();
                return; 
        }

        if (this.actionQueue.length > 0) {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this._processActionQueue();
            }, this.actionDelay);
        } else {
            this._restoreGravity();
            this.isExecutingAction = false;
        }
    }

    _startSoftDropLoop() {
        if (this._softDropRafId !== null) {
            cancelAnimationFrame(this._softDropRafId);
            this._softDropRafId = null;
        }

        if (this.game.fallTimer !== undefined) this.game.fallTimer = 0;
        if (this.game.dropTimer !== undefined) this.game.dropTimer = 0;

        if (this.originalGravity === null && this.game.gravity !== undefined) {
            this.originalGravity = this.game.gravity;
            this.game.gravity = 0;
        }

        const dropSpeedFast = 500 / 12; 

        let prevTime = performance.now();

        const tick = (now) => {
            if (!this.isActive || !this.isAutoPlay) {
                this._softDropRafId = null;
                this._restoreGravity();
                this.isExecutingAction = false;
                return;
            }

            if (this.game.isPaused || this.game.state === 'paused') {
                this._softDropRafId = requestAnimationFrame(tick);
                prevTime = now; 
                return;
            }

            if (this.game._gs !== 'falling') {
                this._softDropRafId = null;
                this._restoreGravity();
                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                }, this.placeDelay);
                return;
            }

            let dt = now - prevTime;
            if (dt > 100) dt = 100; 
            prevTime = now;

            const limitY = this.game._calcLimitY(
                this.game.pivotX,
                this.game.pivotY,
                this.game.targetRot
            );

            if (this.game.pivotY < limitY) {
                const dropDist = dt / dropSpeedFast;
                const prevY = this.game.pivotY;
                this.game.pivotY = Math.min(this.game.pivotY + dropDist, limitY);
                const actualDist = this.game.pivotY - prevY;

                this.game.scoreFloat += actualDist;
                if (this.game.scoreFloat >= 1) {
                    const add = Math.floor(this.game.scoreFloat);
                    this.game.score += add;
                    this.game.scoreFloat -= add;
                    if (typeof this.game._addDropScore === 'function') {
                        this.game._addDropScore(add);
                    }
                    this.game._updateScoreDisplay();
                }

                this._softDropRafId = requestAnimationFrame(tick);
            } else {
                this.game.pivotY = limitY;
                this._softDropRafId = null;
                this._restoreGravity();

                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                }, this.placeDelay);
            }
        };

        this._softDropRafId = requestAnimationFrame(tick);
    }

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