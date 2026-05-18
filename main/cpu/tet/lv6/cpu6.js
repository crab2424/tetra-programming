// ─────────────────────────────────────────────
// cpu6.js
// 6手読みCPU（NEXT1〜5、HOLD考慮） - Wasm Worker 非同期連携版
// ─────────────────────────────────────────────

window.CPU6 = class {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; 
        this.currentMino = null;
        this.baseScore = 0;     

        this.lastGhostState = null;
        this.pendingGhostState = null;
        this.isCalculatingSingle = false;

        this.weights = {
            lineClear: 100,
            hole: -80, 
            heightLimit: -56, 
            step3Plus: -200, 
            flat: 4,
            step1Good: 3, 
            step1Bad: -2, 
            step2: -24, 
            groundedBonus: 72, 
            touchingBonus: 36,   
            //underSpace: -6, 
            //singleWell: 5, 
            //multiWell: -170,
            
            iWell: 20,           
            iWellOver: -4000,      
            blocksOverHole: -300, 
            
            line4: 500,          
            downstackGood: 68,   
            downstackBad: -3,

            tsdShape: 1200,      
            tsdShapeOver: -45, 
            tsdFillBonus: 50,   

            tssClear: 496,       
            tsdClear: 25600,      
            tsdHolePenalty: -6000, 
            pureHole: -50,         

            comboBonus: 20,   
            btbKeep: 496,     
            renCutPenalty: -200,

            tsmMiniPenalty: -1000,      
            tMinoNoClearPenalty: -3600, 

            tsdSetup: 600,         
            tsdSetupOver: -1000,   

            slopeBonus: 72,       
            slopePenalty: -36,    

            centerDip: 100,         // ★追加：凹みが中央(列3~6)にあるとボーナス、端にあるとペナルティ

            fire: 50,             // ★追加：火力評価（火力>=4で正報酬、<=3で負報酬）

            P1_WEIGHT: 1.0,        
        };

        this.worker = new Worker('cpu/tet/lv6/cpu_worker6.js');
        this.workerReady = false;
        this.isCalculating = false;

        this.isExecutingAction = false; 
        this.actionQueue = [];          
        this.actionDelay = 45; 
        this.harddropDelay = 150; 
        
        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log("🚀 Wasm Worker 6 Ready!"); 
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this.handleWorkerResult(e.data.result);
            } else if (e.data.type === 'evaluate_single_result') {
                this.isCalculatingSingle = false;
                this.updateEvalDisplay(e.data.score, e.data.diff);
            }
        };

        this.worker.onerror = (err) => {
            console.error("❌ Worker 6 Error: ", err.message, err.filename, err.lineno);
        };
    }

    updateEvalDisplay(score, diff) {
        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = score;

        const diffEl = document.getElementById('eval-diff');
        if (diffEl) {
            diffEl.style.color = '';
            if (diff > 0) {
                diffEl.textContent = `(+${diff})`;
                diffEl.className = 'eval-diff-plus';
            } else if (diff < 0) {
                diffEl.textContent = `(${diff})`;
                diffEl.className = 'eval-diff-minus';
            } else {
                diffEl.textContent = `(±0)`;
                diffEl.className = '';
                diffEl.style.color = 'var(--text-dim)';
            }
        }
    }

    getGhostY() {
        if (!this.game || !this.game.mino || !this.game.field) return null;
        let m = this.game.mino;
        let ghostY = m.y;
        while (true) {
            let canDrop = true;
            for (let b of m.blocks) {
                let bx = m.x + b.x;
                let by = ghostY + 1 + b.y;
                if (by >= 20) { canDrop = false; break; }
                if (by >= -5) { 
                    if (this.game.field.blocks.some(fb => fb.x === bx && fb.y === by)) {
                        canDrop = false; break;
                    }
                }
            }
            if (!canDrop) break;
            ghostY++;
        }
        return ghostY;
    }

    checkTSpinAt(x, y, rot) {
        if(this.game.mino.type !== 2) return 0; 
        if(!this.game.lastActionWasRotation) return 0;

        const cx = x + this.game.mino.pivot.x - 0.5; 
        const cy = y + this.game.mino.pivot.y - 0.5;
        const px = Math.round(cx);
        const py = Math.round(cy);

        const corners = [
            { x: px - 1, y: py - 1 }, 
            { x: px + 1, y: py - 1 }, 
            { x: px - 1, y: py + 1 }, 
            { x: px + 1, y: py + 1 }, 
        ];

        const occupied = corners.map(c =>
            c.x < 0 || c.x >= 10 || c.y < -5 || c.y >= 20 || this.game.field.has(c.x, c.y)
        );

        let abIdx, cdIdx;
        switch(rot){
            case 0: abIdx = [0, 1]; cdIdx = [2, 3]; break;
            case 1: abIdx = [1, 3]; cdIdx = [0, 2]; break;
            case 2: abIdx = [3, 2]; cdIdx = [1, 0]; break;
            case 3: abIdx = [2, 0]; cdIdx = [3, 1]; break;
            default: return 0;
        }

        const abFilled = abIdx.filter(i => occupied[i]).length;
        const cdFilled = cdIdx.filter(i => occupied[i]).length;

        if(this.game.lastRotUsedPoint5) return 1; 

        if(abFilled === 2 && cdFilled >= 1) return 1; 
        if(cdFilled === 2 && abFilled >= 1) return 2; 

        return 0; 
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

    canDropStraightFromTo(targetX, startY, targetY, targetRot, id) {
        if (!this.game || !this.game.field || !this.game.field.blocks) return false;

        let simMino = new Mino(id);
        for(let i = 0; i < targetRot; i++) simMino.rotate();
        
        let fieldBlocks = this.game.field.blocks;

        for (let y = startY; y <= targetY; y++) {
            for (let b of simMino.blocks) {
                let bx = targetX + b.x;
                let by = y + b.y;
                
                if (bx < 0 || bx >= 10) return false;
                
                if (by >= -5) { 
                    for (let i = 0; i < fieldBlocks.length; i++) {
                        if (fieldBlocks[i].x === bx && fieldBlocks[i].y === by) {
                            return false;
                        }
                    }
                }
            }
        }
        return true;
    }

    buildActionQueue(bestResult) {
        let queue = [];
        
        if (bestResult.action === 'hold') {
            queue.push({ type: 'hold', delay: this.actionDelay });
            return queue;
        }

        let path = bestResult.path;
        if (!path || path.length === 0) {
            queue.push({ type: 'moveToTargetX', targetX: bestResult.x, delay: this.actionDelay });
            queue.push({ type: 'harddrop', delay: this.harddropDelay });
            return queue;
        }

        let levelSpeed = 7;
        const fallbackSpeeds = [0, 1000, 793, 618, 473, 355, 262, 190, 135, 94, 64, 43, 28, 18, 11, 7];
        if (typeof LEVEL_SPEEDS !== 'undefined') {
            levelSpeed = LEVEL_SPEEDS[this.game.level] || fallbackSpeeds[this.game.level] || 7;
        } else {
            levelSpeed = fallbackSpeeds[this.game.level] || 7;
        }
        let softDropDelay = levelSpeed / 20;

        const ACTION_MAP = {
            1: 'moveLeft', 2: 'moveRight', 3: 'softDrop',
            4: 'rotateCW', 5: 'rotateCCW', 6: 'harddrop'
        };

        let startX = this.game.mino.x;
        let startY = this.game.mino.y;
        let startRot = this.game.mino.rotation;

        let backupX = this.game.mino.x;
        let backupY = this.game.mino.y;
        let backupRot = this.game.mino.rotation;
        let backupBlocks = this.game.mino.blocks.map(b => new Block(b.x, b.y, b.type));
        let backupScore = this.game.score;
        let backupLowestY = this.game.lowestY;
        let backupLastActionWasRotation = this.game.lastActionWasRotation;
        let backupLastRotUsedPoint5 = this.game.lastRotUsedPoint5;

        let states = [];
        states.push({ x: backupX, y: backupY, rot: backupRot });

        for (let actId of path) {
            if (actId === 1) { if (this.game.valid(-1, 0)) this.game.mino.x--; }
            else if (actId === 2) { if (this.game.valid(1, 0)) this.game.mino.x++; }
            else if (actId === 3) { if (this.game.valid(0, 1)) this.game.mino.y++; }
            else if (actId === 4) { this.game.tryRotate(1); }
            else if (actId === 5) { this.game.tryRotate(-1); }
            else if (actId === 6) { break; }
            states.push({ x: this.game.mino.x, y: this.game.mino.y, rot: this.game.mino.rotation });
        }

        this.game.mino.x = backupX;
        this.game.mino.y = backupY;
        this.game.mino.rotation = backupRot;
        this.game.mino.blocks = backupBlocks;
        this.game.score = backupScore;
        this.game.lowestY = backupLowestY;
        this.game.lastActionWasRotation = backupLastActionWasRotation;
        this.game.lastRotUsedPoint5 = backupLastRotUsedPoint5;

        let bestI = -1;
        for (let i = states.length - 1; i >= 1; i--) {
            let st = states[i];
            if (this.canDropStraightFromTo(st.x, startY, st.y, st.rot, bestResult.id)) {
                let canRotateTop = this.canDropStraightFromTo(startX, startY, startY, st.rot, bestResult.id);
                let canMoveTop = true;
                let step = st.x > startX ? 1 : -1;
                for (let tx = startX; tx !== st.x + step; tx += step) {
                    if (!this.canDropStraightFromTo(tx, startY, startY, st.rot, bestResult.id)) {
                        canMoveTop = false;
                        break;
                    }
                }
                
                if (canRotateTop && canMoveTop) {
                    bestI = i;
                    break;
                }
            }
        }

        const checkInstantDrop = (checkRot) => {
            if (!this.canDropStraightFromTo(startX, startY, startY, checkRot, bestResult.id)) return false;
            let step = bestResult.x > startX ? 1 : -1;
            for (let tx = startX; tx !== bestResult.x + step; tx += step) {
                if (!this.canDropStraightFromTo(tx, startY, startY, checkRot, bestResult.id)) return false;
            }
            return this.canDropStraightFromTo(bestResult.x, startY, bestResult.y, checkRot, bestResult.id);
        };

        let skipInstantDrop = false;
        if (bestResult.tSpinType > 0 && bestResult.clearedLines && bestResult.clearedLines.length > 0 && this.game.backToBack) {
            skipInstantDrop = true;
        }

        if (!skipInstantDrop && checkInstantDrop(bestResult.rot)) {
            let targetRot = bestResult.rot;

            if ([0, 1, 5, 6].includes(bestResult.id) && (bestResult.rot === 2 || bestResult.rot === 0)) {
                if (checkInstantDrop(startRot)) {
                    targetRot = startRot; 
                }
            }
            
            let diff = (targetRot - startRot + 4) % 4; 
            if (diff === 1) queue.push({ type: 'rotateCW', delay: this.actionDelay }); 
            else if (diff === 2) { queue.push({ type: 'rotateCW', delay: this.actionDelay }); queue.push({ type: 'rotateCW', delay: this.actionDelay }); }
            else if (diff === 3) queue.push({ type: 'rotateCCW', delay: this.actionDelay }); 

            if (bestResult.x !== startX) {
                queue.push({ type: 'moveToTargetX', targetX: bestResult.x, delay: this.actionDelay });
            }
            queue.push({ type: 'harddrop', delay: this.harddropDelay });
            return queue;
        }

        if (bestI > 0) {
            let st = states[bestI];
            
            let diff = (st.rot - startRot + 4) % 4; 
            if (diff === 1) queue.push({ type: 'rotateCW', delay: this.actionDelay }); 
            else if (diff === 2) { queue.push({ type: 'rotateCW', delay: this.actionDelay }); queue.push({ type: 'rotateCW', delay: this.actionDelay }); }
            else if (diff === 3) queue.push({ type: 'rotateCCW', delay: this.actionDelay }); 
            
            if (st.x !== startX) {
                queue.push({ type: 'moveToTargetX', targetX: st.x, delay: this.actionDelay });
            }
            
            let dropDist = st.y - startY;
            if (dropDist > 0) {
                queue.push({ type: 'multiSoftDrop', targetY: st.y, delay: softDropDelay });
            }
            
            let hasSoftDropSequence = false;
            let softDropTargetY = -1;
            for (let j = bestI; j < path.length; j++) {
                let actId = path[j];
                let type = ACTION_MAP[actId];
                if (type === 'softDrop') {
                    hasSoftDropSequence = true;
                    softDropTargetY = states[j + 1].y;
                } else {
                    if (hasSoftDropSequence) {
                        queue.push({ type: 'multiSoftDrop', targetY: softDropTargetY, delay: softDropDelay });
                        hasSoftDropSequence = false;
                    }
                    if (type) {
                        let delay = type === 'harddrop' ? this.harddropDelay : this.actionDelay;
                        queue.push({ type: type, delay: delay });
                    }
                }
            }
            if (hasSoftDropSequence) {
                queue.push({ type: 'multiSoftDrop', targetY: softDropTargetY, delay: softDropDelay });
            }
            
            return queue;
        }

        let hasSoftDropSequence = false;
        let softDropTargetY = -1;
        for (let j = 0; j < path.length; j++) {
            let actId = path[j];
            let type = ACTION_MAP[actId];
            if (type === 'softDrop') {
                hasSoftDropSequence = true;
                softDropTargetY = states[j + 1].y;
            } else {
                if (hasSoftDropSequence) {
                    queue.push({ type: 'multiSoftDrop', targetY: softDropTargetY, delay: softDropDelay });
                    hasSoftDropSequence = false;
                }
                if (type) {
                    let delay = type === 'harddrop' ? this.harddropDelay : this.actionDelay;
                    queue.push({ type: type, delay: delay });
                }
            }
        }
        if (hasSoftDropSequence) {
            queue.push({ type: 'multiSoftDrop', targetY: softDropTargetY, delay: softDropDelay });
        }

        return queue;
    }

    processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            return;
        }

        // ★ポーズ中はアクションの実行を一時停止し、100msごとに解除を待つ
        if (this.game.isPaused || this.game.state === 'paused') {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this.processActionQueue();
            }, 100);
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
            case 'moveLeft':
                if (this.game.valid(-1, 0)) this.game.mino.x--;
                break;
            case 'moveRight':
                if (this.game.valid(1, 0)) this.game.mino.x++;
                break;
            case 'softDrop':
                if (this.game.valid(0, 1)) {
                    this.game.mino.y++;
                    this.game.score += 1;
                    this.game.updateLowestY();
                }
                break;
            case 'multiSoftDrop':
                if (this.game.mino.y >= action.targetY) {
                    action.delay = 0;
                } else {
                    if (this.game.valid(0, 1)) {
                        this.game.mino.y++;
                        this.game.score += 1;
                        this.game.updateLowestY();
                        this.actionQueue.unshift(action);
                    } else {
                        action.delay = 0;
                    }
                }
                break;
            case 'moveToTargetX':
                if (this.game.mino.x < action.targetX) {
                    let prevX = this.game.mino.x;
                    if (this.game.valid(1, 0)) this.game.mino.x++;
                    if (this.game.mino.x < action.targetX) {
                        if (prevX === this.game.mino.x) this.game.mino.x = action.targetX;
                        else this.actionQueue.unshift(action); 
                    }
                } else if (this.game.mino.x > action.targetX) {
                    let prevX = this.game.mino.x;
                    if (this.game.valid(-1, 0)) this.game.mino.x--;
                    if (this.game.mino.x > action.targetX) {
                        if (prevX === this.game.mino.x) this.game.mino.x = action.targetX;
                        else this.actionQueue.unshift(action); 
                    }
                }
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

        let delayTime = action.delay !== undefined ? action.delay : this.actionDelay;

        if (this.actionQueue.length > 0) {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this.processActionQueue();
            }, delayTime);
        } else {
            // ★待機時間中のポーズにも対応
            const tryFinish = () => {
                if (!this.isActive || !this.isAutoPlay) return;
                
                if (this.game.isPaused || this.game.state === 'paused') {
                    setTimeout(tryFinish, 100);
                    return;
                }
                
                this.isExecutingAction = false;
                if (this.bestMoveData && this.bestMoveData.p1 && 
                    this.game.mino && this.game.mino === this.currentMino) {
                    this.executeAction(this.bestMoveData);
                }
            };
            setTimeout(tryFinish, delayTime);
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

        if (this.game.mino) {
            let gx = this.game.mino.x;
            let gy = this.getGhostY();
            let rot = this.game.mino.rotation;
            let type = this.game.mino.type;
            
            let stateStr = `${type}_${gx}_${gy}_${rot}`;
            if (this.lastGhostState !== stateStr) {
                this.lastGhostState = stateStr;
                this.pendingGhostState = { type, rot, x: gx, y: gy };
            }

            if (this.pendingGhostState && !this.isCalculating && !this.isCalculatingSingle) {
                let p = this.pendingGhostState;
                this.pendingGhostState = null;
                this.requestSingleEvaluation(p.type, p.rot, p.x, p.y);
            }
        }

        requestAnimationFrame(() => this.updateLoop());
    }

    requestSingleEvaluation(type, rot, x, y) {
        if (!this.workerReady) return;
        this.isCalculatingSingle = true;

        let boardBuffer = new Uint8Array(250);
        this.game.field.blocks.forEach(b => {
            let by = b.y + 5;
            if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) {
                boardBuffer[by * 10 + b.x] = 1; 
            }
        });

        let weightsArray = new Int32Array([
            this.weights.lineClear, this.weights.hole, this.weights.heightLimit,
            this.weights.step3Plus, this.weights.flat, this.weights.step1Good, 
            this.weights.step1Bad, this.weights.step2, this.weights.groundedBonus, 
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
            this.weights.pureHole,                    
            this.weights.comboBonus,                  
            this.weights.btbKeep,
            this.weights.renCutPenalty,
            this.weights.tsmMiniPenalty,
            this.weights.tMinoNoClearPenalty,
            this.weights.tsdSetup,
            this.weights.tsdSetupOver,
            this.weights.slopeBonus,
            this.weights.slopePenalty,
            this.weights.centerDip,             // ★追加 [33]
            this.weights.fire                   // ★追加 [34]
        ]);

        const currentRen = this.game.ren || 0;
        const currentBtB = this.game.backToBack ? 1 : 0;
        
        let tSpinType = this.checkTSpinAt(x, y, rot);

        this.worker.postMessage({
            type: 'evaluate_single',
            boardBuffer: boardBuffer,
            minoType: type,
            rot: rot,
            x: x,
            y: y + 5, 
            weightsArray: weightsArray,
            ren: currentRen,
            backToBack: currentBtB,
            tSpinType: tSpinType 
        });
    }

    onMinoSpawned() {
        const diffEl = document.getElementById('eval-diff');
        if (diffEl) diffEl.textContent = ''; 

        const mino = this.game.mino;
        if (!mino) return;

        if (!this.workerReady) {
            if (this.isAutoPlay) {
                const tryDropFallback = () => {
                    if (!this.isActive || this.game.mino !== this.currentMino) return;
                    if (this.game.isPaused || this.game.state === 'paused') {
                        setTimeout(tryDropFallback, 100);
                        return;
                    }
                    this.game.hardDrop();
                };
                setTimeout(tryDropFallback, 700);
            }
            return;
        }

        if (this.isCalculating) return;
        this.isCalculating = true; 

        let boardBuffer = new Uint8Array(250);
        this.game.field.blocks.forEach(b => {
            let by = b.y + 5;
            if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) {
                boardBuffer[by * 10 + b.x] = 1; 
            }
        });

        let weightsArray = new Int32Array([
            this.weights.lineClear, this.weights.hole, this.weights.heightLimit,
            this.weights.step3Plus, this.weights.flat, this.weights.step1Good, 
            this.weights.step1Bad, this.weights.step2, this.weights.groundedBonus, 
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
            this.weights.pureHole,                    
            this.weights.comboBonus,                  
            this.weights.btbKeep,
            this.weights.renCutPenalty,
            this.weights.tsmMiniPenalty,
            this.weights.tMinoNoClearPenalty,
            this.weights.tsdSetup,
            this.weights.tsdSetupOver,
            this.weights.slopeBonus,
            this.weights.slopePenalty,
            this.weights.centerDip,             // ★追加 [33]
            this.weights.fire                   // ★追加 [34]
        ]);

        let holdType = this.game.holdMino !== null ? this.game.holdMino.type : -1;

        const currentRen = this.game.ren || 0;
        const currentBtB = this.game.backToBack ? 1 : 0;

        this.worker.postMessage({
            type: 'calculate',
            boardBuffer: boardBuffer,
            currentType: mino.type,
            holdType: holdType,
            next1: this.game.nextQueue[0].type,
            next2: this.game.nextQueue[1].type,
            next3: this.game.nextQueue[2].type, 
            next4: this.game.nextQueue[3].type, 
            next5: this.game.nextQueue[4].type, 
            canHold: this.game.canHold ? 1 : 0,
            weightsArray: weightsArray,
            ren: currentRen,       
            backToBack: currentBtB 
        });
    }

    handleWorkerResult(res) {
        this.isCalculating = false; 

        let actionInt = res[0];
        
        if (actionInt === -1) {
            this.bestMoveData = null;
            if (this.isAutoPlay && this.isActive) {
                const tryDropFallback = () => {
                    if (!this.isActive || this.game.mino !== this.currentMino) return;
                    if (this.game.isPaused || this.game.state === 'paused') {
                        setTimeout(tryDropFallback, 100);
                        return;
                    }
                    this.game.hardDrop();
                };
                setTimeout(tryDropFallback, 700);
            }
            return;
        }

        let bestMove = {
            action: actionInt === 1 ? 'hold' : 'play',
            score: res[1],
            diff: res[2], 
            p1: (res[3] >= 0 && res[3] <= 6) ? { id: res[3], rot: res[4], x: res[5], y: res[6] - 5, spawnY: res[7] - 5 } : null,
            p2: (res[8] >= 0 && res[8] <= 6) ? { id: res[8], rot: res[9], x: res[10], y: res[11] - 5 } : null,
            
            tSpinType: res[12], 
            isTSpin: (res[12] > 0), 

            p3: (res[13] >= 0 && res[13] <= 6) ? { id: res[13], rot: res[14], x: res[15], y: res[16] - 5 } : null,
            p4: (res[17] >= 0 && res[17] <= 6) ? { id: res[17], rot: res[18], x: res[19], y: res[20] - 5 } : null,
            p5: (res[21] >= 0 && res[21] <= 6) ? { id: res[21], rot: res[22], x: res[23], y: res[24] - 5 } : null, 
            p6: (res[25] >= 0 && res[25] <= 6) ? { id: res[25], rot: res[26], x: res[27], y: res[28] - 5 } : null, 
            
            totalScore: res[29] || 0,
            step1Score: res[30] || 0,
            step2Score: res[31] || 0,
            step3Score: res[32] || 0,
            step4Score: res[33] || 0,
            step5Score: res[34] || 0, 
            step6Score: res[35] || 0, 
        };

        if(bestMove.p1) {
            bestMove.id = bestMove.p1.id; 
            bestMove.rot = bestMove.p1.rot; 
            bestMove.x = bestMove.p1.x; 
            bestMove.y = bestMove.p1.y;
            bestMove.spawnY = bestMove.p1.spawnY;
        }

        let actions = [];
        if (res.length >= 43) {
            for (let i = 0; i < 64; i++) {
                let idx = Math.floor(i / 10);
                let shift = (i % 10) * 3;
                let act = (res[36 + idx] >> shift) & 0x7;
                if (act === 0) break; 
                actions.push(act);
                if (act === 6) break; 
            }
        }
        bestMove.path = actions;

        this.bestMoveData = bestMove;

        if (bestMove.p1) {
            let simMino1 = new Mino(bestMove.p1.id);
            for(let i = 0; i < bestMove.p1.rot; i++) simMino1.rotate();
            let droppedBlocks1 = simMino1.blocks.map(b => ({ x: b.x + bestMove.p1.x, y: b.y + bestMove.p1.y }));
            bestMove.clearedLines = this.getClearedLines(this.game.field.blocks, droppedBlocks1);
        }

        this.updateEvalDisplay(bestMove.score, bestMove.diff);

        if (this.game.currentMode === 'test') {
            this.renderEstimatePlace(); 
        }

        if (this.isAutoPlay && this.isActive && this.game.mino === this.currentMino && bestMove.p1) {
            this.executeAction(bestMove);
        }
    }

    getClearedLines(fieldBlocks, minoBlocks) {
        let blocks = [];
        for (let i = 0; i < fieldBlocks.length; i++) blocks.push({ x: fieldBlocks[i].x, y: fieldBlocks[i].y });
        for (let i = 0; i < minoBlocks.length; i++) blocks.push({ x: minoBlocks[i].x, y: minoBlocks[i].y });
        
        let clearedRowIndices = [];
        for (let r = -5; r < 20; r++) { 
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
            { data: this.bestMoveData.p4, name: 'step4' },
            { data: this.bestMoveData.p5, name: 'step5' }, 
            { data: this.bestMoveData.p6, name: 'step6' }  
        ];

        let simField = Array.from({ length: 25 }, () => Array(10).fill(0));
        this.game.field.blocks.forEach(b => {
            let by = b.y + 5;
            if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) simField[by][b.x] = 1;
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
                let by = b.y + 5; 
                if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) simField[by][b.x] = 1;
            }

            let clearedSimLines = [];
            for (let y = 0; y < 25; y++) {
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
                    if (clearedSimLines.includes(y_old_sim + 5)) continue; 
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

        const opacityMap = { 'step1': 0.9, 'step2': 0.5, 'step3': 0.5, 'step4': 0.5, 'step5': 0.5, 'step6': 0.5 };
        const bgOpacityMap = { 'step1': 0.3, 'step2': 0.2, 'step3': 0.1, 'step4': 0.1, 'step5': 0.1, 'step6': 0.1 };
        const zIndexMap = { 'step1': '6', 'step2': '5', 'step3': '4', 'step4': '3', 'step5': '2', 'step6': '1' };

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

            if (drawY >= -5 && drawY < 20) {
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