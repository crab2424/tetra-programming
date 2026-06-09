// ─────────────────────────────────────────────
// p_game.js
// PUYOモード用ゲームエンジン（自己完結型）
// TETLABOに統合するぷよぷよシングルプレイモジュール
// ─────────────────────────────────────────────


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PuyoGame : メインクラス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class PuyoGame {
    constructor(canvasPrefix = null) {
        this.canvasPrefix = canvasPrefix;
        this.isVersusMode = false;
        this.isCpuControlled = false;
        this.rng = null;
        this.tumoRng = null; // オンライン対戦の同ツモ用（ツモ生成専用シード乱数）

        this.canvas = null;
        this.ctx = null;
        this.nextCanvas = null;
        this.nextCtx = null;
        this.scoreEl = null;
        this.timeEl = null;
        this.linesEl = null;
        this.levelEl = null;

        this.state = 'idle';
        this._gs = 'spawn';

        // fix.ogg（puyo_fix / puyo_drop）専用チャタリング防止用：
        // この盤面で最後に fix.ogg を鳴らした時刻（performance.now基準）
        this._lastFixSeTime = null;

        this.score = 0;
        this.chainMax = 0;
        this.chainCount = 0;
        this.clearedPuyos = 0;
        this.chainScoreAdd = 0;
        this.chainScoreStr = "";

        // ★ 火力・おじゃま管理用変数
        this.attackScore = 0;
        this.generatedOjamaTotal = 0;
        this.pendingFire = 0; // まだ相手に送るための処理を待機している火力

        // ★ ぷよ→テト火力変換用変数（混合戦でのみ使用）
        // ぷよ本来の ojamaRate 計算とは独立して保持する
        this.tetAttackCarry = 0; // 連鎖間で持ち越す端数得点（一連の連鎖終了時にmod70で次ターンへ持ち越し）
        this.tetAttackLines = 0; // 現在の連鎖チェーンで確定したおじゃまライン数
        this.tetPendingFire = 0; // 連鎖終了時に相手テトへ送る予定のライン数
        this.tetDropScore = 0; // このツモで積み上げた落下点数（連鎖開始時に1連鎖目の計算へ加算）
        this.hasTetZenkeshi = false; // ★ 全消しボーナス2ラインを保持・消化するためのフラグ
        this._tetCalcAdd = 0; // 点滅時に保存する連鎖消去点（消去時の _resolveTetAttack に渡す）
        this._tetCalcN = 0;   // 点滅時に保存する消去ぷよ数（同上）

        // ★ テトエンジン(game.js)との通信用キュー
        this.garbageQueue = [];
        this.ojamaUpdateQueue = [];
        this.sentGarbageThisTurn = []; // このターン（ツモ〜連鎖終了まで）に相手に送った1段階目のおじゃまオブジェクトを保持
        this.hasDroppedOjamaThisTurn = false;
        this.yokokuContainer = null;

        this.elapsed = 0;
        this._timerRunning = false;
        this._timerStart = 0;
        this._timerReqId = null;

        this._loopId = null;
        this.lastTime = performance.now();

        this.field = [];
        this.nextQueue = [];
        this.activeColors = [];

        this.pivotX = 2;
        this.pivotY = -0.5;
        this.pivotColor = 0;
        this.childColor = 0;

        this.targetRot = 0;
        this.targetAnimRot = 0;
        this.animRot = 0;
        this.quickTurnCount = 0;

        this.activeAnims = [];
        this.lastRotationInfo = null;
        this.fixAnimTimer = 0;
        this.fixAnimDuration = 0;
        this.fw5fTimer = 0;

        this.fallTimer = 0;
        this.lockTimer = 0;
        this.scoreFloat = 0;
        this.spawnAnimTimer = 0;

        this._keys = {};
        this._keyMap = {};
        this._keyHandlerDown = null;
        this._keyHandlerUp = null;
        this._gamepadLoop = null;
        this._gpConnectedHandler = null;
        this._gpDisconnectedHandler = null;
        this._gpPrevState = {};
        this._gamepadIndex = null;
        this._dasDir = 0;
        this._dasTimer = 0;
        this._arrTimer = 0;
        this._countdownLoopId = null; // ★ カウントダウン中にDASをチャージするための専用ループID
        this._priorityMove = false;
        this.inputBuffer = [];

        this._erasingCells = null;
        this._eraseTimer = 0;
        this.eraseWaitTimer = 0;
        this._dropAnim = null;

        this.pendingChainGroups = null;
        this.chainTextInfo = null;
        this.moveLockCount = 0;

        this.isAllClear = false; // ★ 全消し表示フラグ

        this._versusFinishing = false; // ★ versus終了演出中フラグ（stop()のキャンバス消去抑止用）

        this._images = {};
        this._imagesLoaded = false;
        this.isPaused = false;
    }

    _random() {
        if (this.rng) return this.rng();
        return Math.random();
    }

    // ツモ（色選択・ペア生成）専用の乱数。オンライン対戦で両者を同ツモにするため、
    // tumoRng が設定されていればそれを使う（未設定時は通常の _random にフォールバック）。
    // おじゃま生成の _random / Math.random とは分離しているため、受信おじゃま量が両者で
    // 異なってもツモ列はずれない。
    _tumoRandom() {
        if (this.tumoRng) return this.tumoRng();
        return this._random();
    }

    // ══════════════════════════════════════════════
    // 対戦・おじゃま通信 API (tet互換)
    // ══════════════════════════════════════════════

    get pendingOjama() {
        return this.garbageQueue.reduce((sum, g) => sum + g.amount, 0);
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ クラス静的プロパティ：全インスタンスで画像を共有するためのキャッシュ
//    初回ロード後は PuyoGame._sharedImagesLoaded = true になり、
//    以降の _loadImages では即座に callback() が呼ばれる（200ms遅延の解消）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PuyoGame._sharedImages = null;
PuyoGame._sharedImagesLoaded = false;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// グローバル公開 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function startPuyoGame() {
    if (!window._puyoGame) {
        window._puyoGame = new PuyoGame();
    } else {
        window._puyoGame.stop();
    }
    window._puyoGame.start();
}

function stopPuyoGame() {
    if (window._puyoGame) {
        window._puyoGame.stop();
    }
}