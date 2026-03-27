class CPU {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.currentMino = null;
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

        // 新しいミノが出現したかチェック
        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.onMinoSpawned();
        }

        requestAnimationFrame(() => this.updateLoop());
    }

    onMinoSpawned() {
        // 2. 探索フェーズ（最適な設置場所を探す）
        const bestMove = this.searchBestMove(this.game.mino);

        // 3 & 4. 操作フェーズ（1秒後に座標指定で強制配置）
        // レベルに応じてディレイを変えることも可能ですが、テスト用に1秒固定にします
        setTimeout(() => {
            if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                this.executeMove(bestMove.id, bestMove.rot, bestMove.x, bestMove.y);
            }
        }, 1000); 
    }

    // ─────────────────────────────────────────
    // 2. 探索の枠組み (現在はダミー実装)
    // 戻り値: { id, rot, x, y }
    // ─────────────────────────────────────────
    searchBestMove(mino) {
        let bestScore = -Infinity;
        let bestMove = null;

        // TODO: ここで全回転(0~3)と全X座標(0~9)のループを回し、
        // 仮想の盤面に置いて評価値（隙間の少なさ、消去ライン数など）を計算するロジックを作ります。

        // ▼ 仮の実装：とりあえず「右に2マスずらして、1回右回転」させた状態を返す
        bestMove = {
            id: mino.type,
            rot: 1,       // 1: 右回転(East)
            x: 6,         // X座標: 6
            y: 19         // Y座標 (※今回はexecuteMove内でハードドロップを使うため厳密でなくてOK)
        };

        return bestMove;
    }

    // ─────────────────────────────────────────
    // 3 & 4. 座標指定による実行
    // 指定されたパラメータ通りに強制的に状態を書き換え、ハードドロップで固定する
    // ─────────────────────────────────────────
    executeMove(id, targetRot, targetX, targetY) {
        const mino = this.game.mino;

        // 安全対策: 対象のミノが既に変わっていたらキャンセル
        if (!mino || mino.type !== id) return;

        // ① 回転の強制適用
        // Gameクラスの rotate() を使って内部のブロック座標も同期させる
        while (mino.rotation !== targetRot) {
            mino.rotate(); 
            mino.rotation = (mino.rotation + 1) % 4;
        }

        // ② X座標の強制適用
        mino.x = targetX;

        // ③ 落下＆固定
        // ※ Y座標を直接 targetY に書き換えても良いですが、他のブロックへの「めり込み」を
        // 防ぐため、X座標を合わせた状態で一番上から hardDrop() を呼ぶのが最も安全で確実です。
        this.game.hardDrop();
    }
}