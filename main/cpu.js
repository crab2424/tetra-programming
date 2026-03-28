// ─────────────────────────────────────────────
// cpu.js
// CPUの思考・操作・解析をつかさどるクラス
// ─────────────────────────────────────────────

class CPU {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; // true: CPUが操作する, false: 人間が操作してCPUが採点する
        this.currentMino = null;
        this.baseScore = 0;     // 出現時の盤面の基礎点

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
    

    start() {
        this.isActive = true;
        this.updateLoop();
    }

    stop() {
        this.isActive = false;
    }

    updateLoop() {
        if (!this.isActive) return;

        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.onMinoSpawned();
        }

        if (this.game.mino && !this.game.isPaused) {
            this.updateGhostEval();
        }

        requestAnimationFrame(() => this.updateLoop());
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

                if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                    // めり込みを防ぐため、シミュレーション時の安全なY座標(spawnY)も渡す
                    this.moveMinoTo(bestMove.id, bestMove.rot, bestMove.x, bestMove.spawnY);

                    setTimeout(() => {
                        if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                            this.game.hardDrop();
                        }
                    }, 700); // 0.7秒待機
                }
            } else {
                setTimeout(() => {
                    if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                        this.game.hardDrop();
                    }
                }, 700);
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
            let isOverlapping = (by >= 0) && currentBlocks.some(cb => cb.x === bx && cb.y === by);
            return bx >= 0 && bx < 10 && by < 20 && !isOverlapping;
        });
    }

    searchBestMove(mino) {
        let bestDiff = -10000;
        let bestMove = null;
        let searchCount = 0;
        const SEARCH_LIMIT = 200;

        const currentBlocks = this.game.field.blocks.map(b => ({ x: b.x, y: b.y }));
        const baseScore = this.evaluateBoard(currentBlocks, 0, false, 0);

        for (let rot = 0; rot < 4; rot++) {
            for (let x = -2; x < 12; x++) {
                if (searchCount >= SEARCH_LIMIT) break;

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

                if (diff > bestDiff) {
                    bestDiff = diff;
                    bestMove = { id: mino.type, rot: rot, x: x, y: ghostY, score: score, diff: diff, spawnY: mino.y };
                }
            }
        }
        
        return bestMove;
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

    // めり込みを防止しつつ目標の位置へ移動する
    moveMinoTo(id, targetRot, targetX, spawnY) {
        const mino = this.game.mino;
        if (!mino || mino.type !== id) return;

        // まずY座標を安全な場所（spawnY）に戻してから回転操作を行う
        if (spawnY !== undefined) {
            mino.y = spawnY;
        }

        // 目標の向きになるまで、必要な回数だけ確実に回転させる
        let rotationsNeeded = (targetRot - mino.rotation + 4) % 4;
        for (let i = 0; i < rotationsNeeded; i++) {
            mino.rotate(); 
            mino.rotation = (mino.rotation + 1) % 4; // 内部の数値を手動で同期させる！
        }

        const prevX = mino.x;
        mino.x = targetX;
        
        // 移動した結果がフィールド外やブロックと重なる場合（重力で落ちてしまった場合など）
        // その場合はX座標を元に戻してフォールバックする
        if (!this.game.valid(0, 0)) {
            mino.x = prevX;
        }

        this.game.drawAll();
    }
}