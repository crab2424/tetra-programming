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
            hole: -22, 
            heightLimit: -560, 
            step3Plus: -20, 
            flat: 4,
            step1Good: 3, 
            step1Bad: -2, 
            step2: -24, 
            groundedBonus: 72, 
            touchingBonus: 36,   
            //underSpace: -6, 
            //singleWell: 5, 
            //multiWell: -170,
            
            iWell: 200,           
            iWellOver: -800,      
            blocksOverHole: -85,

            line4: 1000,
            downstackGood: 120,
            downstackBad: -600,

            tsdShape: 300,      
            tsdShapeOver: -45, 
            tsdFillBonus: 50,   

            tssClear: 256,       
            tsdClear: 2560,      
            tsdHolePenalty: -60, 
            pureHole: -100,         

            comboBonus: 20,   
            btbKeep: 496,     
            renCutPenalty: -200,

            tsmMiniPenalty: -100,      
            tMinoNoClearPenalty: -160, 

            tsdSetup: 100,         
            tsdSetupOver: -400,   

            slopeBonus: 72,       
            slopePenalty: -36,    

            centerDip: 100,         // ★追加：凹みが中央(列3~6)にあるとボーナス、端にあるとペナルティ

            fire: 5,             // ★追加：火力評価（火力>=4で正報酬、<=3で負報酬）

            P1_WEIGHT: 1.0,        
        };

        this.worker = new Worker('cpu/tet/lv6/cpu_worker6.js');
        this.workerReady = false;
        this.isCalculating = false;

        this.isExecutingAction = false; 
        this.actionQueue = [];          
        this.actionDelay = 40; 
        this.harddropDelay = 80; 
        
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

        // ─────────────────────────────────────────────
        // ★パフェ(全消し)探索 — 評価関数ビームサーチとは独立した別ワーカー
        // ─────────────────────────────────────────────
        this.pcWorker = new Worker('cpu/tet/lv6/pc_check/pc_worker6.js');
        this.pcWorkerReady = false;
        this.pcSequence = null;          // 実行中のPC手順 [{minoType,rot,x,y,useHold}, ...]
        this.pcSearchId = 0;             // stale(古い)PC結果を破棄するためのID
        this.pcSearchActive = false;     // 今ターンPC探索を投げているか
        this.pcFallbackData = null;       // PC待機中にキャッシュするビームサーチ引数
        this.pcFallbackTimer = null;     // PC結果待ちのタイムアウト

        this.PC_TIMEOUT_MS = 300;        // PC結果を待つ上限。超えたらビームサーチへ
        this.PC_MAX_BLOCKS = 40;         // PC探索を起動する最大ブロック数（10手×4）
        this.PC_MAX_DEPTH = 10;          // PC探索の最大手数

        this.pcWorker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log("💎 PC Worker 6 Ready!");
                this.pcWorkerReady = true;
            } else if (e.data.type === 'pc_result') {
                this.handlePCResult(e.data);
            }
        };
        this.pcWorker.onerror = (err) => {
            console.error("❌ PC Worker 6 Error: ", err.message, err.filename, err.lineno);
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
            // CPU操作中は重力を無効にし、ソフトドロップとの干渉を防ぐ
            if (this.game) this.game.gravityDisabled = true;
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

        // SD前の最後の状態（y == startY の最大インデックス）を分割点にする
        // → pre-SD の全移動・回転を一括 prefix 化し、SD以降を residual path として正しく emit する
        // ※ウォールキックで y が変化した回転後状態は y !== startY でフィルタし、
        //   深い位置でのキックを path[bestI:] 側に残して game.tryRotate に委ねる

        const canMoveHorizontal = (x1, x2, y, rot) => {
            if (x1 === x2) return true;
            let step = x2 > x1 ? 1 : -1;
            for (let tx = x1; tx !== x2 + step; tx += step) {
                if (!this.canDropStraightFromTo(tx, y, y, rot, bestResult.id)) return false;
            }
            return true;
        };

        const getSafeTopMoves = (targetX, targetRot) => {
            let canRotateFirst = this.canDropStraightFromTo(startX, startY, startY, targetRot, bestResult.id) &&
                                 canMoveHorizontal(startX, targetX, startY, targetRot);
            if (canRotateFirst) return 'rotate_first';

            let canMoveFirst = canMoveHorizontal(startX, targetX, startY, startRot) &&
                               this.canDropStraightFromTo(targetX, startY, startY, targetRot, bestResult.id);
            if (canMoveFirst) return 'move_first';

            return null;
        };

        let bestI = -1;
        let bestTopOrder = null;
        for (let i = states.length - 1; i >= 1; i--) {
            let st = states[i];
            if (st.y !== startY) continue;  // 垂直移動（キックによる y 変化含む）後はスキップ

            if (this.canDropStraightFromTo(st.x, startY, st.y, st.rot, bestResult.id)) {
                let order = getSafeTopMoves(st.x, st.rot);
                if (order) {
                    bestI = i;
                    bestTopOrder = order;
                    break;
                }
            }
        }

        // BtB付きT-spinは即時落下を除外
        let skipInstantDrop = false;
        if (bestResult.tSpinType > 0 && bestResult.clearedLines && bestResult.clearedLines.length > 0 && this.game.backToBack) {
            skipInstantDrop = true;
        }

        // 即時落下判定: startY から目標位置まで一直線に落下可能か、かつ上部での移動・回転が安全か
        const checkInstantDrop = () => {
            if (!this.canDropStraightFromTo(bestResult.x, startY, bestResult.y, bestResult.rot, bestResult.id)) return false;
            return getSafeTopMoves(bestResult.x, bestResult.rot);
        };

        let instantDropOrder = null;
        if (!skipInstantDrop) {
            instantDropOrder = checkInstantDrop();
        }

        if (instantDropOrder) {
            let targetRot = bestResult.rot;

            // O/I/S/Z(id=0,1,5,6)はrot0とrot2が同形のため回転を省略できる場合は省略
            if ([0, 1, 5, 6].includes(bestResult.id) && (bestResult.rot === 2 || bestResult.rot === 0)) {
                if (startRot === 0 || startRot === 2) {
                    targetRot = startRot;
                }
            }

            let diff = (targetRot - startRot + 4) % 4;
            let rotActions = [];
            if (diff === 1) rotActions.push({ type: 'rotateCW', delay: this.actionDelay });
            else if (diff === 2) { rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); }
            else if (diff === 3) rotActions.push({ type: 'rotateCCW', delay: this.actionDelay });

            let moveAction = null;
            if (bestResult.x !== startX) {
                moveAction = { type: 'moveToTargetX', targetX: bestResult.x, delay: this.actionDelay };
            }

            if (instantDropOrder === 'rotate_first') {
                queue.push(...rotActions);
                if (moveAction) queue.push(moveAction);
            } else {
                if (moveAction) queue.push(moveAction);
                queue.push(...rotActions);
            }

            queue.push({ type: 'harddrop', delay: this.harddropDelay });
            return queue;
        }

        if (bestI > 0) {
            let st = states[bestI];
            
            let diff = (st.rot - startRot + 4) % 4; 
            let rotActions = [];
            if (diff === 1) rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); 
            else if (diff === 2) { rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); }
            else if (diff === 3) rotActions.push({ type: 'rotateCCW', delay: this.actionDelay }); 
            
            let moveAction = null;
            if (st.x !== startX) {
                moveAction = { type: 'moveToTargetX', targetX: st.x, delay: this.actionDelay };
            }

            if (bestTopOrder === 'rotate_first') {
                queue.push(...rotActions);
                if (moveAction) queue.push(moveAction);
            } else {
                if (moveAction) queue.push(moveAction);
                queue.push(...rotActions);
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

        // フォールバック: bestI=-1（ストレートドロップ不可）
        // path 先頭の moves/rotations prefix（最初のSDより前）を先にemitすることで
        // 「移動回転 → ソフトドロップ → その他移動回転」の制約に可能な限り近づける
        const firstSdIdx = path.findIndex(actId => actId === 3);
        console.log("[Optimize] firstSdIdx:", firstSdIdx);

        let startJ = 0;
        if (firstSdIdx > 0) {
            // SDより前の moves/rotations を先出し
            for (let j = 0; j < firstSdIdx; j++) {
                let type = ACTION_MAP[path[j]];
                if (type) queue.push({ type: type, delay: this.actionDelay });
            }
            startJ = firstSdIdx;
        } else if (firstSdIdx === 0) {
            // path が SD先行の場合: [sd1, ac1, sd2, ac2, hd] 構造で
            // ac1の終点が空中かつ即時落下判定を満たすなら sd1 と ac1 を入れ替える

            // sd1 の終端（連続するSDの末尾の次）を探す
            let sd1End = 0;
            while (sd1End < path.length && path[sd1End] === 3) sd1End++;

            // ac1 の終端（次のSD or HD に当たるまで）を探す
            let ac1End = sd1End;
            while (ac1End < path.length && path[ac1End] !== 3 && path[ac1End] !== 6) ac1End++;

            // ac1 が存在し、その終点 state が有効範囲内かチェック
            if (sd1End < ac1End && ac1End < states.length) {
                const ac1State = states[ac1End];
                console.log("[Optimize] sd1End:", sd1End, "ac1End:", ac1End, "ac1State:", ac1State);

                let swapOrder = null;
                // まず ac1State.x で startY から ac1State.y まで落下可能か
                if (this.canDropStraightFromTo(ac1State.x, startY, ac1State.y, ac1State.rot, bestResult.id)) {
                    swapOrder = getSafeTopMoves(ac1State.x, ac1State.rot);
                }

                console.log("[Optimize] swapOrder returned:", swapOrder);
                if (swapOrder) {
                    // ac1 を moveToTargetX と回転アクションで emit（最適化）
                    let diff = (ac1State.rot - startRot + 4) % 4;
                    let rotActions = [];
                    if (diff === 1) rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); 
                    else if (diff === 2) { rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); rotActions.push({ type: 'rotateCW', delay: this.actionDelay }); }
                    else if (diff === 3) rotActions.push({ type: 'rotateCCW', delay: this.actionDelay }); 
                    
                    let moveAction = null;
                    if (ac1State.x !== startX) {
                        moveAction = { type: 'moveToTargetX', targetX: ac1State.x, delay: this.actionDelay };
                    }

                    if (swapOrder === 'rotate_first') {
                        queue.push(...rotActions);
                        if (moveAction) queue.push(moveAction);
                    } else {
                        if (moveAction) queue.push(moveAction);
                        queue.push(...rotActions);
                    }

                    // sd1 + path[ac1End:] を SD グループ化しながら emit
                    // sd1 と後続の sd2 は自動的に1つの multiSoftDrop に合算される
                    let hasSSD = false, sSDTargetY = -1;
                    for (let j = 0; j < sd1End; j++) {
                        hasSSD = true;
                        sSDTargetY = states[j + 1].y;
                    }
                    for (let j = ac1End; j < path.length; j++) {
                        const actId = path[j];
                        const type = ACTION_MAP[actId];
                        if (type === 'softDrop') {
                            hasSSD = true;
                            sSDTargetY = states[j + 1].y;
                        } else {
                            if (hasSSD) {
                                queue.push({ type: 'multiSoftDrop', targetY: sSDTargetY, delay: softDropDelay });
                                hasSSD = false;
                            }
                            if (type) {
                                const delay = type === 'harddrop' ? this.harddropDelay : this.actionDelay;
                                queue.push({ type: type, delay: delay });
                            }
                        }
                    }
                    if (hasSSD) {
                        queue.push({ type: 'multiSoftDrop', targetY: sSDTargetY, delay: softDropDelay });
                    }

                    return queue;
                }
            }
        }

        let hasSoftDropSequence = false;
        let softDropTargetY = -1;
        for (let j = startJ; j < path.length; j++) {
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
                this.game.moveLeft();
                break;
            case 'moveRight':
                this.game.moveRight();
                break;
            case 'softDrop':
                this.game.softDropOne();
                break;
            case 'multiSoftDrop':
                if (this.game.mino.y >= action.targetY) {
                    action.delay = 0;
                } else {
                    if (this.game.softDropOne()) {
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

                // 操作完了 → 重力を再開してからisExecutingActionをリセット
                if (this.game) this.game.gravityDisabled = false;
                this.isExecutingAction = false;
                // ★PC手順を実行した直後なら、次の手へ進む
                if (this.bestMoveData && this.bestMoveData.isPC) {
                    this.runNextPCMove();
                    return;
                }
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
        // ★デバッグ用初期盤面（CPU6.DEBUG_BOARD が null でなければ適用）
        if (CPU6.DEBUG_BOARD !== null) {
            this.game.applyDebugBoard(CPU6.DEBUG_BOARD);
            // カウントダウン中から盤面が見えるよう即時再描画
            if (typeof this.game.drawAll === 'function') this.game.drawAll();

            // リスタート時（game.start の再呼び出し）にも盤面を再適用するため
            // game.start をラップする（二重ラップ防止のためフラグで管理）
            if (!this.game._debugBoardStartWrapped) {
                const origStart = this.game.start.bind(this.game);
                const self = this;
                this.game.start = function() {
                    origStart();
                    // _initGameState() で field がリセットされた直後に再適用
                    if (CPU6.DEBUG_BOARD !== null) {
                        self.game.applyDebugBoard(CPU6.DEBUG_BOARD);
                        if (typeof self.game.drawAll === 'function') self.game.drawAll();
                    }
                };
                this.game._debugBoardStartWrapped = true;
                this.game._debugBoardOrigStart   = origStart;
            }
        }
        this.initEstimateContainer();
        this.updateLoop();
    }

    stop() {
        this.isActive = false;
        this.bestMoveData = null;
        // 操作途中でstopされた場合も重力を必ず復元する
        if (this.game) this.game.gravityDisabled = false;
        if (this.estimateContainer) {
            this.estimateContainer.innerHTML = '';
        }
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.workerReady = false;
        }
        // ★PC探索ワーカーと状態の後始末
        if (this.pcFallbackTimer) { clearTimeout(this.pcFallbackTimer); this.pcFallbackTimer = null; }
        this.pcSequence = null;
        this.pcFallbackData = null;
        this.pcSearchActive = false;
        if (this.pcWorker) {
            this.pcWorker.terminate();
            this.pcWorker = null;
            this.pcWorkerReady = false;
        }
        // ★デバッグ用 game.start ラップを解除
        if (this.game && this.game._debugBoardStartWrapped) {
            this.game.start = this.game._debugBoardOrigStart;
            delete this.game._debugBoardStartWrapped;
            delete this.game._debugBoardOrigStart;
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

        // ── ★PC手順を実行中はここでは何もしない ──
        // 手順の進行は各手のアクション完了時に runNextPCMove が駆動する。
        // （hold操作で中間的に game.mino が入れ替わっても誤発火しないようにするため）
        if (this.pcSequence) return;

        // ★追加：古い評価結果を破棄して、tryFinishによる誤った再実行（無限ホールド等）を防ぐ
        this.bestMoveData = null;

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

        // ── ★PC探索の起動判定（空盤面時のみ。ビームサーチは投げずPC結果を待つ）──
        if (!this.pcSequence && this.shouldSearchPC()) {
            this.pcSearchActive = true;
            this.pcFallbackData = {
                boardBuffer, currentType: mino.type, holdType,
                next1: this.game.nextQueue[0].type,
                next2: this.game.nextQueue[1].type,
                next3: this.game.nextQueue[2].type,
                next4: this.game.nextQueue[3].type,
                next5: this.game.nextQueue[4].type,
                canHold: this.game.canHold ? 1 : 0,
                weightsArray, ren: currentRen, backToBack: currentBtB
            };
            this.requestPCSearch(mino, boardBuffer, holdType);
            if (this.pcFallbackTimer) clearTimeout(this.pcFallbackTimer);
            this.pcFallbackTimer = setTimeout(() => {
                this.pcFallbackTimer = null;
                if (!this.isActive) return;
                if (this.pcSequence) return;
                if (this.game.mino !== this.currentMino) return;
                this.pcSearchActive = false;
                this.pcSearchId++;
                const fallback = this.pcFallbackData;
                this.pcFallbackData = null;
                this.startBeamSearch(fallback);
            }, this.PC_TIMEOUT_MS);
            return; // ビームサーチは投げない
        }

        this.pcSearchActive = false;
        this.isCalculating = true;
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

    // ── ★キャッシュ済みデータでビームサーチを起動する ──
    startBeamSearch(data) {
        if (!data || !this.workerReady || this.isCalculating) return;
        if (!this.isActive || this.game.mino !== this.currentMino) return;
        this.isCalculating = true;
        this.worker.postMessage({
            type: 'calculate',
            boardBuffer: data.boardBuffer,
            currentType: data.currentType,
            holdType: data.holdType,
            next1: data.next1,
            next2: data.next2,
            next3: data.next3,
            next4: data.next4,
            next5: data.next5,
            canHold: data.canHold,
            weightsArray: data.weightsArray,
            ren: data.ren,
            backToBack: data.backToBack
        });
    }

    // ── ★PC探索を起動すべき盤面か ──
    shouldSearchPC() {
        if (!this.pcWorkerReady) return false;
        return this.game.field.blocks.length === 0;
    }

    // ── ★PC探索リクエスト送信（ネクストを11個=current+next0..9 に拡張）──
    requestPCSearch(mino, boardBuffer, holdType) {
        this.pcSearchId++;
        const pieces = new Int32Array(11);
        pieces[0] = mino.type;
        for (let i = 0; i < 10; i++) {
            pieces[i + 1] = this.game.nextQueue[i] ? this.game.nextQueue[i].type : 0;
        }
        // boardBuffer はビームサーチ用と共有（postMessage で各ワーカーへ別々にクローンされる）
        this.pcWorker.postMessage({
            type: 'pc_search',
            boardBuffer: boardBuffer,
            pieces: pieces,
            holdType: holdType,
            canHold: this.game.canHold ? 1 : 0,
            maxDepth: this.PC_MAX_DEPTH,
            searchId: this.pcSearchId
        });
    }

    // ── ★PC手順1手の妥当性検証（盤面/ミノが想定通りか）──
    validatePCStep(expected) {
        if (!this.game.mino) return false;
        const cur = this.game.mino.type;
        const held = this.game.holdMino !== null ? this.game.holdMino.type : -1;
        if (expected.useHold === 0) {
            // そのまま現在ミノを置く想定
            return cur === expected.minoType;
        } else {
            // ホールド入替後に置く想定
            if (!this.game.canHold) return false;
            const afterHold = (held === -1)
                ? (this.game.nextQueue[0] ? this.game.nextQueue[0].type : -1)
                : held;
            return afterHold === expected.minoType;
        }
    }

    // ── ★PC探索結果のハンドラ ──
    handlePCResult(data) {
        if (data.searchId !== this.pcSearchId) return; // 古い結果は破棄
        this.pcSearchActive = false;
        if (this.pcFallbackTimer) { clearTimeout(this.pcFallbackTimer); this.pcFallbackTimer = null; }
        if (!this.isActive) return;

        if (data.found && data.sequence && data.sequence.length > 0 &&
            this.isAutoPlay && this.game.mino === this.currentMino && !this.isExecutingAction) {
            const expected = data.sequence[0];
            this.pcSequence = data.sequence;
            if (this.validatePCStep(expected)) {
                console.log(`💎 Perfect Clear found! ${this.pcSequence.length} moves → executing`);
                this.pcSequence.shift();
                if (this.pcSequence.length === 0) this.pcSequence = null;
                this.executePCMove(expected);
                this.pcFallbackData = null;
                return;
            } else {
                this.pcSequence = null; // 第1手の検証に失敗
            }
        }
        // PC見つからず or 検証失敗 → ビームサーチを起動
        const fallback = this.pcFallbackData;
        this.pcFallbackData = null;
        if (this.isAutoPlay && this.isActive &&
            this.game.mino === this.currentMino && !this.isExecutingAction) {
            this.startBeamSearch(fallback);
        }
    }

    // ── ★PC手順の次の1手を実行する（直前の手のアクション完了後に呼ばれる）──
    runNextPCMove() {
        if (!this.isActive) return;
        if (!this.pcSequence || this.pcSequence.length === 0) {
            this.pcSequence = null; // PC完了。次ピースは通常の onMinoSpawned が処理
            return;
        }
        // 直前の操作の完了と次ピースの出現を待つ
        if (this.isExecutingAction || !this.game.mino) {
            setTimeout(() => this.runNextPCMove(), 20);
            return;
        }
        this.currentMino = this.game.mino; // onMinoSpawned の重複発火を抑止
        const expected = this.pcSequence[0];
        if (!this.validatePCStep(expected)) {
            // 盤面が想定とずれた（ガベージ等）→ 手順を破棄して通常モードへ
            console.log("💎 PC sequence invalidated → fall back to eval");
            this.pcSequence = null;
            this.currentMino = null; // onMinoSpawned を再発火させ通常評価へ戻す
            return;
        }
        this.pcSequence.shift();
        if (this.pcSequence.length === 0) this.pcSequence = null; // 空配列はtruthy → onMinoSpawnedの早期returnを防ぐ
        this.executePCMove(expected);
    }

    // ── ★PC手順1手の実行（ホールド→回転→移動→ハードドロップ）──
    executePCMove(expected) {
        if (!this.isActive) return;

        // 前のアクション実行中（直前ハードドロップの後処理待ち等）なら少し待って再試行。
        // ※ワーカー往復が無く同期的に呼ばれるため、isExecutingAction の解除待ちが必要。
        if (this.isAutoPlay && this.isExecutingAction) {
            setTimeout(() => { if (this.isActive) this.executePCMove(expected); }, 20);
            return;
        }

        const move = {
            action: 'play',
            id: expected.minoType,
            rot: expected.rot,
            x: expected.x,
            y: expected.y - 5,        // 内部0〜24 → JS座標 -5〜19
            pcUseHold: expected.useHold,
            isPC: true
        };
        this.bestMoveData = move;     // ※p1を持たないので processActionQueue末尾の再実行は走らない
        this.bestEstimate = move;

        // PCモード表示
        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = 'PC';
        this.renderPCEstimate(move);

        if (this.isAutoPlay) {
            this.isExecutingAction = true;
            this.actionQueue = this.buildPCActionQueue(move);
            setTimeout(() => this.processActionQueue(), this.actionDelay);
        }
    }

    // ── ★PC手順用のアクションキュー構築 ──
    //   スポーン直後(rotation=0)前提。PC配置は穴なし充填のため "上で回転→移動→落下" で到達可能。
    buildPCActionQueue(move) {
        let queue = [];
        if (move.pcUseHold) {
            queue.push({ type: 'hold', delay: this.actionDelay });
        }
        const diff = move.rot & 3;
        if (diff === 1) {
            queue.push({ type: 'rotateCW', delay: this.actionDelay });
        } else if (diff === 2) {
            queue.push({ type: 'rotateCW', delay: this.actionDelay });
            queue.push({ type: 'rotateCW', delay: this.actionDelay });
        } else if (diff === 3) {
            queue.push({ type: 'rotateCCW', delay: this.actionDelay });
        }
        queue.push({ type: 'moveToTargetX', targetX: move.x, delay: this.actionDelay });
        queue.push({ type: 'harddrop', delay: this.harddropDelay });
        return queue;
    }

    handleWorkerResult(res) {
        this.isCalculating = false;

        // ★PCモードが既に主導している場合、ビームサーチ結果は完全に無視する
        if (this.pcSequence) return;

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

    renderPCEstimate(currentMove) {
        if (!this.estimateContainer) this.initEstimateContainer();
        if (!this.estimateContainer) return;

        this.estimateContainer.innerHTML = '';
        if (!this.isActive) return;

        const allMoves = [];
        if (currentMove) {
            allMoves.push({ id: currentMove.id, rot: currentMove.rot, x: currentMove.x, y: currentMove.y });
        }
        if (this.pcSequence) {
            for (const m of this.pcSequence) {
                allMoves.push({ id: m.minoType, rot: m.rot, x: m.x, y: m.y - 5 });
            }
        }

        for (let i = 0; i < allMoves.length; i++) {
            const borderOpacity = i === 0 ? 0.9 : Math.max(0.25, 0.5 - i * 0.03);
            const bgOpacity     = i === 0 ? 0.3 : Math.max(0.05, 0.12 - i * 0.01);
            const zIndex        = Math.max(1, 11 - i);
            this.renderPCSinglePiece(allMoves[i], borderOpacity, bgOpacity, zIndex);
        }
    }

    renderPCSinglePiece(pData, borderOpacity, bgOpacity, zIndex) {
        const colorMap = {
            0: '0, 240, 240',
            1: '240, 240, 0',
            2: '160, 0, 240',
            3: '0, 0, 240',
            4: '240, 160, 0',
            5: '0, 240, 0',
            6: '240, 0, 0'
        };
        const rgb = colorMap[pData.id] ?? '255, 255, 255';

        let simMino = new Mino(pData.id);
        for (let i = 0; i < pData.rot; i++) simMino.rotate();

        simMino.blocks.forEach(block => {
            const drawX = block.x + pData.x;
            const drawY = block.y + pData.y;
            if (drawY < -5 || drawY >= 20) return;

            const div = document.createElement('div');
            div.style.position = 'absolute';
            div.style.width = '32px';
            div.style.height = '32px';
            div.style.boxSizing = 'border-box';
            div.style.borderWidth = '2px';
            div.style.borderStyle = 'solid';
            div.style.borderRadius = '2px';
            div.style.backgroundColor = `rgba(${rgb}, ${bgOpacity})`;
            div.style.borderColor = `rgba(${rgb}, ${borderOpacity})`;
            div.style.zIndex = String(zIndex);
            div.style.left = `${drawX * 32}px`;
            div.style.top = `${(drawY + 0.5) * 32}px`;
            this.estimateContainer.appendChild(div);
        });
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

// ─────────────────────────────────────────────
// ★デバッグ用初期盤面
//   null にすると無効（通常プレイ）
//   1 = ブロックあり、0 = なし
//   行0 = 最上段（y=0）、列0 = 左端（x=0）
// ─────────────────────────────────────────────
    CPU6.DEBUG_BOARD =　[
    [0,0,1,0,0,0,0,1,1,0], // row 0  (上)
    [0,0,1,0,0,0,0,1,1,0], // row 1
    [0,0,1,0,0,0,1,1,1,0], // row 2
    [0,0,1,0,0,0,1,1,1,0], // row 3
    [0,0,0,1,0,1,1,0,1,0], // row 4
    [0,0,0,1,0,0,1,0,1,0], // row 5
    [0,0,0,0,1,0,0,0,1,0], // row 6
    [0,0,0,0,0,0,0,0,1,0], // row 7
    [0,0,0,1,0,0,0,0,1,0], // row 8
    [0,0,1,0,1,0,0,0,1,0], // row 9
    [0,0,0,0,1,0,0,0,1,0], // row 10
    [0,1,0,0,1,0,0,0,1,0], // row 11
    [1,1,1,1,0,0,0,0,1,0], // row 12
    [1,0,0,0,0,0,0,1,1,0], // row 13
    [1,1,1,0,0,0,0,1,1,0], // row 14
    [1,1,1,0,0,0,0,1,1,0], // row 15
    [1,1,1,0,0,0,1,1,1,0], // row 16
    [1,1,1,1,0,0,1,1,1,0], // row 17
    [1,1,1,1,0,1,1,1,1,0], // row 18
    [1,1,1,1,0,1,1,1,1,0], // row 19 (下)
    ];
// 使うときは以下のコメントを外して値を編集する:
    