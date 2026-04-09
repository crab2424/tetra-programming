// ─────────────────────────────────────────────
// cpu1.js
// ぷよCPU lv1 - Web Worker + Wasm 連携版
// PuyoGame インスタンスを受け取り，自動操作を行う
// ─────────────────────────────────────────────

window.PuyoCPU = class {
    constructor(gameInstance) {
        this.game = gameInstance;

        // ────────────────────────────────
        // ★ 評価パラメータ（ここで調整する）
        // EvalWeights に対応（weightsArray のインデックス順）
        // ────────────────────────────────
        this.weights = {
            chainBonus:        500,  // [0] 連鎖数ボーナス（×連鎖数）
            erasedBonus:        20,  // [1] 消去ぷよ数ボーナス（×消去数）
            heightPenalty:     -30,  // [2] 最大高さペナルティ（×段数）
            heightDiffPenalty:  -8,  // [3] 隣接列高さ差ペナルティ（×差）
            holePenalty:       -60,  // [4] 穴ペナルティ（×個数）
            flatBonus:           5,  // [5] 平坦ボーナス（差=0の隣接ペアごと）
            colorConnBonus:     12,  // [6] 同色隣接ペア数ボーナス
            zenkeshiBonus:     100,  // [7] 全消しボーナス
            p1Weight:           70,  // [8] 1手目スコアの重み (%, 100=等倍)
        };

        // ────────────────────────────────
        // 内部状態
        // ────────────────────────────────
        this.isActive          = false;
        this.isAutoPlay        = true;
        this.isCalculating     = false;
        this.currentPairKey    = null; // 現在処理中の組ぷよを識別するキー
        this.bestMoveData      = null; // 最新の計算結果

        // アクション実行制御
        this.isExecutingAction = false;
        this.actionQueue       = [];
        this.actionDelay       = 80;  // 各アクション間の待機時間 (ms)
        this.placeDelay        = 120; // 設置（固定）前の待機時間 (ms)

        // ────────────────────────────────
        // Web Worker 初期化
        // ────────────────────────────────
        this.workerReady = false;

        // Worker ファイルのパスはプロジェクト構成に合わせて変更する
        this.worker = new Worker('cpu/puyo/lv1/cpu_worker1.js');

        this.worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('🚀 Wasm PuyoCPU1 Worker Ready!');
                this.workerReady = true;
            } else if (e.data.type === 'result') {
                this._handleWorkerResult(e.data.result);
            }
        };

        this.worker.onerror = (err) => {
            console.error('❌ PuyoCPU1 Worker Error:', err.message, err.filename, err.lineno);
        };
    }

    // ══════════════════════════════════════════════
    // 外部 API
    // ══════════════════════════════════════════════

    start() {
        this.isActive = true;
        this._updateLoop();
    }

    stop() {
        this.isActive          = false;
        this.bestMoveData      = null;
        this.isExecutingAction = false;
        this.actionQueue       = [];

        if (this.worker) {
            this.worker.terminate();
            this.worker      = null;
            this.workerReady = false;
        }
    }

    // ══════════════════════════════════════════════
    // メインループ（組ぷよ出現を検知して計算をトリガー）
    // ══════════════════════════════════════════════

    _updateLoop() {
        if (!this.isActive) return;

        const game = this.game;

        // falling ステート（操作可能な状態）の時だけ計算・実行する
        if (game._gs === 'falling') {
            // 組ぷよが切り替わったことを「pivotColor + childColor の組み合わせ」で検知
            const key = `${game.pivotColor}_${game.childColor}_${game.pivotX.toFixed(1)}_${game.pivotY.toFixed(1)}`;
            if (key !== this.currentPairKey) {
                this.currentPairKey    = key;
                this.isExecutingAction = false;
                this.actionQueue       = [];
                this.bestMoveData      = null;
                this._requestCalculation();
            }
        }

        requestAnimationFrame(() => this._updateLoop());
    }

    // ══════════════════════════════════════════════
    // Wasm へ計算を依頼
    // ══════════════════════════════════════════════

    _requestCalculation() {
        if (!this.workerReady || this.isCalculating) return;

        const game = this.game;
        if (!game || game.state !== 'playing') return;

        this.isCalculating = true;

        // ── 盤面データ構築 (uint8[14*6], 内部行順) ──
        // game.field[r][c] は内部行インデックス (0=隠し行0, 1=隠し行1, 2〜13=表示行)
        const TOTAL_ROWS = 14; // ROWS(12) + HIDDEN(2)
        const COLS       = 6;
        const boardBuffer = new Uint8Array(TOTAL_ROWS * COLS);
        for (let r = 0; r < TOTAL_ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                boardBuffer[r * COLS + c] = game.field[r][c] || 0;
            }
        }

        // ── 現在の組ぷよ ──
        const pivotColor = game.pivotColor;
        const childColor = game.childColor;

        // ── NEXT キュー（nextQueue[0] = NEXT1, nextQueue[1] = NEXT2）
        // 各要素は [pivotColor, childColor] の配列
        const next1 = game.nextQueue[0] || [1, 1];
        const next2 = game.nextQueue[1] || [1, 1];

        // ── 重みを Int32Array に変換 ──
        const weightsArray = new Int32Array([
            this.weights.chainBonus,
            this.weights.erasedBonus,
            this.weights.heightPenalty,
            this.weights.heightDiffPenalty,
            this.weights.holePenalty,
            this.weights.flatBonus,
            this.weights.colorConnBonus,
            this.weights.zenkeshiBonus,
            this.weights.p1Weight,
        ]);

        this.worker.postMessage({
            type:        'calculate',
            boardBuffer: boardBuffer,
            pivotColor:  pivotColor,
            childColor:  childColor,
            next1Pivot:  next1[0],
            next1Child:  next1[1],
            next2Pivot:  next2[0],
            next2Child:  next2[1],
            weightsArray: weightsArray,
        });
    }

    // ══════════════════════════════════════════════
    // Worker からの結果受信
    // ══════════════════════════════════════════════

    _handleWorkerResult(res) {
        this.isCalculating = false;

        // outResult[0] = 最善手の軸ぷよ列 (-1 = 探索失敗)
        if (res[0] === -1) {
            console.warn('PuyoCPU1: 配置候補なし');
            // 置き場所がない場合はとりあえず真ん中に縦置き
            if (this.isAutoPlay && this.isActive && !this.game.isPaused) {
                this._executeMove(2, 0, -1, -1, -1, -1);
            }
            return;
        }

        this.bestMoveData = {
            col1: res[0], rot1: res[1],
            score: res[2],
            col2: res[3], rot2: res[4],
            col3: res[5], rot3: res[6],
        };

        // 自動プレイ時は直ちに実行
        if (this.isAutoPlay && this.isActive && !this.game.isPaused) {
            if (!this.isExecutingAction) {
                this._executeMove(
                    this.bestMoveData.col1, this.bestMoveData.rot1,
                    this.bestMoveData.col2, this.bestMoveData.rot2,
                    this.bestMoveData.col3, this.bestMoveData.rot3
                );
            }
        }
    }

    // ══════════════════════════════════════════════
    // 操作実行
    // ──  落下中の組ぷよを目標列・向きへ動かして固定する
    // ══════════════════════════════════════════════

    _executeMove(targetCol, targetRot, _col2, _rot2, _col3, _rot3) {
        if (!this.isActive || !this.isAutoPlay) return;
        if (this.isExecutingAction) return;

        this.isExecutingAction = true;
        this.actionQueue = this._buildActionQueue(targetCol, targetRot);

        // 最初のアクションを少し遅らせてから実行（ゲームの描画に合わせる）
        setTimeout(() => {
            this._processActionQueue();
        }, this.actionDelay);
    }

    // ══════════════════════════════════════════════
    // アクションキューを構築
    // ── 現在位置から targetCol / targetRot へ移動する手順を組み立てる
    // ══════════════════════════════════════════════

    _buildActionQueue(targetCol, targetRot) {
        const queue = [];
        const game  = this.game;

        // 現在の軸ぷよの論理位置（整数列）
        const startCol = game.pivotX;
        const startRot = game.targetRot;

        // ── 1. 回転アクションの生成 ──
        // 向き差を最短経路（CW/CCW）で解決する
        const rotDiff = ((targetRot - startRot) % 4 + 4) % 4;
        if (rotDiff === 1) {
            queue.push({ type: 'rotateCW' });
        } else if (rotDiff === 2) {
            // 180度: CW×2 または CCW×2（どちらでも可）
            queue.push({ type: 'rotateCW' });
            queue.push({ type: 'rotateCW' });
        } else if (rotDiff === 3) {
            queue.push({ type: 'rotateCCW' });
        }

        // ── 2. 横移動アクションの生成 ──
        const moveDiff = targetCol - startCol;
        const moveType = moveDiff > 0 ? 'moveRight' : 'moveLeft';
        for (let i = 0; i < Math.abs(moveDiff); i++) {
            queue.push({ type: moveType });
        }

        // ── 3. 固定（ハードドロップ相当の待機後に lockTimer を加速させる） ──
        // ぷよぷよにはハードドロップがないため、ソフトドロップを連続で送る
        queue.push({ type: 'softDropUntilLock' });

        return queue;
    }

    // ══════════════════════════════════════════════
    // アクションキューの処理
    // ══════════════════════════════════════════════

    _processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            return;
        }

        // ゲームが falling ステートでなければ中断（連鎖中などは待機）
        if (this.game._gs !== 'falling') {
            this.isExecutingAction = false;
            return;
        }

        const action = this.actionQueue.shift();

        switch (action.type) {
            case 'rotateCW':
                this.game._tryRotate(1);
                break;

            case 'rotateCCW':
                this.game._tryRotate(-1);
                break;

            case 'moveLeft':
                this.game._tryMove(-1);
                break;

            case 'moveRight':
                this.game._tryMove(1);
                break;

            case 'softDropUntilLock':
                // ソフトドロップキーを押し続けて高速落下 → ロックタイマーを加速
                // _handleGravity は _update 内で毎フレーム呼ばれるため、
                // ここでは lockTimer を強制的に満たして即固定する
                this._forceLock();
                break;

            default:
                break;
        }

        if (action.type !== 'softDropUntilLock') {
            // 次のアクションへ
            if (this.actionQueue.length > 0) {
                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) this._processActionQueue();
                }, this.actionDelay);
            } else {
                // キューが空になったら固定処理へ
                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                }, this.placeDelay);
            }
        } else {
            // softDropUntilLock は _forceLock 内で処理完了
            this.isExecutingAction = false;
        }
    }

    // ══════════════════════════════════════════════
    // 強制固定（lockTimer を満たして _fixPuyo を呼ぶ）
    // ══════════════════════════════════════════════

    _forceLock() {
        if (!this.isActive) return;
        if (this.game._gs !== 'falling') return;

        // pivotY を limitY に強制スナップして固定
        const limitY = this.game._calcLimitY(
            this.game.pivotX,
            this.game.pivotY,
            this.game.targetRot
        );
        this.game.pivotY = limitY;
        this.game.lockTimer = 99999; // _handleGravity で固定条件を満たす大きな値
        // _update の次フレームで _fixPuyo が呼ばれる
        // 直接呼んでも良いが、アニメーション整合性のため _update に任せる
    }
};