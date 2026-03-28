// ─────────────────────────────────────────────
// cpu.js
// CPUの思考・操作をつかさどるクラス
// ─────────────────────────────────────────────

class CPU {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.currentMino = null;

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ★ 評価値のパラメータ（重み）
        // ここの数値をいじることでCPUの性格・強さが変わります
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        this.weights = {
            lineClear:   100,  // ライン消去（1ラインにつき）
            hole:        -4,  // 穴（1つにつき）
            heightLimit: -10,  // 8段以上になった時のペナルティ（1段につき）

            // ▼ 今回追加した「平らさ」重視のパラメータ ▼
            heightDiff:   -3,  // 最高段と最低段の差（1段差につき）
            flat:          5,  // 隣の列と高さが同じ（1箇所につき）
            step1Good:     3,  // 1段差が2個以下の時のボーナス（1箇所につき）
            step1Bad:     -3,  // 1段差が3個以上の時のペナルティ（1箇所につき）
            step2Plus:    -5,   // 2マス以上の段差（1箇所につき）
            groundedBonus: 20, // ミノの下辺がすべて接地している場合のボーナス
            underSpace:   -30  // ミノの下辺に空間がある場合のペナルティ（1マスにつき）
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

        requestAnimationFrame(() => this.updateLoop());
    }

    onMinoSpawned() {
        const startTime = performance.now();
        const bestMove = this.searchBestMove(this.game.mino);

        // 画面のEVALを更新
        if (bestMove) {
            const evalEl = document.getElementById('eval-value');
            if (evalEl) evalEl.textContent = bestMove.score;
        }

        const processingTime = performance.now() - startTime;
        const waitTime = Math.max(0, 500 - processingTime);

        setTimeout(() => {
            if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                if (bestMove) {
                    this.executeMove(bestMove.id, bestMove.rot, bestMove.x, bestMove.y);
                } else {
                    this.game.hardDrop();
                }
            }
        }, waitTime); 
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

                let bottomEdges = {};
                droppedBlocks.forEach(b => {
                    // 各X座標について、最も下（Y座標が大きい）のブロックを記録
                    if (bottomEdges[b.x] === undefined || b.y > bottomEdges[b.x]) {
                        bottomEdges[b.x] = b.y;
                    }
                });
                
                let underSpaces = 0;
                for (let x in bottomEdges) {
                    let bottomY = bottomEdges[x];
                    // その真下（bottomY + 1）が床（20）であるか、既存のブロックが存在するか
                    let isGrounded = (bottomY + 1 >= 20) || currentBlocks.some(cb => cb.x == x && cb.y == bottomY + 1);
                    if (!isGrounded) {
                        underSpaces++;
                    }
                }

                let simResult = this.simulateBoard(currentBlocks, droppedBlocks);
                let score = this.evaluateBoard(simResult.blocks, simResult.linesCleared, underSpaces);

                if (score > bestScore) {
                    bestScore = score;
                    bestMove = { id: mino.type, rot: rot, x: x, y: ghostY, score: score };
                }
            }
        }
        
        return bestMove;
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

    // ─────────────────────────────────────────
    // 盤面の評価関数（パラメータ変数化）
    // ★ 第3引数に underSpaces を追加
    // ─────────────────────────────────────────
    evaluateBoard(blocks, linesCleared, underSpaces) {
        let score = 0;

        // 【ルール】ライン消去
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

        // ▼ 今回追加した「接地空間」の評価 ▼
        if (underSpaces === 0) {
            // 全て接地している（空間が0）
            score += this.weights.groundedBonus;
        } else {
            // 下に空間がある（宙に浮いた部分がある）
            score += underSpaces * this.weights.underSpace;
        }

        return score;
    }

    executeMove(id, targetRot, targetX, targetY) {
        const mino = this.game.mino;
        if (!mino || mino.type !== id) return;

        while (mino.rotation !== targetRot) {
            mino.rotate(); 
            mino.rotation = (mino.rotation + 1) % 4;
        }

        mino.x = targetX;
        this.game.hardDrop();
    }
}