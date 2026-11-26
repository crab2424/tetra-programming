// ─────────────────────────────────────────────
// cpu.js
// CPUの思考・操作・解析をつかさどるクラス
// ─────────────────────────────────────────────

// SRS のキック（game/tet/rotation.js tryRotate と同じ表。実機は (dx, -dy) を足して試す）。
// CPU のスクリプトは読み直されることがあるので var（const だと 2 回目の読み込みで止まる）
var CPU_KICK_I_CW = { '0->1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], '1->2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
                      '2->3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], '3->0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]] };
var CPU_KICK_CW   = { '0->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '1->2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
                      '2->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '3->0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]] };
var CPU_KICK_I_CCW = { '0->3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], '3->2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
                       '2->1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], '1->0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]] };
var CPU_KICK_CCW   = { '0->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '3->2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
                       '2->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '1->0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]] };

window.CPU = class{
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; // true: CPUが操作する, false: 人間が操作してCPUが採点する
        this.currentMino = null;
        this.baseScore = 0;     // 出現時の盤面の基礎点

        // 1 操作ずつ入れる間隔（ms。設計 source_assets/memory/mode/cpu/tet/lv1-2/lv1-2-input-design.md §2.4。仮の値）
        this.firstDelay = 300;      // 出現 → 最初の操作
        this.actionDelay = 300;     // 操作 → 次の操作
        this.harddropDelay = 350;  // 最後の操作 → ハードドロップ（今までの「飛ばしてから待つ」と同じ）
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
            if (window.CpuZone) CpuZone.planMark(this); // この盤面で決める（ZONE が終わって動いたら考え直す）
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
                let isSpawnValid = this.isValidPlacement(simMino, x, range.y, currentBlocks);
                if (!isSpawnValid) continue;

                searchCount++;

                // 共通ロジックを使って落下位置を計算
                let ghostY = range.y;
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

    // 向きごとに、今の位置から 1 操作ずつ（回転 → 1 マスずつ横移動）入れて届く列の範囲 { lo, hi, y }。届かない向きは null。
    // 回転は今と同じく 右 1 回 / 右 2 回 / 左 1 回で、実機と同じ SRS のキック込み（game/tet/rotation.js tryRotate の表。
    // 2026-11-25: キック無しだと高く積んだ所で縦の I が井戸へ入れず自滅した）。y は回転の後の高さ（キックで変わる）。
    // 横移動はその高さで、途中の列がすべて空いている所まで。横移動の後に回したり下へ動かしたりはしないので、
    // 回転入れ・キックで登る動きは作らない。O は回しても形が同じなので回さない
    reachableRanges(mino, currentBlocks) {
        const x0 = mino.x, y0 = mino.y, r0 = mino.rotation;
        const shapes = [];
        for (let k = 0; k < 4; k++) {
            const m = new Mino(mino.type);
            for (let i = 0; i < k; i++) m.rotate();
            shapes.push(m);
        }
        const top = (this.game && typeof this.game.topLimit === 'number') ? this.game.topLimit : -5;
        const fits = (k, x, y) => this.isValidPlacement(shapes[k], x, y, currentBlocks)
            && shapes[k].blocks.every(b => b.y + y >= top);
        const isI = mino.type === 0;
        const turn = (p, dir) => {
            const to = (p.r + (dir === 1 ? 1 : 3)) % 4;
            const tbl = (dir === 1 ? (isI ? CPU_KICK_I_CW : CPU_KICK_CW) : (isI ? CPU_KICK_I_CCW : CPU_KICK_CCW))[`${p.r}->${to}`];
            for (const [dx, dy] of tbl) {
                // 実機と同じく (dx, -dy) を足した所を試す
                if (fits(to, p.x + dx, p.y - dy)) return { r: to, x: p.x + dx, y: p.y - dy };
            }
            return null;
        };
        const out = [null, null, null, null];
        if (!fits(r0, x0, y0)) return out;
        for (let rot = 0; rot < 4; rot++) {
            if (mino.type === 1 && rot !== r0) continue;
            const d = (rot - r0 + 4) % 4;
            let p = { r: r0, x: x0, y: y0 };
            if (d === 3) p = turn(p, -1);
            else for (let i = 0; p && i < d; i++) p = turn(p, 1);
            if (!p) continue;
            let lo = p.x, hi = p.x;
            while (fits(rot, lo - 1, p.y)) lo--;
            while (fits(rot, hi + 1, p.y)) hi++;
            out[rot] = { lo, hi, y: p.y };
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

    // 置く手を 1 操作ずつの列にする（回転 → 1 マスずつ横移動。最後のハードドロップは runMove が入れる）。
    // moveTo は 1 マスずつ寄せる（今の列から目標の列まで。着くまで列に残る）
    buildActionQueue(move) {
        const mino = this.game.mino;
        const queue = [];
        const d = (move.rot - mino.rotation + 4) % 4;
        if (mino.type !== 1) {
            if (d === 3) queue.push({ type: 'rotate', dir: -1 });
            else for (let i = 0; i < d; i++) queue.push({ type: 'rotate', dir: 1 });
        }
        // 横移動は回転の後の列から数える（回転はキックで列が変わることがある。探索も同じ順で調べている）
        if (move.x !== mino.x || queue.length > 0) queue.push({ type: 'moveTo', x: move.x });
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
        // ZONE が終わって盤面が下がった（発動中の盤面で決めた手はもう合わない）。操作をやめて、いまのミノで考え直す
        // （cpu/tet/cpu_zone.js planStale。次のフレームで updateLoop が onMinoSpawned を呼ぶ）
        const stale = () => {
            if (!(window.CpuZone && CpuZone.planStale(this))) return false;
            this.holdGravity(false);
            CpuZone.planDrop(this);
            return true;
        };

        const tryDrop = () => {
            if (!alive()) return;
            if (paused()) { this.game.cpuSchedule(100, tryDrop); return; }
            if (stale()) return;
            this.game.cpuAction('hardDrop');
        };
        const step = () => {
            if (!alive()) { if (this.isActive) this.holdGravity(false); return; }
            if (paused()) { this.game.cpuSchedule(100, step); return; }
            if (stale()) return;
            let a = queue.shift();
            // 回転の後にもう目標の列にいれば寄せない
            while (a && a.type === 'moveTo' && this.game.mino.x === a.x) a = queue.shift();
            if (a) {
                let ok;
                if (a.type === 'rotate') ok = this.game.cpuAction('rotate', a.dir);
                else {
                    ok = this.game.cpuAction('shift', Math.sign(a.x - this.game.mino.x), true);
                    if (ok && this.game.mino.x !== a.x) queue.unshift(a);
                }
                // 動けなかったら（探索の読みと違う。ふつうは起きない）それ以上は寄せずにその場で落とす
                if (!ok) queue.length = 0;
                this.game.drawAll();
            }
            // 回転だけで目標の列に着いたら、寄せの番を待たずにハードドロップへ
            while (queue.length > 0 && queue[0].type === 'moveTo' && this.game.mino.x === queue[0].x) queue.shift();
            if (queue.length > 0) { this.game.cpuSchedule(this.actionDelay, step); return; }
            this.holdGravity(false);
            this.game.cpuSchedule(this.harddropDelay, tryDrop);
        };

        if (queue.length === 0) { this.holdGravity(false); this.game.cpuSchedule(this.harddropDelay, tryDrop); return; }
        this.holdGravity(true);
        this.game.cpuSchedule(this.firstDelay, step);
    }
}