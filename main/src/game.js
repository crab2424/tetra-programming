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
    }

    initMainCanvas() {
        const id = this.canvasPrefix ? `${this.canvasPrefix}-main-canvas` : MAIN_CANVAS_ID;
        this.mainCanvas = document.getElementById(id);
        this.mainCtx = this.mainCanvas.getContext("2d");
        this.mainCanvas.width = SCREEN_WIDTH;
        this.mainCanvas.height = SCREEN_HEIGHT;

        // ページ読み込み時（ゲーム開始前）に一度だけグリッドを描画しておく
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
        this.drawGrid(this.mainCtx);
        this.mainCtx.restore();
    }

    initNextCanvas() {
        const id = this.canvasPrefix ? `${this.canvasPrefix}-next-canvas` : NEXT_CANVAS_ID;
        this.nextCanvas = document.getElementById(id);
        this.nextCtx = this.nextCanvas.getContext("2d");
        this.nextCanvas.width = BLOCK_SIZE * 4;
        this.nextCanvas.height = BLOCK_SIZE * 13.5;
    }

    initHoldCanvas() {
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
    start() {
        const overlayId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-overlay` : 'versus-countdown-overlay')
            : 'countdown-overlay';
        const textElId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-text` : 'versus-countdown-text')
            : 'countdown-text';

        this._initGameState();

        // DASの先行チャージ等を受け付けるため、カウントダウン開始「前」にキーイベントをセット
        this.setKeyEvent();

        // カウントダウン開始
        runCountdown(overlayId, textElId, () => {
            this._startGameplay();
        }, null);
    }

    // ─────────────────────────────────────────
    // ゲーム状態の初期化（カウントダウン前に呼ぶ）
    // ─────────────────────────────────────────
    _initGameState() {
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

        // 7バッグをリセット
        // ★nextQueue は内部で11個保持（CPU6のパフェ探索が10手先まで読むため）。
        //   ただし画面表示は先頭5個のみ（drawNext 参照）。
        this.bag = [];
        this.nextQueue = [];
        for (let i = 0; i < 11; i++) {
            this.nextQueue.push(new Mino(this.getNextType()));
        }
        this.garbageQueue = [];
        this.updateGarbageGauge();

        this.pendingAttack = 0;
        this.pendingInternalAttack = 0; // 追加
        this.updateAttackGauge();

        // VS設定：テトのマージンタイム管理
        // マージン突入から [0, 32, 64, 96, 128, 160] 秒後にインデックス 0→1→2→3→4→5 へ進む
        // null = マージン未突入（従来の固定火力を使用）、0〜5 = マージン中のステップ
        this.vsMarginMultiplier = 1.0;   // 互換のため残す（ぷよ側との乗率計算では使用しない）
        this._tetMarginStep = null;      // null = マージン未突入
        if (this._vsMarginTimer) { clearTimeout(this._vsMarginTimer); this._vsMarginTimer = null; }
        this._vsMarginTimerStart = 0;
        this._vsMarginTimerDuration = 0;
        this._vsMarginTimerCb = null;
        this._vsMarginTimerRemaining = null;

        if (this.isVersusMode && typeof this.vsMarginTimeMs === 'number' && this.vsMarginTimeMs !== null) {
            const TET_MARGIN_INTERVAL_MS = 32000; // 32秒ごとにステップアップ
            const TET_MARGIN_MAX_STEP = 5;        // 最大インデックス（160秒で到達）
            const startMargin = () => {
                if (!this.isVersusMode) return;
                // マージン突入直後：ステップ0（テーブルindex=0）を適用
                this._tetMarginStep = 0;
                const step = () => {
                    if (this._tetMarginStep < TET_MARGIN_MAX_STEP) {
                        this._tetMarginStep++;
                    }
                    if (this._tetMarginStep < TET_MARGIN_MAX_STEP) {
                        this._vsMarginTimer = setTimeout(step, TET_MARGIN_INTERVAL_MS);
                        this._vsMarginTimerStart = performance.now();
                        this._vsMarginTimerDuration = TET_MARGIN_INTERVAL_MS;
                        this._vsMarginTimerCb = step;
                    } else {
                        this._vsMarginTimer = null;
                    }
                };
                this._vsMarginTimer = setTimeout(step, TET_MARGIN_INTERVAL_MS);
                this._vsMarginTimerStart = performance.now();
                this._vsMarginTimerDuration = TET_MARGIN_INTERVAL_MS;
                this._vsMarginTimerCb = step;
            };
            if (this.vsMarginTimeMs === 0) {
                startMargin(); // 即時発動
            } else {
                this._vsMarginTimer = setTimeout(startMargin, this.vsMarginTimeMs);
                this._vsMarginTimerStart = performance.now();
                this._vsMarginTimerDuration = this.vsMarginTimeMs;
                this._vsMarginTimerCb = startMargin;
            }
        }

        this.nextMino = null;
        this.field = new Field()
        this.holdMino = null
        this.canHold = true
        this.score = 0
        this.isPaused = false
        this.actionLabels = [];
        this.actionAlpha = 0;
        if (this._labelsInitialized) {
            Object.keys(this.labelTimers).forEach(id => {
                if (this.labelTimers[id].fade) clearTimeout(this.labelTimers[id].fade);
                if (this.labelTimers[id].clear) clearTimeout(this.labelTimers[id].clear);

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

        // リスタート時にタイマー表示をリセット
        this.updateTimeDisplay();

        // カウントダウンフラグと、ミノの未出現状態の設定
        this.isCountingDown = true;
        this.mino = null;

        // 既存のタイマーをすべて止めておく
        clearInterval(this.timer);
        this.timer = null;
        if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }

        // リスタート時に表示中のオーバーレイを強制終了する
        const countdownId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-overlay` : 'versus-countdown-overlay')
            : 'countdown-overlay';
        const finishId = this.isVersusMode
            ? (this.canvasPrefix ? `${this.canvasPrefix}-finish-overlay` : 'versus-finish-overlay')
            : 'versus-finish-overlay';

        const countdownOverlay = document.getElementById(countdownId);
        const finishOverlay = document.getElementById(finishId);

        if (countdownOverlay) {
            if (countdownOverlay.countdownTimer) clearTimeout(countdownOverlay.countdownTimer);
            countdownOverlay.classList.remove('active');
        }
        if (finishOverlay) {
            if (finishOverlay.finishTimer1) clearTimeout(finishOverlay.finishTimer1);
            if (finishOverlay.finishTimer2) clearTimeout(finishOverlay.finishTimer2);
            finishOverlay.classList.remove('active', 'fadeout');
        }

        // 初期描画（カウントダウン中もフィールドとNEXTが見える）
        this.drawAll()
    }

    // ─────────────────────────────────────────
    // 実際のゲームプレイ開始（START! 表示の瞬間に呼ばれる）
    // ─────────────────────────────────────────
    _startGameplay() {
        // カウントダウンを解除し、ここで初めてミノを出現させる
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

    // タイマーの描画ループ（約60fps）
    startTimerLoop() {
        const loop = () => {
            if (!this.isTimerRunning) return;
            this.updateTimeDisplay();
            this.timerReqId = requestAnimationFrame(loop);
        };
        this.timerReqId = requestAnimationFrame(loop);
    }

    // タイムの計算とHTMLへの反映
    updateTimeDisplay() {
        let totalMs = this.elapsedTime;
        if (this.isTimerRunning) {
            totalMs += performance.now() - this.startTime;
        }

        let displayMs = totalMs;
        // 対戦モードではtime-valueは使わない（非表示のため参照先なし）
        const timeEl = this.isVersusMode ? null : document.getElementById("time-value");

        // Ultra モード時はカウントダウン処理
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

        if (timeEl) {
            timeEl.textContent = formattedTime;
        }
    }

    // ポーズ切り替え
    // SE再生の薄いラッパ（A案）。人間・CPUどちらの盤面でもそれぞれの操作音を鳴らす。
    playSe(key) {
        window.SeManager?.play(key);
    }

    togglePause() {
        if (this.isPaused) {
            this.resume()
        } else {
            this.pause()
        }
    }

    pause() {
        if (this.isPaused) return
        this.isPaused = true
        // ③ ポーズ中はBGMを止めず小音量で流し続ける
        window.BgmManager?.duck()
        clearInterval(this.timer)

        // 接地猶予タイマーが動いていた場合、残り時間を計算して保存する
        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
            this.lockRemaining -= (performance.now() - this.lockStartTime);
            this._wasLockingWhenPaused = true;
        } else {
            this._wasLockingWhenPaused = false;
        }

        // マージンタイマーの停止と残り時間の保存
        if (this._vsMarginTimer) {
            clearTimeout(this._vsMarginTimer);
            this._vsMarginTimer = null;
            this._vsMarginTimerRemaining = this._vsMarginTimerDuration - (performance.now() - this._vsMarginTimerStart);
        }

        this.showPauseOverlay()

        if (this.isTimerRunning) {
            this.elapsedTime += performance.now() - this.startTime;
            this.isTimerRunning = false;
            cancelAnimationFrame(this.timerReqId);
        }
    }

    resume() {
        if (!this.isPaused) return
        this.isPaused = false
        // ③ ポーズ解除でBGM音量を元に戻す
        window.BgmManager?.unduck()
        this.hidePauseOverlay()

        // 接地中(lockTimer稼働中)だったか空中だったかで再開処理を分ける
        if (this._wasLockingWhenPaused) {
            // 保存しておいた残り時間（最低0ms）で猶予タイマーを再開
            this.startLockTimer(Math.max(0, this.lockRemaining));
            this._wasLockingWhenPaused = false;
        } else if (!this.isGrounded) {
            this.startGravity();
        }

        // マージンタイマーの再開
        if (this._vsMarginTimerRemaining !== null && this._vsMarginTimerCb) {
            this._vsMarginTimerDuration = Math.max(0, this._vsMarginTimerRemaining);
            this._vsMarginTimer = setTimeout(this._vsMarginTimerCb, this._vsMarginTimerDuration);
            this._vsMarginTimerStart = performance.now();
            this._vsMarginTimerRemaining = null;
        }

        if (!this.isTimerRunning) {
            this.startTime = performance.now();
            this.isTimerRunning = true;
            this.startTimerLoop();
        }
    }

    // ─── 重力の開始 ───
    startGravity() {
        if (this.timer) clearInterval(this.timer);
        // 現在のレベルに応じた速度を取得（15を超えた場合は最速の7ms）
        const speed = LEVEL_SPEEDS[this.level] || 7;
        this.timer = setInterval(() => this.dropMino(), speed);
    }

    showPauseOverlay() {
        // 対戦モードでは versus-pause-overlay を使う（router.js 側で管理）
        if (this.isVersusMode) return;
        // QUIZモード時のみ LEVEL SELECT ボタンを表示、それ以外は非表示
        const levelSelectBtn = document.getElementById('pause-quiz-level-select-btn');
        if (levelSelectBtn) {
            const isQuiz = (typeof currentGameMode !== 'undefined') && currentGameMode && currentGameMode.id === 'quiz';
            levelSelectBtn.style.display = isQuiz ? '' : 'none';
        }

        document.getElementById('pause-overlay').classList.add('active')
    }

    hidePauseOverlay() {
        // 対戦モードでは versus-pause-overlay を使う（router.js 側で管理）
        if (this.isVersusMode) return;
        document.getElementById('pause-overlay').classList.remove('active')
    }

    // ゲームオーバー処理
    // 引数に isClear（デフォルト false）を追加
    gameOver(isClear = false) {
        this.isClear = isClear;
        if (!isClear) this.playSe('gameover');
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

        // 対戦モードの場合は versusGameOver() に委譲する
        if (this.isVersusMode) {
            const loser = (this.canvasPrefix === 'cpu') ? 'cpu' : 'player';
            if (typeof versusGameOver === 'function') versusGameOver(loser);
            return;
        }

        // シングルプレイの終了演出（FINISH!）を表示してからリザルトへ
        const finishText = isClear ? 'FINISH!' : 'GAME OVER';
        const finishClass = isClear ? 'finish-clear' : 'finish-gameover';
        showFinishOverlay('finish-overlay', 'finish-text', finishText, finishClass, 1200, () => {
            const timeEl = document.getElementById('time-value');
            const resultTitle = document.getElementById('result-title');

            // クリア/ゲームオーバーの表示切り替え
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

            // Sprint モードのゲームオーバー時は記録なし（タイム非表示）
            if (this.mode === 'sprint' && !isClear) {
                document.getElementById('result-time').textContent = "--:--.--";
            } else {
                document.getElementById('result-time').textContent = timeEl ? timeEl.textContent : '00:00.00';
            }

            if (typeof switchPage === 'function') switchPage('result');
        });
    }

    getNextType() {
        if (this.bag.length === 0) {
            this.bag = [0, 1, 2, 3, 4, 5, 6];
            // シャッフル（Fisher-Yates）
            for (let i = this.bag.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    }

    // 新しいミノを出す
    popMino() {
        this.mino = this.nextQueue.shift();
        this.mino.spawn();

        // 出現位置での致命判定
        if (!this.valid(0, 0)) {
            // -3 などの固定値ではなく、現在の位置から1引く
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

        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
        }
        this.startGravity(); // 重力をリセットして開始
    }

    // SRS回転
    tryRotate(rotDir) {
        const isI = this.mino.type === 0
        const from = this.mino.rotation
        const to = (from + (rotDir === 1 ? 1 : 3)) % 4

        const kickTableCW = isI ? {
            '0->1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
            '1->2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
            '2->3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
            '3->0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]
        } : {
            '0->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
            '1->2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
            '2->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
            '3->0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]
        }

        const kickTableCCW = isI ? {
            '0->3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
            '3->2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
            '2->1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
            '1->0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]
        } : {
            '0->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
            '3->2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
            '2->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
            '1->0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]
        }
        const key = `${from}->${to}`
        const table = rotDir === 1 ? kickTableCW[key] : kickTableCCW[key]

        if (!table) return false

        for (let i = 0; i < table.length; i++) {
            const [dx, dy] = table[i];
            // 「回転後の形状でキックオフセット(dx,-dy)を加算した位置」を検証する
            // rotDir で回転、moveX/moveY でキックを別々に渡す
            if (this.validRotated(rotDir, dx, -dy)) {
                if (rotDir === 1) this.mino.rotate()
                else this.mino.rotateCCW()

                this.mino.x += dx
                this.mino.y += -dy
                this.mino.rotation = to

                // T-spin判定用フラグを記録
                // キックテーブルの5番目（index=4）がPoint 5（井戸抜け用）
                this.lastRotUsedPoint5 = (i === 4);
                this.lastActionWasRotation = true;
                this.playSe('rotate');
                return true
            }
        }
        return false
    }

    // 回転後にキックオフセットを加えた位置が有効かどうかを検証
    // （valid/getNewBlocks とは独立した専用メソッド）
    validRotated(rotDir, kickX, kickY) {
        const pivot = this.mino.pivot
        const newBlocks = this.mino.blocks.map(block => {
            // 1. pivot 基準で回転
            let relX = block.x - pivot.x
            let relY = block.y - pivot.y
            let rx, ry
            if (rotDir === 1) {
                rx = -relY
                ry = relX
            } else {
                rx = relY
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
    holdCurrentMino() {
        if (!this.canHold) return
        // VS設定：HOLDが無効な場合はホールド操作を受け付けない
        if (this.isVersusMode && this.vsHoldEnabled === false) return
        this.canHold = false
        this.playSe('hold')

        if (this.holdMino === null) {
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
            ホールドから出した時の致命判定とタイマーリセット
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

            if (this.lockTimer) {
                clearTimeout(this.lockTimer);
                this.lockTimer = null;
            }
            this.startGravity();
        }
        this.drawAll()
    }

    // 第3引数 isPerfectClear を追加（デフォルトは false）
    Scoring(tSpinType, linesCleared, isPerfectClear = false) {
        let baseScore = 0;

        // ─── T-SPIN系 ───
        if (tSpinType === 'tspin') {
            if (linesCleared === 0) baseScore = 400;
            if (linesCleared === 1) baseScore = 800;
            if (linesCleared === 2) baseScore = 1200;
            if (linesCleared === 3) baseScore = 1600;
        }
        else if (tSpinType === 'mini') {
            if (linesCleared === 0) baseScore = 100;
            if (linesCleared === 1) baseScore = 200;
        }
        // ─── 通常ライン消去 ───
        else {
            if (linesCleared === 1) baseScore = 100;
            if (linesCleared === 2) baseScore = 300;
            if (linesCleared === 3) baseScore = 500;
            if (linesCleared === 4) baseScore = 800;
        }

        // ─── BtB判定 ───
        const isBtBAction = (
            linesCleared > 0 &&
            (linesCleared === 4 || tSpinType !== null)
        );

        let lineScore = baseScore;
        let isB2BTriggered = false; // 火力計算用フラグ

        if (isBtBAction) {
            if (this.backToBack) {
                lineScore = Math.floor(lineScore * 1.5);
                isB2BTriggered = true; // 発動したことを記録
            }
            this.backToBack = true;
        } else if (linesCleared > 0) {
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
        let currentRenForGarbage = this.ren; // 火力計算用に加算前の値を保持
        if (linesCleared > 0) {
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
        // おじゃまブロック（火力）の計算
        // _tetMarginStep === null : マージン未突入（従来の固定値を使用）
        // _tetMarginStep === 0〜5 : マージン中（テーブルから値を参照）
        // テーブルは [0秒, 32秒, 64秒, 96秒, 128秒, 160秒] 突入後のステップに対応
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        let generatedGarbage = 0;

        const _ms = this._tetMarginStep; // null = 未突入、0〜5 = マージン中

        if (_ms === null) {
            // ────────────────────────────────────────
            // マージン未突入：従来の固定テーブルをそのまま使用
            // ────────────────────────────────────────
            if (isPerfectClear) {
                generatedGarbage = 10;
            } else if (linesCleared > 0) {
                // 基本火力
                if (tSpinType === 'tspin') {
                    generatedGarbage = linesCleared * 2;
                } else {
                    if (linesCleared === 2) generatedGarbage = 1;
                    else if (linesCleared === 3) generatedGarbage = 2;
                    else if (linesCleared === 4) generatedGarbage = 4;
                }
                // BtBボーナス
                if (isB2BTriggered) generatedGarbage += 1;
                // RENボーナス（従来テーブル）
                let r = currentRenForGarbage;
                if (r === 2 || r === 3) generatedGarbage += 1;
                else if (r === 4 || r === 5) generatedGarbage += 2;
                else if (r === 6 || r === 7) generatedGarbage += 3;
                else if (r >= 8 && r <= 12) generatedGarbage += 4;
                else if (r >= 13) generatedGarbage += 5;
            }
        } else {
            // ────────────────────────────────────────
            // マージン中：各要素をテーブルから参照
            // ────────────────────────────────────────

            // ── 基本火力テーブル（clear lines） ──
            const _garbageTables = {
                lines1: [0, 0, 1, 1, 1, 2],
                lines2: [1, 1, 2, 2, 3, 4],
                lines3: [2, 2, 3, 4, 5, 6],
                lines4: [4, 5, 5, 6, 8, 10],
            };
            // T-Spin（mini除く）火力テーブル
            const _tspinTables = {
                single: [2, 2, 3, 4, 5, 6],
                double: [4, 5, 5, 6, 8, 10],
                triple: [6, 7, 8, 10, 12, 16],
            };
            // BtBボーナステーブル
            const _btbBonus = [1, 1, 2, 2, 3, 4];
            // PCボーナステーブル（対テト相殺用）
            const _pcBonus = [12, 13, 14, 15, 16, 18];
            // REN追加ボーナステーブル（従来RENボーナスにさらに加算、2REN以降）
            const _renBonus = [0, 0, 0, 1, 1, 1];

            if (isPerfectClear) {
                generatedGarbage = _pcBonus[_ms];
            } else if (linesCleared > 0) {
                // 基本火力
                if (tSpinType === 'tspin') {
                    if (linesCleared === 1) generatedGarbage = _tspinTables.single[_ms];
                    else if (linesCleared === 2) generatedGarbage = _tspinTables.double[_ms];
                    else if (linesCleared === 3) generatedGarbage = _tspinTables.triple[_ms];
                } else {
                    if (linesCleared === 1) generatedGarbage = _garbageTables.lines1[_ms];
                    else if (linesCleared === 2) generatedGarbage = _garbageTables.lines2[_ms];
                    else if (linesCleared === 3) generatedGarbage = _garbageTables.lines3[_ms];
                    else if (linesCleared === 4) generatedGarbage = _garbageTables.lines4[_ms];
                }
                // BtBボーナス
                if (isB2BTriggered) generatedGarbage += _btbBonus[_ms];
                // RENボーナス：従来テーブル + マージン追加ボーナス（2REN以降の全ボーナスに加算）
                let r = currentRenForGarbage;
                if (r === 2 || r === 3) generatedGarbage += 1 + _renBonus[_ms];
                else if (r === 4 || r === 5) generatedGarbage += 2 + _renBonus[_ms];
                else if (r === 6 || r === 7) generatedGarbage += 3 + _renBonus[_ms];
                else if (r >= 8 && r <= 12) generatedGarbage += 4 + _renBonus[_ms];
                else if (r >= 13) generatedGarbage += 5 + _renBonus[_ms];
            }
        }

        ////console.log(`[Scoring] prefix: ${this.canvasPrefix}, lines: ${linesCleared}, tSpin: ${tSpinType}, ren: ${currentRenForGarbage}, genGarbage: ${generatedGarbage}`);

        return generatedGarbage;
    }

    sendGarbage(amount) {
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        if (!opponent || amount <= 0) return;

        // ── 注意：火力補正乗率は secureMino 内で実効火力として計算済み。ここでは再計算しない ──

        let isOpponentPuyo = false;
        if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
            isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
        } else if (opponent) {
            isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
        }

        // ★追加：異種戦（ぷよ相手）の場合はゲージ量をおじゃまぷよの個数に変換する
        let actualAmount = amount;
        if (isOpponentPuyo) {
            const table = [0, 4, 5, 6, 8, 10, 13, 16, 20, 24, 28, 33, 38, 43, 49, 55, 61, 68];
            if (amount < table.length) {
                actualAmount = table[amount];
            } else {
                // n>=18の場合の階差数列の一般項: an = (n^2 - 21n + 204)/2
                actualAmount = Math.floor((amount * amount - 21 * amount + 204) / 2);
            }
            //console.log(`[sendGarbage] ぷよ相手用にゲージ ${amount} をおじゃまぷよ ${actualAmount} 個に変換して送信`);
        } else {
            //console.log(`[sendGarbage] ${this.canvasPrefix || 'player'} から相手へ ${amount} 送信`);
        }

        // 穴の計算（テト相手のみ意味があるが、エラーを防ぐため actualAmount 回ループする）
        const holes = [];
        let prevHole = -1;

        for (let i = 0; i < actualAmount; i++) {
            let holeX;
            if (i === 0) {
                holeX = Math.floor(Math.random() * COLS_COUNT);
            } else {
                const rate = this.vsGarbageHoleRate !== undefined ? this.vsGarbageHoleRate / 100 : 0.7;
                if (Math.random() < rate) {
                    holeX = prevHole;
                } else {
                    const offset = Math.floor(Math.random() * (COLS_COUNT - 1)) + 1;
                    holeX = (prevHole + offset) % COLS_COUNT;
                }
            }
            holes.push(holeX);
            prevHole = holeX;
        }

        const garbageObj = { amount: actualAmount, holes: holes, ready: false };
        opponent.garbageQueue.push(garbageObj);

        // 相手のゲージを更新（青色のゲージが増える）
        if (typeof opponent.updateGarbageGauge === 'function') {
            opponent.updateGarbageGauge();
        }

        // 異種戦(ぷよ相手)なら1000ms後、テト同士なら1500ms後に降下可能に
        const delay = isOpponentPuyo ? 1000 : 1500;

        setTimeout(() => {
            // タイマー発火時に相殺されて消滅していなければ状態変更
            if (opponent.garbageQueue.includes(garbageObj) && garbageObj.amount > 0) {
                garbageObj.ready = true;
                // 相手のゲージを更新（青→赤点滅に変わる）
                if (typeof opponent.updateGarbageGauge === 'function') {
                    opponent.updateGarbageGauge();
                }
            }
        }, delay);
    }

    applyGarbage() {
        const readyGarbage = this.garbageQueue.filter(g => g.ready);
        this.garbageQueue = this.garbageQueue.filter(g => !g.ready);

        if (readyGarbage.length === 0) return;

        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        let isOpponentPuyo = false;
        if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
            isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
        } else if (opponent) {
            isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
        }

        // ★ 異種戦（相手がぷよ）からの攻撃は最大7ラインずつ降る
        const limit = isOpponentPuyo ? 7 : Infinity;
        let droppedLines = 0;

        // ★ 追加：まとめて降ってくるおじゃまの穴位置を一貫して保持・計算するための変数
        let lastHole = -1;

        for (let j = 0; j < readyGarbage.length; j++) {
            let g = readyGarbage[j];
            let dropCount = 0;

            for (let i = 0; i < g.amount; i++) {
                if (droppedLines >= limit) {
                    break;
                }
                this.field.blocks.forEach(block => block.y -= 1);

                // ---------------------------------------------------------------------
                // ★ 旧仕様：送られた時点で計算されたholesを使用（バラバラに送られたら途切れる）
                // const currentHole = (g.holes && g.holes[i] !== undefined) ? g.holes[i] : Math.floor(Math.random() * COLS_COUNT);
                // ---------------------------------------------------------------------

                // ★ 新仕様：まとめて受けるおじゃまは、ここで一括で穴バラを計算する
                let currentHole;
                if (droppedLines === 0) {
                    // 今回受ける一番下の段（最初の1段目）は完全にランダム
                    currentHole = Math.floor(Math.random() * COLS_COUNT);
                } else {
                    // 2段目以降は70%で同じ穴、30%で違う穴
                    const rate = this.vsGarbageHoleRate !== undefined ? this.vsGarbageHoleRate / 100 : 0.7;
                    if (Math.random() < rate) {
                        currentHole = lastHole;
                    } else {
                        const offset = Math.floor(Math.random() * (COLS_COUNT - 1)) + 1;
                        currentHole = (lastHole + offset) % COLS_COUNT;
                    }
                }
                lastHole = currentHole;

                for (let x = 0; x < COLS_COUNT; x++) {
                    if (x !== currentHole) {
                        this.field.blocks.push(new Block(x, ROWS_COUNT - 1, 7));
                    }
                }
                dropCount++;
                droppedLines++;
            }

            if (dropCount < g.amount) {
                // 制限にかかった場合、残りの攻撃を再びreadyキューの先頭へ
                let remainHoles = g.holes ? g.holes.slice(dropCount) : [];
                this.garbageQueue.unshift({ amount: g.amount - dropCount, holes: remainHoles, ready: true });
                for (let k = j + 1; k < readyGarbage.length; k++) {
                    this.garbageQueue.push(readyGarbage[k]);
                }
                break;
            }
        }

        // おじゃまがフィールドに出現したのでゲージを減らす
        this.updateGarbageGauge();
    }

    // 自分に降ってくる予定の火力を相殺し、余った火力を返す
    offsetGarbage(amount) {
        //console.log(`[offsetGarbage] ${this.canvasPrefix || 'player'} が ${amount} の火力で相殺を試みます。現在のキュー:`, JSON.parse(JSON.stringify(this.garbageQueue)));

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

    // 予告ゲージのDOMを更新
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

    // ★追加: 攻撃(送る用)ゲージの更新
    updateAttackGauge() {
        if (!this.isVersusMode) return;

        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        let isOpponentPuyo = false;
        if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
            isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
        } else if (opponent) {
            isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
        }

        const gaugeId = this.canvasPrefix ? `${this.canvasPrefix}-attack-gauge` : null;
        if (!gaugeId) return;
        const gaugeEl = document.getElementById(gaugeId);
        if (!gaugeEl) return;

        gaugeEl.innerHTML = '';

        // 相手がぷよの場合のみ表示する
        if (!isOpponentPuyo) {
            gaugeEl.style.display = 'none';
            return;
        }

        gaugeEl.style.display = 'flex';

        if (this.pendingAttack <= 0) return;

        let amount = this.pendingAttack;
        let cycles = Math.floor(amount / 20);
        let remain = amount % 20;

        if (amount > 0 && remain === 0) {
            cycles -= 1;
            remain = 20;
        }

        const colors = ['c-0', 'c-1', 'c-2', 'c-3']; // 緑, 黄, オレンジ, 水色

        // 1周目の場合はベースがない
        if (cycles === 0) {
            let color = colors[0];
            for (let i = 0; i < remain; i++) {
                const block = document.createElement('div');
                block.className = `attack-block ${color}`;
                gaugeEl.appendChild(block);
            }
        } else {
            let baseColorIdx = (cycles - 1) % colors.length;
            let nextColorIdx = cycles % colors.length;

            let baseColor = colors[baseColorIdx];
            let nextColor = colors[nextColorIdx];

            for (let i = 0; i < 20; i++) {
                const block = document.createElement('div');
                // 下から上に積むので、remainの数だけ新しい色にする
                if (i < remain) {
                    block.className = `attack-block ${nextColor}`;
                } else {
                    block.className = `attack-block ${baseColor}`;
                }
                gaugeEl.appendChild(block);
            }
        }
    }

    // ミノを即座に固定する共通処理
    secureMino(viaHardDrop = false) {
        let isAllOutside = this.mino.blocks.every(block => (block.y + this.mino.y) < 0);

        // ─── T-spin判定（固定前に行う）───
        const tSpinResult = this.checkTSpin();

        this.mino.blocks.forEach(e => {
            e.x += this.mino.x
            e.y += this.mino.y
        })
        this.field.blocks = this.field.blocks.concat(this.mino.blocks)

        // 固定音：ハードドロップ時は harddrop SE を鳴らしているので二重化を避ける
        if (!viaHardDrop) this.playSe('lock');

        const renForCalc = this.ren; // ★ぷよ用火力計算のために加算前のRENを保持

        const linesCleared = this.field.checkLine()

        // ─── ライン消去・T-spin のSE ───
        if (tSpinResult !== null) {
            this.playSe('tspin');
        } else if (linesCleared >= 4) {
            this.playSe('4lines');
        } else if (linesCleared > 0) {
            this.playSe('lineclear');
        }

        const isBtBAction = (linesCleared > 0 && (linesCleared === 4 || tSpinResult !== null));
        const isB2BTriggered = isBtBAction && this.backToBack;
        const currentRen = (linesCleared > 0 && this.ren > 0) ? this.ren : 0;

        const isPerfectClear = (this.field.blocks.length === 0);
        const is4Lines = (linesCleared === 4);

        // Scoring() の戻り値として火力（段数）を受け取る
        let generatedGarbage = this.Scoring(tSpinResult, linesCleared, isPerfectClear);
        this.updateStatsDisplay();

        if (tSpinResult !== null || isB2BTriggered || currentRen > 0 || isPerfectClear || is4Lines) {
            this.showActionLabels(tSpinResult, linesCleared, isB2BTriggered, currentRen, isPerfectClear, is4Lines);
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 相殺（オフセット）と送り返し処理
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (this.isVersusMode) {
            const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
            let isOpponentPuyo = false;
            if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
                isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
            } else if (opponent) {
                isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
            }

            //console.log(`[secureMino] prefix: ${this.canvasPrefix}, isOpponentPuyo: ${isOpponentPuyo}, pendingAttack(Before): ${this.pendingAttack}, pendingInternalAttack(Before): ${this.pendingInternalAttack}`);

            if (isOpponentPuyo) {
                // ★ 今回の新仕様：ライン消去時は今回発生分のみで相殺、設置時に溜まったゲージで相殺
                if (linesCleared > 0) {
                    // ── マージンステップ取得（null = 未突入） ──
                    const _ms = this._tetMarginStep; // null or 0〜5

                    // ── 対ぷよ攻撃用火力テーブル（マージン中のみ使用） ──
                    const _puyoTables = {
                        lines1: [0, 0, 1, 1, 1, 2],
                        lines2: [1, 1, 2, 2, 3, 4],
                        lines3: [2, 2, 3, 4, 5, 6],
                        lines4: [4, 5, 5, 6, 8, 10],
                        tspinSingle: [2, 2, 3, 4, 5, 6],
                        tspinDouble: [3, 3, 4, 5, 6, 8],
                        tspinTriple: [4, 5, 5, 6, 8, 10],
                    };
                    const _puyoBtbBonus = [1, 1, 2, 2, 3, 4];
                    const _puyoPcBonus  = [7, 7, 8, 9, 10, 12];
                    // REN追加ボーナス（従来RENボーナスにさらに加算）
                    const _puyoRenBonus = [0, 0, 1, 1, 1, 1];
                    // 対テト相殺用REN追加ボーナス（Scoring()と同じ定義）
                    const _tetRenBonus  = [0, 0, 1, 1, 1, 1];

                    // 1. 対ぷよ用アタックゲージ火力を計算
                    let puyoAttack = 0;
                    if (isPerfectClear) {
                        puyoAttack = (_ms === null) ? 6 : _puyoPcBonus[_ms];
                    } else {
                        if (_ms === null) {
                            // ── マージン未突入：従来の固定値 ──
                            if (tSpinResult === 'tspin') {
                                if (linesCleared === 1) puyoAttack = 2;
                                else if (linesCleared === 2) puyoAttack = 3;
                                else if (linesCleared === 3) puyoAttack = 5;
                            } else {
                                if (linesCleared === 2) puyoAttack = 1;
                                else if (linesCleared === 3) puyoAttack = 2;
                                else if (linesCleared === 4) puyoAttack = 4;
                            }
                            if (isB2BTriggered) puyoAttack += 1;
                            // 従来RENテーブル（2REN以降）
                            const renTable = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5];
                            let renVal = (renForCalc >= renTable.length) ? 5 : renTable[renForCalc];
                            puyoAttack += renVal;
                        } else {
                            // ── マージン中：テーブル参照 ──
                            if (tSpinResult === 'tspin') {
                                if (linesCleared === 1) puyoAttack = _puyoTables.tspinSingle[_ms];
                                else if (linesCleared === 2) puyoAttack = _puyoTables.tspinDouble[_ms];
                                else if (linesCleared === 3) puyoAttack = _puyoTables.tspinTriple[_ms];
                            } else {
                                if (linesCleared === 1) puyoAttack = _puyoTables.lines1[_ms];
                                else if (linesCleared === 2) puyoAttack = _puyoTables.lines2[_ms];
                                else if (linesCleared === 3) puyoAttack = _puyoTables.lines3[_ms];
                                else if (linesCleared === 4) puyoAttack = _puyoTables.lines4[_ms];
                            }
                            if (isB2BTriggered) puyoAttack += _puyoBtbBonus[_ms];
                            // 従来RENテーブル + マージン追加ボーナス（2REN以降）
                            const renTable = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5];
                            let renVal = (renForCalc >= renTable.length) ? 5 : renTable[renForCalc];
                            if (renForCalc >= 2) renVal += _puyoRenBonus[_ms];
                            puyoAttack += renVal;
                        }
                    }

                    // 2. 相殺用の内部火力（generatedGarbage）を対ぷよ用RENボーナス基準に揃え直す
                    //    Scoring()で計算済みの generatedGarbage はテト用REN追加ボーナス込みなので、
                    //    マージン中の場合のみ対ぷよ用REN追加ボーナスへ差し替える（未突入時は両方0なので変化なし）
                    if (!isPerfectClear && linesCleared > 0 && _ms !== null) {
                        const tetRenAdd  = (renForCalc >= 2) ? _tetRenBonus[_ms] : 0;
                        const puyoRenAdd = (renForCalc >= 2) ? _puyoRenBonus[_ms] : 0;
                        // 同じ値なので差し替えは不要だが、将来の変更に備えて明示的に処理
                        generatedGarbage = generatedGarbage - tetRenAdd + puyoRenAdd;
                    }

                    // ── 乗率適用（vsAttackMultiplierのみ。vsMarginMultiplierはぷよ側が管理） ──
                    const _vsMultTvP = (this.vsAttackMultiplier ?? 1.0);
                    const effectiveGenerated = (this.isVersusMode && generatedGarbage > 0)
                        ? Math.max(1, Math.floor(generatedGarbage * _vsMultTvP))
                        : generatedGarbage;
                    const effectivePuyoAttack = (this.isVersusMode && puyoAttack > 0)
                        ? Math.max(1, Math.floor(puyoAttack * _vsMultTvP))
                        : puyoAttack;

                    // 2. 「今回発生した実効火力」のみを使って相殺を試みる（溜まっているゲージは使わない）
                    let canceledGarbage = 0;
                    let remainGenerated = effectiveGenerated;

                    if (this.garbageQueue.length > 0 && effectiveGenerated > 0) {
                        remainGenerated = this.offsetGarbage(effectiveGenerated);
                        canceledGarbage = effectiveGenerated - remainGenerated;
                    }

                    // 3. 相殺に使われなかった分(remainGenerated)を内部火力の貯蓄に追加
                    this.pendingInternalAttack += remainGenerated;

                    // アタックゲージ(送信用)に蓄える火力 = 今回の実効ぶよ用火力 - 相殺ライン(負の場合は0)
                    let attackToAdd = Math.max(0, effectivePuyoAttack - canceledGarbage);
                    this.pendingAttack += attackToAdd;

                    //console.log(`[secureMino] -> 消去あり: 実効ぶよ用火力 ${effectivePuyoAttack}(内部 ${effectiveGenerated}), 相殺使用 ${canceledGarbage}, 現在の貯蓄(表示): ${this.pendingAttack}(内部: ${this.pendingInternalAttack})`);

                } else {
                    // ライン消去がない（設置のみ）場合、溜まっているゲージ（内部火力）を放出して相殺・送信を行う
                    // 内部火力は設置のたびに実効化された値を積み上げているので、ここでは再適用しない
                    let canceledGarbage = 0;
                    if (this.garbageQueue.length > 0 && this.pendingInternalAttack > 0) {
                        let beforeInternal = this.pendingInternalAttack;
                        this.pendingInternalAttack = this.offsetGarbage(this.pendingInternalAttack);
                        canceledGarbage = beforeInternal - this.pendingInternalAttack;
                    }

                    // 余った火力を計算して相手に送信
                    let sendAmount = Math.max(0, this.pendingAttack - canceledGarbage);
                    if (sendAmount > 0) {
                        //console.log(`[secureMino] -> 消去なし: 貯蓄から ${sendAmount} を相手に送信します`);
                        this.sendGarbage(sendAmount); // 実効化済み。sendGarbage内では再計算しない
                    }

                    // 放出後は両方ともリセット
                    this.pendingAttack = 0;
                    this.pendingInternalAttack = 0;
                }
                this.updateAttackGauge();
            } else {
                // ★従来通り（テト同士）── マージンテーブル適用済みの generatedGarbage をそのまま使用
                // （Scoring()内でマージンステップに応じた値を計算済みなので乗率補正は不要）
                if (generatedGarbage > 0) {
                    // vsAttackMultiplier のみ適用（マージン火力増加はテーブルで処理済み）
                    const _vsMultTvT = (this.vsAttackMultiplier ?? 1.0);
                    const effectiveGarbage = (this.isVersusMode && _vsMultTvT !== 1.0)
                        ? Math.max(1, Math.floor(generatedGarbage * _vsMultTvT))
                        : generatedGarbage;

                    // 実効火力で相殺し、余った分を送信
                    const remainder = this.offsetGarbage(effectiveGarbage);

                    if (remainder > 0) {
                        this.sendGarbage(remainder);
                    }
                }
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
            this.mino = null;
            this.gameOver();
            return;
        }

        // 次のミノが出現する直前（今のミノが固定された瞬間）に、自分に届いている火力を適用
        if (this.isVersusMode || this.garbageQueue.length > 0) {
            if (this.vsGarbageDamageOnClear !== false || linesCleared === 0) {
                this.applyGarbage();
            }
        }

        this.popMino()
    }

    // ハードドロップ
    hardDrop() {
        let dropDistance = 0;
        while (this.valid(0, 1)) {
            this.mino.y++
            dropDistance++;
        }

        // ハードドロップスコア加算（距離 × 2）
        if (dropDistance > 0) {
            this.score += dropDistance * 2;
            this.updateStatsDisplay();
        }

        // 実際に落下した場合のみ回転フラグをリセット
        // （その場ハードドロップは直前の回転をT-spin判定に活かす）
        if (dropDistance > 0) this.lastActionWasRotation = false;

        // タイマーを両方停止
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }

        this.playSe('harddrop')
        this.secureMino(true)
        this.drawAll()
    }

    // ─────────────────────────────────────────
    // T-spin判定（ガイドライン 9.1 準拠）
    // 戻り値: 'tspin' | 'mini' | null
    // ─────────────────────────────────────────
    checkTSpin() {
        // T型（type=2）以外は対象外
        if (this.mino.type !== 2) return null;
        // 直前のアクションが回転でなければ対象外
        if (!this.lastActionWasRotation) return null;

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
        switch (this.mino.rotation) {
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
        if (this.lastRotUsedPoint5) {
            return 'tspin';
        }

        // A・B側2隅 + C・D側1隅以上 → T-Spin
        if (abFilled === 2 && cdFilled >= 1) {
            return 'tspin';
        }

        // C・D側2隅 + A・B側1隅以上 → Mini T-Spin
        if (cdFilled === 2 && abFilled >= 1) {
            return 'mini';
        }

        return null;
    }

    // ─────────────────────────────────────────
    // アクションラベル（PC, 4-LINES, T-Spin, B2B, REN）を一定時間表示する（DOM表示）
    // ─────────────────────────────────────────
    showActionLabels(tSpinType, linesCleared, isB2B, renCount, isPerfectClear, is4Lines) {
        // 対戦モードでは prefix 付きのコンテナを使う
        const containerId = (this.isVersusMode && this.canvasPrefix)
            ? `${this.canvasPrefix}-action-label-container`
            : 'action-label-container';
        const container = document.getElementById(containerId);
        if (!container) return;

        // 初回呼び出し時に、完全に独立した絶対配置のスロットを作成する
        if (!this._labelsInitialized) {
            container.innerHTML = '';

            // コンテナを基準点（座標0, 0のアンカー）として扱うための設定
            container.style.width = '0px';
            container.style.height = '0px';
            container.style.position = 'absolute';

            this.labelElements = {};
            this.labelTimers = {};

            // 完全自由配置用の座標マッピング（コンテナを基準としたpx単位）
            this.labelLayout = {
                four: { x: 80, y: 0 },    // 1. 4-LINES
                mini: { x: 40, y: 35 },   // 2. MINI
                tspin: { x: 60, y: 70 },   // 3. T-SPIN
                b2b: { x: 60, y: 105 },  // 4. BACK-TO-BACK
                pc: { x: 60, y: 140 },  // 5. PERFECT CLEAR
                ren: { x: 80, y: 175 }   // 6. REN
            };

            const slotIds = ['four', 'mini', 'tspin', 'b2b', 'pc', 'ren'];
            slotIds.forEach(id => {
                const el = document.createElement('div');
                el.className = `action-label`;
                el.style.opacity = '0';

                // 絶対配置（他のラベルの位置に一切影響を与えない）
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

            if (timers.fade) clearTimeout(timers.fade);
            if (timers.clear) clearTimeout(timers.clear);

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
        if (is4Lines) {
            triggerLabel('four', '4-LINES', 'four font-orbitron');
        }

        // 2 & 3. T-SPIN / MINI T-SPIN
        if (tSpinType !== null) {
            const clearNames = ['', ' SINGLE', ' DOUBLE', ' TRIPLE'];
            const suffix = clearNames[linesCleared] ?? '';

            if (tSpinType === 'mini') {
                triggerLabel('mini', 'MINI', 'mini font-tech');
                triggerLabel('tspin', 'T-SPIN' + suffix, 'mini font-tech');
            } else {
                if (this.labelElements['mini'].style.opacity !== '0') {
                    this.labelElements['mini'].style.opacity = '0';
                    this.labelElements['mini'].innerHTML = '&nbsp;';
                }
                triggerLabel('tspin', 'T-SPIN' + suffix, 'tspin font-tech');
            }
        }

        // 4. BACK-TO-BACK
        if (isB2B) {
            triggerLabel('b2b', 'BACK-TO-BACK', 'b2b font-orbitron');
        }

        // 5. PERFECT CLEAR
        if (isPerfectClear) {
            triggerLabel('pc', 'PERFECT CLEAR', 'pc font-orbitron');
        }

        // 6. REN
        if (renCount > 0) {
            triggerLabel('ren', renCount + ' REN', 'ren font-orbitron');
        }
    }

    // ─── 表示の更新 ───
    updateStatsDisplay() {
        // 対戦モードでは prefix 付きの要素IDを参照する
        const prefix = (this.isVersusMode && this.statsPrefix) ? `${this.statsPrefix}-` : '';

        // スコア
        const scoreEl = document.getElementById(`${prefix}score-value`);
        if (scoreEl) scoreEl.textContent = this.score;

        // レベル
        const levelEl = document.getElementById(`${prefix}level-value`);
        if (levelEl) levelEl.textContent = this.level;

        // ライン
        const linesEl = document.getElementById(`${prefix}lines-value`);
        if (linesEl) linesEl.textContent = this.lines;
    }

    getGhostY() {
        let ghostY = this.mino.y
        while (true) {
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
            if (canMove) {
                ghostY++
            } else {
                break
            }
        }
        return ghostY
    }

    drawAll() {
        this.mainCtx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT)
        this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height)
        this.holdCtx.clearRect(0, 0, this.holdCanvas.width, this.holdCanvas.height)

        // キャンバス背景を不透明に塗りつぶす（透明のままだと背後のパーティクルが透過して見えるため）
        this.mainCtx.fillStyle = '#0a0a0f';
        this.mainCtx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        this.nextCtx.fillStyle = '#0a0a0f';
        this.nextCtx.fillRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
        this.holdCtx.fillStyle = '#0a0a0f';
        this.holdCtx.fillRect(0, 0, this.holdCanvas.width, this.holdCanvas.height);

        // 上に少し余白を作る（-1行目の一部を表示）
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);

        // ブロックを描画する前にグリッドを描画する
        this.drawGrid(this.mainCtx);

        this.field.drawFixedBlocks(this.mainCtx);

        // this.mino が存在するときだけゴーストを描画
        if (this.mino) {
            const ghostY = this.getGhostY()
            if (ghostY !== this.mino.y) {
                this.mainCtx.globalAlpha = 0.25
                this.mino.draw(this.mainCtx, ghostY)
                this.mainCtx.globalAlpha = 1.0
            }
        }

        const minoScale = 0.8;

        // Draw next queue vertically（表示は先頭5個のみ。内部は11個保持）
        const spacing = 3;
        this.nextQueue.slice(0, 5).forEach((mino, i) => {
            this.nextCtx.save();
            this.nextCtx.translate(0, i * spacing * BLOCK_SIZE * minoScale);
            this.nextCtx.scale(minoScale, minoScale);
            mino.drawNext(this.nextCtx);
            this.nextCtx.restore();
        });

        // this.mino が存在するときだけ本体を描画
        if (this.mino) {
            this.mino.draw(this.mainCtx)
        }

        this.mainCtx.restore();

        if (this.holdMino) {
            this.holdCtx.save();
            if (!this.canHold) {
                this.holdCtx.globalAlpha = 0.4;
            }
            this.holdCtx.scale(minoScale, minoScale);
            this.holdMino.drawNext(this.holdCtx);
            this.holdCtx.restore();
        }
    }

    dropMino() {
        // CPU操作中は重力を無効（ソフトドロップとの干渉を防ぐ）
        // フリーズ（接地）はcheckGroundStateで別途管理されるため影響なし
        if (this.gravityDisabled) return;
        if (this.valid(0, 1)) {
            this.mino.y++;
            this.updateLowestY();
        }
        this.checkGroundState();
        this.drawAll();
    }

    // 接地状態をチェックし、重力と固定猶予タイマーを切り替える
    checkGroundState(actionHappened = false, wasGrounded = false) {
        // 接地状態からの操作ならカウントを進める
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

            // カウントが15回以上の場合は即座に強制固定
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

        // ポーズ時の計算用に開始時刻と設定時間を記録
        this.lockStartTime = performance.now();
        this.lockRemaining = delay;

        this.lockTimer = setTimeout(() => {
            this.lockTimer = null;
            this.secureMino();
            this.drawAll();
        }, delay);
    }

    valid(moveX, moveY, rot = 0) {
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
    // デバッグ用：初期盤面を2D配列で設定する
    //   board: 20行×10列の配列（board[0]が最上段、board[19]が最下段）
    //          1=ブロックあり、0=なし
    // ─────────────────────────────────────────
    applyDebugBoard(board) {
        if (!board) return;
        this.field.blocks = [];
        for (let row = 0; row < 20; row++) {
            for (let col = 0; col < 10; col++) {
                if (board[row][col] === 1) {
                    this.field.blocks.push(new Block(col, row, 7)); // type7 = グレー（ゴミブロック色）
                }
            }
        }
    }

    // ─────────────────────────────────────────
    // CPU / 外部から呼び出す単純移動ヘルパー
    // ─────────────────────────────────────────
    moveLeft() {
        if (this.valid(-1, 0)) {
            this.mino.x--;
            this.lastActionWasRotation = false;
            this.playSe('move');
            return true;
        }
        return false;
    }

    moveRight() {
        if (this.valid(1, 0)) {
            this.mino.x++;
            this.lastActionWasRotation = false;
            this.playSe('move');
            return true;
        }
        return false;
    }

    softDropOne() {
        if (this.valid(0, 1)) {
            this.mino.y++;
            this.score += 1;
            this.updateLowestY();
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────
    // キーイベント（localStorage のキー設定を参照）
    // ─────────────────────────────────────────
    setKeyEvent() {
        // CPU制御モードの場合はキーイベントを一切設定しない
        if (this.isCpuControlled) return;

        // 押されているキーを管理
        this.keyState = {}

        // 設定を読み込み
        /**
         * @type {{das: number, arr: number, dcd: number}}
         */
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
        if (this._keyDownHandler) document.removeEventListener('keydown', this._keyDownHandler)
        if (this._keyUpHandler) document.removeEventListener('keyup', this._keyUpHandler)
        if (this._keyLoop) clearInterval(this._keyLoop)

        /**
         * キー設定
         * @type {Object.<string, {code: string, label: string}>}
         */
        const keys = loadKeys();

        this._keyDownHandler = (e) => {
            // 対戦モードでは versus-page がアクティブな場合のみ動作
            const activePageId = this.isVersusMode ? 'versus-page' : 'game-page';
            const gamePage = document.getElementById(activePageId)
            if (!gamePage || !gamePage.classList.contains('active')) return

            // リスタート (ポーズ中・プレイ中問わず即座にやり直し)
            // 対戦モードではリスタートキーは router.js 側で管理するためスキップ
            if (!this.isVersusMode && e.code === keys.restart.code) {
                e.preventDefault()
                if (e.repeat) return; // 長押しによる連続発火を防止
                this.start()
                return
            }

            // ポーズ
            // 対戦モードではポーズは router.js の toggleVersusPause() に委譲
            if (!this.isVersusMode && e.code === keys.pause.code) {
                e.preventDefault()
                if (e.repeat) return; // 長押しによる連続発火を防止
                if (this.isCountingDown) return;
                this.togglePause()
                return
            }

            // ポーズ中は他のキー入力を無視
            if (this.isPaused) return

            this.keyState[e.code] = true

            const now = performance.now()
            if (e.code === keys.moveLeft.code && this._leftPressTime === null) {
                this._leftPressTime = now
                this._lastMoveTimeLeft = 0
                this._lastHorizontal = 'left'
            }
            if (e.code === keys.moveRight.code && this._rightPressTime === null) {
                this._rightPressTime = now
                this._lastMoveTimeRight = 0
                this._lastHorizontal = 'right'
            }

            // 単発系（押した瞬間のみ）
            if (e.code === keys.hardDrop.code) {
                e.preventDefault()
                if (e.repeat) return;            // 長押しによる連続発火を防止
                if (this.isCountingDown) return; // カウントダウン中は無効

                if (this.DCD_DELAY > 0 &&
                    (this._dasBlockedLeft || this._dasBlockedRight)) {
                    this._dcdUntil = performance.now() + this.DCD_DELAY
                }
                this.hardDrop()
            }
            if (e.code === keys.hold.code) {
                e.preventDefault()
                if (e.repeat) return;            // 長押し防止
                if (this.isCountingDown) return; // カウントダウン中は無効
                this.holdCurrentMino()
            }
        }

        this._keyUpHandler = (e) => {
            this.keyState[e.code] = false

            if (e.code === keys.moveLeft.code) {
                this._leftPressTime = null
                this._dasBlockedLeft = false
                this._dcdUntil = 0

                // 左を離したとき、右が押されていれば右を優先
                if (this.keyState[keys.moveRight.code]) {
                    this._lastHorizontal = 'right'
                }
            }

            if (e.code === keys.moveRight.code) {
                this._rightPressTime = null
                this._dasBlockedRight = false
                this._dcdUntil = 0

                // 右を離したとき、左が押されていれば左を優先
                if (this.keyState[keys.moveLeft.code]) {
                    this._lastHorizontal = 'left'
                }
            }
        }

        document.addEventListener('keydown', this._keyDownHandler)
        document.addEventListener('keyup', this._keyUpHandler)

        // 最適化：ループ内で毎回ID検索すると流石にチリツモで重くなるため、外で取得しておく
        // 対戦モードでは versus-page を参照する
        const activePageId = this.isVersusMode ? 'versus-page' : 'game-page';
        const gamePage = document.getElementById(activePageId);

        // 毎フレーム入力処理（同時入力対応）
        this._lastFrameTime = performance.now()
        this._keyLoop = setInterval(() => {
            if (!gamePage || !gamePage.classList.contains('active')) return
            if (this.isPaused) return
            // カウントダウン中はDASの時間を裏で記録するだけで、操作の実行はしない
            if (this.isCountingDown) return;
            if (!this.mino) return;

            const nowPerf = performance.now()
            const delta = nowPerf - this._lastFrameTime
            this._lastFrameTime = nowPerf

            let acted = false
            let wasGrounded = this.isGrounded; // 操作前の接地状態を記憶

            const now = nowPerf

            const leftPressed = this.keyState[keys.moveLeft.code];
            const rightPressed = this.keyState[keys.moveRight.code];

            // 優先方向を決定（後押し優先）
            let dir = null;
            if (leftPressed && rightPressed) {
                dir = this._lastHorizontal;
            } else if (leftPressed) {
                dir = 'left';
            } else if (rightPressed) {
                dir = 'right';
            }

            if (dir === 'left') {
                if (this._leftPressTime !== null) {
                    const heldTime = now - this._leftPressTime
                    const inDcd = now < this._dcdUntil

                    // 初回入力（押した瞬間）
                    if (this._lastMoveTimeLeft === 0) {
                        if (this.valid(-1, 0)) {
                            this.mino.x--
                            this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                            this.playSe('move')
                            acted = true
                        }
                        this._lastMoveTimeLeft = now
                        this._dasBlockedLeft = false
                    }
                    // DAS後の連続移動
                    else if (heldTime >= this.DAS_DELAY &&
                        now - this._lastMoveTimeLeft >= this.ARR_INTERVAL) {
                        if (!inDcd) {
                            if (this.valid(-1, 0)) {
                                this.mino.x--
                                this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                                this.playSe('move')
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
            else if (dir === 'right') {
                if (this._rightPressTime !== null) {
                    const heldTime = now - this._rightPressTime
                    const inDcd = now < this._dcdUntil

                    // 初回入力（押した瞬間）
                    if (this._lastMoveTimeRight === 0) {
                        if (this.valid(1, 0)) {
                            this.mino.x++
                            this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                            this.playSe('move')
                            acted = true
                        }
                        this._lastMoveTimeRight = now
                        this._dasBlockedRight = false
                    }
                    // DAS後の連続移動
                    else if (heldTime >= this.DAS_DELAY &&
                        now - this._lastMoveTimeRight >= this.ARR_INTERVAL) {
                        if (!inDcd) {
                            if (this.valid(1, 0)) {
                                this.mino.x++
                                this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                                this.playSe('move')
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

            if (this.keyState[keys.softDrop.code]) {
                // 初回押し込み時は即座に1段落とす
                if (this._lastSoftDropTime === 0) {
                    this._lastSoftDropTime = now;
                    if (this.valid(0, 1)) {
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
                    if (elapsed >= currentSoftDropArr) {
                        // 経過時間の中に、何マスの落下が含まれるかを割り算で計算（フレームの壁を突破）
                        let dropCount = Math.floor(elapsed / currentSoftDropArr);

                        let actuallyDropped = 0;
                        for (let i = 0; i < dropCount; i++) {
                            if (this.valid(0, 1)) {
                                this.mino.y++;
                                actuallyDropped++;
                            } else {
                                break; // 途中で接地したらループを抜ける
                            }
                        }

                        if (actuallyDropped > 0) {
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
            if (this.keyState[keys.rotateCW.code]) {
                if (!this._rotCWPressed) {
                    if (this.tryRotate(1)) {
                        this.updateLowestY(); // キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCWPressed = true
                }
            }
            if (!this.keyState[keys.rotateCW.code]) {
                this._rotCWPressed = false
            }

            if (this.keyState[keys.rotateCCW.code]) {
                if (!this._rotCCWPressed) {
                    if (this.tryRotate(-1)) {
                        this.updateLowestY(); // キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCCWPressed = true
                }
            }
            if (!this.keyState[keys.rotateCCW.code]) {
                this._rotCCWPressed = false
            }

            // ─── DCD 発動チェック（回転） ──────────────────────────
            // DASが効いていて動けない（空振り）状態で回転が入力された場合にDCDを開始する
            if (this.DCD_DELAY > 0 && acted) {
                const rotActed =
                    (this.keyState[keys.rotateCW.code] && this._rotCWPressed) ||
                    (this.keyState[keys.rotateCCW.code] && this._rotCCWPressed)
                if (rotActed && (this._dasBlockedLeft || this._dasBlockedRight)) {
                    this._dcdUntil = now + this.DCD_DELAY
                }
            }

            // アクションが起きたら接地状態を再評価（15回制限もここで処理される）
            if (acted) {
                this.checkGroundState(true, wasGrounded);
                this.drawAll()
            }

        }, 4) // （最小実行間隔の4ms、つまり秒間約250回ループ）

        // ─────────────────────────────────────────
        // Gamepad サポート
        // ─────────────────────────────────────────
        // 既存のキーマッピングを壊さないよう、ゲームパッドの操作は
        // keyboard のキーコードに対応するフラグを `this.keyState` に書き込みます。
        // またボタンの押下遷移は即時アクション（ホールド、ハードドロップ、回転等）を呼び出します。

        if (this._gamepadLoop) clearInterval(this._gamepadLoop)
        if (this._gpConnectedHandler) window.removeEventListener('gamepadconnected', this._gpConnectedHandler)
        if (this._gpDisconnectedHandler) window.removeEventListener('gamepaddisconnected', this._gpDisconnectedHandler)

        const DEFAULT_GAMEPAD = {
            moveLeft: [{ type: 'button', index: 14 }], // D-Pad Left
            moveRight: [{ type: 'button', index: 15 }], // D-Pad Right
            softDrop: [{ type: 'button', index: 13 }], // D-Pad Down
            hardDrop: [{ type: 'button', index: 12 }], // D-Pad Up
            rotateCW: [{ type: 'button', index: 0 }], // A
            rotateCCW: [{ type: 'button', index: 1 }], // B
            hold: [{ type: 'button', index: 4 }, { type: 'button', index: 5 }], // L/R
            pause: [{ type: 'button', index: 9 }], // Start
            restart: [{ type: 'button', index: 8 }]  // Select / Back
        };

        // Prefer configuration exposed by settings.js when available
        let gpConfig = DEFAULT_GAMEPAD;
        if (typeof currentGamepadConfig !== 'undefined' && currentGamepadConfig) {
            gpConfig = currentGamepadConfig;
        } else {
            const saved = localStorage.getItem('game_gamepadconfig');
            if (saved) {
                try {
                    gpConfig = { ...DEFAULT_GAMEPAD, ...JSON.parse(saved) };
                } catch (e) {
                    localStorage.removeItem('game_gamepadconfig');
                    gpConfig = DEFAULT_GAMEPAD;
                }
            }
        }

        const normalizeGamepadConfig = (cfg) => {
            const out = {};
            for (const action in DEFAULT_GAMEPAD) {
                const v = cfg && cfg[action];
                if (Array.isArray(v)) out[action] = v.slice(0, 2);
                else if (v && typeof v === 'object') out[action] = [v];
                else out[action] = DEFAULT_GAMEPAD[action];
            }
            return out;
        };
        gpConfig = normalizeGamepadConfig(gpConfig);

        let GP_STICK_DEADZONE = 0.45;
        if (typeof loadGamepadOptions === 'function') {
            const opt = loadGamepadOptions();
            if (opt && Number.isFinite(opt.deadzone)) {
                GP_STICK_DEADZONE = Math.min(0.95, Math.max(0.05, opt.deadzone));
            }
        } else {
            const rawOpt = localStorage.getItem('game_gamepad_options');
            if (rawOpt) {
                try {
                    const parsed = JSON.parse(rawOpt);
                    if (parsed && Number.isFinite(parsed.deadzone)) {
                        GP_STICK_DEADZONE = Math.min(0.95, Math.max(0.05, parsed.deadzone));
                    }
                } catch (e) {
                    localStorage.removeItem('game_gamepad_options');
                }
            }
        }
        this._prevGamepadState = this._prevGamepadState || {}
        this._gamepadIndex = (typeof this._gamepadIndex === 'number') ? this._gamepadIndex : null

        this._gpConnectedHandler = (e) => {
            this._gamepadIndex = e.gamepad.index;
            if (typeof showGlobalToast === 'function') {
                showGlobalToast('Gamepad connected: ' + (e.gamepad.id || ''))
            }
        }
        this._gpDisconnectedHandler = (e) => {
            // 接続切れたパッドが現在参照しているものなら参照解除
            if (this._gamepadIndex === e.gamepad.index) this._gamepadIndex = null
            if (typeof showGlobalToast === 'function') {
                showGlobalToast('Gamepad disconnected')
            }
        }

        window.addEventListener('gamepadconnected', this._gpConnectedHandler)
        window.addEventListener('gamepaddisconnected', this._gpDisconnectedHandler)

        // ゲームパッド用ポーリングループ（60FPS程度）
        this._gamepadLoop = setInterval(() => {
            const pads = (navigator.getGamepads) ? navigator.getGamepads() : []
            let pad = null
            if (this._gamepadIndex !== null && pads[this._gamepadIndex]) pad = pads[this._gamepadIndex]
            else {
                // 最初に見つかったパッドを採用
                for (let i = 0; i < pads.length; i++) { if (pads[i]) { pad = pads[i]; break } }
            }
            if (!pad) return

            const stickX = (pad.axes && pad.axes.length > 0) ? pad.axes[0] : 0;
            const stickY = (pad.axes && pad.axes.length > 1) ? pad.axes[1] : 0;

            // 各アクションについて現在押されているかを判定
            const keysForAction = keys; // from outer scope
            for (const action in gpConfig) {
                const mappings = Array.isArray(gpConfig[action]) ? gpConfig[action] : (gpConfig[action] ? [gpConfig[action]] : [])
                let pressed = false

                for (let mi = 0; mi < mappings.length; mi++) {
                    const mapping = mappings[mi]
                    if (!mapping) continue
                    if (mapping.type === 'button') {
                        const b = pad.buttons[mapping.index]
                        pressed = pressed || !!(b && b.pressed)
                    } else if (mapping.type === 'axis') {
                        const a = pad.axes[mapping.index]
                        pressed = pressed || !!(a && Math.abs(a) > 0.5)
                    }
                }

                // 左スティックはデフォルト入力として常時有効
                if (action === 'moveLeft') pressed = pressed || (stickX <= -GP_STICK_DEADZONE)
                if (action === 'moveRight') pressed = pressed || (stickX >= GP_STICK_DEADZONE)
                if (action === 'softDrop') pressed = pressed || (stickY >= GP_STICK_DEADZONE)
                if (action === 'hardDrop') pressed = pressed || (stickY <= -GP_STICK_DEADZONE)

                const keyCode = (keysForAction[action] && keysForAction[action].code) ? keysForAction[action].code : null
                const prev = !!this._prevGamepadState[action]

                // 単発系アクションは遷移で実行
                if (action === 'hardDrop' || action === 'hold' || action === 'pause' || action === 'restart') {
                    if (pressed && !prev) {
                        // トグル系は即時呼び出し
                        try {
                            if (action === 'hardDrop') {
                                if (this.isCountingDown) { /* ignore during countdown */ }
                                else this.hardDrop()
                            } else if (action === 'hold') {
                                if (this.isCountingDown) { /* ignore */ }
                                else this.holdCurrentMino()
                            } else if (action === 'pause') {
                                if (!this.isVersusMode && !this.isCountingDown) this.togglePause()
                            } else if (action === 'restart') {
                                if (!this.isVersusMode) this.start()
                            }
                        } catch (e) {/* 防御的に例外握り潰す */ }
                    }
                    // update prev state and continue
                    this._prevGamepadState[action] = pressed
                    continue
                }

                // 継続系は keyState に反映して既存のロジックを再利用
                if (keyCode) {
                    if (pressed && !this.keyState[keyCode]) {
                        // キーダウンと同等の初回処理
                        this.keyState[keyCode] = true
                        const now = performance.now()
                        if (action === 'moveLeft' && this._leftPressTime === null) {
                            this._leftPressTime = now
                            this._lastMoveTimeLeft = 0
                            this._lastHorizontal = 'left'
                        }
                        if (action === 'moveRight' && this._rightPressTime === null) {
                            this._rightPressTime = now
                            this._lastMoveTimeRight = 0
                            this._lastHorizontal = 'right'
                        }
                        if (action === 'softDrop' && this._lastSoftDropTime === 0) {
                            this._lastSoftDropTime = now
                            if (!this.mino) break;
                            if (this.valid(0, 1)) {
                                this.mino.y++
                                this.updateLowestY()
                                this.lastActionWasRotation = false
                                this.score += 1
                                this.updateStatsDisplay()
                            }
                        }
                    }
                    if (!pressed && this.keyState[keyCode]) {
                        // キーアップ相当の処理
                        this.keyState[keyCode] = false
                        if (action === 'moveLeft') {
                            this._leftPressTime = null
                            this._dasBlockedLeft = false
                            this._dcdUntil = 0
                            if (this.keyState[keysForAction.moveRight.code]) this._lastHorizontal = 'right'
                        }
                        if (action === 'moveRight') {
                            this._rightPressTime = null
                            this._dasBlockedRight = false
                            this._dcdUntil = 0
                            if (this.keyState[keysForAction.moveLeft.code]) this._lastHorizontal = 'left'
                        }
                        if (action === 'softDrop') {
                            this._lastSoftDropTime = 0
                        }
                    }
                }

                this._prevGamepadState[action] = pressed
            }
        }, 16)
    }
}