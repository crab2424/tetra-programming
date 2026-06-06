// ─────────────────────────────────────────────
// manager.js
// インスタンスの保持、開始、終了、停止、再開を統括するマネージャー
// ─────────────────────────────────────────────

class GameManager {
    // 稼働中のゲームインスタンスを保持するオブジェクト
    static instances = {
        p1: null,
        p2: null
    };

    // 全体の状態
    static state = {
        isPaused: false,
        isCountingDown: false // ★追加: カウントダウン中のポーズ無効化用フラグ
    };

    static _isInputInitialized = false; // ★追加: イベントの多重登録防止フラグ

    // ─────────────────────────────────────────────
    // ★新規追加: 入力管理の一元化
    // ─────────────────────────────────────────────
    
    /**
     * ゲーム全体のキー入力監視を初期化する（ブラウザロード時に1回だけ呼ばれる想定）
     */
    static initInputHandling() {
        if (this._isInputInitialized) return;
        
        const handleKey = (e, isDown) => {
            // ゲーム画面が表示されていない場合はキー入力を無視
            const gamePage = document.getElementById('game-page');
            if (!gamePage || !gamePage.classList.contains('active')) return;

            const keys = (typeof loadKeys === 'function') ? loadKeys() : { pause: { code: 'Escape' } };

            // 1. ポーズの処理（keydownの時のみ判定）
            if (isDown && e.code === keys.pause.code) {
                if (!GameManager.state.isCountingDown) {
                    GameManager.togglePause();
                }
                return; // ポーズキーは各ゲームエンジンの操作処理には渡さない
            }

            // ポーズ中はその他のゲーム操作を無効化
            if (GameManager.state.isPaused) return;

            // 2. 各インスタンスへイベントを分配 (receiveInputを呼び出す)
            Object.values(this.instances).forEach(inst => {
                // inst が存在し、receiveInput メソッドを持っていれば入力を渡す
                if (inst && typeof inst.receiveInput === 'function') {
                    inst.receiveInput(e, isDown);
                }
            });
        };

        // ブラウザ全体でのイベント監視はここだけで行う
        document.addEventListener('keydown', (e) => handleKey(e, true), { passive: false });
        document.addEventListener('keyup', (e) => handleKey(e, false), { passive: false });

        this._isInputInitialized = true;
    }

    // ─────────────────────────────────────────────
    // インスタンス管理
    // ─────────────────────────────────────────────
    
    /**
     * ゲームインスタンスを登録する
     * @param {string} playerType 'p1' または 'p2'
     * @param {Object} instance Game または PuyoGame のインスタンス
     */
    static setInstance(playerType, instance) {
        this.instances[playerType] = instance;
    }

    /**
     * 登録されているインスタンスを取得する
     * @param {string} playerType 'p1' または 'p2'
     */
    static getInstance(playerType) {
        return this.instances[playerType];
    }

    // ─────────────────────────────────────────────
    // ライフサイクル管理（終了・ポーズ）
    // ─────────────────────────────────────────────

    /**
     * 稼働中の全てのゲームを強制終了し、メモリを解放する
     */
    static stopAllGames() {
        // P1の停止と破棄
        if (this.instances.p1) {
            if (typeof this.instances.p1.stop === 'function') {
                this.instances.p1.stop();
            }
            this.instances.p1 = null;
        }

        // P2の停止と破棄
        if (this.instances.p2) {
            if (typeof this.instances.p2.stop === 'function') {
                this.instances.p2.stop();
            }
            this.instances.p2 = null;
        }

        this.state.isPaused = false;
        this.state.isCountingDown = false; // 強制終了時はカウントダウンフラグもリセット

        // 【安全策】グローバルにインスタンスが残っている場合も破棄する
        if (typeof window !== 'undefined') {
            if (window._game && typeof window._game.stop === 'function') window._game.stop();
            if (window._puyoGame && typeof window._puyoGame.stop === 'function') window._puyoGame.stop();
            if (window.gameP1 && typeof window.gameP1.stop === 'function') window.gameP1.stop();
            if (window.gameP2 && typeof window.gameP2.stop === 'function') window.gameP2.stop();
            
            window._game = null;
            window._puyoGame = null;
            window.gameP1 = null;
            window.gameP2 = null;
        }

        // オーバーレイの解除
        const pauseOverlay = document.getElementById('pause-overlay');
        if (pauseOverlay) pauseOverlay.classList.remove('active');
        const countdownOverlay = document.getElementById('countdown-overlay');
        if (countdownOverlay) countdownOverlay.classList.remove('active');
    }

    /**
     * 全ゲームのポーズ状態を切り替える (Pause / Resume)
     */
    static togglePause() {
        const overlay = document.getElementById('pause-overlay');
        if (!overlay) return;

        if (this.state.isPaused) {
            this.resumeAll();
            overlay.classList.remove('active');
        } else {
            this.pauseAll();
            overlay.classList.add('active');
        }
    }

    /**
     * 全ゲームをポーズする
     */
    static pauseAll() {
        this.state.isPaused = true;
        Object.values(this.instances).forEach(inst => {
            // カウントダウン中などのすり抜けを防ぐため、状態をチェックしてポーズ
            if (inst && typeof inst.pause === 'function') {
                inst.pause();
            }
        });
    }

    /**
     * 全ゲームを再開する
     */
    static resumeAll() {
        this.state.isPaused = false;
        Object.values(this.instances).forEach(inst => {
            if (inst && typeof inst.resume === 'function') {
                inst.resume();
            }
        });
    }
}