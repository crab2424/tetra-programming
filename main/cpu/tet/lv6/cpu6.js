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
            hole: -55, 
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

            tSlotTsd: 2000,       // ★Phase2: 実行可能なTSD(2ライン)スロットの先読みポテンシャル（旧tsdShape[17]）
            tSlotReady: 750,     // ★Phase2: TSDスロットは出来たが両脇未充填(建設途中)の地形ボーナス（旧tsdShapeOver[18]）
            tSlotTss: 150,       // ★Phase2: 実行可能なTSS(1ライン)スロットの先読みポテンシャル（旧tsdFillBonus[19]）

            tssClear: 256,
            tsdClear: 2560,
            tstClear: 6000,      // ★Phase1追加：TST(3ライン T-spin)消去ボーナス。TSDより上位
            tsdHolePenalty: -60, // ★Phase2: 現在未使用(旧TSDスコアリング廃止に伴い)。[22]の枠は保持
            pureHole: -100,         

            comboBonus: 20,   
            btbKeep: 496,     
            renCutPenalty: -200,

            tsmMiniPenalty: -100,      
            tMinoNoClearPenalty: -200, 

            tsdSetup: 100,         
            tsdSetupOver: -400,   

            slopeBonus: 72,       
            slopePenalty: -36,    

            centerDip: 100,         // ★追加：凹みが中央(列3~6)にあるとボーナス、端にあるとペナルティ

            b2bHold: 150,           // ★追加[35]：配置後もBtBを保持している盤面への静的ボーナス（CC back_to_back相当）

            tSlotTst: 3000,          // ★Phase3追加[36]：T-slot先読みでTST(3ライン)スロット発見時の加点（CC tslot[3]相当・暫定/要チューニング）

            P1_WEIGHT: 1.0,
        };

        this.worker = new Worker('cpu/tet/lv6/cpu_worker6.js?v=11'); // ★v=11: 探索幅12→48で再ビルド
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

        this.PC_SEARCH_TIME_MS = 300;    // ★PC探索(WASM)のウォールクロック上限。超えたら none 扱い
        this.PC_TIMEOUT_MS = 500;        // PC結果を待つ上限（探索上限+余裕）。超えたらビームサーチへ
        this.PC_MAX_BLOCKS = 40;         // PC探索を起動する最大ブロック数（10手×4）
        this.PC_MAX_DEPTH = 10;          // PC探索の最大手数
        this.PC_READY_WAIT_MS = 1200;    // 空盤面で pcWorker のロード完了を待つ上限（リスタート対策）
        this._pcReadyWaitStart = null;   // 空盤面待機の開始時刻

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

        // BtB付きT-spinは即時落下を除外
        let skipInstantDrop = false;
        if (bestResult.tSpinType > 0 && bestResult.clearedLines && bestResult.clearedLines.length > 0 && this.game.backToBack) {
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

        // ★リスタート(game.start の再呼び出し)時に CPU 側の PC 状態を確実にリセットするため
        //   game.start をラップする（DEBUG_BOARD の有無に関わらず常時インストール）。
        //   二重ラップ防止のためフラグで管理。
        if (!this.game._cpu6StartWrapped) {
            const origStart = this.game.start.bind(this.game);
            const self = this;
            this.game.start = function() {
                origStart();
                // ★PC 関連の持ち越し状態をリセット（リスタートで PC が動かなくなるのを防ぐ）
                self.resetPCState();
                // _initGameState() で field がリセットされた直後にデバッグ盤面を再適用
                if (CPU6.DEBUG_BOARD !== null) {
                    self.game.applyDebugBoard(CPU6.DEBUG_BOARD);
                    if (typeof self.game.drawAll === 'function') self.game.drawAll();
                }
            };
            this.game._cpu6StartWrapped = true;
            this.game._cpu6OrigStart    = origStart;
        }

        // ★デバッグ用初期盤面（CPU6.DEBUG_BOARD が null でなければ適用）
        if (CPU6.DEBUG_BOARD !== null) {
            this.game.applyDebugBoard(CPU6.DEBUG_BOARD);
            // カウントダウン中から盤面が見えるよう即時再描画
            if (typeof this.game.drawAll === 'function') this.game.drawAll();
        }

        this.initEstimateContainer();
        this.updateLoop();
    }

    // ── ★PC 関連状態のリセット（リスタート時に呼ぶ）──
    resetPCState() {
        if (this.pcFallbackTimer) { clearTimeout(this.pcFallbackTimer); this.pcFallbackTimer = null; }
        this.pcSequence = null;
        this.pcFallbackData = null;
        this.pcSearchActive = false;
        this.pcSearchId++;            // 進行中だった古い PC 結果を無効化
        this.isExecutingAction = false;
        this.isCalculating = false;
        this.actionQueue = [];
        this._pcReadyWaitStart = null;
        this.currentMino = null;      // 新しい1ピース目で onMinoSpawned を再発火させる
        if (this.game) this.game.gravityDisabled = false;
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
        // ★game.start ラップを解除（新しいコントローラが再ラップできるように）
        if (this.game && this.game._cpu6StartWrapped) {
            this.game.start = this.game._cpu6OrigStart;
            delete this.game._cpu6StartWrapped;
            delete this.game._cpu6OrigStart;
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
            this.weights.tSlotTsd,                    // [17] ★Phase2改名
            this.weights.tSlotReady,                  // [18] ★Phase2改名
            this.weights.tSlotTss,                    // [19] ★Phase2改名
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
            this.weights.tstClear,              // ★Phase1: [34]（旧fireを置換。C++ EvalWeights.tstClear）
            this.weights.b2bHold,               // ★追加 [35]
            this.weights.tSlotTst               // ★Phase3追加 [36]
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

        // ── ★リスタート対策：空盤面なのに pcWorker のロードが未完了なら、
        //   PC 探索の唯一のチャンス（空盤面フレーム）を beam に消費させず少し待つ。──
        if (this.isAutoPlay && this.game.field.blocks.length === 0 && !this.pcWorkerReady) {
            if (this._pcReadyWaitStart === null) this._pcReadyWaitStart = performance.now();
            if (performance.now() - this._pcReadyWaitStart < this.PC_READY_WAIT_MS) {
                setTimeout(() => {
                    if (this.isActive && this.game.mino === this.currentMino) this.onMinoSpawned();
                }, 50);
                return;
            }
            // 待機上限を超過 → 通常処理（beam）へフォールスルー
        } else {
            this._pcReadyWaitStart = null;
        }

        // beam ワーカー未ロード時のドロップ即時フォールバック。
        // ただし PC 探索が可能な空盤面（pcWorker 準備済み）なら、PC のチャンスを残すため抑止する。
        if (!this.workerReady && !this.shouldSearchPC()) {
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
            this.weights.tSlotTsd,                    // [17] ★Phase2改名
            this.weights.tSlotReady,                  // [18] ★Phase2改名
            this.weights.tSlotTss,                    // [19] ★Phase2改名
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
            this.weights.tstClear,              // ★Phase1: [34]（旧fireを置換。C++ EvalWeights.tstClear）
            this.weights.b2bHold,               // ★追加 [35]
            this.weights.tSlotTst               // ★Phase3追加 [36]
        ]);

        let holdType = this.game.holdMino !== null ? this.game.holdMino.type : -1;

        const currentRen = this.game.ren || 0;
        const currentBtB = this.game.backToBack ? 1 : 0;
        // ★着弾予定のおじゃまライン数（生存判定 pick_move 用）。ready+unready 合計（internalは除外＝ゲージ表示と一致）
        const incoming = this.getIncomingGarbage();

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
                next6: this.game.nextQueue[5] ? this.game.nextQueue[5].type : 0, // ★深さ8対応
                next7: this.game.nextQueue[6] ? this.game.nextQueue[6].type : 0, // ★深さ8対応
                next8: this.game.nextQueue[7] ? this.game.nextQueue[7].type : 0, // ★深さ8対応
                canHold: this.game.canHold ? 1 : 0,
                weightsArray, ren: currentRen, backToBack: currentBtB,
                incoming: incoming
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
            next6: this.game.nextQueue[5] ? this.game.nextQueue[5].type : 0, // ★深さ8対応
            next7: this.game.nextQueue[6] ? this.game.nextQueue[6].type : 0, // ★深さ8対応
            next8: this.game.nextQueue[7] ? this.game.nextQueue[7].type : 0, // ★深さ8対応
            canHold: this.game.canHold ? 1 : 0,
            weightsArray: weightsArray,
            ren: currentRen,
            backToBack: currentBtB,
            incoming: incoming
        });
    }

    // ── ★着弾予定のおじゃまライン数を集計（ready=確定 + unready=猶予中。internalは除外）──
    //   Cold Clear の pick_move 相当（生存判定）に渡す。garbage.js の updateGarbageGauge と同じ集計基準。
    getIncomingGarbage() {
        if (!this.game || !this.game.garbageQueue) return 0;
        let total = 0;
        this.game.garbageQueue.forEach(g => {
            if (g.internal) return;
            total += g.amount;
        });
        return total;
    }

    // ── ★キャッシュ済みデータでビームサーチを起動する ──
    startBeamSearch(data) {
        if (!data || this.isCalculating) return;
        if (!this.isActive || this.game.mino !== this.currentMino) return;
        // ★cold load対策: ビームワーカー未ロードのときは破棄せず準備完了を待って再試行する。
        //   （初回ロードで PC未発見→ここに来たとき workerReady=false だと、従来は無言で
        //    return して当該ピースを誰も駆動できず恒久的な待機状態になっていた）
        if (!this.workerReady) {
            setTimeout(() => this.startBeamSearch(data), 50);
            return;
        }
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
            next6: data.next6, // ★深さ8対応
            next7: data.next7, // ★深さ8対応
            next8: data.next8, // ★深さ8対応
            canHold: data.canHold,
            weightsArray: data.weightsArray,
            ren: data.ren,
            backToBack: data.backToBack,
            incoming: data.incoming || 0
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
            maxTimeMs: this.PC_SEARCH_TIME_MS,
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
        if (!this.isActive) { this.pcSearchActive = false; return; }

        // ★直前の操作（前PCの最終ハードドロップ後処理など）が未完了の間は、
        //   結果を破棄せず少し待って再試行する。破棄すると待機状態のままフリーズし、
        //   直前PCのゴースト表示が残るバグになる。
        //   （fallbackタイマーが先に発火すると searchId が更新され、本リトライは自然終了する）
        if (this.isAutoPlay && this.game.mino === this.currentMino && this.isExecutingAction) {
            setTimeout(() => this.handlePCResult(data), 20);
            return;
        }

        this.pcSearchActive = false;
        if (this.pcFallbackTimer) { clearTimeout(this.pcFallbackTimer); this.pcFallbackTimer = null; }

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
            path: expected.path,      // ★到達経路(ねじ込み対応)。1=左2=右3=SD4=CW5=CCW6=HD
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
            // ★CPU操作中は重力を無効化（ビーム同様）。これにより配置ピースが spawn に留まり、
            //   buildPCActionQueue の spawn 起点シミュレーションと実機が一致する。
            if (this.game) this.game.gravityDisabled = true;
            this.actionQueue = this.buildPCActionQueue(move);
            setTimeout(() => this.processActionQueue(), this.actionDelay);
        }
    }

    // ── ★PC手順用のアクションキュー構築 ──
    //   buildActionQueue と同一の経路最適化（連続SDの multiSoftDrop 化・移動/回転の並べ替え・
    //   即時落下判定）を流用する。HOLD する場合は先頭に hold を積み、配置ピースを spawn 位置へ
    //   一時設置した上で buildActionQueue を呼ぶ（HOLD 実行後はそのピースが spawn で出現するため）。
    buildPCActionQueue(move) {
        let queue = [];
        if (move.pcUseHold) {
            queue.push({ type: 'hold', delay: this.actionDelay });
        }

        // buildActionQueue に渡す擬似 bestResult（PC は spin 火力等は考慮しない）
        const bestResult = {
            action: 'play',
            id: move.id,
            x: move.x,
            y: move.y,            // JS座標（executePCMove で expected.y-5 済み）
            rot: move.rot,
            path: move.path,
            tSpinType: 0,
            clearedLines: []
        };

        // ★配置ピースを spawn 位置に一時設置して buildActionQueue のシミュレーションを行う。
        //   （HOLD 有無に関わらず、実行時には配置ピースが spawn から動き出すため整合する）
        const savedMino = this.game.mino;
        let pathQueue;
        try {
            const temp = new Mino(move.id);
            if (typeof temp.spawn === 'function') temp.spawn();
            this.game.mino = temp;
            pathQueue = this.buildActionQueue(bestResult);
        } finally {
            this.game.mino = savedMino;
        }

        for (const a of pathQueue) queue.push(a);
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
        // ★versusモードでは配置予測を表示しない（testモードのみ表示）
        if (this.game.currentMode !== 'test') return;

        const allMoves = [];
        if (currentMove) {
            allMoves.push({ id: currentMove.id, rot: currentMove.rot, x: currentMove.x, y: currentMove.y });
        }
        if (this.pcSequence) {
            for (const m of this.pcSequence) {
                allMoves.push({ id: m.minoType, rot: m.rot, x: m.x, y: m.y - 5 });
            }
        }

        // ★ライン消去に応じて以降の配置を分断表示する（renderEstimatePlace と同様）
        let simField = Array.from({ length: 25 }, () => Array(10).fill(0));
        this.game.field.blocks.forEach(b => {
            let by = b.y + 5;
            if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) simField[by][b.x] = 1;
        });

        let yMap = {};
        for (let i = -10; i < 20; i++) yMap[i] = i;

        for (let i = 0; i < allMoves.length; i++) {
            const borderOpacity = i === 0 ? 0.9 : Math.max(0.25, 0.5 - i * 0.03);
            const bgOpacity     = i === 0 ? 0.3 : Math.max(0.05, 0.12 - i * 0.01);
            const zIndex        = Math.max(1, 11 - i);
            this.renderPCSinglePiece(allMoves[i], borderOpacity, bgOpacity, zIndex, yMap);

            // 配置ブロックを simField に反映
            let simMino = new Mino(allMoves[i].id);
            for (let r = 0; r < allMoves[i].rot; r++) simMino.rotate();
            let droppedBlocks = simMino.blocks.map(b => ({ x: b.x + allMoves[i].x, y: b.y + allMoves[i].y }));
            for (let b of droppedBlocks) {
                let by = b.y + 5;
                if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) simField[by][b.x] = 1;
            }

            // ライン消去判定
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
                while (currentY_sim >= -10) {
                    newYMap[currentY_sim] = yMap[currentY_sim] || currentY_sim;
                    currentY_sim--;
                }
                yMap = newYMap;
            }
        }
    }

    renderPCSinglePiece(pData, borderOpacity, bgOpacity, zIndex, yMap) {
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
            let drawY = block.y + pData.y;

            // ★ライン消去に応じた表示位置の補正
            if (yMap && yMap[drawY] !== undefined) drawY = yMap[drawY];

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
    CPU6.DEBUG_BOARD =　null;
// 使うときは以下のコメントを外して値を編集する:
    
