const SATRT_BTN_ID = "start-btn"
const MAIN_CANVAS_ID = "main-canvas"
const NEXT_CANVAS_ID = "next-canvas"
const HOLD_CANVAS_ID = "hold-canvas"
const GAME_SPEED = 500;
const BLOCK_SIZE = 32;
const COLS_COUNT = 10;
const ROWS_COUNT = 20;
const LEVEL_SPEEDS = [
    0, // インデックス合わせのためのダミー(Level 0)
    1000, 793, 618, 473, 355, 262, 190, 135, 94, 64, 43, 28, 18, 11, 7
]; // ミノが1マス落ちる時間（ms）
const VISIBLE_EXTRA_ROW_RATIO = 0.5; // 上に見せる割合（-1行目）
const SCREEN_WIDTH = COLS_COUNT * BLOCK_SIZE;
const SCREEN_HEIGHT = (ROWS_COUNT + VISIBLE_EXTRA_ROW_RATIO) * BLOCK_SIZE;
const NEXT_AREA_SIZE = 160;
const BLOCK_SOURCES = [
    "images/block-0.png",
    "images/block-1.png",
    "images/block-2.png",
    "images/block-3.png",
    "images/block-4.png",
    "images/block-5.png",
    "images/block-6.png",
    "images/block-7.png"
]

window.onload = function(){
    Asset.init(function() {
    let game = new Game()
    // グローバルに保持（設定変更後に setKeyEvent を外から呼ぶため）
    window._game = game

    // ★ 追加：対戦用CPUゲームインスタンスを初期化（canvasPrefix='cpu'）
    let cpuGame = new Game('cpu')
    window._cpuGame = cpuGame

    // メインメニューの「GAME START」ボタン（旧UIとの後方互換、非表示だが残す）
    document.getElementById('menu-start-btn').onclick = function(){
        switchPage('game');
        game.start();
        this.blur();
    }

    // リザルト画面の「RETRY」ボタン
    document.getElementById('result-retry-btn').onclick = function(){
        switchPage('game');
        game.start();
        this.blur();
    }

    // 非表示のstart-btnは後方互換のため残す（非表示）
    document.getElementById(SATRT_BTN_ID).onclick = function(){
        switchPage('game');
        game.start()
        this.blur()
    }

    // ★ 追加：準備画面のコントロール表示を初期化（router.js の関数を呼ぶ）
    if (typeof updateMenuControlsDisplay === 'function') updateMenuControlsDisplay();
    })
}

// ─────────────────────────────────────────────
// 素材管理クラス
// ─────────────────────────────────────────────
class Asset{
    static blockImages = []

    static init(callback){
        let loadCnt = 0
        for(let i = 0; i <= 7; i++){
            let img = new Image();
            img.src = BLOCK_SOURCES[i];
            img.onload = function(){
                loadCnt++
                Asset.blockImages.push(img)
                if(loadCnt >= BLOCK_SOURCES.length && callback){
                    callback()
                }
            }
        }
    }
}

// ─────────────────────────────────────────────
// ★ 追加：カウントダウン演出ユーティリティ
// overlayId   : 表示するオーバーレイ要素のID
// textEl      : 数字/テキストを表示する要素
// onStart     : "START!" 表示の瞬間（入力受付開始）に呼ぶコールバック
// onComplete  : 演出が完全に終了したときのコールバック（任意）
// ─────────────────────────────────────────────
function runCountdown(overlayId, textElId, onStart, onComplete) {
    const overlay = document.getElementById(overlayId);
    const textEl  = document.getElementById(textElId);
    if (!overlay || !textEl) {
        if (onStart)    onStart();
        if (onComplete) onComplete();
        return;
    }

    // ★ 追加：前回のタイマーが動いていればキャンセル（リスタート対策）
    if (overlay.countdownTimer) clearTimeout(overlay.countdownTimer);

    overlay.classList.add('active');

    const steps = ['3', '2', '1', 'START!'];
    let stepIdx = 0;

    const showStep = () => {
        const val = steps[stepIdx];
        textEl.textContent = val;

        textEl.classList.remove('countdown-pop');
        void textEl.offsetWidth;
        textEl.classList.add('countdown-pop');

        if (val === 'START!' && onStart) {
            onStart();
        }

        stepIdx++;

        if (stepIdx < steps.length) {
            overlay.countdownTimer = setTimeout(showStep, 700);
        } else {
            overlay.countdownTimer = setTimeout(() => {
                overlay.classList.remove('active');
                textEl.textContent = '';
                if (onComplete) onComplete();
            }, 600);
        }
    };

    showStep();
}

// ─────────────────────────────────────────────
// ★ 終了演出ユーティリティ（リセット対応版）
// ─────────────────────────────────────────────
function showFinishOverlay(overlayId, textElId, text, className, duration, onComplete) {
    const overlay = document.getElementById(overlayId);
    const textEl  = document.getElementById(textElId);
    if (!overlay || !textEl) {
        if (onComplete) setTimeout(onComplete, duration || 800);
        return;
    }

    // ★ 追加：前回のタイマーが動いていればキャンセル
    if (overlay.countdownTimer) clearTimeout(overlay.countdownTimer);
    if (overlay.finishTimer1) clearTimeout(overlay.finishTimer1);
    if (overlay.finishTimer2) clearTimeout(overlay.finishTimer2);

    textEl.className = 'finish-text';
    if (className) textEl.classList.add(className);
    textEl.textContent = text;

    // リスタート用にクラスをリセットしてから表示
    overlay.classList.remove('fadeout');
    overlay.classList.add('active');

    overlay.finishTimer1 = setTimeout(() => {
        overlay.classList.add('fadeout');
        overlay.finishTimer2 = setTimeout(() => {
            overlay.classList.remove('active', 'fadeout');
            textEl.textContent = '';
            if (onComplete) onComplete();
        }, 500);
    }, duration || 800);
}

// ─────────────────────────────────────────────
// Game クラス
// ─────────────────────────────────────────────
class Game{
    // ★ 変更：canvasPrefix を引数で受け取れるようにする
    // 通常モード: prefix = null（従来のID: main-canvas, next-canvas, hold-canvas）
    // 対戦モード: prefix = 'player' or 'cpu'（例: player-main-canvas）
    constructor(canvasPrefix = null){
        this.canvasPrefix = canvasPrefix; // null なら通常モード
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
    }

    initMainCanvas(){
        // ★ prefix が指定されていれば "{prefix}-main-canvas" を使う
        const id = this.canvasPrefix ? `${this.canvasPrefix}-main-canvas` : MAIN_CANVAS_ID;
        this.mainCanvas = document.getElementById(id);
        this.mainCtx = this.mainCanvas.getContext("2d");
        this.mainCanvas.width = SCREEN_WIDTH;
        this.mainCanvas.height = SCREEN_HEIGHT;

        // ★ 追加：ページ読み込み時（ゲーム開始前）に一度だけグリッドを描画しておく
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
        this.drawGrid(this.mainCtx);
        this.mainCtx.restore();
    }

    initNextCanvas(){
        // ★ prefix が指定されていれば "{prefix}-next-canvas" を使う
        const id = this.canvasPrefix ? `${this.canvasPrefix}-next-canvas` : NEXT_CANVAS_ID;
        this.nextCanvas = document.getElementById(id);
        this.nextCtx = this.nextCanvas.getContext("2d");
        this.nextCanvas.width = BLOCK_SIZE * 4;
        this.nextCanvas.height = BLOCK_SIZE * 13.5;
    }

    initHoldCanvas(){
        // ★ prefix が指定されていれば "{prefix}-hold-canvas" を使う
        const id = this.canvasPrefix ? `${this.canvasPrefix}-hold-canvas` : HOLD_CANVAS_ID;
        this.holdCanvas = document.getElementById(id);
        this.holdCtx = this.holdCanvas.getContext("2d");
        this.holdCanvas.width = BLOCK_SIZE * 4;
        this.holdCanvas.height = BLOCK_SIZE * 4;
    }

