// ─────────────────────────────────────────────
// cpu3.js
// 4手読みCPU（NEXT1〜3、HOLD考慮） - Wasm Worker 非同期連携版
// ─────────────────────────────────────────────

window.CPU3 = class {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; 
        this.currentMino = null;
        this.baseScore = 0;     

        this.weights = {
            lineClear: 14,
            hole: -64, 
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

            // ★変更：維持の旨味を減らし、打つ（消す）ことの旨味を圧倒的に大きくする
            tsdShape: 75,      // TSDの地形がある時のボーナス(300から150に減少)
            tsdShapeOver: -1000, // TSD地形を2個以上作った場合の減点
            tsdFillBonus: 24,   // TSD消去ラインがブロックで埋まっているほど加点（15から40に増加）

            // ★追加・変更：TSSとTSDのボーナス分離、および空洞ペナルティ
            tssClear: 400,       // TSSを打った時のベースボーナス (1手目なら4倍で1600)
            tsdClear: 4800,      // TSDを打った時のベースボーナス (2手目なら3倍で3600 -> TSS1手目より上)
            tsdHolePenalty: 2000, // Tスピンを打った結果として空洞が残った場合の特大ペナルティ
            pureHole: -500,         // ★追加：上下左右が塞がれた1マスの穴へのペナルティ

            P1_WEIGHT: 0.8,        
        };

        this.worker = new Worker('cpu/lv3/cpu_worker3.js');
        this.workerReady = false;
        this.isCalculating = false;

        this.isExecutingAction = false; 
        this.actionQueue = [];          
        this.actionDelay = 1000;          
        
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

    executeAction(bestResult) {
        if (!this.isActive) return;
        this.bestEstimate = bestResult;

        if (this.isAutoPlay) {
            if (this.isExecutingAction) return;

            this.isExecutingAction = true;
            this.actionQueue = this.buildActionQueue(bestResult);
            this.processActionQueue();

            setTimeout(() => {
                this.processActionQueue();
            }, this.actionDelay);
        }
    }

    buildActionQueue(bestResult) {
        let queue = [];
        
        if (bestResult.action === 1) {
            queue.push({ type: 'hold', delay: 200 });
            return queue;
        }

        let currentRot = this.game.currentMino.rot;
        let targetRot = bestResult.rot;
        let diff = (targetRot - currentRot + 4) % 4; 
        
        if (diff === 1) {
            queue.push({ type: 'rotate', dir: 1, delay: this.actionDelay }); 
        } else if (diff === 2) {
            queue.push({ type: 'rotate', dir: 1, delay: this.actionDelay }); 
            queue.push({ type: 'rotate', dir: 1, delay: this.actionDelay }); 
        } else if (diff === 3) {
            queue.push({ type: 'rotate', dir: -1, delay: this.actionDelay }); 
        }

        let targetX = bestResult.x;
        queue.push({ type: 'moveToTargetX', targetX: targetX, delay: this.actionDelay });

        if (bestResult.isTSpin) {
            queue.push({ type: 'warpToY', targetY: bestResult.y, delay: this.actionDelay });
        };

        queue.push({ type: 'harddrop', delay: this.actionDelay });
        return queue;
    }

    processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            return;
        }

        const action = this.actionQueue.shift();

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
                this.game.currentMino.rot = (this.game.currentMino.rot + (action.dir === 1 ? 1 : 3)) % 4;
                this.updateMinoBlocks();
                break;
            case 'moveToTargetX':
                if (this.game.currentMino.x < action.targetX) {
                    this.game.currentMino.x++;
                    this.updateMinoBlocks();
                    this.actionQueue.unshift(action); 
                } else if (this.game.currentMino.x > action.targetX) {
                    this.game.currentMino.x--;
                    this.updateMinoBlocks();
                    this.actionQueue.unshift(action); 
                }
                break;
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
                this.game.lockMino(); 
                break;
        }

        if (typeof this.game.draw === 'function') this.game.draw();
        else if (typeof this.game.render === 'function') this.game.render();

        if (this.actionQueue.length > 0) {
            let delayTime = action.delay || this.actionDelay;
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this.processActionQueue();
            }, delayTime);
        } else {
            setTimeout(() => { this.isExecutingAction = false; }, 50);
        }
    }

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
        if (this.estimateContainer) this.estimateContainer.innerHTML = '';
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
            this.weights.line4, this.weights.downstackGood, this.weights.downstackBad,
            Math.round(this.weights.P1_WEIGHT * 100), 
            this.weights.tsdShape,                    
            this.weights.tsdShapeOver,                
            this.weights.tsdFillBonus,
            this.weights.tssClear,                    
            this.weights.tsdClear,                    
            this.weights.tsdHolePenalty,              
            this.weights.pureHole                     
        ]);

        let holdType = this.game.holdMino !== null ? this.game.holdMino.type : -1;

        this.worker.postMessage({
            type: 'calculate',
            boardBuffer: boardBuffer,
            currentType: mino.type,
            holdType: holdType,
            next1: this.game.nextQueue[0].type,
            next2: this.game.nextQueue[1].type,
            next3: this.game.nextQueue[2].type, 
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
            // ★JSエラー防止：idが0〜6の正常な値の時のみオブジェクトを作成する
            p1: (res[3] >= 0 && res[3] <= 6) ? { id: res[3], rot: res[4], x: res[5], y: res[6], spawnY: res[7] } : null,
            p2: (res[8] >= 0 && res[8] <= 6) ? { id: res[8], rot: res[9], x: res[10], y: res[11] } : null,
            isTSpin: (res[12] === 1), 
            p3: (res[13] >= 0 && res[13] <= 6) ? { id: res[13], rot: res[14], x: res[15], y: res[16] } : null,
            p4: (res[17] >= 0 && res[17] <= 6) ? { id: res[17], rot: res[18], x: res[19], y: res[20] } : null,
            
            totalScore: res[21] || 0,
            step1Score: res[22] || 0,
            step2Score: res[23] || 0,
            step3Score: res[24] || 0,
            step4Score: res[25] || 0,
        };

        // 互換性のため直下にプロパティも配置
        if(bestMove.p1) {
            bestMove.id = bestMove.p1.id; bestMove.rot = bestMove.p1.rot; bestMove.x = bestMove.p1.x; bestMove.spawnY = bestMove.p1.spawnY;
        }

        this.bestMoveData = bestMove;
        console.log(`[CPU Eval] Total: ${bestMove.totalScore} | 1st: ${bestMove.step1Score} | 2nd: ${bestMove.step2Score} | 3rd: ${bestMove.step3Score} | 4th: ${bestMove.step4Score}`);

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

        if (this.isAutoPlay && this.isActive && !this.game.isPaused && this.game.mino === this.currentMino && bestMove.p1) {
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

        const steps = [
            { data: this.bestMoveData.p1, name: 'step1' },
            { data: this.bestMoveData.p2, name: 'step2' },
            { data: this.bestMoveData.p3, name: 'step3' },
            { data: this.bestMoveData.p4, name: 'step4' }
        ];

        let simField = Array.from({ length: 20 }, () => Array(10).fill(0));
        this.game.field.blocks.forEach(b => {
            if (b.y >= 0 && b.y < 20 && b.x >= 0 && b.x < 10) simField[b.y][b.x] = 1;
        });

        let yMap = {};
        for (let i = -10; i < 20; i++) yMap[i] = i;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!step.data) continue;

            this.createEstimateBlocks(step.data, step.name, yMap);

            let simMino = new Mino(step.data.id);
            for(let r = 0; r < step.data.rot; r++) simMino.rotate();
            let droppedBlocks = simMino.blocks.map(b => ({ x: b.x + step.data.x, y: b.y + step.data.y }));

            for (let b of droppedBlocks) {
                if (b.y >= 0 && b.y < 20 && b.x >= 0 && b.x < 10) simField[b.y][b.x] = 1;
            }

            let clearedSimLines = [];
            for (let y = 0; y < 20; y++) {
                let isFull = true;
                for (let x = 0; x < 10; x++) {
                    if (simField[y][x] === 0) { isFull = false; break; }
                }
                if (isFull) clearedSimLines.push(y);
            }

            if (clearedSimLines.length > 0) {
                for (let y of clearedSimLines) {
                    for (let ty = y; ty > 0; ty--) simField[ty] = [...simField[ty - 1]];
                    simField[0] = Array(10).fill(0);
                }

                let newYMap = {};
                let currentY_sim = 19;
                for (let y_old_sim = 19; y_old_sim >= -10; y_old_sim--) {
                    if (clearedSimLines.includes(y_old_sim)) continue;
                    newYMap[currentY_sim] = yMap[y_old_sim];
                    currentY_sim--;
                }
                while(currentY_sim >= -10) {
                     newYMap[currentY_sim] = yMap[currentY_sim] || currentY_sim;
                     currentY_sim--;
                }
                yMap = newYMap;
            }
        }
    }

    createEstimateBlocks(pData, stepClass, yMap) {
        let simMino = new Mino(pData.id);
        for(let i = 0; i < pData.rot; i++) simMino.rotate();

        const opacityMap = { 'step1': 0.9, 'step2': 0.6, 'step3': 0.35, 'step4': 0.15 };
        const bgOpacityMap = { 'step1': 0.3, 'step2': 0.2, 'step3': 0.1, 'step4': 0.05 };
        const zIndexMap = { 'step1': '4', 'step2': '3', 'step3': '2', 'step4': '1' };

        const colorMap = {
            0: { border: `rgba(0, 240, 240, ${opacityMap[stepClass]})`, bg: `rgba(0, 240, 240, ${bgOpacityMap[stepClass]})` }, 
            1: { border: `rgba(240, 240, 0, ${opacityMap[stepClass]})`, bg: `rgba(240, 240, 0, ${bgOpacityMap[stepClass]})` }, 
            2: { border: `rgba(160, 0, 240, ${opacityMap[stepClass]})`, bg: `rgba(160, 0, 240, ${bgOpacityMap[stepClass]})` }, 
            3: { border: `rgba(0, 0, 240, ${opacityMap[stepClass]})`,   bg: `rgba(0, 0, 240, ${bgOpacityMap[stepClass]})` },   
            4: { border: `rgba(240, 160, 0, ${opacityMap[stepClass]})`, bg: `rgba(240, 160, 0, ${bgOpacityMap[stepClass]})` }, 
            5: { border: `rgba(0, 240, 0, ${opacityMap[stepClass]})`,   bg: `rgba(0, 240, 0, ${bgOpacityMap[stepClass]})` },   
            6: { border: `rgba(240, 0, 0, ${opacityMap[stepClass]})`,   bg: `rgba(240, 0, 0, ${bgOpacityMap[stepClass]})` }    
        };
        const colors = colorMap[pData.id] || { border: `rgba(255, 255, 255, ${opacityMap[stepClass]})`, bg: `rgba(255, 255, 255, ${bgOpacityMap[stepClass]})` };

        simMino.blocks.forEach(block => {
            let drawX = block.x + pData.x;
            let drawY = block.y + pData.y;

            if (yMap && yMap[drawY] !== undefined) drawY = yMap[drawY];

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
                div.style.zIndex = zIndexMap[stepClass];

                div.style.left = `${drawX * 32}px`;
                div.style.top = `${(drawY + 0.5) * 32}px`;
                
                this.estimateContainer.appendChild(div);
            }
        });
    }
};