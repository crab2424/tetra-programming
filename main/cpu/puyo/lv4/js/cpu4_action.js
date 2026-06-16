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

        setTimeout(() => {
            this._processActionQueue();
        }, this.thinkDelay);
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
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this._processActionQueue();
            }, 100);
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
                this._startSoftDropLoop();
                return;
        }

        if (this.actionQueue.length > 0) {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this._processActionQueue();
            }, this.actionDelay);
        } else {
            this._restoreGravity();
            this.isExecutingAction = false;
        }
    },

    _startSoftDropLoop() {
        if (this._softDropRafId !== null) {
            cancelAnimationFrame(this._softDropRafId);
            this._softDropRafId = null;
        }

        if (this.game.fallTimer !== undefined) this.game.fallTimer = 0;
        if (this.game.dropTimer !== undefined) this.game.dropTimer = 0;

        if (this.originalGravity === null && this.game.gravity !== undefined) {
            this.originalGravity = this.game.gravity;
            this.game.gravity = 0;
        }

        const dropSpeedFast = 500 / 12;

        let prevTime = performance.now();

        const tick = (now) => {
            if (!this.isActive || !this.isAutoPlay) {
                this._softDropRafId = null;
                this._restoreGravity();
                this.isExecutingAction = false;
                return;
            }

            if (this.game.isPaused || this.game.state === 'paused') {
                this._softDropRafId = requestAnimationFrame(tick);
                prevTime = now;
                return;
            }

            if (this.game._gs !== 'falling') {
                this._softDropRafId = null;
                this._restoreGravity();
                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                }, this.placeDelay);
                return;
            }

            let dt = now - prevTime;
            if (dt > 100) dt = 100;
            prevTime = now;

            const limitY = this.game._calcLimitY(
                this.game.pivotX,
                this.game.pivotY,
                this.game.targetRot
            );

            if (this.game.pivotY < limitY) {
                const dropDist = dt / dropSpeedFast;
                const prevY = this.game.pivotY;
                this.game.pivotY = Math.min(this.game.pivotY + dropDist, limitY);
                const actualDist = this.game.pivotY - prevY;

                this.game.scoreFloat += actualDist;
                if (this.game.scoreFloat >= 1) {
                    const add = Math.floor(this.game.scoreFloat);
                    this.game.score += add;
                    this.game.scoreFloat -= add;
                    if (typeof this.game._addDropScore === 'function') {
                        this.game._addDropScore(add);
                    }
                    this.game._updateScoreDisplay();
                }

                this._softDropRafId = requestAnimationFrame(tick);
            } else {
                this.game.pivotY = limitY;
                this._softDropRafId = null;
                this._restoreGravity();

                setTimeout(() => {
                    if (this.isActive && this.isAutoPlay) {
                        if (this.game._gs === 'falling') this._forceLock();
                    }
                    this.isExecutingAction = false;
                }, this.placeDelay);
            }
        };

        this._softDropRafId = requestAnimationFrame(tick);
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

        const limitY = this.game._calcLimitY(
            this.game.pivotX,
            this.game.pivotY,
            this.game.targetRot
        );
        this.game.pivotY = limitY;
        this.game.lockTimer = 99999;
    },
});
