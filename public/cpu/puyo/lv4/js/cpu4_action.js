// ─────────────────────────────────────────────
// cpu4_action.js（操作エミュレーション / 移動・回転・ソフトドロップ）
//   PuyoCPU4.prototype を拡張する（cpu4.js が class 本体を定義済みであること）。
//
//   _executeMove()        … 目標 col/rot へ向けた操作キューを起動
//   _buildActionQueue()   … 回転・移動・着地までの操作列を組み立て
//   _processActionQueue() … キューを 1 手ずつ消化
//   _startSoftDropLoop()  … 重力を退避して高速ソフトドロップ
//   _restoreGravity()     … 退避した重力を復元
//   _forceLock()          … 落下中ピースを強制ロック
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU4.prototype, {

    _executeMove(targetCol, targetRot, path) {
        if (!this.isActive || !this.isAutoPlay) return;
        if (this.isExecutingAction) return;

        this.isExecutingAction = true;
        // ★ BFS(getAllPlacements)が出した到達操作列 path があればそれを再生する（上部回し対応）。
        //   path は spawn(列2/rot0)起点の絶対操作列で、着手開始時のピースも spawn なので整合する。
        //   path 無し（無候補フォールバック等）のときは従来の「回転→移動」で組み立てる。
        this.actionQueue = Array.isArray(path)
            ? this._buildActionQueueFromPath(path)
            : this._buildActionQueue(targetCol, targetRot);

        this.game.cpuSchedule(this.thinkDelay, () => {
            this._processActionQueue();
        });
    },

    // ★ BFS の操作列(path)をそのままアクションキューへ変換する。
    //   コード 1=左 2=右 4=回転CW 5=回転CCW。クイックターンは path 上に回転コードが
    //   2個連続で並ぶので、_tryRotate の quickTurnCount 蓄積で実機どおり 180°反転する。
    _buildActionQueueFromPath(path) {
        const queue = [];
        for (const code of path) {
            if (code === 1)      queue.push({ type: 'moveLeft' });
            else if (code === 2) queue.push({ type: 'moveRight' });
            else if (code === 4) queue.push({ type: 'rotateCW' });
            else if (code === 5) queue.push({ type: 'rotateCCW' });
        }
        queue.push({ type: 'softDropUntilLock' });
        return queue;
    },

    _buildActionQueue(targetCol, targetRot) {
        const queue = [];
        const game  = this.game;

        const startCol = game.pivotX;
        const startRot = game.targetRot;

        const rotDiff = ((targetRot - startRot) % 4 + 4) % 4;
        if (rotDiff === 1) queue.push({ type: 'rotateCW' });
        else if (rotDiff === 2) { queue.push({ type: 'rotateCW' }); queue.push({ type: 'rotateCW' }); }
        else if (rotDiff === 3) queue.push({ type: 'rotateCCW' });

        const moveDiff = targetCol - startCol;
        const moveType = moveDiff > 0 ? 'moveRight' : 'moveLeft';
        for (let i = 0; i < Math.abs(moveDiff); i++) {
            queue.push({ type: moveType });
        }

        queue.push({ type: 'softDropUntilLock' });

        return queue;
    },

    _processActionQueue() {
        if (!this.isActive || !this.isAutoPlay || this.actionQueue.length === 0) {
            this.isExecutingAction = false;
            this._restoreGravity();
            return;
        }

        if (this.game.isPaused || this.game.state === 'paused') {
            this.game.cpuSchedule(100, () => {
                if (this.isActive && this.isAutoPlay) this._processActionQueue();
            });
            return;
        }

        if (this.game._gs !== 'falling') {
            this.isExecutingAction = false;
            this._restoreGravity();
            return;
        }

        const action = this.actionQueue.shift();

        switch (action.type) {
            case 'rotateCW':
                this.game.cpuAction('rotate', 1);
                break;
            case 'rotateCCW':
                this.game.cpuAction('rotate', -1);
                break;
            case 'moveLeft':
                this.game.cpuAction('move', -1);
                break;
            case 'moveRight':
                this.game.cpuAction('move', 1);
                break;
            case 'softDropUntilLock':
                this._startSoftDropLoop();
                return;
        }

        if (this.actionQueue.length > 0) {
            this.game.cpuSchedule(this.actionDelay, () => {
                if (this.isActive && this.isAutoPlay) this._processActionQueue();
            });
        } else {
            this._restoreGravity();
            this.isExecutingAction = false;
        }
    },

    _startSoftDropLoop() {
        // 既存のループが動いていれば止めてから開始（世代を進めると古い tick は何もせず抜ける）
        const gen = this._softDropGen = (this._softDropGen || 0) + 1;
        this._softDropRafId = gen;

        // 自然落下タイマーをリセット（落下中に自然落下と競合させない）
        this.game.cpuAction('softDropStart');

        // テト側の gravity プロパティがある場合は退避
        if (this.originalGravity === null && this.game.gravity !== undefined) {
            this.originalGravity = this.game.gravity;
            this.game.gravity = 0;
        }

        const dropSpeedFast = 500 / 12; // プレイヤーと同じ: 500ms / 12マス

        // 毎フレームの入力の所で落とす（以前は専用の rAF と実時間。経過時間はゲーム時計から取る）
        let prevTime = this.game.clock.now();

        const tick = () => {
            if (gen !== this._softDropGen) return;
            const now = this.game.clock.now();
            // 停止・ポーズ・ゲーム状態の変化を検知したらループ終了
            if (!this.isActive || !this.isAutoPlay) {
                this._softDropRafId = null;
                this._restoreGravity();
                this.isExecutingAction = false;
                return;
            }

            if (this.game.isPaused || this.game.state === 'paused') {
                // ポーズ中は再開まで待機
                this.game.cpuFrame(tick);
                prevTime = now; // ポーズ中の時間を無効化
                return;
            }

            if (this.game._gs !== 'falling') {
                // 落下フェーズ終了（固定アニメ等に遷移）→ ループ終了
                this._softDropRafId = null;
                this._restoreGravity();
                this.game.cpuSchedule(this.placeDelay, () => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                });
                return;
            }

            // ── 経過時間から落下距離を計算（プレイヤーと同じ計算式）──
            let dt = now - prevTime;
            if (dt > 100) dt = 100; // 最大遅延ガード
            prevTime = now;

            if (this.game.cpuAction('softDropStep', dt / dropSpeedFast)) {
                // まだ接地していない
                this.game.cpuFrame(tick);
            } else {
                // 接地した → ループ終了し、lockTimer を進めて固定を促す
                this._softDropRafId = null;
                this._restoreGravity();

                this.game.cpuSchedule(this.placeDelay, () => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                });
            }
        };

        this.game.cpuFrame(tick);
    },

    _restoreGravity() {
        if (this.originalGravity !== null && this.game) {
            this.game.gravity = this.originalGravity;
            this.originalGravity = null;
        }
    },

    _forceLock() {
        this._restoreGravity();
        if (!this.isActive) return;
        if (this.game._gs !== 'falling') return;

        this.game.cpuAction('forceLock'); // 着地位置へ下ろして lockTimer を満了にする
    },
});
