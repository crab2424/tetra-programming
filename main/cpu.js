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
            touchingBonus: 0,   // 接地条件を満たした時、周囲の壁・床・ブロックに触れている面1つにつきプラス
            underSpace:   -6,
            singleWell:    0,  // 3段以上の深い穴が1列だけの場合のボーナス（Iミノ待ち）
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
                // 1. EVAL値と「得点差」の表示を更新（CPU操作時にも表示）
                const evalEl = document.getElementById('eval-value');
                if (evalEl) evalEl.textContent = bestMove.score;

                if (diffEl) {
                    let diff = bestMove.score - this.baseScore;
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

                if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                    // 2. 最高スコアが確定した瞬間に「向きとX座標に横・回転移動」させる
                    this.moveMinoTo(bestMove.id, bestMove.rot, bestMove.x);

                    // 3. 0.3秒（300ms）待機してからハードドロップする
                    setTimeout(() => {
                        if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                            this.game.hardDrop();
                        }
                    }, 700);
                }
            } else {
                // 置く場所が見つからない時のフェイルセーフ
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

    searchBestMove(mino) {
        let bestScore = -Infinity;
        let bestMove = null;
        let searchCount = 0;
        const SEARCH_LIMIT = 2000;

        const currentBlocks = this.game.field.blocks.map(b => ({ x: b.x, y: b.y }));

        for (let rot = 0; rot < 4; rot++) {
            for (let x = -2; x < 12; x++) {
                if (searchCount >= SEARCH_LIMIT) break;

                let simMino = new Mino(mino.type);
                simMino.x = x;
                simMino.y = mino.y; 
                
                for (let i = 0; i < rot; i++) simMino.rotate();

                let isSpawnValid = simMino.blocks.every(b => {
                    let bx = b.x + simMino.x;
                    let by = b.y + simMino.y;
                    return bx >= 0 && bx < 10 && by < 20 && !currentBlocks.some(cb => cb.x === bx && cb.y === by);
                });

                if (!isSpawnValid) continue;

                searchCount++;

                let ghostY = simMino.y;
                while (true) {
                    let canMove = simMino.blocks.every(b => {
                        let bx = b.x + simMino.x;
                        let by = b.y + ghostY + 1;
                        return bx >= 0 && bx < 10 && by < 20 && !currentBlocks.some(cb => cb.x === bx && cb.y === by);
                    });
                    if (canMove) ghostY++;
                    else break;
                }

                let droppedBlocks = simMino.blocks.map(b => ({ x: b.x + simMino.x, y: b.y + ghostY }));
                
                let placement = this.calculatePlacementInfo(currentBlocks, droppedBlocks);
                let simResult = this.simulateBoard(currentBlocks, droppedBlocks);
                
                let score = this.evaluateBoard(simResult.blocks, simResult.linesCleared, placement.isFullyGrounded, placement.touchingCount);

                if (score > bestScore) {
                    bestScore = score;
                    bestMove = { id: mino.type, rot: rot, x: x, y: ghostY, score: score };
                }
            }
        }
        
        return bestMove;
    }

    calculatePlacementInfo(currentBlocks, droppedBlocks) {
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
        let blocks = [...fieldBlocks, ...minoBlocks];
        let linesCleared = 0;
        
        for (let r = 0; r < 20; r++) {
            let rowCount = blocks.filter(b => b.y === r).length;
            if (rowCount === 10) { 
                linesCleared++;
                blocks = blocks.filter(b => b.y !== r);
                blocks.filter(b => b.y < r).forEach(b => b.y++);
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

    // ─────────────────────────────────────────
    // ★ 変更：移動（回転とX座標の適用）のみを行い、描画を更新する
    // ─────────────────────────────────────────
    moveMinoTo(id, targetRot, targetX) {
        const mino = this.game.mino;
        if (!mino || mino.type !== id) return;

        while (mino.rotation !== targetRot) {
            mino.rotate(); 
            mino.rotation = (mino.rotation + 1) % 4;
        }

        mino.x = targetX;
        
        // 移動結果を即座に画面に反映させる
        this.game.drawAll();
    }
}