    // グリッド線を描画する
    drawGrid(ctx) {
        ctx.save();
        // グリッド線の色と太さ（暗い背景に馴染む薄い白）
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;

        // 縦線を引く
        for (let x = 0; x <= COLS_COUNT; x++) {
            ctx.beginPath();
            // -1行目の上端（見えている部分）から一番下まで
            ctx.moveTo(x * BLOCK_SIZE, -BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
            ctx.lineTo(x * BLOCK_SIZE, ROWS_COUNT * BLOCK_SIZE);
            ctx.stroke();
        }

        // 横線を引く（-1行目の区切り線も含むように -1 からスタート）
        for (let y = -1; y <= ROWS_COUNT; y++) {
            ctx.beginPath();
            ctx.moveTo(0, y * BLOCK_SIZE);
            ctx.lineTo(COLS_COUNT * BLOCK_SIZE, y * BLOCK_SIZE);
            ctx.stroke();
        }
        ctx.restore();
    }

    // ゲーム開始
    start(){
        const overlayId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-overlay` : 'versus-countdown-overlay')
            : 'countdown-overlay';
        const textElId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-text` : 'versus-countdown-text')
            : 'countdown-text';

        this._initGameState();

        // ★ 追加：DASの先行チャージ等を受け付けるため、カウントダウン開始「前」にキーイベントをセット
        this.setKeyEvent();

        // カウントダウン開始
        runCountdown(overlayId, textElId, () => {
            this._startGameplay();
        }, null);
    }

    // ─────────────────────────────────────────
    // ★ 追加：ゲーム状態の初期化（カウントダウン前に呼ぶ）
    // ─────────────────────────────────────────
    _initGameState(){
        // モードごとの初期化
        this.mode = this.currentMode || 'marathon';
        if (this.mode === 'sprint') {
            this.startLevel = 1;
            this.goalLines = 40;
            this.timeLimit = 0;
        } else if (this.mode === 'ultra') {
            this.startLevel = 1;
            this.goalLines = 0;
            this.timeLimit = 120 * 1000; // 2分（ミリ秒）
        } else {
            // marathon
            this.startLevel = this.marathonStartLevel || 1;
            this.goalLines = this.marathonGoal || 150;
            this.timeLimit = 0;
        }

        // ★ 7バッグをリセット
        this.bag = [];
        this.nextQueue = [];
        for(let i = 0; i < 5; i++){
            this.nextQueue.push(new Mino(this.getNextType()));
        }
        this.garbageQueue = [];
        this.updateGarbageGauge();
        this.nextMino = null;
        this.field = new Field()
        this.holdMino = null
        this.canHold = true
        this.score = 0
        this.isPaused = false
        this.actionLabels = [];
        this.actionAlpha = 0;
        if(this._labelsInitialized) {
            Object.keys(this.labelTimers).forEach(id => {
                if(this.labelTimers[id].fade) clearTimeout(this.labelTimers[id].fade);
                if(this.labelTimers[id].clear) clearTimeout(this.labelTimers[id].clear);

                this.labelElements[id].style.opacity = '0';
                this.labelElements[id].innerHTML = '&nbsp;';
            });
        }
        this.lastActionWasRotation = false;
        this.lastRotUsedPoint5 = false;
        this.backToBack = false;
        this.ren = 0;
        this.hidePauseOverlay()
        this.level = 1;
        this.lines = 0;
        this.updateStatsDisplay();
        this.elapsedTime = 0;
        this.isTimerRunning = false;

        // ★ 追加：リスタート時にタイマー表示をリセット
        this.updateTimeDisplay();

        // ★ 追加：カウントダウンフラグと、ミノの未出現状態の設定
        this.isCountingDown = true;
        this.mino = null;

        // 既存のタイマーをすべて止めておく
        clearInterval(this.timer);
        this.timer = null;
        if(this.lockTimer){ clearTimeout(this.lockTimer); this.lockTimer = null; }

        // ★ 追加：リスタート時に表示中のオーバーレイを強制終了する
        const countdownId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-overlay` : 'versus-countdown-overlay')
            : 'countdown-overlay';
        const finishId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-finish-overlay` : 'versus-finish-overlay')
            : 'finish-overlay';

        const countdownOverlay = document.getElementById(countdownId);
        const finishOverlay = document.getElementById(finishId);

        if (countdownOverlay) {
            if(countdownOverlay.countdownTimer) clearTimeout(countdownOverlay.countdownTimer);
            countdownOverlay.classList.remove('active');
        }
        if (finishOverlay) {
            if(finishOverlay.finishTimer1) clearTimeout(finishOverlay.finishTimer1);
            if(finishOverlay.finishTimer2) clearTimeout(finishOverlay.finishTimer2);
            finishOverlay.classList.remove('active', 'fadeout');
        }

