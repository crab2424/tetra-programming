// ─────────────────────────────────────────────
// cpu2.js
// 2手読みCPU（NEXT1、HOLD考慮）- Wasm連携対応版
// ─────────────────────────────────────────────

class CPU2 {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true; 
        this.currentMino = null;
        this.baseScore = 0;     

        // 評価関数の重み
        this.weights = {
            lineClear:    20,
            hole:         -24,
            heightLimit:  -5,
            heightDiff:   -3,
            flat:          2,
            step1Good:     3,
            step1Bad:     -2,
            step2Plus:    -8,
            groundedBonus: 12,
            touchingBonus: 1,   
            underSpace:   -6,
            singleWell:    1,  
            multiWell:    -10,   
        };

        // ─── Wasm (C++) 連携用の変数 ───
        this.boardBuffer = new Uint8Array(200); // 10x20の盤面用1次元配列
        this.boardPtr = null;                   // C++側の盤面用メモリポインタ
        this.resultPtr = null;                  // C++側の結果受け取り用メモリポインタ
    }

    // 予測表示用コンテナの初期化
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
        this.updateLoop();
    }

    stop() {
        this.isActive = false;
        this.bestMoveData = null;
        if (this.estimateContainer) {
            this.estimateContainer.innerHTML = '';
        }

        // メモリリーク防止：Wasm側に確保したメモリを解放する
        if (typeof Module !== 'undefined' && Module._free) {
            if (this.boardPtr !== null) {
                Module._free(this.boardPtr);
                this.boardPtr = null;
            }
            if (this.resultPtr !== null) {
                Module._free(this.resultPtr);
                this.resultPtr = null;
            }
        }
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

        // ★ 変更：WasmとJSを透過的に切り替えるラッパー関数を呼ぶ
        const bestMove = this.searchBestMove(this.game.mino);
        this.bestMoveData = bestMove;

        if (this.game.currentMode === 'test') {
            this.renderEstimatePlace();
        }

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
        }

        if (this.isAutoPlay) {
            if (bestMove) {
                if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                    if (bestMove.action === 'hold') {
                        setTimeout(() => {
                            if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                                this.game.holdCurrentMino();
                            }
                        }, 700);
                    } else {
                        this.moveMinoTo(bestMove.id, bestMove.rot, bestMove.x, bestMove.spawnY);

                        setTimeout(() => {
                            if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                                this.game.hardDrop();
                            }
                        }, 700);
                    }
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

    isValidPlacement(simMino, testX, testY, currentBlocks) {
        return simMino.blocks.every(b => {
            let bx = b.x + testX;
            let by = b.y + testY;
            let isOverlapping = (by >= 0) && currentBlocks.some(cb => cb.x === bx && cb.y === by);
            return bx >= 0 && bx < 10 && by < 20 && !isOverlapping;
        });
    }

    getAllPlacements(boardBlocks, pieceType, spawnY) {
        let placements = [];
        for (let rot = 0; rot < 4; rot++) {
            for (let x = -2; x < 12; x++) {
                let simMino = new Mino(pieceType);
                simMino.rotation = 0;
                for (let i = 0; i < rot; i++) {
                    simMino.rotate();
                    simMino.rotation = (simMino.rotation + 1) % 4;
                }

                if (!this.isValidPlacement(simMino, x, spawnY, boardBlocks)) {
                    continue;
                }

                let ghostY = spawnY;
                while (this.isValidPlacement(simMino, x, ghostY + 1, boardBlocks)) {
                    ghostY++;
                }

                let droppedBlocks = simMino.blocks.map(b => ({ x: b.x + x, y: b.y + ghostY }));
                let placementInfo = this.calculatePlacementInfo(boardBlocks, droppedBlocks);
                let simResult = this.simulateBoard(boardBlocks, droppedBlocks);

                placements.push({
                    rot: rot,
                    x: x,
                    y: ghostY, 
                    spawnY: spawnY,
                    blocks: simResult.blocks,
                    linesCleared: simResult.linesCleared,
                    isFullyGrounded: placementInfo.isFullyGrounded,
                    touchingCount: placementInfo.touchingCount
                });
            }
        }
        return placements;
    }

    getClearedLines(fieldBlocks, minoBlocks) {
        let blocks = [];
        for (let i = 0; i < fieldBlocks.length; i++) {
            blocks.push({ x: fieldBlocks[i].x, y: fieldBlocks[i].y });
        }
        for (let i = 0; i < minoBlocks.length; i++) {
            blocks.push({ x: minoBlocks[i].x, y: minoBlocks[i].y });
        }
        
        let clearedRowIndices = [];
        for (let r = 0; r < 20; r++) {
            let rowCount = blocks.filter(b => b.y === r).length;
            if (rowCount === 10) { 
                clearedRowIndices.push(r);
            }
        }
        return clearedRowIndices;
    }

    // ─────────────────────────────────────────────
    // ★ 分岐：WasmモジュールがあればC++版、なければJS版を呼ぶ
    // ─────────────────────────────────────────────
    searchBestMove(mino) {
        if (typeof Module !== 'undefined' && Module._searchBestMoveWasm) {
            return this.searchBestMoveWasm(mino);
        }
        return this.searchBestMoveJS(mino);
    }

    // ─────────────────────────────────────────────
    // ★ 新規追加：C++ (WebAssembly) に探索を依頼する処理
    // ─────────────────────────────────────────────
    searchBestMoveWasm(mino) {
        // 1. 盤面データの構築（1次元配列化）
        this.boardBuffer.fill(0);
        this.game.field.blocks.forEach(b => {
            if (b.x >= 0 && b.x < 10 && b.y >= 0 && b.y < 20) {
                this.boardBuffer[b.y * 10 + b.x] = 1;
            }
        });

        // 2. メモリ領域の確保（初回のみ）
        if (this.boardPtr === null) {
            this.boardPtr = Module._malloc(200);        // 盤面用（1バイト×200マス）
            this.resultPtr = Module._malloc(4 * 12);    // 結果受け取り用（4バイト整数×12要素）
        }

        // 3. 盤面データをWasmのメモリへ高速コピー
        Module.HEAPU8.set(this.boardBuffer, this.boardPtr);

        // ミノ情報の取得
        const currentType = mino.type;
        const holdType = this.game.holdMino ? this.game.holdMino.type : -1;
        const next1 = this.game.nextQueue[0].type;
        const next2 = this.game.nextQueue[1].type;
        const canHold = this.game.canHold ? 1 : 0;

        // 4. C++の関数を呼び出す
        // void searchBestMoveWasm(uint8_t* board, int current, int hold, int next1, int next2, int canHold, int* outResult)
        Module._searchBestMoveWasm(
            this.boardPtr, 
            currentType, holdType, next1, next2, canHold, 
            this.resultPtr
        );

        // 5. C++からの結果を読み取る（Int32Arrayとしてパース）
        // outResult配列の定義:
        // [0]: action (-1:無効, 0:play, 1:hold)
        // [1]: score
        // [2]: diff
        // [3]: p1_id, [4]: p1_rot, [5]: p1_x, [6]: p1_y, [7]: p1_spawnY
        // [8]: p2_id, [9]: p2_rot, [10]: p2_x, [11]: p2_y
        const res = new Int32Array(Module.HEAP32.buffer, this.resultPtr, 12);
        
        if (res[0] === -1) return null; // 有効な手がない場合

        let bestMove = {
            action: res[0] === 1 ? 'hold' : 'play',
            score: res[1],
            diff: res[2],
            id: res[3], rot: res[4], x: res[5], spawnY: res[7],
            p1: { id: res[3], rot: res[4], x: res[5], y: res[6] },
            p2: res[8] !== -1 ? { id: res[8], rot: res[9], x: res[10], y: res[11] } : null,
            clearedLines: []
        };

        // ゴースト描画用に、1手目で消去されるラインをJS側でサクッと計算する
        if (bestMove.p1) {
            let simMino1 = new Mino(bestMove.p1.id);
            for(let i = 0; i < bestMove.p1.rot; i++) simMino1.rotate();
            let droppedBlocks1 = simMino1.blocks.map(b => ({ x: b.x + bestMove.p1.x, y: b.y + bestMove.p1.y }));
            bestMove.clearedLines = this.getClearedLines(this.game.field.blocks, droppedBlocks1);
        }

        return bestMove;
    }

    // ─────────────────────────────────────────────
    // 既存の JavaScript による探索（フォールバック用）
    // ─────────────────────────────────────────────
    searchBestMoveJS(mino) {
        let bestDiff = -10000;
        let bestMove = null;

        const baseBlocks = this.game.field.blocks.map(b => ({ x: b.x, y: b.y }));
        const baseScore = this.evaluateBoard(baseBlocks, 0, false, 0);

        let A = mino.type;
        let B = this.game.holdMino !== null ? this.game.holdMino.type : null;
        let C = this.game.nextQueue[0].type;
        let D = this.game.nextQueue[1].type; 

        let paths = [];

        paths.push({ firstAction: 'play', piece1: A, piece2: C }); 
        paths.push({ firstAction: 'play', piece1: A, piece2: B !== null ? B : D }); 

        if (this.game.canHold) {
            let firstPieceToPlay = B !== null ? B : C;
            let nextPiece = B !== null ? C : D;
            let heldPiece = A; 

            paths.push({ firstAction: 'hold', piece1: firstPieceToPlay, piece2: nextPiece }); 
            paths.push({ firstAction: 'hold', piece1: firstPieceToPlay, piece2: heldPiece }); 
        }

        let getSpawnY = (type) => type === 0 ? -1 : -2; 

        for (let path of paths) {
            let placements1 = this.getAllPlacements(baseBlocks, path.piece1, getSpawnY(path.piece1));

            for (let p1 of placements1) {
                let placements2 = this.getAllPlacements(p1.blocks, path.piece2, getSpawnY(path.piece2));

                if (placements2.length === 0) {
                    let score = this.evaluateBoard(p1.blocks, p1.linesCleared, p1.isFullyGrounded, p1.touchingCount) - 10000;
                    let diff = score - baseScore;
                    if (diff > bestDiff) {
                        bestDiff = diff;
                        bestMove = { 
                            action: path.firstAction, id: path.piece1, rot: p1.rot, x: p1.x, spawnY: p1.spawnY, score: score, diff: diff,
                            p1: { id: path.piece1, rot: p1.rot, x: p1.x, y: p1.y },
                            p2: null
                        };
                    }
                    continue;
                }

                for (let p2 of placements2) {
                    let totalLinesCleared = p1.linesCleared + p2.linesCleared;
                    let score = this.evaluateBoard(p2.blocks, totalLinesCleared, p2.isFullyGrounded, p2.touchingCount);
                    let diff = score - baseScore;

                    if (diff > bestDiff) {
                        bestDiff = diff;
                        bestMove = {
                            action: path.firstAction,
                            id: path.piece1,
                            rot: p1.rot,
                            x: p1.x,
                            spawnY: p1.spawnY,
                            score: score,
                            diff: diff,
                            p1: { id: path.piece1, rot: p1.rot, x: p1.x, y: p1.y }, 
                            p2: { id: path.piece2, rot: p2.rot, x: p2.x, y: p2.y }  
                        };
                    }
                }
            }
        }
        
        if (bestMove && bestMove.p1) {
            let simMino1 = new Mino(bestMove.p1.id);
            for(let i = 0; i < bestMove.p1.rot; i++) simMino1.rotate();
            let droppedBlocks1 = simMino1.blocks.map(b => ({ x: b.x + bestMove.p1.x, y: b.y + bestMove.p1.y }));
            bestMove.clearedLines = this.getClearedLines(baseBlocks, droppedBlocks1);
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
                blocks.filter(b => b.y < r).forEach(b => b.y++);
                r--; 
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

    moveMinoTo(id, targetRot, targetX, spawnY) {
        const mino = this.game.mino;
        if (!mino || mino.type !== id) return;

        if (spawnY !== undefined) {
            mino.y = spawnY;
        }

        let rotationsNeeded = (targetRot - mino.rotation + 4) % 4;
        for (let i = 0; i < rotationsNeeded; i++) {
            mino.rotate(); 
            mino.rotation = (mino.rotation + 1) % 4;
        }

        const prevX = mino.x;
        mino.x = targetX;
        
        if (!this.game.valid(0, 0)) {
            mino.x = prevX;
        }

        this.game.drawAll();
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
                if (clearedLines.includes(y_orig)) {
                    continue; 
                }
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
                if (yMap[drawY] !== undefined) {
                    drawY = yMap[drawY];
                }
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
}