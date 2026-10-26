// ─────────────────────────────────────────────
// cpu6n.js
// テト CPU lv6 の新しい探索（engine/。探索・評価・経路は clys がもと：https://github.com/citrus610/clys, MIT, (c) 2024 citrus610）。
// 確定 NEXT を深さぶん（最大 32 本＋1）渡し、ビーム1本・締め切り thinkMs で読む。PC 探索 Worker は使わない。
// 操作の組み立て・実行・予想位置の表示は lv6（CPU6）のメソッドを借りる（CPU_CONFIGS の deps: [6]）。
// 本番の lv6 に切り替えるまでは CPU TEST 専用のレベル 8（LV6N）。設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md §3
// ─────────────────────────────────────────────

window.CPU6N = class {
    // ★ wasm を再ビルドしたら ?v= を上げる（cpu_worker6n.js の ?v と揃える）
    static WORKER_URLS = ['cpu/tet/lv6/wasm/cpu_worker6n.js?v=1'];

    // 重みの並び（engine/ai/eval.h の WEIGHT_LEN の表と同じ順。追加は必ず末尾に）
    static WEIGHT_KEYS = [
        'height', 'well',
        'heightMap0', 'heightMap1', 'heightMap2', 'heightMap3', 'heightMap4',
        'heightMap5', 'heightMap6', 'heightMap7', 'heightMap8', 'heightMap9',
        'wellMap0', 'wellMap1', 'wellMap2', 'wellMap3', 'wellMap4',
        'wellMap5', 'wellMap6', 'wellMap7', 'wellMap8', 'wellMap9',
        'bump', 'transition', 'holeA', 'holeB', 'cover',
        'tslot0', 'tslot1', 'tslot2', 'tslot3',
        'bonusB2b', 'bonusRen', 'scale',
        'pc', 'pcNext', 'tspin1', 'tspin2', 'tspin3',
        'clear1', 'clear2', 'clear3', 'clear4',
        'b2b', 'ren0', 'ren1', 'ren2', 'ren3', 'ren4',
        'feed', 'order', 'delay', 'wasteT', 'wasteI',
        'pcNextOwn', 'transitionWeighted', 'selectBest',
        'incHeight', 'incDangerH', 'incDanger', 'renDangerH', 'renCalmPct', 'tLookahead', 'nlSplit',
    ];

    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true;
        this.currentMino = null;
        this.bestMoveData = null;

        // 既定は原作 clys の config.json（eval.cpp の DEFAULT_WEIGHTS と同じ値）。P2 の A/B の結果で差し替える。
        // 1行1項目・行末に説明（CPU 重み調整パネルがこのコメントを説明として読む）
        this.weights = {
            height: -50,             // 盤面：最大の高さ 1段あたり
            well: 50,                // 盤面：ウェルの深さ（4まで）1段あたり
            heightMap0: 10,          // 盤面：列0の高さ 1段あたり
            heightMap1: 10,          // 盤面：列1の高さ
            heightMap2: 0,           // 盤面：列2の高さ
            heightMap3: -5,          // 盤面：列3の高さ
            heightMap4: -10,         // 盤面：列4の高さ
            heightMap5: -10,         // 盤面：列5の高さ
            heightMap6: -5,          // 盤面：列6の高さ
            heightMap7: 0,           // 盤面：列7の高さ
            heightMap8: 10,          // 盤面：列8の高さ
            heightMap9: 10,          // 盤面：列9の高さ
            wellMap0: -100,          // 盤面：ウェルが列0にある
            wellMap1: -150,          // 盤面：ウェルが列1にある
            wellMap2: 0,             // 盤面：ウェルが列2にある
            wellMap3: 50,            // 盤面：ウェルが列3にある
            wellMap4: 100,           // 盤面：ウェルが列4にある
            wellMap5: 100,           // 盤面：ウェルが列5にある
            wellMap6: 50,            // 盤面：ウェルが列6にある
            wellMap7: 0,             // 盤面：ウェルが列7にある
            wellMap8: -150,          // 盤面：ウェルが列8にある
            wellMap9: -100,          // 盤面：ウェルが列9にある
            bump: -25,               // 盤面：隣の列との段差の二乗（ウェルを除く）
            transition: -20,         // 盤面：行方向の切り替わり 1回あたり（transitionWeighted=1 のときだけ。0 なら原作どおり +1）
            holeA: -400,             // 盤面：一番低い列より上の穴 1マスあたり
            holeB: -200,             // 盤面：一番低い列の高さ（その下の穴の代わり）1段あたり
            cover: -20,              // 盤面：穴の上に積まれた段数（1穴5段まで）
            tslot0: 100,             // 盤面：T-slot（置いても消えない）
            tslot1: 200,             // 盤面：T-slot（TSS）
            tslot2: 250,             // 盤面：T-slot（TSD）
            tslot3: 500,             // 盤面：T-slot（TST）
            bonusB2b: 200,           // 盤面：BtB を保っている
            bonusRen: 200,           // 盤面：REN 1 あたり
            scale: 1024,             // 盤面の評価の倍率（1024＝1倍）
            pc: 2000,                // 行動：パーフェクトクリア（pcNextOwn=0 なら PC の1手前の形にも）
            pcNext: 1000,            // 行動：あと1ミノで PC の形（pcNextOwn=1 のときだけ）
            tspin1: 50,              // 行動：TSS
            tspin2: 400,             // 行動：TSD
            tspin3: 750,             // 行動：TST
            clear1: -400,            // 行動：1ライン消し
            clear2: -300,            // 行動：2ライン消し
            clear3: -200,            // 行動：3ライン消し
            clear4: 250,             // 行動：4-LINES
            b2b: 100,                // 行動：BtB の消去
            ren0: 180,               // 行動：REN 3〜4
            ren1: 450,               // 行動：REN 5〜6
            ren2: 1000,              // 行動：REN 7〜8
            ren3: 1500,              // 行動：REN 9〜10
            ren4: 2000,              // 行動：REN 11〜
            feed: -100,              // 行動：REN 1 を消さずに切る
            order: 100,              // 行動：非BtB の次に BtB（の順を減点）
            delay: -25,              // 行動：ソフトドロップ・HOLD の手間
            wasteT: -150,            // 行動：T を T-spin 以外に使う
            wasteI: -100,            // 行動：I を 4-LINES 以外に使う
            pcNextOwn: 0,            // スイッチ：1=PC の1手前の形に pcNext を使う（原作は pc）
            transitionWeighted: 0,   // スイッチ：1=transition に重みを掛ける（L4）
            selectBest: 0,           // スイッチ：1=初手を最後の層のキー最大で選ぶ（0=子孫の数 visit）
            incHeight: 0,            // L2：受ける前提のおじゃま（予告−送った火力）1段あたり
            incDangerH: 0,           // L2：>0 のとき 最大高さ＋受けるおじゃま がこれを超えた段に incDanger
            incDanger: 0,            // L2：上の超過1段あたり
            renDangerH: 0,           // L1：>0 のとき REN の報酬を満額にするのは 高さ＋受けるおじゃま ≥ これ のときだけ
            renCalmPct: 0,           // L1：平時の REN の報酬の割合（%）
            tLookahead: 0,           // L3：>0 のとき T-slot の T の本数を確定 NEXT のこの本数＋HOLD で数える
            nlSplit: 0,              // L5：>0 のとき消去ありの手に幅のこの % のビームを分ける

            // 探索の設定（重みの配列には入らない）。wasm の 80ms ≒ native 56ms で、P1 では幅 256 が良かった（設計 §6.4）
            searchWidth: 256,        // 探索：ビームの幅
            searchDepth: 32,         // 探索：読む深さの上限（確定 NEXT の本数）
            thinkMs: 80,             // 探索：締め切り（ms）
        };

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
                console.log('🚀 Wasm Worker 6n Ready!');
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this.handleWorkerResult(e.data.result);
            }
        };
        this.worker.onerror = (err) => {
            console.error('❌ Worker 6n Error: ', err.message, err.filename, err.lineno);
        };
    }

    weightsArray() {
        return new Int32Array(this.constructor.WEIGHT_KEYS.map(k => Math.round(this.weights[k] || 0)));
    }

    start() {
        this.isActive = true;
        // リスタート（game.start の呼び直し）で操作途中の状態が残らないようにする
        if (!this.game._cpu6nStartWrapped) {
            const origStart = this.game.start.bind(this.game);
            const self = this;
            this.game.start = function() {
                origStart();
                self.resetState();
            };
            this.game._cpu6nStartWrapped = true;
            this.game._cpu6nOrigStart = origStart;
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
        if (this.game && this.game._cpu6nStartWrapped) {
            this.game.start = this.game._cpu6nOrigStart;
            delete this.game._cpu6nStartWrapped;
            delete this.game._cpu6nOrigStart;
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

        // 確定 NEXT を深さぶん（HOLD が空なら1本多く使う）まで継ぎ足す。表示は先頭5個のまま、ツモの順は変わらない
        const depth = Math.max(1, Math.min(32, Math.round(this.weights.searchDepth)));
        if (typeof this.game.ensureNextQueue === 'function') this.game.ensureNextQueue(depth + 1);

        // current＋内部 NEXT 全部（bag を戻すのに全部使う）
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
            holdType: this.game.holdMino !== null ? this.game.holdMino.type : -1,
            bagAfter,
            backToBack: this.game.backToBack ? 1 : 0,
            ren: this.game.ren || 0,
            incoming: this.getIncomingGarbage(),
            weights: this.weightsArray(),
            width: Math.max(1, Math.round(this.weights.searchWidth)),
            depth,
            thinkMs: Math.max(1, Math.round(this.weights.thinkMs)),
        });
    }

    // 4マス（TETLABO 座標）に一致する (rot, x, y) を Mino の形から求める
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

    // out: [0] 手あり [1] ミノ [2..9] 4マス [10] HOLD [11] visit [12] ノード [13] 深さ [14] ms [15] キー [16] T-spin（0/1/2=mini）
    //      [17] path 長 [18..] path（lv6_wasm.cpp lv6Search）
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
            console.warn('lv6n: 置き方を TETLABO の形に直せませんでした', id, cells);
            return;
        }

        const path = [];
        for (let i = 0; i < res[17]; i++) path.push(res[18 + i]);

        const move = {
            action: 'play',
            useHold: res[10] === 1,
            id, rot: pose.rot, x: pose.x, y: pose.y,
            path,
            tSpinType: res[16] === 1 ? 1 : 0,
            // 探索が T-spin と見た置き方は BtB に関係なく即時落下に短縮しない（最後が回転の経路を保つ。設計 §2.4）
            keepSpin: res[16] > 0,
            clearedLines: this.getClearedLines(this.game.field.blocks, cells),
            score: res[15],
            nodes: res[12],
            depth: res[13],
        };
        move.p1 = { id, rot: pose.rot, x: pose.x, y: pose.y };
        this.bestMoveData = move;

        if (window.__cpu6nLog) {
            console.log(`⚡ lv6n: ${res[14]} ms, nodes ${res[12]}, depth ${res[13]}, visit ${res[11]}, key ${res[15]}`);
        }
        this.updateEvalDisplay(res[15]);
        if (this.game.currentMode === 'test') this.renderEstimatePlace();

        if (this.isAutoPlay && this.game.mino === this.currentMino) this.executeAction(move);
    }

    executeAction(move) {
        if (!this.isActive || !this.isAutoPlay) return;
        if (this.isExecutingAction) return;
        if (move.useHold && !this.game.canHold) {
            console.warn('lv6n: HOLD できない局面で HOLD の手が来ました');
            return;
        }
        this.isExecutingAction = true;
        if (this.game) this.game.gravityDisabled = true;
        this.actionQueue = this.buildHoldActionQueue(move);
        setTimeout(() => this.processActionQueue(), this.actionDelay);
    }

    // HOLD → 出てきたミノを path どおり置く、を1つのアクション列にする（cpu_clys.js と同じやり方）
    buildHoldActionQueue(move) {
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

    // EVAL 欄：選んだ初手の探索のキー（action の累計＋最後の盤面の eval）。旧 lv6 の1手評価（ゴースト位置の評価）は無い
    updateEvalDisplay(score) {
        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = score;
        const diffEl = document.getElementById('eval-diff');
        if (diffEl) diffEl.textContent = '';
    }
};

// ── 操作の組み立て・実行・予測表示は lv6 と同じものを使う ──
for (const name of [
    'getGhostY', 'canDropStraightFromTo', 'buildActionQueue', 'processActionQueue',
    'initEstimateContainer', 'getClearedLines', 'renderEstimatePlace', 'createEstimateBlocks',
]) {
    window.CPU6N.prototype[name] = window.CPU6.prototype[name];
}
