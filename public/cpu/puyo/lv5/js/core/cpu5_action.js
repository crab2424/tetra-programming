// ─────────────────────────────────────────────
// cpu5_action.js（操作エミュレーション / 移動・回転・クイックドロップ）
//   PuyoCPU5.prototype を拡張する（cpu5.js が class 本体を定義済みであること）。
//
//   _executeMove()        … 目標 col/rot へ向けた操作キューを起動
//   _buildActionQueue()   … 回転・移動・着地までの操作列を組み立て
//   _processActionQueue() … キューを 1 手ずつ消化
//   _startQuickDrop()     … クイックドロップ（ハードドロップ）で即着地・即設置
//   _restoreGravity()     … 退避した重力を復元（クイックドロップでは未使用の安全弁）
//
//   ★ 高速化：従来は重力を退避して RAF ループで疑似ソフトドロップしていたが、
//     ゲーム本体の _tryQuickDrop()（着地計算→lockTimer→設置音→_fixPuyo）を
//     直接呼ぶハードドロップに置き換え、落下アニメ分のフレームを丸ごと削減する。
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU5.prototype, {

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
        queue.push({ type: 'quickDrop' });
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

        queue.push({ type: 'quickDrop' });

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
            case 'quickDrop':
                this._startQuickDrop();
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

    // ★ クイックドロップ（ハードドロップ）：移動・回転が終わったピースを即着地・即設置する。
    //   ゲーム本体の _tryQuickDrop() が「着地Y算出 → lockTimer 設定 → 設置音 → _fixPuyo(true)」を
    //   すべて行うため、CPU 側は重力退避も RAF ループも不要。落下アニメ分のフレームを丸ごと省く。
    _startQuickDrop() {
        if (!this.isActive || !this.isAutoPlay) {
            this.isExecutingAction = false;
            return;
        }

        // ポーズ中は falling に戻るまで待ってからドロップする。
        if (this.game.isPaused || this.game.state === 'paused') {
            setTimeout(() => {
                if (this.isActive && this.isAutoPlay) this._startQuickDrop();
            }, 100);
            return;
        }

        // 既に落下が終わっている（連鎖中・ロック済み等）なら何もせず終了。
        if (this.game._gs !== 'falling') {
            this.isExecutingAction = false;
            return;
        }

        // 一気に着地させて即設置。
        this.game._tryQuickDrop();

        // 設置後に少し間を置いてから次の手の実行を許可する（演出の間）。
        setTimeout(() => {
            this.isExecutingAction = false;
        }, this.placeDelay);
    },

    // 旧ソフトドロップ実装の重力退避の後始末（クイックドロップ化後は退避しないので実質 no-op）。
    //   stop() / _processActionQueue() からの呼び出し互換のため安全弁として残す。
    _restoreGravity() {
        if (this.originalGravity !== null && this.game) {
            this.game.gravity = this.originalGravity;
            this.originalGravity = null;
        }
    },
});
