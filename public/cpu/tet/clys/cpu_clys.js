// ─────────────────────────────────────────────
// cpu_clys.js
// 参考AI clys（https://github.com/citrus610/clys, MIT, (c) 2024 citrus610）を TETLABO の CPU として動かす。
// 探索・評価・経路は wasm（native/clys_wasm.cpp）。操作の組み立て・実行は lv7（CPU7）のメソッドを借りる
// （CPU_CONFIGS の deps: [7] で cpu7.js を先に読む）。PC 探索・EVAL の1手評価・重み調整パネルは無い。
// 設計: source_assets/memory/cpu/tet/clys-port-design.md
// ─────────────────────────────────────────────

window.CPUClys = class {
    // ★ wasm を再ビルドしたら ?v= を上げる（cpu_worker_clys.js の ?v と揃える）
    static WORKER_URLS = ['cpu/tet/clys/wasm/cpu_worker_clys.js?v=1'];

    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true;
        this.currentMino = null;
        this.bestMoveData = null;

        // 探索の設定（原作の既定: 幅 500・branch 3。思考時間は設計 §2.5）
        this.thinkMs = 100;
        this.width = 500;
        this.branch = 3;
        this.nextCount = 8;          // 探索に渡す NEXT の本数（lv6 と同じ）

        this.worker = CpuWorkerPool.acquire(this.constructor.WORKER_URLS[0]);
        this.workerReady = false;
        this.isCalculating = false;

        this.isExecutingAction = false;
        this.actionQueue = [];
        this.actionDelay = 40;       // lv6 と同じ操作速度
        this.harddropDelay = 80;
        this._holdSpawnType = null;  // アクション列の途中で HOLD したときに出てくるミノ（再探索しない）

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('🚀 clys Worker Ready!');
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this.handleWorkerResult(e.data.result);
            }
        };
        this.worker.onerror = (err) => {
            console.error('❌ clys Worker Error: ', err.message, err.filename, err.lineno);
        };
    }

    start() {
        this.isActive = true;
        // リスタート（game.start の呼び直し）で操作途中の状態が残らないようにする
        if (!this.game._clysStartWrapped) {
            const origStart = this.game.start.bind(this.game);
            const self = this;
            this.game.start = function() {
                origStart();
                self.resetState();
            };
            this.game._clysStartWrapped = true;
            this.game._clysOrigStart = origStart;
        }
        this.initEstimateContainer();
        this.updateLoop();
    }

    resetState() {
        this.isExecutingAction = false;
        this.isCalculating = false;
        this.actionQueue = [];
        this.bestMoveData = null;
        this._holdSpawnType = null;
        this.currentMino = null;
        if (this.game) this.game.gravityDisabled = false;
    }

    stop() {
        this.isActive = false;
        this.bestMoveData = null;
        if (this.game) this.game.gravityDisabled = false;
        if (this.estimateContainer) this.estimateContainer.innerHTML = '';
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.workerReady = false;
        }
        if (this.game && this.game._clysStartWrapped) {
            this.game.start = this.game._clysOrigStart;
            delete this.game._clysStartWrapped;
            delete this.game._clysOrigStart;
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
        const mino = this.game.mino;
        if (!mino) return;

        // 自分のアクション列の HOLD で出てきたミノはそのまま置く（再探索しない）
        if (this._holdSpawnType !== null) {
            const expected = this._holdSpawnType;
            this._holdSpawnType = null;
            if (mino.type === expected) return;
        }

        this.bestMoveData = null;

        if (!this.workerReady) {
            this.currentMino = null; // ready まで待つ（updateLoop が次のフレームで再試行）
            return;
        }
        if (this.isCalculating) return;

        const boardBuffer = new Uint8Array(250);
        this.game.field.blocks.forEach(b => {
            const by = b.y + 5;
            if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) boardBuffer[by * 10 + b.x] = 1;
        });

        // current＋内部 NEXT 全部（bag を戻すのに全部使う）。探索に渡すのは先頭 1+nextCount 本
        const queue = [mino.type];
        for (const m of (this.game.nextQueue || [])) queue.push(m.type);
        let bagAfter = 0;
        for (const t of (this.game.bag || [])) bagAfter |= 1 << t;

        this.isCalculating = true;
        this._calcMino = mino;
        this.worker.postMessage({
            type: 'calculate',
            boardBuffer,
            queue: new Int32Array(queue),
            nSearch: 1 + this.nextCount,
            holdType: this.game.holdMino !== null ? this.game.holdMino.type : -1,
            bagAfter,
            backToBack: this.game.backToBack ? 1 : 0,
            ren: this.game.ren || 0,
            incoming: this.getIncomingGarbage(),
            thinkMs: this.thinkMs,
            width: this.width,
            branch: this.branch,
        });
    }

    // clys の4マス（TETLABO 座標）に一致する (rot, x, y) を Mino の形から求める
    _findPose(id, cells) {
        const key = (x, y) => x + ',' + y;
        const want = new Set(cells.map(c => key(c.x, c.y)));
        for (let rot = 0; rot < 4; rot++) {
            const m = new Mino(id);
            for (let i = 0; i < rot; i++) m.rotate();
            const b0 = m.blocks[0];
            for (const c of cells) {
                const x = c.x - b0.x, y = c.y - b0.y;
                if (m.blocks.every(b => want.has(key(b.x + x, b.y + y)))) return { rot, x, y };
            }
        }
        return null;
    }

    handleWorkerResult(res) {
        this.isCalculating = false;
        if (!this.isActive) return;
        // 探索中に次のミノへ進んでいたら（重力で接地した等）結果は捨てて、いまのミノで考え直す
        if (this._calcMino !== this.currentMino) {
            if (this.currentMino && !this.isExecutingAction) this.onMinoSpawned();
            return;
        }

        if (res[0] !== 1) {
            // 置ける手が無い（窒息）。その場で落とす
            if (this.isAutoPlay && this.game.mino === this.currentMino) {
                setTimeout(() => {
                    if (this.isActive && this.game.mino === this.currentMino && !this.game.isPaused) this.game.hardDrop();
                }, 700);
            }
            return;
        }

        const id = res[1];
        const cells = [];
        for (let i = 0; i < 4; i++) cells.push({ x: res[2 + i * 2], y: res[3 + i * 2] });
        const pose = this._findPose(id, cells);
        if (!pose) {
            console.warn('clys: 置き方を TETLABO の形に直せませんでした', id, cells);
            return;
        }

        const path = [];
        for (let i = 0; i < res[15]; i++) path.push(res[16 + i]);
        const last = path.filter(a => a !== 6).pop();

        const move = {
            action: 'play',
            useHold: res[10] === 1,
            id, rot: pose.rot, x: pose.x, y: pose.y,
            path,
            tSpinType: (id === 2 && (last === 4 || last === 5)) ? 1 : 0,
            clearedLines: this.getClearedLines(this.game.field.blocks, cells),
            score: res[11],       // visit
            nodes: res[12],
            depth: res[13],
        };
        move.p1 = { id, rot: pose.rot, x: pose.x, y: pose.y };
        this.bestMoveData = move;

        this.updateEvalDisplay(res[11], 0);
        if (this.game.currentMode === 'test') this.renderEstimatePlace();

        if (this.isAutoPlay && this.game.mino === this.currentMino) this.executeAction(move);
    }

    executeAction(move) {
        if (!this.isActive || !this.isAutoPlay) return;
        if (this.isExecutingAction) return;
        if (move.useHold && !this.game.canHold) {
            console.warn('clys: HOLD できない局面で HOLD の手が来ました');
            return;
        }
        this.isExecutingAction = true;
        if (this.game) this.game.gravityDisabled = true;
        this.actionQueue = this.buildClysActionQueue(move);
        setTimeout(() => this.processActionQueue(), this.actionDelay);
    }

    // HOLD → 出てきたミノを path どおり置く、を1つのアクション列にする（lv6 の buildPCActionQueue と同じやり方）
    buildClysActionQueue(move) {
        if (!move.useHold) return this.buildActionQueue(move);
        const queue = [{ type: 'hold', delay: this.actionDelay }];
        this._holdSpawnType = move.id;
        const savedMino = this.game.mino;
        let pathQueue;
        try {
            const temp = new Mino(move.id);
            temp.spawn();
            this.game.mino = temp;
            pathQueue = this.buildActionQueue(move);
        } finally {
            this.game.mino = savedMino;
        }
        for (const a of pathQueue) queue.push(a);
        return queue;
    }

    getIncomingGarbage() {
        if (!this.game || !this.game.garbageQueue) return 0;
        let total = 0;
        this.game.garbageQueue.forEach(g => { if (!g.internal) total += g.amount; });
        return total;
    }

    updateEvalDisplay(score) {
        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = score;
        const diffEl = document.getElementById('eval-diff');
        if (diffEl) diffEl.textContent = '';
    }
};

// ── 操作の組み立て・実行・予測表示は lv7 と同じものを使う ──
for (const name of [
    'getGhostY', 'canDropStraightFromTo', 'buildActionQueue', 'processActionQueue',
    'initEstimateContainer', 'getClearedLines', 'renderEstimatePlace', 'createEstimateBlocks',
]) {
    window.CPUClys.prototype[name] = window.CPU7.prototype[name];
}
