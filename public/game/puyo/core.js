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
        // ★ 連鎖文字DOM(48px固定)の縮小率。online対戦の相手パペットが --ol-scale に
        //   合わせて上書きする（src/battle/driver.ts）。CPU戦・単発プレイは常に1倍のまま。
        this._chainTextScale = 1;

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
        // ★ 描画アニメ（軸ぷよ点滅・消去予告点滅・ALL CLEAR明滅）専用の経過時間。
        //   elapsed はストップウォッチ用でプレイ中は0のまま進まない（_stopTimerでのみ加算）ため分離。
        this._animMs = 0;
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
        this._animMap = null;    // ★ _render が毎フレーム再利用する (fr*cols+c)->anim ルックアップ
        this._erasingSet = null; // ★ 同上 (fr*cols+c) の消去対象セル集合
        this._eraseTimer = 0;
        this.eraseWaitTimer = 0;
        this._dropAnim = null;

        this.pendingChainGroups = null;
        this.chainTextInfo = null;
        this._chainTextEl = null;   // ★ 連鎖文字の永続DOM要素（使い回し）
        this._chainNumEl = null;    // ★ 連鎖数字span（連鎖毎にテキストだけ更新）
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
// 先読み（preloadImages）の多重起動防止と、ロード完了待ちコールバックのキュー。
// 起動時の裏読みと初回 start() が重なっても画像ロードを1回に集約する。
PuyoGame._sharedImagesLoading = false;
PuyoGame._sharedImagesPending = [];

// ★ おじゃま予告アイコンの共有キャッシュ（盤面ぷよ画像と同じく全インスタンス共有）。
//    予告は表示更新が頻繁なため、デコード済みの Image を保持して clone で使い回す。
//    { img名: HTMLImageElement }。null = 未先読み。
PuyoGame._sharedOjamaImages = null;

// ★ 連鎖文字グリフのウォームアップ済みフラグ（ページ単位で1度だけ実行）
PuyoGame._chainGlyphsWarmed = false;

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