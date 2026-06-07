// ─────────────────────────────────────────────
// Game クラス
// ─────────────────────────────────────────────
class Game {
    // canvasPrefix を引数で受け取れるようにする
    // 通常モード: prefix = null（従来のID: main-canvas, next-canvas, hold-canvas）
    // 対戦モード: prefix = 'player' or 'cpu'（例: player-main-canvas）
    constructor(canvasPrefix = null) {
        this.canvasPrefix = canvasPrefix; // null なら通常モード
        this.rule = 'tet';
        this.initMainCanvas()
        this.initNextCanvas()
        this.initHoldCanvas()
        this.lockDelay = 600; // 0.6秒
        this.lockTimer = null;
        this.isGrounded = false;
        this.bag = [];
        this.nextQueue = [];
        this.level = 1;
        this.lines = 0;
        this.backToBack = false;
        this.ren = 0;
        this.startTime = 0;
        this.elapsedTime = 0;
        this.isTimerRunning = false;
        this.actionLabels = [];
        this.actionAlpha = 0;
        this.pendingAttack = 0;
        this.pendingInternalAttack = 0; // 追加：相殺用（テト基準）の内部保持火力
        this._garbageTimers = []; // おじゃま降下猶予タイマー（ポーズで一時停止できるよう管理）
    }
}
