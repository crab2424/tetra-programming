// ─────────────────────────────────────────────
// cpu.js
// CPUの思考・操作・解析をつかさどるクラス
// ─────────────────────────────────────────────

window.CPU = class{
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; // true: CPUが操作する, false: 人間が操作してCPUが採点する
        this.currentMino = null;
        this.baseScore = 0;     // 出現時の盤面の基礎点

        // 1 操作ずつ入れる間隔（ms。設計 source_assets/memory/mode/cpu/tet/lv1-2/lv1-2-input-design.md §2.4。仮の値）
        this.firstDelay = 250;      // 出現 → 最初の操作
        this.actionDelay = 250;     // 操作 → 次の操作
        this.harddropDelay = 1000;  // 最後の操作 → ハードドロップ（今までの「飛ばしてから待つ」と同じ）
        this._gravityHeld = false;

        this.weights = {
            lineClear:    20,
            hole:         -16,
            heightLimit:  -5,
            heightDiff:   -3,
            flat:          2,
            step1Good:     3,
            step1Bad:     -2,
            step2Plus:    -8,
            groundedBonus: 12,
            touchingBonus: 1,   // 接地条件を満たした時、周囲の壁・床・ブロックに触れている面1つにつきプラス
            underSpace:   -6,
            singleWell:    1,  // 3段以上の深い穴が1列だけの場合のボーナス（Iミノ待ち）
            multiWell:    -10,   // 深い穴が2列以上ある場合のペナルティ（深さ1マスにつき掛け算）
        };
    }
    

    // 盤面に触るのは game.cpuAction だけ。待ち時間は game.cpuSchedule、毎フレームの見張りは game.cpuFrame
    // （どれもフレームの入力の所で動く。core/cpu_port.js・設計 record §4.1 D6）
    start() {
        this.isActive = true;
        this.game.cpuFrame(() => this.updateLoop());
    }

    stop() {
        this.isActive = false;
        // 操作の途中で止めたら重力を戻す（フレームの外なので cpuAction は通さない。lv6・lv7 と同じ）
        if (this._gravityHeld && this.game) this.game.gravityDisabled = false;
        this._gravityHeld = false;
    }

    isEvalDisplayVisible() {
        if (!this._evalAreaEl) this._evalAreaEl = document.getElementById('eval-area');
        return !!this._evalAreaEl && this._evalAreaEl.style.display !== 'none';
    }

    updateLoop() {
        if (!this.isActive) return;
        // ZONE（VERSUS）: 発動の判断・発動中の手の速さ（cpu/tet/cpu_zone.js）。ZONE の無い試合では何もしない
        if (window.CpuZone && CpuZone.tick(this, 1)) { this.game.cpuFrame(() => this.updateLoop()); return; }

        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.onMinoSpawned();
        }

        // ★EVAL表示(#eval-area)が非表示の間は毎フレームの盤面複製・評価をスキップする（トリガー=表示状態）
        if (this.game.mino && !this.game.isPaused && this.isEvalDisplayVisible()) {
            this.updateGhostEval();
        }

        this.game.cpuFrame(() => this.updateLoop());
    }

    onMinoSpawned() {
        const diffEl = document.getElementById('eval-diff');
        if (diffEl) diffEl.textContent = ''; 

        const currentBlocks = this.game.field.blocks.map(b => ({ x: b.x, y: b.y }));
        this.baseScore = this.evaluateBoard(currentBlocks, 0, false, 0);

        if (this.isAutoPlay) {
            const bestMove = this.searchBestMove(this.game.mino);

            if (bestMove) {
                const evalEl = document.getElementById('eval-value');
                if (evalEl) evalEl.textContent = bestMove.score;

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

                if (this.isActive && this.game.mino === this.currentMino) {
                    this.runMove(bestMove);
                }
            } else {
                // 最適手が見つからなかった場合（ゲームオーバー寸前など）のフォールバック
                const tryDropFallback = () => {
                    if (!this.isActive || this.game.mino !== this.currentMino) return;
                    
                    if (this.game.isPaused || this.game.state === 'paused') {
                        this.game.cpuSchedule(100, tryDropFallback);
                        return;
                    }
                    this.game.cpuAction('hardDrop');
                };
                // ZONE の発動中は待たずに落とす（待つと ZONE の時間だけ減る。cpu/tet/cpu_zone.js noMoveDelay）
                this.game.cpuSchedule(window.CpuZone ? CpuZone.noMoveDelay(this, 1000) : 1000, tryDropFallback);
            }
        }
    }

    updateGhostEval() {
        const mino = this.game.mino;
        if (!mino) return;

        const currentBlocks = this.game.field.blocks.map(b => ({ x: b.x, y: b.y }));
        const ghostY = this.game.getGhostY(); 

        let droppedBlocks = mino.blocks.map(b => ({ x: b.x + mino.x, y: b.y + ghostY }));

        let placement = this.calculatePlacementInfo(currentBlocks, droppedBlocks);
        let simResult = this.simulateBoard(currentBlocks, droppedBlocks);
        
        let score = this.evaluateBoard(simResult.blocks, simResult.linesCleared, placement.isFullyGrounded, placement.touchingCount);

        const evalEl = document.getElementById('eval-value');
        const diffEl = document.getElementById('eval-diff');
        
        if (evalEl) evalEl.textContent = score;

        if (diffEl) {

            diffEl.style.color = '';

            let diff = score - this.baseScore;
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

    // シミュレーションと実際の判定を完全に一致させる共通メソッド
    isValidPlacement(simMino, testX, testY, currentBlocks) {
        return simMino.blocks.every(b => {
            let bx = b.x + testX;
            let by = b.y + testY;
            // 上部（y<0）は天井がないため重なり判定のみ行い、左右と下部の壁抜けを防ぐ
            // ★ v2.2.3 I: 隠し行（y<0）にもブロックはあり得るので重なり判定は常に行う
            //   （旧実装は y<0 を素通しにしており、はみ出して積んだブロックを突き抜けて置けると誤認していた）
            let isOverlapping = currentBlocks.some(cb => cb.x === bx && cb.y === by);
            return bx >= 0 && bx < 10 && by < 20 && !isOverlapping;
        });
    }

    // ★ v2.2.3 I: 実機の出現判定（game/tet/board.js popMino: 出現位置→1段上の順に試す）
    canSpawnOn(blocks, type) {
        const m = new Mino(type);
        m.spawn();
        return this.isValidPlacement(m, m.x, m.y, blocks) || this.isValidPlacement(m, m.x, m.y - 1, blocks);
    }

    searchBestMove(mino) {
        // ★ v2.2.3 I: 生存する手（Lock Out せず、次のミノが出現できる）を最優先で選ぶ。
        //   旧実装は致死を判定しておらず、死ぬ手も評価値だけで選んでいた。全手が死ぬ局面では評価値で選ぶ。
        let bestDiff = -Infinity;
        let bestMove = null;
        let bestAlive = false;
        const nextType = (this.game.nextQueue && this.game.nextQueue[0]) ? this.game.nextQueue[0].type : null;
        let searchCount = 0;
        const SEARCH_LIMIT = 200;

        const currentBlocks = this.game.field.blocks.map(b => ({ x: b.x, y: b.y }));
        const baseScore = this.evaluateBoard(currentBlocks, 0, false, 0);
        const reach = this.reachableRanges(mino, currentBlocks);

        for (let rot = 0; rot < 4; rot++) {
            // 1 操作ずつ入れて届く手だけ（設計 source_assets/memory/mode/cpu/tet/lv1-2/lv1-2-input-design.md §2.2）
            const range = reach[rot];
            if (!range) continue;
            for (let x = -2; x < 12; x++) {
                if (searchCount >= SEARCH_LIMIT) break;
                if (x < range.lo || x > range.hi) continue;

                let simMino = new Mino(mino.type);
                simMino.rotation = 0;

                // シミュレーション用のMinoも内部数値を同期して回す
                for (let i = 0; i < rot; i++) {
                    simMino.rotate();
                    simMino.rotation = (simMino.rotation + 1) % 4; 
                }

                // 共通ロジックを使って出現位置の重なりを判定
                let isSpawnValid = this.isValidPlacement(simMino, x, mino.y, currentBlocks);
                if (!isSpawnValid) continue;

                searchCount++;

                // 共通ロジックを使って落下位置を計算
                let ghostY = mino.y;
                while (this.isValidPlacement(simMino, x, ghostY + 1, currentBlocks)) {
                    ghostY++;
                }

                let droppedBlocks = simMino.blocks.map(b => ({ x: b.x + x, y: b.y + ghostY }));
                
                let placement = this.calculatePlacementInfo(currentBlocks, droppedBlocks);
                let simResult = this.simulateBoard(currentBlocks, droppedBlocks);
                
                let score = this.evaluateBoard(simResult.blocks, simResult.linesCleared, placement.isFullyGrounded, placement.touchingCount);
                
                // EVAL差の計算
                let diff = score - baseScore;

                // ZONE の発動中は、全ブロックが枠の上でも実機で致命にならない（game/tet/board.js secureMino・ZONE 本編 §15）
                const lockOut = !(this.game && this.game.zoneActive) && droppedBlocks.every(b => b.y < 0);
                const alive = !lockOut && (nextType === null || this.canSpawnOn(simResult.blocks, nextType));
                if ((alive && !bestAlive) || (alive === bestAlive && diff > bestDiff)) {
                    bestAlive = alive;
                    bestDiff = diff;
                    bestMove = { id: mino.type, rot: rot, x: x, y: ghostY, score: score, diff: diff, spawnY: mino.y };
                }
            }
        }
        
        return bestMove;
    }

    // 向きごとに、今の位置から 1 操作ずつ（回転 → 1 マスずつ横移動）入れて届く列の範囲 { lo, hi }。届かない向きは null。
    // 回転は出現の列でその場で回れるものだけ（途中の向きも含めてキック無しで重ならない。SRS の最初の試しは (0,0)
    // なので、その場で回れれば実機の回転も同じ所に回る）。横移動は出現の高さで、途中の列がすべて空いている所まで。
    // O は回しても形が同じなので回さない
    reachableRanges(mino, currentBlocks) {
        const x0 = mino.x, y0 = mino.y, r0 = mino.rotation;
        const shapes = [];
        for (let k = 0; k < 4; k++) {
            const m = new Mino(mino.type);
            for (let i = 0; i < k; i++) m.rotate();
            shapes.push(m);
        }
        const fits = (k, x) => this.isValidPlacement(shapes[k], x, y0, currentBlocks);
        const out = [null, null, null, null];
        for (let rot = 0; rot < 4; rot++) {
            if (mino.type === 1 && rot !== r0) continue;
            const d = (rot - r0 + 4) % 4;
            const turns = d === 3 ? [rot] : Array.from({ length: d + 1 }, (_, i) => (r0 + i) % 4);
            if (!turns.every(k => fits(k, x0))) continue;
            let lo = x0, hi = x0;
            while (fits(rot, lo - 1)) lo--;
            while (fits(rot, hi + 1)) hi++;
            out[rot] = { lo, hi };
        }
        return out;
    }

    calculatePlacementInfo(currentBlocks, droppedBlocks) {
        // 各列の「最も下にあるブロック」だけを抽出する
        let bottomEdges = {};
        
        droppedBlocks.forEach(b => {
            if (bottomEdges[b.x] === undefined || b.y > bottomEdges[b.x]) {
                bottomEdges[b.x] = b.y;
            }
        });

        let isFullyGrounded = true;
        for (let x in bottomEdges) {
            let bottomY = bottomEdges[x];
            let xNum = parseInt(x, 10);
            // bottomEdgesに格納された最下段のブロックの真下が床かブロックかをチェック
            let grounded = (bottomY + 1 >= 20) || currentBlocks.some(cb => cb.x === xNum && cb.y === bottomY + 1);
            if (!grounded) {
                isFullyGrounded = false;
                break;
            }
        }

        let touchingCount = 0;
        if (isFullyGrounded) {
            droppedBlocks.forEach(b => {
                const neighbors = [ {dx: -1, dy: 0}, {dx: 1, dy: 0}, {dx: 0, dy: 1} ];
                
                neighbors.forEach(n => {
                    let nx = b.x + n.dx;
                    let ny = b.y + n.dy;
                    
                    if (nx < 0 || nx >= 10 || ny >= 20) {
                        touchingCount++;
                    } 
                    else if (currentBlocks.some(cb => cb.x === nx && cb.y === ny)) {
                        touchingCount++;
                    }
                });
            });
        }

        return { isFullyGrounded, touchingCount };
    }

    simulateBoard(fieldBlocks, minoBlocks) {
        // ★ 修正：シミュレーション時のフィールド破損を防ぐため、完全なディープコピーを作成する
        // （以前はオブジェクトの参照が残っていたため、元の盤面まで沈んでしまっていた）
        let blocks = [];
        for (let i = 0; i < fieldBlocks.length; i++) {
            blocks.push({ x: fieldBlocks[i].x, y: fieldBlocks[i].y });
        }
        for (let i = 0; i < minoBlocks.length; i++) {
            blocks.push({ x: minoBlocks[i].x, y: minoBlocks[i].y });
        }
        
        let linesCleared = 0;

        // ZONE の発動中（VERSUS）: 底のそろった段（ZONE 段）は消えない。そろった段は底へ移り、その下が 1 段上がる
        // （game/tet/zone.js _zoneCheckLine と同じ。ZONE 段の数は置く前の盤面の底から数える）
        if (this.game && this.game.zoneActive) {
            const rowOf = (list, r) => list.reduce((n, b) => n + (b.y === r ? 1 : 0), 0);
            let floorY = 20;
            while (floorY > 0 && rowOf(fieldBlocks, floorY - 1) === 10) floorY--;
            const top = (typeof this.game.topLimit === 'number') ? this.game.topLimit : -5; // ZONE の試合は -20
            for (let r = floorY - 1; r >= top; r--) {
                if (rowOf(blocks, r) !== 10) continue;
                for (const b of blocks) {
                    if (b.y === r) b.y = floorY - 1;
                    else if (b.y > r && b.y < floorY) b.y -= 1;
                }
                floorY--;
                linesCleared++;
            }
            return { blocks, linesCleared };
        }
        
        for (let r = 0; r < 20; r++) {
            let rowCount = blocks.filter(b => b.y === r).length;
            if (rowCount === 10) { 
                linesCleared++;
                blocks = blocks.filter(b => b.y !== r);
                // 消去した行より上のブロックを1段下ろす（コピーしたブロックの座標をいじる）
                blocks.filter(b => b.y < r).forEach(b => b.y++);
                r--; // 消去した行を再チェックするためにrを戻す
            }
        }
        return { blocks, linesCleared };
    }

    evaluateBoard(blocks, linesCleared, isFullyGrounded, touchingCount) {
        let score = 0;

        score += linesCleared * this.weights.lineClear;

        let heights = new Array(10).fill(0);
        let holes = 0;

        for (let c = 0; c < 10; c++) {
            let colBlocks = blocks.filter(b => b.x === c).sort((a, b) => a.y - b.y);
            if (colBlocks.length > 0) {
                let topY = colBlocks[0].y;
                heights[c] = 20 - topY; 
                holes += (heights[c] - colBlocks.length);
            }
        }

        let maxHeight = Math.max(...heights, 0);
        let minHeight = Math.min(...heights);

        score += (maxHeight - minHeight) * this.weights.heightDiff;

        if (maxHeight >= 8) {
            score += (maxHeight - 7) * this.weights.heightLimit;
        }

        score += holes * this.weights.hole;

        let step1Count = 0;
        for (let c = 0; c < 9; c++) {
            let diff = Math.abs(heights[c] - heights[c + 1]);
            
            if (diff === 0) {
                score += this.weights.flat;
            } else if (diff === 1) {
                step1Count++;
            } else if (diff >= 2) {
                score += this.weights.step2Plus;
            }
        }

        if (step1Count <= 2) {
            score += step1Count * this.weights.step1Good;
        } else {
            score += step1Count * this.weights.step1Bad;
        }

        let deepWells = []; 
        for (let c = 0; c < 10; c++) {
            let leftDiff  = (c === 0) ? Infinity : heights[c - 1] - heights[c];
            let rightDiff = (c === 9) ? Infinity : heights[c + 1] - heights[c];
            
            if (leftDiff >= 3 && rightDiff >= 3) {
                let depth = Math.min(leftDiff, rightDiff);
                if (c === 0) depth = rightDiff;
                if (c === 9) depth = leftDiff;
                deepWells.push(depth);
            }
        }

        if (deepWells.length === 1) {
            score += this.weights.singleWell;
        } else if (deepWells.length >= 2) {
            let totalDepth = deepWells.reduce((sum, d) => sum + d, 0);
            score += totalDepth * this.weights.multiWell;
        }

        if (isFullyGrounded) {
            score += this.weights.groundedBonus;
            score += touchingCount * this.weights.touchingBonus;
        }

        return score;
    }

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
}