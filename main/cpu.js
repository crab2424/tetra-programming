// ─────────────────────────────────────────────
// cpu.js
// CPUの思考・操作をつかさどるクラス
// ─────────────────────────────────────────────

class CPU {
    constructor(gameInstance) {
        this.game = gameInstance; // window._cpuGame のインスタンスを保持
        this.isActive = false;
        this.currentMino = null;  // 現在処理中のミノを記録
    }

    // CPUの思考ループを開始
    start() {
        this.isActive = true;
        this.updateLoop();
    }

    // CPUの思考ループを停止（ゲームオーバー時などに呼ぶ）
    stop() {
        this.isActive = false;
    }

    // 毎フレーム（または定期的に）状態を監視するループ
    updateLoop() {
        if (!this.isActive) return;

        // 1. 現在操作可能なミノを取得する
        // （game.mino が存在し、かつ前回記録したミノと違うオブジェクトなら「新規出現」と判定）
        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.onMinoSpawned();
        }

        // 次のフレームでもう一度チェック
        requestAnimationFrame(() => this.updateLoop());
    }

    // ミノが出現した瞬間に呼ばれる処理
    onMinoSpawned() {
        // 2. ミノの設置場所について探索する（今回は省略）
        
        // 3. 設置場所を決定し、操作に変換する（今回は「1秒後にハードドロップ」に決定）
        
        // 4. 操作を行う
        setTimeout(() => {
            // 1秒経つ前にゲームが終了したり、ポーズされたり、
            // 既に別のミノに切り替わっていないかをチェック（安全対策）
            if (this.isActive && !this.game.isPaused && this.game.mino === this.currentMino) {
                this.game.hardDrop(); // 直接メソッドを叩いて操作
            }
        }, 1000);
    }
}