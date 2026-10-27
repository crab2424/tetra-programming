// ─────────────────────────────────────────────
// cpu7.js
// テト CPU lv7（探索・評価・経路は engine/。clys がもと：https://github.com/citrus610/clys, MIT, (c) 2024 citrus610）。
// 確定 NEXT を深さぶん（最大 32 本＋1）渡し、ビーム1本・締め切り thinkMs で読む。PC 探索 Worker は使わない。
// 操作の組み立て・実行・予想位置の表示（getGhostY〜createEstimateBlocks）は旧 lv6 の cpu6.js から移したもの。
// 参考AI clys（cpu/tet/clys/cpu_clys.js）はこのクラスのメソッドを借りる。
// 設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md（「lv6n」＝この lv7）
// ─────────────────────────────────────────────

window.CPU7 = class {
    // ★ wasm を再ビルドしたら ?v= を上げる（cpu_worker7.js の ?v と揃える）
    static WORKER_URLS = ['cpu/tet/lv7/wasm/cpu_worker7.js?v=2'];

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
        this.actionDelay = 40;       // 旧 lv6 と同じ操作速度
        this.harddropDelay = 80;
        this._holdSpawnType = null;  // アクション列の途中で HOLD したときに出てくるミノ（再探索しない）

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('🚀 Wasm Worker 7 Ready!');
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this.handleWorkerResult(e.data.result);
            }
        };
        this.worker.onerror = (err) => {
            console.error('❌ Worker 7 Error: ', err.message, err.filename, err.lineno);
        };
    }

    weightsArray() {
        return new Int32Array(this.constructor.WEIGHT_KEYS.map(k => Math.round(this.weights[k] || 0)));
    }

    start() {
        this.isActive = true;
        // リスタート（game.start の呼び直し）で操作途中の状態が残らないようにする
        if (!this.game._cpu7StartWrapped) {
            const origStart = this.game.start.bind(this.game);
            const self = this;
            this.game.start = function() {
                origStart();
                self.resetState();
            };
            this.game._cpu7StartWrapped = true;
            this.game._cpu7OrigStart = origStart;
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
        if (this.game && this.game._cpu7StartWrapped) {
            this.game.start = this.game._cpu7OrigStart;
            delete this.game._cpu7StartWrapped;
            delete this.game._cpu7OrigStart;
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
    //      [17] path 長 [18..] path（lv7_wasm.cpp lv7Search）
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
            console.warn('lv7: 置き方を TETLABO の形に直せませんでした', id, cells);
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

        if (window.__cpu7Log) {
            console.log(`⚡ lv7: ${res[14]} ms, nodes ${res[12]}, depth ${res[13]}, visit ${res[11]}, key ${res[15]}`);
        }
        this.updateEvalDisplay(res[15]);
        if (this.game.currentMode === 'test') this.renderEstimatePlace();

        if (this.isAutoPlay && this.game.mino === this.currentMino) this.executeAction(move);
    }

    executeAction(move) {
        if (!this.isActive || !this.isAutoPlay) return;
        if (this.isExecutingAction) return;
        if (move.useHold && !this.game.canHold) {
            console.warn('lv7: HOLD できない局面で HOLD の手が来ました');
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

    // EVAL 欄：選んだ初手の探索のキー（action の累計＋最後の盤面の eval）。1手評価（ゴースト位置の評価）は無い
    updateEvalDisplay(score) {
        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = score;
        const diffEl = document.getElementById('eval-diff');
        if (diffEl) diffEl.textContent = '';
    }

    // ── 操作の組み立て・実行・予測表示（旧 lv6 cpu6.js から移した。PC 手順の分岐は除いた）──

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
            else if (actId === 4) { this.game.tryRotate(1, true); }   // 再生はSE抑止
            else if (actId === 5) { this.game.tryRotate(-1, true); }  // 再生はSE抑止
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

        // (x1→x2, y, rot) の水平移動が全て衝突なく通過できるか
        const canMoveHorizontal = (x1, x2, y, rot) => {
            if (x1 === x2) return true;
            const step = x2 > x1 ? 1 : -1;
            for (let tx = x1; tx !== x2 + step; tx += step) {
                if (!this.canDropStraightFromTo(tx, y, y, rot, bestResult.id)) return false;
            }
            return true;
        };

        // (fromX, fromY, fromRot) → (toX, fromY, toRot) に直接到達可能か
        // dropTargetY: 並べ替え後はAC操作(移動・回転)を上の行(fromY)で行うため、
        //   そこからtoX/toRotで dropTargetY まで一直線に落下できるかを必ず検証する。
        //   省略時はfromY（単一行＝落下スパンなし＝従来挙動）。
        //   ※preSdState.y(上の行)だけで折り返しを判定すると、x一致時に
        //     canMoveHorizontalが無条件true・単一行落下も自明trueとなり、
        //     縦の障害物を無視してsd群間の折り返しを潰すバグになる。
        // 'rotate_first' / 'move_first' / null を返す
        const canReachDirectAt = (fromX, fromY, fromRot, toX, toRot, dropTargetY = fromY) => {
            if (this.canDropStraightFromTo(fromX, fromY, fromY, toRot, bestResult.id) &&
                canMoveHorizontal(fromX, toX, fromY, toRot) &&
                this.canDropStraightFromTo(toX, fromY, dropTargetY, toRot, bestResult.id)) {
                return 'rotate_first';
            }
            if (canMoveHorizontal(fromX, toX, fromY, fromRot) &&
                this.canDropStraightFromTo(toX, fromY, dropTargetY, toRot, bestResult.id)) {
                return 'move_first';
            }
            return null;
        };

        // 回転差分をqueueに追加
        const emitRot = (from, to) => {
            const diff = (to - from + 4) % 4;
            if (diff === 1) queue.push({ type: 'rotateCW', delay: this.actionDelay });
            else if (diff === 2) { queue.push({ type: 'rotateCW', delay: this.actionDelay }); queue.push({ type: 'rotateCW', delay: this.actionDelay }); }
            else if (diff === 3) queue.push({ type: 'rotateCCW', delay: this.actionDelay });
        };

        // BtB付きT-spinは即時落下を除外（keepSpin：探索が T-spin と見た置き方。lv7 は BtB に関係なく除外）
        let skipInstantDrop = false;
        if (bestResult.keepSpin && bestResult.clearedLines && bestResult.clearedLines.length > 0) {
            skipInstantDrop = true;
        } else if (bestResult.tSpinType > 0 && bestResult.clearedLines && bestResult.clearedLines.length > 0 && this.game.backToBack) {
            skipInstantDrop = true;
        }

        // 即時落下判定: スポーン高さから目標位置まで一直線に落下可能か
        const checkInstantDrop = () => {
            if (!this.canDropStraightFromTo(bestResult.x, startY, bestResult.y, bestResult.rot, bestResult.id)) return false;
            return canReachDirectAt(startX, startY, startRot, bestResult.x, bestResult.rot);
        };

        let instantDropOrder = null;
        if (!skipInstantDrop) instantDropOrder = checkInstantDrop();

        if (instantDropOrder) {
            let targetRot = bestResult.rot;
            // O/I/S/Z(id=0,1,5,6)はrot0とrot2が同形のため、現在rotと揃えて回転を省略
            if ([0, 1, 5, 6].includes(bestResult.id) && (bestResult.rot === 2 || bestResult.rot === 0)) {
                if (startRot === 0 || startRot === 2) targetRot = startRot;
            }
            if (instantDropOrder === 'rotate_first') {
                emitRot(startRot, targetRot);
                if (bestResult.x !== startX) queue.push({ type: 'moveToTargetX', targetX: bestResult.x, delay: this.actionDelay });
            } else {
                if (bestResult.x !== startX) queue.push({ type: 'moveToTargetX', targetX: bestResult.x, delay: this.actionDelay });
                emitRot(startRot, targetRot);
            }
            queue.push({ type: 'harddrop', delay: this.harddropDelay });
            return queue;
        }

        // ── SD/AC群分割ベースのパス最適化（連続SDの貪欲マージ対応版）──
        // pathをSD群(連続するSD)とAC群(移動・回転)に分類する。
        // SD群の始点(waypoint)を辿り、ある始点から「上の行で移動・回転 → 一直線落下」で
        // 直接到達できる“最も遠い”後続SD始点まで貪欲にジャンプし、間のSD/AC群をまとめて省略する。
        //   例: sd1→sd2, sd1→sd3 が到達可能なら sd2 を飛ばして sd1→sd3 を1回の落下で行う。
        // canReachDirectAt が縦スパン込み(上の行での横移動掃引＋落下列の衝突)を検証するため、
        // 途中のSD始点を飛ばしても安全。到達不可になった時点で打ち切り、そこを新たな起点とする。
        const groups = [];
        {
            let i = 0;
            while (i < path.length && path[i] !== 6) {
                const isSd = path[i] === 3;
                const start = i;
                while (i < path.length && path[i] !== 6 && (path[i] === 3) === isSd) i++;
                groups.push({ isSd, start, end: i });
            }
        }
        if (groups.length > 0 && groups[groups.length - 1].isSd) {
            groups.pop();
        }

        // (base → end) の移動・回転を順序付きでqueueへ
        const emitReorder = (base, end, order) => {
            if (order === 'rotate_first') {
                emitRot(base.rot, end.rot);
                if (end.x !== base.x) queue.push({ type: 'moveToTargetX', targetX: end.x, delay: this.actionDelay });
            } else {
                if (end.x !== base.x) queue.push({ type: 'moveToTargetX', targetX: end.x, delay: this.actionDelay });
                emitRot(base.rot, end.rot);
            }
        };
        // AC群を raw（path通りの素の操作列）でqueueへ
        const emitRawAC = (acg) => {
            if (!acg) return;
            for (let i = acg.start; i < acg.end; i++) {
                const type = ACTION_MAP[path[i]];
                if (type) queue.push({ type, delay: this.actionDelay });
            }
        };

        // SD群をwaypointとして抽出。各SDの始点状態・底Y・直後のAC群を保持。
        const sd = [];
        let leadAC = null; // 最初のSDより前のAC群（位置決め）
        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            if (g.isSd) {
                const after = (gi + 1 < groups.length && !groups[gi + 1].isSd) ? groups[gi + 1] : null;
                sd.push({ start: states[g.start], bottomY: states[g.end].y, acAfter: after });
            } else if (sd.length === 0) {
                leadAC = g;
            }
        }

        if (sd.length === 0) {
            // SDなし → AC群のみ(高々1つ)。始点→終点で単独直接到達判定。
            for (const g of groups) {
                if (g.isSd) continue;
                const from = states[g.start];
                const to   = states[g.end];
                const order = canReachDirectAt(from.x, from.y, from.rot, to.x, to.rot);
                if (order) emitReorder(from, to, order);
                else emitRawAC(g);
            }
        } else {
            // 先頭AC群：最初のSD始点へ位置決め（落下なし＝単一行判定）
            if (leadAC) {
                const from = states[leadAC.start];
                const to   = states[leadAC.end]; // = sd[0].start
                const order = canReachDirectAt(from.x, from.y, from.rot, to.x, to.rot);
                if (order) emitReorder(from, to, order);
                else emitRawAC(leadAC);
            }

            // ── 連続SDの貪欲マージ ──
            const m = sd.length;
            let cur = 0; // 現在到達しているSD始点index（最初のSD始点に居る）
            while (cur < m - 1) {
                // curから直接到達できる“最も遠い”後続SD始点を、連続到達可能な限り延長して探す
                let best = -1, bestOrder = null;
                for (let j = cur + 1; j <= m - 1; j++) {
                    const order = canReachDirectAt(
                        sd[cur].start.x, sd[cur].start.y, sd[cur].start.rot,
                        sd[j].start.x, sd[j].start.rot, sd[j].start.y
                    );
                    if (order) { best = j; bestOrder = order; }
                    else break; // 到達不可になった時点で打ち切り
                }
                if (best === -1) {
                    // 隣接SD始点へも直接到達不可 → SD_curの落下 + 直後AC群を raw 出力
                    queue.push({ type: 'multiSoftDrop', targetY: sd[cur].bottomY, delay: softDropDelay });
                    emitRawAC(sd[cur].acAfter);
                    cur++;
                } else {
                    // cur→best へジャンプ：上の行で net 移動回転 → bestの始点行まで一直線落下。
                    // 間の sd[cur+1..best-1] とそのAC群は省略される。
                    emitReorder(sd[cur].start, sd[best].start, bestOrder);
                    queue.push({ type: 'multiSoftDrop', targetY: sd[best].start.y, delay: softDropDelay });
                    cur = best;
                }
            }

            // 末尾：最後のSD始点に到達済み → そのSDの落下 + 末尾AC群 raw（後続SDが無く最適化不可）
            queue.push({ type: 'multiSoftDrop', targetY: sd[m - 1].bottomY, delay: softDropDelay });
            emitRawAC(sd[m - 1].acAfter);
        }

        queue.push({ type: 'harddrop', delay: this.harddropDelay });
        return queue;
    }

    processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            if (this.game && this.isExecutingAction) {
                this.game.gravityDisabled = false; // 空キューの場合に重力が停止したままになるのを防ぐ
            }
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
            case 'moveToTargetX': {
                const beforeX = this.game.mino.x;
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
                // 1マスでも実際に動いたら移動音を鳴らす（スナップ補正含む）
                if (this.game.mino.x !== beforeX) this.game.playSe('move');
                break;
            }
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
