// ─────────────────────────────────────────────
// cpu4.js
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
            heightLimit: -96, 
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
            
            line4: 100,          
            downstackGood: 68,   
            downstackBad: -3,

            // ★変更：維持の旨味を減らし、打つ（消す）ことの旨味を圧倒的に大きくする
            tsdShape: 150,      // TSDの地形がある時のボーナス(300から150に減少)
            tsdShapeOver: -45, // TSD地形を2個以上作った場合の減点
            tsdFillBonus: 24,   // TSD消去ラインがブロックで埋まっているほど加点（15から40に増加）

            // ★追加・変更：TSSとTSDのボーナス分離、および空洞ペナルティ
            tssClear: 25,       // TSSを打った時のベースボーナス (1手目なら4倍で1600)
            tsdClear: 1280,      // TSDを打った時のベースボーナス (2手目なら3倍で3600 -> TSS1手目より上)
            tsdHolePenalty: -200, // Tスピンを打った結果として空洞が残った場合の特大ペナルティ
            pureHole: -50,         // ★追加：上下左右が塞がれた1マスの穴へのペナルティ

            P1_WEIGHT: 0.8,        
        };

        this.worker = new Worker('cpu/lv4/cpu_worker4.js');
        this.workerReady = false;
        this.isCalculating = false;

        this.isExecutingAction = false; 
        this.actionQueue = [];          
        this.actionDelay = 80; // 高速入力のための待機時間（ミリ秒）
        this.harddropDelay = 200; // ハードドロップ後の硬直時間（ミリ秒）
        
        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log("🚀 Wasm Worker 4 Ready!"); 
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this.handleWorkerResult(e.data.result);
            }
        };

        this.worker.onerror = (err) => {
            console.error("❌ Worker 4 Error: ", err.message, err.filename, err.lineno);
        };
    }

    executeAction(bestResult) {
        if (!this.isActive) return;
        this.bestEstimate = bestResult;

        if (this.isAutoPlay) {
            if (this.isExecutingAction) return;

            this.isExecutingAction = true;
            this.actionQueue = this.buildActionQueue(bestResult);
            
            setTimeout(() => {
                this.processActionQueue();
            }, this.actionDelay);
        }
    }

    buildActionQueue(bestResult) {
        let queue = [];
        
        if (bestResult.action === 'hold') {
            queue.push({ type: 'hold', delay: this.actionDelay });
            return queue;
        }

        let targetX = bestResult.x;
        let targetRot = bestResult.rot;

        if (bestResult.isTSpin) {
            // 【T-Spinの自然な入力手順】
            let cx = targetX + 1; // 空洞の中心X
            let cy = bestResult.y + 2; // 空洞の中心Y
            
            // 盤面の状態を 2D 配列で正確に再現（現在操作中のミノを判定から除外するため）
            let board = Array.from({length: 20}, () => Array(10).fill(0));
            this.game.field.blocks.forEach(b => {
                if (b.y >= 0 && b.y < 20 && b.x >= 0 && b.x < 10) board[b.y][b.x] = 1;
            });
            let checkSolid = (x, y) => {
                if (x < 0 || x >= 10 || y >= 20) return true; // 壁や床はブロック扱い
                if (y < 0) return false;
                return board[y][x] === 1;
            };

            // ★より強力な屋根判定：cxの左右の列を上から見ていき、より高い位置(yが小さい)にブロックがある方を屋根とする
            let leftHeight = 20;
            let rightHeight = 20;
            for (let y = 0; y <= cy; y++) {
                if (checkSolid(cx - 1, y) && leftHeight === 20) leftHeight = y;
                if (checkSolid(cx + 1, y) && rightHeight === 20) rightHeight = y;
            }

            console.log(`T-Spin判定: cx=${cx}, cy=${cy}, leftHeight=${leftHeight}, rightHeight=${rightHeight}`);
            
            let firstRot = 'rotateCW';
            let secondRot = 'rotateCW';

            if (leftHeight < rightHeight) {
                // 左側に高いブロック（屋根）がある -> 右回転(CW)で滑り込ませる
                firstRot = 'rotateCW';
                secondRot = 'rotateCW';
            } else if (rightHeight < leftHeight) {
                // 右側に高いブロック（屋根）がある -> 左回転(CCW)で滑り込ませる
                firstRot = 'rotateCCW';
                secondRot = 'rotateCCW';
            }

            // 1. T-spinの場所まで左右移動
            queue.push({ type: 'moveToTargetX', targetX: targetX, delay: this.actionDelay });
            // 2. T-spinの屋根がついている向きと「逆向き」の回転
            queue.push({ type: firstRot, delay: this.actionDelay });
            // 3. 接地するまでソフトドロップ
            queue.push({ type: 'softdropToBottom', delay: this.actionDelay });
            // 4. 接地したら先ほど回転した向きと同じ向きの回転
            queue.push({ type: secondRot, delay: this.actionDelay });
            
            // （保険：回転のズレを矯正し、確実にT-Spin判定にする）
            queue.push({ 
                type: 'warpToTarget', 
                targetX: targetX, 
                targetY: bestResult.y, 
                targetRot: targetRot, 
                delay: this.actionDelay 
            });
            // 5. ハードドロップ（操作後の遅延付与）
            queue.push({ type: 'harddrop', delay: this.harddropDelay });
            
            return queue;
        }

        // 【通常時の操作】
        let currentRot = this.game.mino.rotation; 
        let diff = (targetRot - currentRot + 4) % 4; 
        
        if (diff === 1) {
            queue.push({ type: 'rotateCW', delay: this.actionDelay }); 
        } else if (diff === 2) {
            queue.push({ type: 'rotateCW', delay: this.actionDelay }); 
            queue.push({ type: 'rotateCW', delay: this.actionDelay }); 
        } else if (diff === 3) {
            queue.push({ type: 'rotateCCW', delay: this.actionDelay }); 
        }

        queue.push({ type: 'moveToTargetX', targetX: targetX, delay: this.actionDelay });
        queue.push({ type: 'harddrop', delay: this.harddropDelay });

        return queue;
    }

    processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            return;
        }

        const action = this.actionQueue.shift();

        if (!this.game.mino) {
            this.isExecutingAction = false;
            this.actionQueue = [];
            return;
        }

        switch (action.type) {
            case 'hold':
                this.game.holdCurrentMino();
                break;
            case 'rotateCW':
                this.game.tryRotate(1);
                break;
            case 'rotateCCW':
                this.game.tryRotate(-1);
                break;
            case 'moveToTargetX':
                if (this.game.mino.x < action.targetX) {
                    let prevX = this.game.mino.x;
                    if (this.game.valid(1, 0)) this.game.mino.x++;
                    
                    if (this.game.mino.x < action.targetX) {
                        if (prevX === this.game.mino.x) {
                            this.game.mino.x = action.targetX;
                        } else {
                            this.actionQueue.unshift(action); 
                        }
                    }
                } else if (this.game.mino.x > action.targetX) {
                    let prevX = this.game.mino.x;
                    if (this.game.valid(-1, 0)) this.game.mino.x--;

                    if (this.game.mino.x > action.targetX) {
                        if (prevX === this.game.mino.x) {
                            this.game.mino.x = action.targetX;
                        } else {
                            this.actionQueue.unshift(action); 
                        }
                    }
                }
                break;
            case 'softdropToBottom':
                // ★修正：whileループによるフリーズを防止。1マス落としてまたキューに戻す。
                if (this.game.valid(0, 1)) {
                    this.game.mino.y++;
                    this.game.score += 1;
                    this.game.updateLowestY();
                    // まだ下に行ける場合は、キューの先頭に自分自身を戻す
                    if (this.game.valid(0, 1)) {
                        action.delay = 15; // 滑らかに落ちる速度（1マスあたりの待機ミリ秒）
                        this.actionQueue.unshift(action);
                    }
                }
                break;
            case 'warpToTarget':
                this.game.mino.x = action.targetX;
                this.game.mino.y = action.targetY;
                while (this.game.mino.rotation !== action.targetRot) {
                    this.game.mino.rotate(); 
                    this.game.mino.rotation = (this.game.mino.rotation + 1) % 4;
                }
                this.game.lastActionWasRotation = true;
                this.game.lastRotUsedPoint5 = true; 
                break;
            case 'harddrop':
                this.game.hardDrop(); 
                break;
        }

        if (typeof this.game.drawAll === 'function') {
            this.game.drawAll();
        } else if (typeof this.game.draw === 'function') {
            this.game.draw();
        }

        // 次のアクションをスケジュール、またはキュー終了時の遅延処理
        let delayTime = action.delay !== undefined ? action.delay : this.actionDelay;

        if (this.actionQueue.length > 0) {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) {
                    this.processActionQueue();
                }
            }, delayTime);
        } else {
            // キューが空になったら、指定されたディレイ（今回はハードドロップ後の200ms）待ってから操作権を解放
            setTimeout(() => {
                this.isExecutingAction = false;
                
                // もし待機中に次の計算が完了していたら、途切れることなく次の操作を開始する
                if (this.isActive && this.isAutoPlay && !this.game.isPaused && 
                    this.bestMoveData && this.bestMoveData.p1 && 
                    this.game.mino && this.game.mino === this.currentMino) {
                    this.executeAction(this.bestMoveData);
                }
            }, delayTime);
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
            diff: res[22],
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

        if(bestMove.p1) {
            bestMove.id = bestMove.p1.id; 
            bestMove.rot = bestMove.p1.rot; 
            bestMove.x = bestMove.p1.x; 
            bestMove.y = bestMove.p1.y;
            bestMove.spawnY = bestMove.p1.spawnY;
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
            this.executeAction(bestMove);
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