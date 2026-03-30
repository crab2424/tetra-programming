// ─────────────────────────────────────────────
// cpu3.js
// 2手読みCPU（NEXT1、HOLD考慮） - Wasm Worker 非同期連携版
// ─────────────────────────────────────────────

// ★修正：動的ロードで破棄・再定義できるように、windowオブジェクトに明示的に登録する
window.CPU3 = class {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; 
        this.currentMino = null;
        this.baseScore = 0;     

        this.weights = {
            lineClear: 14,
            hole: -36, 
            heightLimit: -22, 
            heightDiff: -7, 
            flat: 4,
            step1Good: 3, 
            step1Bad: -2, 
            step2Plus: -8, 
            groundedBonus: 12, 
            touchingBonus: 6,   
            underSpace: -6, 
            singleWell: 5, 
            multiWell: -10,
            
            iWell: 32,           
            iWellOver: -10,      
            blocksOverHole: -3, 
            
            line4: 200,          
            downstackGood: 48,   
            downstackBad: -3,
            tsdShape: 300,     // 
            tsdClear: 640,    // 実際にTSDを打った時の特大ボーナス

            P1_WEIGHT: 0.8,        

            
        };

        this.worker = new Worker('cpu/lv3/cpu_worker3.js');
        this.workerReady = false;
        this.isCalculating = false;

        this.isExecutingAction = false; // アクション実行中かどうかのフラグ
        this.actionQueue = [];          // 実行する操作のキュー（配列）
        this.actionDelay = 1000;          // 1操作ごとの待機時間(ミリ秒)。好みに合わせて調整可能
        

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log("🚀 Wasm Worker 3 Ready!"); 
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this.handleWorkerResult(e.data.result);
            }
        };

        this.worker.onerror = (err) => {
            console.error("❌ Worker 3 Error: ", err.message, err.filename, err.lineno);
        };
    }

    // ★2. 既存の executeAction を以下の内容でまるごと上書きしてください
    executeAction(bestResult) {
        if (!this.isActive) return;

        this.bestEstimate = bestResult;

        if (this.isAutoPlay) {
            // 既にアクション実行中なら重複させない
            if (this.isExecutingAction) return;

            this.isExecutingAction = true;
            // 操作キューを構築
            this.actionQueue = this.buildActionQueue(bestResult);
            // キューの処理を開始
            this.processActionQueue();

            // ★修正ポイント2: すぐに開始せず、最初の1手目にも少しだけラグを入れる
            setTimeout(() => {
                this.processActionQueue();
            }, this.actionDelay);
        }
    }


    // ★3. クラス内に以下の3つの新しいメソッド（buildActionQueue, processActionQueue, updateMinoBlocks）を追加してください

    // 受け取った結果から、実際のキー入力のような操作順序を組み立てる
    buildActionQueue(bestResult) {
        let queue = [];
        
        // 1. HOLDするかしないか
        if (bestResult.action === 1) {
            // ホールドする場合は0.2秒(200ms)待機する指定
            queue.push({ type: 'hold', delay: 200 });
            // HOLD後は新しいミノが降ってくるため、ここで今回のシーケンスは終了
            return queue;
        }

        // 2. 回転 (左右どちらか使って回す)
        let currentRot = this.game.currentMino.rot;
        let targetRot = bestResult.rot;
        let diff = (targetRot - currentRot + 4) % 4; // 回転の差分(0〜3)
        
        if (diff === 1) {
            queue.push({ type: 'rotate', dir: 1, delay: this.actionDelay }); // 右回転1回
        } else if (diff === 2) {
            queue.push({ type: 'rotate', dir: 1, delay: this.actionDelay }); 
            queue.push({ type: 'rotate', dir: 1, delay: this.actionDelay }); // 2回回転
        } else if (diff === 3) {
            queue.push({ type: 'rotate', dir: -1, delay: this.actionDelay }); // 左回転1回
        }

        // 3. 移動 (目標のX座標を設定)
        let targetX = bestResult.x;
        queue.push({ type: 'moveToTargetX', targetX: targetX, delay: this.actionDelay });

        // 4. (将来、ソフドロからの回転入れを実装予定)
        // // ▼ 追加：Tスピンの場合は穴の中にワープさせる ▼
        if (bestResult.isTSpin) {
            queue.push({ type: 'warpToY', targetY: bestResult.y, delay: this.actionDelay });
        };

        // 5. ハードドロップ
        queue.push({ type: 'harddrop', delay: this.actionDelay });

        return queue;
    }

    // キューから操作を1つ取り出して実行し、次を予約する
    processActionQueue() {
        // 中断されたり、キューが空になったら終了
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            return;
        }

        const action = this.actionQueue.shift();

        // ★修正ポイント4: 現在のミノがゲーム側で確定(ロック)されていないか確認
        // (ゲームループ側で勝手に着地判定されてしまうのを防ぐ)
        if (!this.game.currentMino) {
            this.isExecutingAction = false;
            this.actionQueue = [];
            return;
        }

        switch (action.type) {
            case 'hold':
                this.game.hold();
                break;
                
            case 'rotate':
                if (action.dir === 1) {
                    this.game.currentMino.rot = (this.game.currentMino.rot + 1) % 4;
                } else {
                    this.game.currentMino.rot = (this.game.currentMino.rot + 3) % 4;
                }
                this.updateMinoBlocks();
                break;
                
            case 'moveToTargetX':
                // targetX に向かって1マスずつ移動し、まだ到達していなければキューの先頭に戻す
                if (this.game.currentMino.x < action.targetX) {
                    this.game.currentMino.x++;
                    this.updateMinoBlocks();
                    this.actionQueue.unshift(action); // まだ移動が必要なのでキューに戻す
                } else if (this.game.currentMino.x > action.targetX) {
                    this.game.currentMino.x--;
                    this.updateMinoBlocks();
                    this.actionQueue.unshift(action); // まだ移動が必要なのでキューに戻す
                }
                break;

            // ▼ 追加：ワープ処理 ▼
            case 'warpToY':
                this.game.currentMino.y = action.targetY;
                this.updateMinoBlocks();
                break;
                
            case 'harddrop':
                let dropDistance = 0;
                while (!this.game.checkCollision(0, dropDistance + 1, this.game.currentMino)) {
                    dropDistance++;
                }
                this.game.currentMino.y += dropDistance;
                this.updateMinoBlocks();
                this.game.lockMino(); // 固定
                break;
        }

        // 描画を即座に反映させる（gameオブジェクトに描画メソッドがある場合）
        if (typeof this.game.draw === 'function') {
            this.game.draw();
        } else if (typeof this.game.render === 'function') {
            this.game.render();
        }

        if (this.actionQueue.length > 0) {
            let delayTime = action.delay || this.actionDelay;
            // アロー関数で this を保持しつつタイマーセット
            setTimeout(() => {
                // タイマー発火時にまだアクティブか再確認
                if (this.isActive && this.isAutoPlay) {
                    this.processActionQueue();
                }
            }, delayTime);
        } else {
            // ここで即座に false にせず、少しだけ余韻を残す(任意)
            setTimeout(() => {
                this.isExecutingAction = false;
            }, 50);
        }
    }

    // 回転や移動をした際に、ブロックの実座標データを更新するための補助メソッド
    updateMinoBlocks() {
        if (this.game.currentMino) {
            this.game.currentMino.blocks = this.game.getBlocks(
                this.game.currentMino.id,
                this.game.currentMino.rot,
                this.game.currentMino.x,
                this.game.currentMino.y
            );
        }
    }

    initEstimateContainer() {
        const canvasId = this.game.canvasPrefix ? `${this.game.canvasPrefix}-main-canvas` : 'main-canvas';
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

    start() {
        this.isActive = true;
        this.initEstimateContainer();
        this.updateLoop();
    }

    stop() {
        this.isActive = false;
        this.bestMoveData = null;
        if (this.estimateContainer) {
            this.estimateContainer.innerHTML = '';
        }
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.workerReady = false;
        }
    }

    updateLoop() {
        if (!this.isActive) return;
        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.onMinoSpawned();
        }
        requestAnimationFrame(() => this.updateLoop());
    }

    onMinoSpawned() {
        const diffEl = document.getElementById('eval-diff');
        if (diffEl) diffEl.textContent = ''; 

        const mino = this.game.mino;
        if (!mino) return;

        if (!this.workerReady) {
            if (this.isAutoPlay) setTimeout(() => this.game.hardDrop(), 700);
            return;
        }

        if (this.isCalculating) return;
        this.isCalculating = true; 

        let boardBuffer = new Uint8Array(200);
        this.game.field.blocks.forEach(b => {
            if (b.y >= 0 && b.y < 20 && b.x >= 0 && b.x < 10) {
                boardBuffer[b.y * 10 + b.x] = 1; 
            }
        });

        let weightsArray = new Int32Array([
            this.weights.lineClear, this.weights.hole, this.weights.heightLimit,
            this.weights.heightDiff, this.weights.flat, this.weights.step1Good,
            this.weights.step1Bad, this.weights.step2Plus, this.weights.groundedBonus,
            this.weights.touchingBonus, 
            this.weights.iWell, this.weights.iWellOver, this.weights.blocksOverHole,
            this.weights.line4, this.weights.downstackGood, this.weights.downstackBad
        ]);

        let holdType = this.game.holdMino !== null ? this.game.holdMino.type : -1;

        this.worker.postMessage({
            type: 'calculate',
            boardBuffer: boardBuffer,
            currentType: mino.type,
            holdType: holdType,
            next1: this.game.nextQueue[0].type,
            next2: this.game.nextQueue[1].type,
            canHold: this.game.canHold ? 1 : 0,
            weightsArray: weightsArray
        });
    }

    handleWorkerResult(res) {
        this.isCalculating = false; 

        let actionInt = res[0];
        
        if (actionInt === -1) {
            this.bestMoveData = null;
            if (this.isAutoPlay && this.isActive && !this.game.isPaused) {
                setTimeout(() => this.game.hardDrop(), 700);
            }
            return;
        }

        let bestMove = {
            action: actionInt === 1 ? 'hold' : 'play',
            score: res[1],
            diff: res[2],
            id: res[3], rot: res[4], x: res[5], spawnY: res[7],
            p1: { id: res[3], rot: res[4], x: res[5], y: res[6] },
            p2: res[8] !== -1 ? { id: res[8], rot: res[9], x: res[10], y: res[11] } : null,
            isTSpin: (res[12] === 1) // ★C++から受け取ったフラグ
        };

        this.bestMoveData = bestMove;

        if (bestMove.p1) {
            let simMino1 = new Mino(bestMove.p1.id);
            for(let i = 0; i < bestMove.p1.rot; i++) simMino1.rotate();
            let droppedBlocks1 = simMino1.blocks.map(b => ({ x: b.x + bestMove.p1.x, y: b.y + bestMove.p1.y }));
            bestMove.clearedLines = this.getClearedLines(this.game.field.blocks, droppedBlocks1);
        }

        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = bestMove.score;

        const diffEl = document.getElementById('eval-diff');
        if (diffEl) {
            diffEl.style.color = '';
            if (bestMove.diff > 0) {
                diffEl.textContent = `(+${bestMove.diff})`;
                diffEl.className = 'eval-diff-plus';
            } else if (bestMove.diff < 0) {
                diffEl.textContent = `(${bestMove.diff})`;
                diffEl.className = 'eval-diff-minus';
            } else {
                diffEl.textContent = `(±0)`;
                diffEl.className = '';
                diffEl.style.color = 'var(--text-dim)';
            }
        }

        if (this.game.currentMode === 'test') {
            this.renderEstimatePlace(); 
        }

        if (this.isAutoPlay && this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
            if (bestMove.action === 'hold') {
                setTimeout(() => {
                    if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                        this.game.holdCurrentMino();
                    }
                }, 200);
            } else {
                this.moveMinoTo(bestMove.id, bestMove.rot, bestMove.x, bestMove.spawnY);
                setTimeout(() => {
                    if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                        this.game.hardDrop();
                    }
                }, 800);
            }
        }
    }

    getClearedLines(fieldBlocks, minoBlocks) {
        let blocks = [];
        for (let i = 0; i < fieldBlocks.length; i++) blocks.push({ x: fieldBlocks[i].x, y: fieldBlocks[i].y });
        for (let i = 0; i < minoBlocks.length; i++) blocks.push({ x: minoBlocks[i].x, y: minoBlocks[i].y });
        
        let clearedRowIndices = [];
        for (let r = 0; r < 20; r++) {
            let rowCount = blocks.filter(b => b.y === r).length;
            if (rowCount === 10) { 
                clearedRowIndices.push(r);
            }
        }
        return clearedRowIndices;
    }

    moveMinoTo(id, targetRot, targetX, spawnY) {
        const mino = this.game.mino;
        if (!mino || mino.type !== id) return;

        if (spawnY !== undefined) mino.y = spawnY;

        let rotationsNeeded = (targetRot - mino.rotation + 4) % 4;
        for (let i = 0; i < rotationsNeeded; i++) {
            mino.rotate(); 
            mino.rotation = (mino.rotation + 1) % 4;
        }

        const prevX = mino.x;
        mino.x = targetX;
        
        if (!this.game.valid(0, 0)) mino.x = prevX;

        this.game.drawAll();
    }

    renderEstimatePlace() {
        if (!this.estimateContainer) this.initEstimateContainer();
        if (!this.estimateContainer) return;

        this.estimateContainer.innerHTML = '';

        if (!this.isActive || !this.bestMoveData) return;

        const p1 = this.bestMoveData.p1;
        const p2 = this.bestMoveData.p2;
        const clearedLines = this.bestMoveData.clearedLines || [];

        if (p1) this.createEstimateBlocks(p1, 'step1');
        if (p2) this.createEstimateBlocks(p2, 'step2', clearedLines);
    }

    createEstimateBlocks(pData, stepClass, clearedLines = []) {
        let simMino = new Mino(pData.id);
        for(let i = 0; i < pData.rot; i++) simMino.rotate();

        let yMap = {};
        if (stepClass === 'step2' && clearedLines.length > 0) {
            let currentY_sim = 19;
            for (let y_orig = 19; y_orig >= -10; y_orig--) {
                if (clearedLines.includes(y_orig)) continue; 
                yMap[currentY_sim] = y_orig;
                currentY_sim--;
            }
        }

        const colorMap = {
            0: { border: 'rgba(0, 240, 240, 0.8)', bg: 'rgba(0, 240, 240, 0.25)' }, 
            1: { border: 'rgba(240, 240, 0, 0.8)', bg: 'rgba(240, 240, 0, 0.25)' }, 
            2: { border: 'rgba(160, 0, 240, 0.8)', bg: 'rgba(160, 0, 240, 0.25)' }, 
            3: { border: 'rgba(0, 0, 240, 0.8)',   bg: 'rgba(0, 0, 240, 0.25)' },   
            4: { border: 'rgba(240, 160, 0, 0.8)', bg: 'rgba(240, 160, 0, 0.25)' }, 
            5: { border: 'rgba(0, 240, 0, 0.8)',   bg: 'rgba(0, 240, 0, 0.25)' },   
            6: { border: 'rgba(240, 0, 0, 0.8)',   bg: 'rgba(240, 0, 0, 0.25)' }    
        };
        const colors = colorMap[pData.id] || { border: 'rgba(255, 255, 255, 0.8)', bg: 'rgba(255, 255, 255, 0.25)' };

        simMino.blocks.forEach(block => {
            let drawX = block.x + pData.x;
            let drawY = block.y + pData.y;

            if (stepClass === 'step2' && clearedLines.length > 0) {
                if (yMap[drawY] !== undefined) drawY = yMap[drawY];
            }

            if (drawY >= -1 && drawY < 20) {
                let div = document.createElement('div');
                div.className = `cpu-estimate-block ${stepClass}`;
                
                div.style.position = 'absolute';
                div.style.width = '32px';
                div.style.height = '32px';
                div.style.boxSizing = 'border-box';
                div.style.borderWidth = '2px';
                div.style.borderStyle = 'solid';
                div.style.borderRadius = '2px';
                
                div.style.backgroundColor = colors.bg;
                div.style.borderColor = colors.border;
                div.style.zIndex = stepClass === 'step1' ? '2' : '1';

                div.style.left = `${drawX * 32}px`;
                div.style.top = `${(drawY + 0.5) * 32}px`;
                
                this.estimateContainer.appendChild(div);
            }
        });
    }
};