// ─────────────────────────────────────────────
// cpu2.js
// 2手読みCPU（NEXT1、HOLD考慮） - Wasm Worker 非同期連携版
// ─────────────────────────────────────────────

window.CPU2 = class {
    // ★ 思考用 worker の URL（CpuWorkerPool が使い回す。ロード画面の prewarm もこれを見る）。
    //   wasm を再ビルドしたらここの ?v= を上げること。
    static WORKER_URLS = [
        'cpu/tet/lv2/cpu_worker2.js?v=7',
    ];
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; 
        this.currentMino = null;
        this.baseScore = 0;     

        // 1 操作ずつ入れる間隔（ms。設計 source_assets/memory/mode/cpu/tet/lv1-2/lv1-2-input-design.md §2.4。仮の値）
        this.firstDelay = 150;      // 思考の結果 → 最初の操作
        this.actionDelay = 150;     // 操作 → 次の操作
        this.harddropDelay = 315;   // 最後の操作 → ハードドロップ（今までの「飛ばしてから待つ」と同じ）
        this._gravityHeld = false;

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
            
            line4: 400,          
            downstackGood: 48,   
            downstackBad: -3,    

            // 1 手目の評価にかける重み（cpu2.cpp: score1 * P1_WEIGHT + score2。整数でそのまま掛ける）。
            // 2026-11-18 まで JS が送っておらず、wasm は確保の外（中身 0）を読んでいた＝ずっと 0 で動いていた。
            // 強さを変えないため 0 を明示して送る（設計 lv1-2-input-design.md §5 L2）
            P1_WEIGHT: 0,             
        };

        // Workerの生成
        this.worker = CpuWorkerPool.acquire(this.constructor.WORKER_URLS[0]);
        this.workerReady = false;
        this.isCalculating = false;

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log("🚀 Wasm Worker 2 Ready!"); 
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                // 結果はフレームの入力の所で受け取る（盤面に触るのは game.cpuAction だけ。core/cpu_port.js）
                // 録画には思考の結果も残す（再生中に CPU の考えを出す。game.cpuThink → core/replay.js）
                const res = e.data.result;
                this.game.cpuSchedule(0, () => { this.game.cpuThink(res); this.handleWorkerResult(res); });
            }
        };

        this.worker.onerror = (err) => {
            console.error("❌ Worker 2 Error: ", err.message, err.filename, err.lineno);
        };
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
        this.game.cpuFrame(() => this.updateLoop());
    }

    stop() {
        this.isActive = false;
        this.bestMoveData = null;
        // 操作の途中で止めたら重力を戻す（フレームの外なので cpuAction は通さない。lv6・lv7 と同じ）
        if (this._gravityHeld && this.game) this.game.gravityDisabled = false;
        this._gravityHeld = false;
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
        // ZONE（VERSUS）: 発動の判断・発動中の手の速さ（cpu/tet/cpu_zone.js）。ZONE の無い試合では何もしない
        if (window.CpuZone && CpuZone.tick(this, 2)) { this.game.cpuFrame(() => this.updateLoop()); return; }
        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.onMinoSpawned();
        }
        this.game.cpuFrame(() => this.updateLoop());
    }

    onMinoSpawned() {
        const diffEl = document.getElementById('eval-diff');
        if (diffEl) diffEl.textContent = ''; 

        const mino = this.game.mino;
        if (!mino) return;

        if (!this.workerReady) {
            // ★ v2.2.3 G: worker 準備前は「700ms 後にその場でハードドロップ」していたが、出現位置での
            //   即置き＝自滅手になり、stop() 後の古いタイマーが次の試合のミノまで落としていた。
            //   ready まで待つ（currentMino を戻して updateLoop に次フレームで再試行させる。その間は重力任せ）。
            this.currentMino = null;
            return;
        }

        if (this.isCalculating) return;
        this.isCalculating = true; 
        // 考えている間も重力を止める（探索は今の位置から通り道を調べる。§2.3）
        this.holdGravity(true);

        // ★ v2.2.3 I: 隠し5行（実機 y=-5〜-1）も含めた 25 行で渡す（内部 y = 実機 y + 5）。
        let boardBuffer = new Uint8Array(250);
        this.game.field.blocks.forEach(b => {
            // ZONE の試合は枠の上 20 段まで積める。探索は 25 段なので、枠の上 6 段目より上は最上段にたたむ
            // （その列は天井まで埋まっている、と読む。探索は出現位置から落とす手しか作らないので置き方は変わらない）
            const by = Math.max(0, b.y + 5);
            if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) {
                boardBuffer[by * 10 + b.x] = 1; 
            }
        });
        // ZONE の発動中は印を付ける（探索が ZONE 段を消えない床として読む。cpu/tet/cpu_zone.js）
        if (window.CpuZone) CpuZone.stampBoard(boardBuffer, this.game);

        let weightsArray = new Int32Array([
            this.weights.lineClear, this.weights.hole, this.weights.heightLimit,
            this.weights.heightDiff, this.weights.flat, this.weights.step1Good,
            this.weights.step1Bad, this.weights.step2Plus, this.weights.groundedBonus,
            this.weights.touchingBonus, 
            this.weights.iWell, this.weights.iWellOver, this.weights.blocksOverHole,
            this.weights.line4, this.weights.downstackGood, this.weights.downstackBad,
            Math.round(this.weights.P1_WEIGHT)
        ]);

        // VS 設定で HOLD なしの試合は、探索に「HOLD できない・中身なし」を渡す（2 手目より先でも HOLD を使わない。v2.6.2 A）

        const holdOk = typeof this.game._holdAllowed !== 'function' || this.game._holdAllowed();

        let holdType = this.game.holdMino !== null ? this.game.holdMino.type : -1;

        if (!holdOk) holdType = -1;

        this.worker.postMessage({
            type: 'calculate',
            boardBuffer: boardBuffer,
            currentType: mino.type,
            holdType: holdType,
            next1: this.game.nextQueue[0].type,
            next2: this.game.nextQueue[1].type,
            canHold: (holdOk && this.game.canHold) ? 1 : 0,
            // 今のミノの位置・向き（探索はここから 1 操作ずつ動かして届く手だけを作る。内部 y = 実機 y + 5）
            curX: mino.x, curY: mino.y + 5, curRot: mino.rotation,
            weightsArray: weightsArray
        });
    }

    handleWorkerResult(res) {
        this.isCalculating = false; 

        let actionInt = res[0];
        
        if (actionInt === -1) {
            this.bestMoveData = null;
            this.holdGravity(false);
            if (this.isAutoPlay && this.isActive) {
                const tryDropFallback = () => {
                    if (!this.isActive || this.game.mino !== this.currentMino) return;
                    if (this.game.isPaused || this.game.state === 'paused') {
                        this.game.cpuSchedule(100, tryDropFallback);
                        return;
                    }
                    this.game.cpuAction('hardDrop');
                };
                // ZONE の発動中は待たずに落とす（待つと ZONE の時間だけ減る。cpu/tet/cpu_zone.js noMoveDelay）
                this.game.cpuSchedule(window.CpuZone ? CpuZone.noMoveDelay(this, 700) : 700, tryDropFallback);
            }
            return;
        }

        let bestMove = {
            action: actionInt === 1 ? 'hold' : 'play',
            score: res[1],
            diff: res[2],
            // ★ v2.2.3 I: wasm は内部座標（実機 y + 5）で返すので戻す
            id: res[3], rot: res[4], x: res[5], spawnY: res[7] - 5,
            p1: { id: res[3], rot: res[4], x: res[5], y: res[6] - 5 },
            p2: res[8] !== -1 ? { id: res[8], rot: res[9], x: res[10], y: res[11] - 5 } : null
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

        if (this.isAutoPlay && this.isActive && this.game.mino === this.currentMino) {
            if (bestMove.action === 'hold') {
                const tryHold = () => {
                    if (!this.isActive || this.game.mino !== this.currentMino) { if (this.isActive) this.holdGravity(false); return; }
                    if (this.game.isPaused || this.game.state === 'paused') {
                        this.game.cpuSchedule(100, tryHold);
                        return;
                    }
                    this.holdGravity(false);
                    this.game.cpuAction('hold');
                };
                this.game.cpuSchedule(200, tryHold);
            } else {
                this.runMove(bestMove);
            }
        } else {
            // 手を打たない（CPU TEST で人が打つ・ミノが変わった等）なら重力を戻す
            this.holdGravity(false);
        }
    }

    // ── 置く手を 1 操作ずつ入れる（lv1 cpu.js と同じ作り。設計 lv1-2-input-design.md §2）──
    // 置く手を 1 操作ずつの列にする（回転 → 1 マスずつ横移動。最後のハードドロップは runMove が入れる）
    buildActionQueue(move) {
        const mino = this.game.mino;
        const queue = [];
        const d = (move.rot - mino.rotation + 4) % 4;
        if (mino.type !== 1) {
            if (d === 3) queue.push({ type: 'rotate', dir: -1 });
            else for (let i = 0; i < d; i++) queue.push({ type: 'rotate', dir: 1 });
        }
        const dx = move.x - mino.x;
        for (let i = 0; i < Math.abs(dx); i++) queue.push({ type: 'shift', dir: Math.sign(dx) });
        return queue;
    }

    // 操作の間は重力を止める（探索は出現の高さで通り道を調べている。§2.3）。stop() は game.gravityDisabled を直接戻す
    holdGravity(on) {
        if (on === !!this._gravityHeld) return;
        this._gravityHeld = on;
        this.game.cpuAction('gravity', on);
    }

    // 手を 1 操作ずつ入れる（game.cpuAction 'rotate' / 'shift' / 'hardDrop'。設計 lv1-2-input-design.md §2）。
    // 操作の間隔を空けて動きを見せ、入れ終えたら重力を戻して少し待ってからハードドロップする
    runMove(move) {
        const mino = this.currentMino;
        const queue = this.buildActionQueue(move);
        const alive = () => this.isActive && this.game.mino === mino;
        const paused = () => this.game.isPaused || this.game.state === 'paused';

        const tryDrop = () => {
            if (!alive()) return;
            if (paused()) { this.game.cpuSchedule(100, tryDrop); return; }
            this.game.cpuAction('hardDrop');
        };
        const step = () => {
            if (!alive()) { if (this.isActive) this.holdGravity(false); return; }
            if (paused()) { this.game.cpuSchedule(100, step); return; }
            const a = queue.shift();
            if (a) {
                const ok = a.type === 'rotate'
                    ? this.game.cpuAction('rotate', a.dir)
                    : this.game.cpuAction('shift', a.dir, true);
                // 動けなかったら（探索の読みと違う。ふつうは起きない）それ以上は寄せずにその場で落とす
                if (!ok) queue.length = 0;
                this.game.drawAll();
            }
            if (queue.length > 0) { this.game.cpuSchedule(this.actionDelay, step); return; }
            this.holdGravity(false);
            this.game.cpuSchedule(this.harddropDelay, tryDrop);
        };

        if (queue.length === 0) { this.holdGravity(false); this.game.cpuSchedule(this.harddropDelay, tryDrop); return; }
        this.holdGravity(true);
        this.game.cpuSchedule(this.firstDelay, step);
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