        // 初期描画（カウントダウン中もフィールドとNEXTが見える）
        this.drawAll()
    }

    // ─────────────────────────────────────────
    // ★ 追加：実際のゲームプレイ開始（START! 表示の瞬間に呼ばれる）
    // ─────────────────────────────────────────
    _startGameplay(){
        // ★ 追加：カウントダウンを解除し、ここで初めてミノを出現させる
        this.isCountingDown = false;
        this.popMino();
        this.drawAll();

        // タイマー開始
        this.startTime = performance.now();
        this.isTimerRunning = true;
        this.startTimerLoop();

        // 重力開始
        this.startGravity()
    }

    // ▼ 新規追加: タイマーの描画ループ（約60fps）
    startTimerLoop() {
        const loop = () => {
            if (!this.isTimerRunning) return;
            this.updateTimeDisplay();
            this.timerReqId = requestAnimationFrame(loop);
        };
        this.timerReqId = requestAnimationFrame(loop);
    }

    // ▼ 新規追加: タイムの計算とHTMLへの反映
    updateTimeDisplay() {
        let totalMs = this.elapsedTime;
        if (this.isTimerRunning) {
            totalMs += performance.now() - this.startTime;
        }

        let displayMs = totalMs;
        // ★ 対戦モードではtime-valueは使わない（非表示のため参照先なし）
        const timeEl = this.isVersusMode ? null : document.getElementById("time-value");

        // ★ 追加：Ultra モード時はカウントダウン処理
        if (this.mode === 'ultra') {
            displayMs = this.timeLimit - totalMs;
            if (displayMs <= 0) {
                displayMs = 0;
                if (this.isTimerRunning) {
                    this.isTimerRunning = false;
                    this.gameOver(true); // 時間切れでクリア扱い
                    return;
                }
            }
            // 残り10秒以下で文字を赤くする演出
            if (timeEl) {
                if (displayMs <= 10000) {
                    timeEl.style.color = "var(--danger)";
                    timeEl.style.webkitTextFillColor = "var(--danger)";
                } else {
                    timeEl.style.color = "";
                    timeEl.style.webkitTextFillColor = "transparent";
                }
            }
        } else {
            // 他のモードは通常色に戻す
            if (timeEl) {
                timeEl.style.color = "";
                timeEl.style.webkitTextFillColor = "transparent";
            }
        }

        const m = Math.floor(displayMs / 60000);
        const s = Math.floor((displayMs % 60000) / 1000);
        const ms = Math.floor((displayMs % 1000) / 10);

        const formattedTime =
            String(m).padStart(2, '0') + ':' +
            String(s).padStart(2, '0') + '.' +
            String(ms).padStart(2, '0');

        if(timeEl) {
            timeEl.textContent = formattedTime;
        }
    }

    // ポーズ切り替え
    togglePause(){
        if(this.isPaused){
            this.resume()
        } else {
            this.pause()
        }
    }

    pause(){
        if(this.isPaused) return
        this.isPaused = true
        clearInterval(this.timer)

        // ★変更: 接地猶予タイマーが動いていた場合、残り時間を計算して保存する
        if(this.lockTimer){
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
            this.lockRemaining -= (performance.now() - this.lockStartTime);
            this._wasLockingWhenPaused = true;
        } else {
            this._wasLockingWhenPaused = false;
        }

        this.showPauseOverlay()

        if(this.isTimerRunning){
            this.elapsedTime += performance.now() - this.startTime;
            this.isTimerRunning = false;
            cancelAnimationFrame(this.timerReqId);
        }
    }

    resume(){
        if(!this.isPaused) return
        this.isPaused = false
        this.hidePauseOverlay()

        // ★変更: 接地中(lockTimer稼働中)だったか空中だったかで再開処理を分ける
        if (this._wasLockingWhenPaused) {
            // 保存しておいた残り時間（最低0ms）で猶予タイマーを再開
            this.startLockTimer(Math.max(0, this.lockRemaining));
            this._wasLockingWhenPaused = false;
        } else if (!this.isGrounded) {
            this.startGravity();
        }

        if(!this.isTimerRunning){
            this.startTime = performance.now();
            this.isTimerRunning = true;
            this.startTimerLoop();
        }
    }

    // ─── 重力の開始 ───
    startGravity(){
        if(this.timer) clearInterval(this.timer);
        // 現在のレベルに応じた速度を取得（15を超えた場合は最速の7ms）
        const speed = LEVEL_SPEEDS[this.level] || 7;
        this.timer = setInterval(() => this.dropMino(), speed);
    }

    showPauseOverlay(){
        // ★ 対戦モードでは versus-pause-overlay を使う（router.js 側で管理）
        if (this.isVersusMode) return;
        document.getElementById('pause-overlay').classList.add('active')
    }

    hidePauseOverlay(){
        // ★ 対戦モードでは versus-pause-overlay を使う（router.js 側で管理）
        if (this.isVersusMode) return;
        document.getElementById('pause-overlay').classList.remove('active')
    }

    // ゲームオーバー処理
    // ★ 変更：引数に isClear（デフォルト false）を追加
    gameOver(isClear = false) {
        this.isClear = isClear;
        this.drawAll();
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }
        this.isPaused = true;

        if (this.isTimerRunning) {
            this.elapsedTime += performance.now() - this.startTime;
            this.isTimerRunning = false;
            cancelAnimationFrame(this.timerReqId);
            this.updateTimeDisplay();
        }

        // ★ 追加：対戦モードの場合は versusGameOver() に委譲する
        if (this.isVersusMode) {
            const loser = (this.canvasPrefix === 'cpu') ? 'cpu' : 'player';
            if (typeof versusGameOver === 'function') versusGameOver(loser);
            return;
        }

        // ★ 追加：シングルプレイの終了演出（FINISH!）を表示してからリザルトへ
        const finishText = isClear ? 'FINISH!' : 'GAME OVER';
        const finishClass = isClear ? 'finish-clear' : 'finish-gameover';
        showFinishOverlay('finish-overlay', 'finish-text', finishText, finishClass, 1200, () => {
            const timeEl = document.getElementById('time-value');
            const resultTitle = document.getElementById('result-title');

            // ★ 追加：クリア/ゲームオーバーの表示切り替え
            if (isClear) {
                resultTitle.textContent = "CLEARED!";
                resultTitle.style.color = "var(--success)";
                resultTitle.style.background = "none";
                resultTitle.style.webkitTextFillColor = "var(--success)";
            } else {
                resultTitle.textContent = "GAME OVER";
                resultTitle.style.background = "linear-gradient(90deg, var(--accent), var(--accent2))";
                resultTitle.style.webkitBackgroundClip = "text";
                resultTitle.style.webkitTextFillColor = "transparent";
            }

            document.getElementById('result-score').textContent = this.score;
            document.getElementById('result-level').textContent = this.level;
            document.getElementById('result-lines').textContent = this.lines;

            // ★ 追加：Sprint モードのゲームオーバー時は記録なし（タイム非表示）
            if (this.mode === 'sprint' && !isClear) {
                document.getElementById('result-time').textContent = "--:--.--";
            } else {
                document.getElementById('result-time').textContent = timeEl ? timeEl.textContent : '00:00.00';
            }

            if (typeof switchPage === 'function') switchPage('result');
        });
    }

    getNextType(){
        if(this.bag.length === 0){
            this.bag = [0,1,2,3,4,5,6];
            // シャッフル（Fisher-Yates）
            for(let i = this.bag.length - 1; i > 0; i--){
                const j = Math.floor(Math.random() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    }

    // 新しいミノを出す
    popMino(){
        this.mino = this.nextQueue.shift();
        this.mino.spawn();

        // ★ 追加：出現位置での致命判定
        if (!this.valid(0, 0)) {
            // ★ 修正: -3 などの固定値ではなく、現在の位置から1引く
            this.mino.y -= 1;
            if (!this.valid(0, 0)) {
                this.gameOver();
                return;
            }
        }

        this.nextQueue.push(new Mino(this.getNextType()));
        this.canHold = true

        // 状態・タイマー・カウントの初期化
        this.isGrounded = false;
        this.lowestY = this.mino.y;
        this.moveCount = 0;
        // T-spin判定フラグのリセット
        this.lastActionWasRotation = false;
        this.lastRotUsedPoint5 = false;

        if(this.lockTimer){
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
        }
        this.startGravity(); // 重力をリセットして開始
    }

    // SRS回転
    tryRotate(rotDir){
        const isI = this.mino.type === 0
        const from = this.mino.rotation
        const to = (from + (rotDir === 1 ? 1 : 3)) % 4

        const kickTableCW = isI ? {
        '0->1': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
        '1->2': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
        '2->3': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
        '3->0': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]]
    } : {
        '0->1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
        '1->2': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
        '2->3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
        '3->0': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]
    }

        const kickTableCCW = isI ? {
        '0->3': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
        '3->2': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
        '2->1': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
        '1->0': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]]
    } : {
        '0->3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
        '3->2': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
        '2->1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
        '1->0': [[0,0],[1,0],[1,-1],[0,2],[1,2]]
    }
        const key = `${from}->${to}`
        const table = rotDir === 1 ? kickTableCW[key] : kickTableCCW[key]

        if(!table) return false

        for(let i = 0; i < table.length; i++){
            const [dx, dy] = table[i];
            // 「回転後の形状でキックオフセット(dx,-dy)を加算した位置」を検証する
            // rotDir で回転、moveX/moveY でキックを別々に渡す
            if(this.validRotated(rotDir, dx, -dy)){
                if(rotDir === 1) this.mino.rotate()
                else this.mino.rotateCCW()

                this.mino.x += dx
                this.mino.y += -dy
                this.mino.rotation = to

                // T-spin判定用フラグを記録
                // キックテーブルの5番目（index=4）がPoint 5（井戸抜け用）
                this.lastRotUsedPoint5 = (i === 4);
                this.lastActionWasRotation = true;
                return true
            }
        }
        return false
    }

    // 回転後にキックオフセットを加えた位置が有効かどうかを検証
    // （valid/getNewBlocks とは独立した専用メソッド）
    validRotated(rotDir, kickX, kickY){
        const pivot = this.mino.pivot
        const newBlocks = this.mino.blocks.map(block => {
            // 1. pivot 基準で回転
            let relX = block.x - pivot.x
            let relY = block.y - pivot.y
            let rx, ry
            if(rotDir === 1){
                rx = -relY
                ry =  relX
            } else {
                rx =  relY
                ry = -relX
            }
            const rotatedX = Math.round(rx + pivot.x)
            const rotatedY = Math.round(ry + pivot.y)

            // 2. ミノのワールド座標 + キックオフセットを加算
            return {
                x: rotatedX + this.mino.x + kickX,
                y: rotatedY + this.mino.y + kickY
            }
        })

        return newBlocks.every(block =>
            block.x >= 0 &&
            block.x < COLS_COUNT &&
            block.y >= -5 &&
            block.y < ROWS_COUNT &&
            !this.field.has(block.x, block.y)
        )
    }

    // ホールド
    holdCurrentMino(){
        if(!this.canHold) return
        this.canHold = false

        if(this.holdMino === null){
            this.holdMino = new Mino()
            this.holdMino.type = this.mino.type
            this.holdMino.initBlocks()
            this.popMino()
            this.canHold = false
        } else {
            let prevHoldType = this.holdMino.type
            this.holdMino = new Mino()
            this.holdMino.type = this.mino.type
            this.holdMino.initBlocks()
            this.mino = new Mino()
            this.mino.type = prevHoldType
            this.mino.initBlocks()
            this.mino.spawn()

            /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            追加: ホールドから出した時の致命判定とタイマーリセット
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
            if (!this.valid(0, 0)) {
                this.mino.y -= 1; // 1列上で再試行
                if (!this.valid(0, 0)) {
                    this.gameOver();
                    return;
                }
            }

            // 状態・タイマー・カウントの初期化（popMinoと同じにする）
            this.isGrounded = false;
            this.lowestY = this.mino.y;
            this.moveCount = 0;

            if(this.lockTimer){
                clearTimeout(this.lockTimer);
                this.lockTimer = null;
            }
            this.startGravity();
        }
        this.drawAll()
    }

    // ★ 変更：第3引数 isPerfectClear を追加（デフォルトは false）
    Scoring(tSpinType, linesCleared, isPerfectClear = false){
        let baseScore = 0;

        // ─── T-SPIN系 ───
        if(tSpinType === 'tspin'){
            if(linesCleared === 0) baseScore = 400;
            if(linesCleared === 1) baseScore = 800;
            if(linesCleared === 2) baseScore = 1200;
            if(linesCleared === 3) baseScore = 1600;
        }
        else if(tSpinType === 'mini'){
            if(linesCleared === 0) baseScore = 100;
            if(linesCleared === 1) baseScore = 200;
        }
        // ─── 通常ライン消去 ───
        else {
            if(linesCleared === 1) baseScore = 100;
            if(linesCleared === 2) baseScore = 300;
            if(linesCleared === 3) baseScore = 500;
            if(linesCleared === 4) baseScore = 800;
        }

        // ─── BtB判定 ───
        const isBtBAction = (
            linesCleared > 0 &&
            (linesCleared === 4 || tSpinType !== null)
        );

        let lineScore = baseScore;
        let isB2BTriggered = false; // ★ 追加：火力計算用フラグ

        if(isBtBAction){
            if(this.backToBack){
                lineScore = Math.floor(lineScore * 1.5);
                isB2BTriggered = true; // ★ 発動したことを記録
            }
            this.backToBack = true;
        } else if(linesCleared > 0){
            this.backToBack = false;
        }

        // ─── Level適用（ライン消去分のみ） ───
        lineScore *= this.level;

        // ─── PERFECT CLEAR ボーナス ───
        if (isPerfectClear) {
            let pcBonus = 0;
            if (linesCleared === 1) pcBonus = 800;
            if (linesCleared === 2) pcBonus = 1000;
            if (linesCleared === 3) pcBonus = 1800;
            if (linesCleared === 4) pcBonus = 2000;

            lineScore += (pcBonus * this.level);
        }

        // ─── REN処理 ───
        let renBonus = 0;
        let currentRenForGarbage = this.ren; // ★ 追加：火力計算用に加算前の値を保持
        if(linesCleared > 0){
            const renCount = Math.min(this.ren, 20);
            renBonus = renCount * 50;
            this.ren++;
        } else {
            this.ren = 0;
        }

        this.score += Math.floor(lineScore + renBonus);

        if (linesCleared > 0) {
            this.lines += linesCleared;
            if (this.mode === 'marathon') {
                this.level = Math.min(15, this.startLevel + Math.floor(this.lines / 10));
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ★ おじゃまブロック（火力）の計算
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        let generatedGarbage = 0;

        if (isPerfectClear) {
            // PCは10ライン固定（ボーナスなし）
            generatedGarbage = 10;
        } else if (linesCleared > 0) {
            // 基本火力
            if (tSpinType !== null) {
                // T-Spin時は消去ライン数の2倍
                generatedGarbage = linesCleared * 2;
            } else {
                // 通常消去
                if (linesCleared === 2) generatedGarbage = 1;
                else if (linesCleared === 3) generatedGarbage = 2;
                else if (linesCleared === 4) generatedGarbage = 4;
            }

            // BtBボーナス
            if (isB2BTriggered) {
                generatedGarbage += 1;
            }

            // RENボーナス
            let r = currentRenForGarbage;
            if (r === 2 || r === 3) generatedGarbage += 1;
            else if (r === 4 || r === 5) generatedGarbage += 2;
            else if (r === 6 || r === 7) generatedGarbage += 3;
            else if (r >= 8 && r <= 12) generatedGarbage += 4;
            else if (r >= 13) generatedGarbage += 5;
            // r === 0, 1 (0REN, 1REN) は 0加算なのでそのまま
        }

        return generatedGarbage;
    }

    sendGarbage(amount){
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        if(!opponent || amount <= 0) return;

        const holes = [];
        let prevHole = -1;

        for (let i = 0; i < amount; i++) {
            let holeX;
            if (i === 0) {
                holeX = Math.floor(Math.random() * COLS_COUNT);
            } else {
                if (Math.random() < 0.7) {
                    holeX = prevHole;
                } else {
                    const offset = Math.floor(Math.random() * (COLS_COUNT - 1)) + 1;
                    holeX = (prevHole + offset) % COLS_COUNT;
                }
            }
            holes.push(holeX);
            prevHole = holeX;
        }

        const garbageObj = { amount: amount, holes: holes, ready: false };
        opponent.garbageQueue.push(garbageObj);

        // ★ 追加：相手のゲージを更新（青色のゲージが増える）
        opponent.updateGarbageGauge();

        // 1.5秒経過後に確定
        setTimeout(() => {
            // タイマー発火時に相殺されて消滅していなければ状態変更
            garbageObj.ready = true;
            // ★ 追加：相手のゲージを更新（青→赤点滅に変わる）
            opponent.updateGarbageGauge();
        }, 1500);
    }

    applyGarbage(){
        const readyGarbage = this.garbageQueue.filter(g => g.ready);
        this.garbageQueue = this.garbageQueue.filter(g => !g.ready);

        if(readyGarbage.length === 0) return;

        readyGarbage.forEach(g => {
            for(let i = 0; i < g.amount; i++){
                this.field.blocks.forEach(block => block.y -= 1);
                const currentHole = g.holes[i];
                for(let x = 0; x < COLS_COUNT; x++){
                    if(x !== currentHole){
                        this.field.blocks.push(new Block(x, ROWS_COUNT - 1, 7));
                    }
                }
            }
        });

        // ★ 追加：おじゃまがフィールドに出現したのでゲージを減らす
        this.updateGarbageGauge();
    }

    // ★ 追加：自分に降ってくる予定の火力を相殺し、余った火力を返す
    offsetGarbage(amount) {
        // 1. まずは「確定(ready)」で最も古いおじゃまから相殺
        for (let i = 0; i < this.garbageQueue.length && amount > 0; i++) {
            if (this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                if (this.garbageQueue[i].amount <= amount) {
                    amount -= this.garbageQueue[i].amount;
                    this.garbageQueue[i].amount = 0;
                } else {
                    this.garbageQueue[i].amount -= amount;
                    amount = 0;
                }
            }
        }

        // 2. 次に「猶予中(unready)」で最も古いおじゃまを相殺
        for (let i = 0; i < this.garbageQueue.length && amount > 0; i++) {
            if (!this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                if (this.garbageQueue[i].amount <= amount) {
                    amount -= this.garbageQueue[i].amount;
                    this.garbageQueue[i].amount = 0;
                } else {
                    this.garbageQueue[i].amount -= amount;
                    amount = 0;
                }
            }
        }

        // 相殺しきって amount が 0 になったキューを削除
        this.garbageQueue = this.garbageQueue.filter(g => g.amount > 0);

        // 相殺した結果をゲージに反映
        this.updateGarbageGauge();

        // 相殺しきれず余った火力（＝相手に送り返す火力）を返す
        return amount;
    }

    // ★ 追加：予告ゲージのDOMを更新
    updateGarbageGauge() {
        if (!this.isVersusMode) return;
        const gaugeId = this.canvasPrefix ? `${this.canvasPrefix}-garbage-gauge` : null;
        if (!gaugeId) return;
        const gaugeEl = document.getElementById(gaugeId);
        if (!gaugeEl) return;

        gaugeEl.innerHTML = '';

        // ready（確定・赤）と unready（猶予中・青）の合計をカウント
        let readyCount = 0;
        let unreadyCount = 0;

        this.garbageQueue.forEach(g => {
            if (g.ready) readyCount += g.amount;
            else unreadyCount += g.amount;
        });

        // 下から表示するため、先にreadyを、後にunreadyをDOMに追加する
        for (let i = 0; i < readyCount; i++) {
            const block = document.createElement('div');
            block.className = 'gauge-block ready';
            gaugeEl.appendChild(block);
        }
        for (let i = 0; i < unreadyCount; i++) {
            const block = document.createElement('div');
            block.className = 'gauge-block unready';
            gaugeEl.appendChild(block);
        }
    }

    // ミノを即座に固定する共通処理
    secureMino(){
        let isAllOutside = this.mino.blocks.every(block => (block.y + this.mino.y) < 0);

        // ─── T-spin判定（固定前に行う）───
        const tSpinResult = this.checkTSpin();

        this.mino.blocks.forEach(e => {
            e.x += this.mino.x
            e.y += this.mino.y
        })
        this.field.blocks = this.field.blocks.concat(this.mino.blocks)

        const linesCleared = this.field.checkLine()

        const isBtBAction = (linesCleared > 0 && (linesCleared === 4 || tSpinResult !== null));
        const isB2BTriggered = isBtBAction && this.backToBack;
        const currentRen = (linesCleared > 0 && this.ren > 0) ? this.ren : 0;

        const isPerfectClear = (this.field.blocks.length === 0);
        const is4Lines = (linesCleared === 4);

        // ★ 変更：Scoring() の戻り値として火力（段数）を受け取る
        const generatedGarbage = this.Scoring(tSpinResult, linesCleared, isPerfectClear);
        this.updateStatsDisplay();

        if (tSpinResult !== null || isB2BTriggered || currentRen > 0 || isPerfectClear || is4Lines) {
            this.showActionLabels(tSpinResult, linesCleared, isB2BTriggered, currentRen, isPerfectClear, is4Lines);
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ★ 変更：相殺（オフセット）と送り返し処理
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (this.isVersusMode && generatedGarbage > 0) {
            // 自分の待機中のおじゃまを相殺し、余った分（送り返し分）を受け取る
            const remainder = this.offsetGarbage(generatedGarbage);

            // 余った火力があれば相手に送る
            if (remainder > 0) {
                this.sendGarbage(remainder);
            }
        }

        if (this.mode === 'sprint' && this.lines >= this.goalLines) {
            this.gameOver(true); // クリア！
            return;
        } else if (this.mode === 'marathon' && this.goalLines !== Infinity && this.lines >= this.goalLines) {
            this.gameOver(true); // クリア！
            return;
        }

        if (isAllOutside) {
            this.gameOver();
            return;
        }

        // ★ 追加：次のミノが出現する直前（今のミノが固定された瞬間）に、自分に届いている火力を適用
        if(this.isVersusMode){
            this.applyGarbage();
        }

        this.popMino()
    }

    // ハードドロップ
    hardDrop(){
        let dropDistance = 0;
        while(this.valid(0, 1)){
            this.mino.y++
            dropDistance++;
        }

        // ハードドロップスコア加算（距離 × 2）
        if(dropDistance > 0){
            this.score += dropDistance * 2;
            this.updateStatsDisplay();
        }

        // 実際に落下した場合のみ回転フラグをリセット
        // （その場ハードドロップは直前の回転をT-spin判定に活かす）
        if(dropDistance > 0) this.lastActionWasRotation = false;

        // タイマーを両方停止
        if(this.timer) { clearInterval(this.timer); this.timer = null; }
        if(this.lockTimer){ clearTimeout(this.lockTimer); this.lockTimer = null; }

        this.secureMino()
        this.drawAll()
    }

    // ─────────────────────────────────────────
    // T-spin判定（ガイドライン 9.1 準拠）
    // 戻り値: 'tspin' | 'mini' | null
    // ─────────────────────────────────────────
    checkTSpin(){
        // T型（type=2）以外は対象外
        if(this.mino.type !== 2) return null;
        // 直前のアクションが回転でなければ対象外
        if(!this.lastActionWasRotation) return null;

        // T型ミノのピボット（中心マス）のフィールド座標
        // ピボットは blocks 定義上 {x:1, y:2}、ミノ位置を加算したワールド座標
        const cx = this.mino.x + this.mino.pivot.x - 0.5; // セル左上基準に変換
        const cy = this.mino.y + this.mino.pivot.y - 0.5;
        // ピボットの中心セル座標（floor で整数化）
        const px = Math.round(cx);
        const py = Math.round(cy);

        // 斜め4隅の座標を調べる
        //  (-1,-1) (+1,-1)
        //  (-1,+1) (+1,+1)
        const corners = [
            { x: px - 1, y: py - 1 }, // 左上
            { x: px + 1, y: py - 1 }, // 右上
            { x: px - 1, y: py + 1 }, // 左下
            { x: px + 1, y: py + 1 }, // 右下
        ];

        // 各隅が「埋まっているか」を判定（フィールド外も埋まりとして扱う）
        const occupied = corners.map(c =>
            c.x < 0 || c.x >= COLS_COUNT || c.y < 0 || c.y >= ROWS_COUNT
            || this.field.has(c.x, c.y)
        );
        // occupied[0]=左上, [1]=右上, [2]=左下, [3]=右下

        // ─── 向きに応じてA/B面・C/D面を割り当てる ───
        // ガイドライン図（Page 22）に基づく：
        //   North: A=左上[0], B=右上[1],  C=左下[2], D=右下[3]
        //   East:  A=右上[1], B=右下[3],  C=左上[0], D=左下[2]
        //   South: A=右下[3], B=左下[2],  C=右上[1], D=左上[0]
        //   West:  A=左下[2], B=左上[0],  C=右下[3], D=右上[1]
        let abIdx, cdIdx;
        switch(this.mino.rotation){
            case 0: // North
                abIdx = [0, 1]; cdIdx = [2, 3]; break;
            case 1: // East
                abIdx = [1, 3]; cdIdx = [0, 2]; break;
            case 2: // South
                abIdx = [3, 2]; cdIdx = [1, 0]; break;
            case 3: // West
                abIdx = [2, 0]; cdIdx = [3, 1]; break;
            default:
                return null;
        }

        const abFilled = abIdx.filter(i => occupied[i]).length; // A・B側の埋まり数
        const cdFilled = cdIdx.filter(i => occupied[i]).length; // C・D側の埋まり数

        // Point 5使用 → 常にT-Spin
        if(this.lastRotUsedPoint5){
            return 'tspin';
        }

        // A・B側2隅 + C・D側1隅以上 → T-Spin
        if(abFilled === 2 && cdFilled >= 1){
            return 'tspin';
        }

        // C・D側2隅 + A・B側1隅以上 → Mini T-Spin
        if(cdFilled === 2 && abFilled >= 1){
            return 'mini';
        }

        return null;
    }

    // ─────────────────────────────────────────
    // アクションラベル（PC, 4-LINES, T-Spin, B2B, REN）を一定時間表示する（DOM表示）
    // ─────────────────────────────────────────
    showActionLabels(tSpinType, linesCleared, isB2B, renCount, isPerfectClear, is4Lines){
        // ★ 対戦モードでは prefix 付きのコンテナを使う
        const containerId = (this.isVersusMode && this.canvasPrefix)
            ? `${this.canvasPrefix}-action-label-container`
            : 'action-label-container';
        const container = document.getElementById(containerId);
        if(!container) return;

        // 初回呼び出し時に、完全に独立した絶対配置のスロットを作成する
        if(!this._labelsInitialized) {
            container.innerHTML = '';

            // コンテナを基準点（座標0, 0のアンカー）として扱うための設定
            container.style.width = '0px';
            container.style.height = '0px';
            container.style.position = 'absolute';
            // ※ container自体の位置は style.css の #action-label-container (left: -200px; top: 240px;) に依存します

            this.labelElements = {};
            this.labelTimers = {};

            // ★ 完全自由配置用の座標マッピング（コンテナを基準としたpx単位）
            // x: プラスで右、マイナスで左へ移動
            // y: プラスで下、マイナスで上へ移動
            this.labelLayout = {
                four:  { x: 80, y: 0 },    // 1. 4-LINES
                mini:  { x: 40, y: 35 },   // 2. MINI
                tspin: { x: 60, y: 70 },   // 3. T-SPIN
                b2b:   { x: 60, y: 105 },  // 4. BACK-TO-BACK
                pc:    { x: 60, y: 140 },  // 5. PERFECT CLEAR
                ren:   { x: 80, y: 175 }   // 6. REN
            };

            const slotIds = ['four', 'mini', 'tspin', 'b2b', 'pc', 'ren'];
            slotIds.forEach(id => {
                const el = document.createElement('div');
                el.className = `action-label`;
                el.style.opacity = '0';

                // ★ 絶対配置（他のラベルの位置に一切影響を与えない）
                el.style.position = 'absolute';
                el.style.whiteSpace = 'nowrap'; // テキストの意図しない折り返しを防止

                // 座標の適用 (テキストの中央がX座標の基準になるように transform を使用)
                el.style.left = `${this.labelLayout[id].x}px`;
                el.style.top = `${this.labelLayout[id].y}px`;
                el.style.transform = 'translateX(-50%)';

                el.innerHTML = '&nbsp;';

                container.appendChild(el);
                this.labelElements[id] = el;
                this.labelTimers[id] = { fade: null, clear: null };
            });
            this._labelsInitialized = true;
        }

        const triggerLabel = (id, text, additionalClass) => {
            const el = this.labelElements[id];
            const timers = this.labelTimers[id];

            if(timers.fade) clearTimeout(timers.fade);
            if(timers.clear) clearTimeout(timers.clear);

            el.className = `action-label ${additionalClass}`;
            el.textContent = text;
            el.style.opacity = '1';

            timers.fade = setTimeout(() => {
                el.style.opacity = '0';
            }, 800);

            timers.clear = setTimeout(() => {
                el.innerHTML = '&nbsp;';
            }, 1200);
        };

        // 1. 4-LINES
        if(is4Lines){
            triggerLabel('four', '4-LINES', 'four font-orbitron');
        }

        // 2 & 3. T-SPIN / MINI T-SPIN
        if(tSpinType !== null){
            const clearNames = ['', ' SINGLE', ' DOUBLE', ' TRIPLE'];
            const suffix = clearNames[linesCleared] ?? '';

            if(tSpinType === 'mini'){
                triggerLabel('mini', 'MINI', 'mini font-tech');
                triggerLabel('tspin', 'T-SPIN' + suffix, 'mini font-tech');
            } else {
                if(this.labelElements['mini'].style.opacity !== '0'){
                    this.labelElements['mini'].style.opacity = '0';
                    this.labelElements['mini'].innerHTML = '&nbsp;';
                }
                triggerLabel('tspin', 'T-SPIN' + suffix, 'tspin font-tech');
            }
        }

        // 4. BACK-TO-BACK
        if(isB2B){
            triggerLabel('b2b', 'BACK-TO-BACK', 'b2b font-orbitron');
        }

        // 5. PERFECT CLEAR
        if(isPerfectClear){
            triggerLabel('pc', 'PERFECT CLEAR', 'pc font-orbitron');
        }

        // 6. REN
        if(renCount > 0){
            triggerLabel('ren', renCount + ' REN', 'ren font-orbitron');
        }
    }

    // ─── 表示の更新 ───
    updateStatsDisplay(){
        // ★ 対戦モードでは prefix 付きの要素IDを参照する
        const prefix = (this.isVersusMode && this.statsPrefix) ? `${this.statsPrefix}-` : '';

        // スコア
        const scoreEl = document.getElementById(`${prefix}score-value`);
        if(scoreEl) scoreEl.textContent = this.score;

        // レベル
        const levelEl = document.getElementById(`${prefix}level-value`);
        if(levelEl) levelEl.textContent = this.level;

        // ライン
        const linesEl = document.getElementById(`${prefix}lines-value`);
        if(linesEl) linesEl.textContent = this.lines;
    }

    getGhostY(){
        let ghostY = this.mino.y
        while(true){
            let newBlocks = this.mino.blocks.map(block => ({
                x: block.x + this.mino.x,
                y: block.y + ghostY + 1
            }))
            let canMove = newBlocks.every(block =>
                block.x >= 0 &&
                block.x < COLS_COUNT &&
                block.y < ROWS_COUNT &&
                !this.field.has(block.x, block.y)
            )
            if(canMove){
                ghostY++
            } else {
                break
            }
        }
        return ghostY
    }

    drawAll(){
        this.mainCtx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT)
        this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height)
        this.holdCtx.clearRect(0, 0, this.holdCanvas.width, this.holdCanvas.height)

        // 上に少し余白を作る（-1行目の一部を表示）
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);

        // ★ ブロックを描画する前にグリッドを描画する
        this.drawGrid(this.mainCtx);

        this.field.drawFixedBlocks(this.mainCtx);

        // ★ 変更：this.mino が存在するときだけゴーストを描画
        if (this.mino) {
            const ghostY = this.getGhostY()
            if(ghostY !== this.mino.y){
                this.mainCtx.globalAlpha = 0.25
                this.mino.draw(this.mainCtx, ghostY)
                this.mainCtx.globalAlpha = 1.0
            }
        }

        const minoScale = 0.8;

        // Draw next queue vertically
        const spacing = 3;
        this.nextQueue.forEach((mino, i) => {
            this.nextCtx.save();
            this.nextCtx.translate(0, i * spacing * BLOCK_SIZE * minoScale);
            this.nextCtx.scale(minoScale, minoScale);
            mino.drawNext(this.nextCtx);
            this.nextCtx.restore();
        });

        // ★ 変更：this.mino が存在するときだけ本体を描画
        if (this.mino) {
            this.mino.draw(this.mainCtx)
        }

        this.mainCtx.restore();

        if(this.holdMino){
            this.holdCtx.save(); // ★ 追加
            if(!this.canHold){
                this.holdCtx.globalAlpha = 0.4;
            }
            this.holdCtx.scale(minoScale, minoScale); // ★ 追加
            this.holdMino.drawNext(this.holdCtx);
            this.holdCtx.restore(); // ★ 追加
        }
    }

    dropMino(){
        if(this.valid(0, 1)){
            this.mino.y++;
            this.updateLowestY(); // ★ 追加
        }
        this.checkGroundState();
        this.drawAll();
    }

    // 接地状態をチェックし、重力と固定猶予タイマーを切り替える
    checkGroundState(actionHappened = false, wasGrounded = false) {
        // ★ 接地状態からの操作ならカウントを進める
        if (actionHappened && wasGrounded) {
            this.moveCount++;
        }

        if (!this.valid(0, 1)) {
            // ▼ 接地している場合 ▼
            if (!this.isGrounded) {
                this.isGrounded = true;
                if (this.timer) {
                    clearInterval(this.timer);
                    this.timer = null;
                }
            }

            // ★ カウントが15回以上の場合は即座に強制固定
            if (this.moveCount >= 15) {
                if (this.lockTimer) {
                    clearTimeout(this.lockTimer);
                    this.lockTimer = null;
                }
                this.secureMino();
                // secureMino()内で次のミノが呼ばれ描画されるためここで終了
                return;
            }

            // まだ余裕がある場合は猶予タイマー開始（またはリセット）
            this.startLockTimer();
        } else {
            // ▼ 空中にいる場合 ▼
            // 15回超えでも空中なら自由に動ける（接地した瞬間に上のブロックで強制固定される）
            if (this.isGrounded) {
                this.isGrounded = false;
                if (this.lockTimer) {
                    clearTimeout(this.lockTimer);
                    this.lockTimer = null;
                }
                this.startGravity();
            }
        }
    }

    // 最低Y座標を更新し、更新されたら操作回数をリセットする
    updateLowestY() {
        if (this.mino.y > this.lowestY) {
            this.lowestY = this.mino.y;
            this.moveCount = 0; // 最低位置が更新されたら15カウントをリセット
        }
    }

    // 固定猶予タイマーの起動・リセット
    startLockTimer(delay = this.lockDelay) {
        if (this.lockTimer) clearTimeout(this.lockTimer);

        // ★追加: ポーズ時の計算用に開始時刻と設定時間を記録
        this.lockStartTime = performance.now();
        this.lockRemaining = delay;

        this.lockTimer = setTimeout(() => {
            this.lockTimer = null;
            this.secureMino();
            this.drawAll();
        }, delay); // ★ this.lockDelay ではなく引数の delay を使う
    }

    valid(moveX, moveY, rot=0){
        let newBlocks = this.mino.getNewBlocks(moveX, moveY, rot)
        return newBlocks.every(block => {
            return (
                block.x >= 0 &&
                block.y >= -5 &&
                block.x < COLS_COUNT &&
                block.y < ROWS_COUNT &&
                !this.field.has(block.x, block.y)
            )
        })
    }

    // ─────────────────────────────────────────
    // キーイベント（localStorage のキー設定を参照）
    // ─────────────────────────────────────────
    setKeyEvent(){
        // ★ 追加：CPU制御モードの場合はキーイベントを一切設定しない
        if (this.isCpuControlled) return;

        // 押されているキーを管理
        this.keyState = {}
        // 設定を読み込み
        let tuning = loadTuning();


        const frameMs = 1000 / 60; // 1フレーム = 約16.67ms

        // DAS, ARR, DCD をフレーム数からミリ秒に変換してセット
        this.DAS_DELAY = tuning.das * frameMs;
        this.ARR_INTERVAL = tuning.arr * frameMs;
        this.DCD_DELAY = tuning.dcd * frameMs;

        // ソフトドロップ用ARR
        const currentLevelSpeed = LEVEL_SPEEDS[this.level] || 7;
        const currentSoftDropArr = currentLevelSpeed / 20;

        this._lastSoftDropTime = 0;
        this._leftPressTime = null;
        this._rightPressTime = null;
        this._lastHorizontal = null;
        this._lastMoveTimeLeft = 0;
        this._lastMoveTimeRight = 0;
        this._dcdUntil = 0;
        this._dasBlockedLeft = false;
        this._dasBlockedRight = false;

        // 既存のリスナー解除
        if(this._keyDownHandler) document.removeEventListener('keydown', this._keyDownHandler)
        if(this._keyUpHandler)   document.removeEventListener('keyup', this._keyUpHandler)
        if(this._keyLoop)        clearInterval(this._keyLoop)

        const keys = loadKeys();

        this._keyDownHandler = (e) => {
            // ★ 対戦モードでは versus-page がアクティブな場合のみ動作
            const activePageId = this.isVersusMode ? 'versus-page' : 'game-page';
            const gamePage = document.getElementById(activePageId)
            if(!gamePage || !gamePage.classList.contains('active')) return

            // リスタート (ポーズ中・プレイ中問わず即座にやり直し)
            // ★ 対戦モードではリスタートキーは router.js 側で管理するためスキップ
            if(!this.isVersusMode && e.code === keys.restart.code){
                e.preventDefault()
                if(e.repeat) return; // ★追加：長押しによる連続発火を防止
                this.start()
                return
            }

            // ポーズ
            // ★ 対戦モードではポーズは router.js の toggleVersusPause() に委譲
            if(!this.isVersusMode && e.code === keys.pause.code){
                e.preventDefault()
                if(e.repeat) return; // ★追加：長押しによる連続発火を防止
                if(this.isCountingDown) return;
                this.togglePause()
                return
            }

            // ポーズ中は他のキー入力を無視
            if(this.isPaused) return

            this.keyState[e.code] = true

            const now = performance.now()
            if(e.code === keys.moveLeft.code && this._leftPressTime === null){
                this._leftPressTime = now
                this._lastMoveTimeLeft = 0
                this._lastHorizontal = 'left'
            }
            if(e.code === keys.moveRight.code && this._rightPressTime === null){
                this._rightPressTime = now
                this._lastMoveTimeRight = 0
                this._lastHorizontal = 'right'
            }

            // 単発系（押した瞬間のみ）
            if(e.code === keys.hardDrop.code){
                e.preventDefault()
                if(e.repeat) return;            // ★追加：長押しによる連続発火を防止
                if(this.isCountingDown) return; // ★追加：カウントダウン中は無効

                if(this.DCD_DELAY > 0 &&
                    (this._dasBlockedLeft || this._dasBlockedRight)){
                    this._dcdUntil = performance.now() + this.DCD_DELAY
                }
                this.hardDrop()
            }
            if(e.code === keys.hold.code){
                e.preventDefault()
                if(e.repeat) return;            // ★追加：長押し防止
                if(this.isCountingDown) return; // ★追加：カウントダウン中は無効
                this.holdCurrentMino()
            }
        }

        this._keyUpHandler = (e) => {
            this.keyState[e.code] = false

            if(e.code === keys.moveLeft.code){
                this._leftPressTime = null
                this._dasBlockedLeft = false
                this._dcdUntil = 0

                // 左を離したとき、右が押されていれば右を優先
                if(this.keyState[keys.moveRight.code]){
                    this._lastHorizontal = 'right'
                }
            }

            if(e.code === keys.moveRight.code){
                this._rightPressTime = null
                this._dasBlockedRight = false
                this._dcdUntil = 0

                // 右を離したとき、左が押されていれば左を優先
                if(this.keyState[keys.moveLeft.code]){
                    this._lastHorizontal = 'left'
                }
            }
        }

        document.addEventListener('keydown', this._keyDownHandler)
        document.addEventListener('keyup', this._keyUpHandler)

        // ★最適化：ループ内で毎回ID検索すると流石にチリツモで重くなるため、外で取得しておく
        // ★ 対戦モードでは versus-page を参照する
        const activePageId = this.isVersusMode ? 'versus-page' : 'game-page';
        const gamePage = document.getElementById(activePageId);

        // 毎フレーム入力処理（同時入力対応）
        this._lastFrameTime = performance.now()
        this._keyLoop = setInterval(() => {
            if(!gamePage || !gamePage.classList.contains('active')) return
            if(this.isPaused) return
            // ★ 追加：カウントダウン中はDASの時間を裏で記録するだけで、操作の実行はしない
            if(this.isCountingDown) return;

            const nowPerf = performance.now()
            const delta = nowPerf - this._lastFrameTime
            this._lastFrameTime = nowPerf

            let acted = false
            let wasGrounded = this.isGrounded; // 操作前の接地状態を記憶

            const now = nowPerf

            const leftPressed  = this.keyState[keys.moveLeft.code];
            const rightPressed = this.keyState[keys.moveRight.code];

            // 優先方向を決定（後押し優先）
            let dir = null;
            if(leftPressed && rightPressed){
                dir = this._lastHorizontal;
            } else if(leftPressed){
                dir = 'left';
            } else if(rightPressed){
                dir = 'right';
            }

            if(dir === 'left'){
                if(this._leftPressTime !== null){
                    const heldTime = now - this._leftPressTime
                    const inDcd = now < this._dcdUntil

                    // 初回入力（押した瞬間）
                    if(this._lastMoveTimeLeft === 0){
                        if(this.valid(-1, 0)){
                            this.mino.x--
                            this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                            acted = true
                        }
                        this._lastMoveTimeLeft = now
                        this._dasBlockedLeft = false
                    }
                    // DAS後の連続移動
                    else if(heldTime >= this.DAS_DELAY &&
                            now - this._lastMoveTimeLeft >= this.ARR_INTERVAL){
                        if(!inDcd){
                            if(this.valid(-1, 0)){
                                this.mino.x--
                                this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                                acted = true
                                this._dasBlockedLeft = false
                            } else {
                                this._dasBlockedLeft = true
                            }
                        }
                        this._lastMoveTimeLeft = now
                    }
                }
                this._dasBlockedRight = false
            }
            else if(dir === 'right'){
                if(this._rightPressTime !== null){
                    const heldTime = now - this._rightPressTime
                    const inDcd = now < this._dcdUntil

                    // 初回入力（押した瞬間）
                    if(this._lastMoveTimeRight === 0){
                        if(this.valid(1, 0)){
                            this.mino.x++
                            this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                            acted = true
                        }
                        this._lastMoveTimeRight = now
                        this._dasBlockedRight = false
                    }
                    // DAS後の連続移動
                    else if(heldTime >= this.DAS_DELAY &&
                            now - this._lastMoveTimeRight >= this.ARR_INTERVAL){
                        if(!inDcd){
                            if(this.valid(1, 0)){
                                this.mino.x++
                                this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                                acted = true
                                this._dasBlockedRight = false
                            } else {
                                this._dasBlockedRight = true
                            }
                        }
                        this._lastMoveTimeRight = now
                    }
                }
                this._dasBlockedLeft = false
            }
            else {
                this._dasBlockedLeft = false
                this._dasBlockedRight = false
            }

            // ソフトドロップ（専用ARR）
            const currentLevelSpeed = LEVEL_SPEEDS[this.level] || 7;
            const currentSoftDropArr = currentLevelSpeed / 20;

            if(this.keyState[keys.softDrop.code]){
                // 初回押し込み時は即座に1段落とす
                if(this._lastSoftDropTime === 0){
                    this._lastSoftDropTime = now;
                    if(this.valid(0, 1)){
                        this.mino.y++;
                        this.updateLowestY();
                        this.lastActionWasRotation = false;
                        acted = true;
                        this.score += 1;
                        this.updateStatsDisplay();
                    }
                } else {
                    // 前回ソフトドロップ処理をしてからの経過時間
                    let elapsed = now - this._lastSoftDropTime;

                    // 必要な時間（currentSoftDropArr）が経過していたら落下処理
                    if(elapsed >= currentSoftDropArr){
                        // 経過時間の中に、何マスの落下が含まれるかを割り算で計算（フレームの壁を突破）
                        let dropCount = Math.floor(elapsed / currentSoftDropArr);

                        let actuallyDropped = 0;
                        for(let i = 0; i < dropCount; i++){
                            if(this.valid(0, 1)){
                                this.mino.y++;
                                actuallyDropped++;
                            } else {
                                break; // 途中で接地したらループを抜ける
                            }
                        }

                        if(actuallyDropped > 0){
                            this.updateLowestY();
                            this.lastActionWasRotation = false;
                            acted = true;
                            this.score += actuallyDropped; // 実際に落ちたマス数分だけスコア加算
                            this.updateStatsDisplay();
                        }

                        // 余った端数の時間を次回に持ち越す（超高速落下時のガタつき防止）
                        this._lastSoftDropTime = now - (elapsed % currentSoftDropArr);
                    }
                }
            } else {
                this._lastSoftDropTime = 0;
            }

            // 回転（即時反応させる）
            if(this.keyState[keys.rotateCW.code]){
                if(!this._rotCWPressed){
                    if(this.tryRotate(1)){
                        this.updateLowestY(); // ★ 追加：キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCWPressed = true
                }
            }
            if(!this.keyState[keys.rotateCW.code]){
                this._rotCWPressed = false
            }

            if(this.keyState[keys.rotateCCW.code]){
                if(!this._rotCCWPressed){
                    if(this.tryRotate(-1)){
                        this.updateLowestY(); // ★ 追加：キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCCWPressed = true
                }
            }
            if(!this.keyState[keys.rotateCCW.code]){
                this._rotCCWPressed = false
            }

            // ─── DCD 発動チェック（回転） ──────────────────────────
            // DASが効いていて動けない（空振り）状態で回転が入力された場合にDCDを開始する
            if(this.DCD_DELAY > 0 && acted){
                const rotActed =
                    (this.keyState[keys.rotateCW.code]  && this._rotCWPressed) ||
                    (this.keyState[keys.rotateCCW.code] && this._rotCCWPressed)
                if(rotActed && (this._dasBlockedLeft || this._dasBlockedRight)){
                    this._dcdUntil = now + this.DCD_DELAY
                }
            }

            // ★ アクションが起きたら接地状態を再評価（15回制限もここで処理される）
            if(acted){
                this.checkGroundState(true, wasGrounded);
                this.drawAll()
            }

        }, 4) // （最小実行間隔の4ms、つまり秒間約250回ループ）
    }
}

// ─────────────────────────────────────────────
// Block クラス
// ─────────────────────────────────────────────
class Block{
    constructor(x, y, type){
        this.x = x
        this.y = y
        if(type >= 0) this.setType(type)
    }

    setType(type){
        this.type = type
        this.image = Asset.blockImages[type]
    }

    draw(offsetX = 0, offsetY = 0, ctx){
        let drawX = this.x + offsetX
        let drawY = this.y + offsetY

        // 修正前: drawY >= 0 && ...
        // 修正後: drawY >= -1 && ...
        if(drawX >= 0 && drawX < COLS_COUNT &&
            drawY >= -1 && drawY < ROWS_COUNT){
            ctx.drawImage(
                this.image,
                drawX * BLOCK_SIZE,
                drawY * BLOCK_SIZE,
                BLOCK_SIZE,
                BLOCK_SIZE
            )
        }
    }

    drawNext(ctx){
        let offsetX = 0
        let offsetY = 0
        switch(this.type){
            case 0: offsetX = 0.5; offsetY = 1;   break;
            case 1: offsetX = 0.5; offsetY = 0.5; break;
            default: offsetX = 1;  offsetY = 0.5; break;
        }
        ctx.drawImage(
            this.image,
            (this.x + offsetX) * BLOCK_SIZE,
            (this.y + offsetY) * BLOCK_SIZE,
            BLOCK_SIZE,
            BLOCK_SIZE
        )
    }
}

// ─────────────────────────────────────────────
// Mino クラス
// ─────────────────────────────────────────────
class Mino{

    // mino の種類を決定してブロックを初期化
    constructor(type = null){
        this.pivot = { x: 1.5, y: 1.5 }; // デフォルトの回転軸（4x4中心）
        this.type = (type !== null) ? type : Math.floor(Math.random() * 7);
        this.rotation = 0; // 0:上 1:右 2:下 3:左
        this.initBlocks()
    }

    initBlocks(){
        let t = this.type
        switch(t){
            case 0: // I型
                this.blocks = [new Block(0,1,t),new Block(1,1,t),new Block(2,1,t),new Block(3,1,t)]
                this.pivot = { x: 1.5, y: 1.5 }
                break;
            case 1: // O型（回転しないので中心固定）
                this.blocks = [new Block(1,1,t),new Block(2,1,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1.5, y: 1.5 }
                break;
            case 2: // T型
                this.blocks = [new Block(1,1,t),new Block(0,2,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 3: // J型
                this.blocks = [new Block(0,1,t),new Block(0,2,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 4: // L型
                this.blocks = [new Block(2,1,t),new Block(0,2,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 5: // S型
                this.blocks = [new Block(1,1,t),new Block(2,1,t),new Block(0,2,t),new Block(1,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 6: // Z型
                this.blocks = [new Block(0,1,t),new Block(1,1,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
        }
    }

    spawn(){
        this.x = COLS_COUNT/2 - 2
        // ★ 修正: Iミノ(type:0)はブロック定義が1段高いため、yを1段下げる
        this.y = (this.type === 0) ? -1 : -2;
        this.rotation = 0
    }

    draw(ctx, overrideY = null){
        const drawY = overrideY !== null ? overrideY : this.y
        this.blocks.forEach(block => {
            block.draw(this.x, drawY, ctx)
        })
    }

    drawNext(ctx){
        this.blocks.forEach(block => {
            block.drawNext(ctx)
        })
    }

    // 右回転（時計回り）
    rotate(){
        this.blocks.forEach(block=>{
            let relX = block.x - this.pivot.x
            let relY = block.y - this.pivot.y

            let newX = -relY
            let newY = relX

            block.x = Math.round(newX + this.pivot.x)
            block.y = Math.round(newY + this.pivot.y)
        })
    }

    // 左回転（反時計回り）
    rotateCCW(){
        this.blocks.forEach(block=>{
            let relX = block.x - this.pivot.x
            let relY = block.y - this.pivot.y

            let newX = relY
            let newY = -relX

            block.x = Math.round(newX + this.pivot.x)
            block.y = Math.round(newY + this.pivot.y)
        })
    }

    getNewBlocks(moveX, moveY, rot){
        let newBlocks = this.blocks.map(block=>{
            return new Block(block.x, block.y)
        })
        newBlocks.forEach(block => {
            if(moveX || moveY){
                block.x += moveX
                block.y += moveY
            }
            if(rot === 1 || rot === -1){
                let relX = block.x - this.pivot.x
                let relY = block.y - this.pivot.y

                let newX, newY
                if(rot === 1){
                    newX = -relY
                    newY = relX
                } else {
                    newX = relY
                    newY = -relX
                }

                block.x = Math.round(newX + this.pivot.x)
                block.y = Math.round(newY + this.pivot.y)
            }
            block.x += this.x
            block.y += this.y
        })
        return newBlocks
    }
}

// ─────────────────────────────────────────────
// Field クラス
// ─────────────────────────────────────────────
class Field{
    constructor(){
        this.blocks = []
    }

    drawFixedBlocks(ctx){
        this.blocks.forEach(block => block.draw(0, 0, ctx))
    }

    checkLine(){
        let linesCleared = 0
        for(var r = 0; r < ROWS_COUNT; r++){
            var c = this.blocks.filter(block => block.y === r).length
            if(c === COLS_COUNT){
                this.blocks = this.blocks.filter(block => block.y !== r)
                this.blocks.filter(block => block.y < r).forEach(upper => upper.y++)
                linesCleared++
                r--
            }
        }
        return linesCleared
    }

    has(x, y){
        return this.blocks.some(block => block.x == x && block.y == y)
    }
}