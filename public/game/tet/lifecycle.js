// ─────────────────────────────────────────────
// tet/lifecycle.js  ―  Game.prototype mixin
// ライフサイクル（開始/初期化・重力/ゲームオーバー・ポーズ・タイマー）
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

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
            // START! のタイミングでBGM開始（versus は startVersusGame 側で鳴らすため除外）。
            // CPU TEST(currentMode==='test')は専用BGM、それ以外のシングル(marathon/sprint/ultra)は singleBgmKey でモード別キーに解決。
            if (!this.isVersusMode && window.BgmManager) {
                window.BgmManager.play(this.currentMode === 'test'
                    ? 'test_bgm'
                    : window.BgmManager.singleBgmKey(this.currentMode));
            }
            this._startGameplay();
        }, null);
    },

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
        // おじゃま降下猶予タイマーをリセット（前ゲームの残りタイマーが発火しないように）
        if (this._garbageTimers) {
            this._garbageTimers.forEach(t => { if (t.id) clearTimeout(t.id); });
        }
        this._garbageTimers = [];
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
            // preElapsedMs: マージン突入時点で「すでに経過したものとして扱う」ミリ秒数。
            // 負のマージンタイムで、テーブルを進めた状態でVSを開始するために使う。
            const startMargin = (preElapsedMs = 0) => {
                if (!this.isVersusMode) return;
                // 事前経過ぶんステップを進めた状態で突入（上限はクランプ）
                this._tetMarginStep = Math.min(
                    Math.floor(preElapsedMs / TET_MARGIN_INTERVAL_MS),
                    TET_MARGIN_MAX_STEP
                );
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
                if (this._tetMarginStep < TET_MARGIN_MAX_STEP) {
                    // 次ステップまでの残り（事前経過がステップ境界に満たない端数を差し引く）
                    const nextDelay = TET_MARGIN_INTERVAL_MS - (preElapsedMs % TET_MARGIN_INTERVAL_MS);
                    this._vsMarginTimer = setTimeout(step, nextDelay);
                    this._vsMarginTimerStart = performance.now();
                    this._vsMarginTimerDuration = nextDelay;
                    this._vsMarginTimerCb = step;
                } else {
                    this._vsMarginTimer = null;
                }
            };
            if (this.vsMarginTimeMs === 0) {
                startMargin(); // 即時発動
            } else if (this.vsMarginTimeMs < 0) {
                startMargin(-this.vsMarginTimeMs); // 負=テーブルを進めた状態で即突入
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
    },

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
    },

    // ─── 重力の開始 ───
    startGravity() {
        if (this.timer) clearInterval(this.timer);
        // 現在のレベルに応じた速度を取得（15を超えた場合は最速の7ms）
        const speed = LEVEL_SPEEDS[this.level] || 7;
        this.timer = setInterval(() => this.dropMino(), speed);
    },

    // ゲームオーバー処理
    // 引数に isClear（デフォルト false）を追加
    gameOver(isClear = false) {
        this.isClear = isClear;
        if (!isClear) this.playSe('gameover');
        this.drawAll();
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }
        // おじゃま降下猶予タイマーを全て停止
        if (this._garbageTimers && this._garbageTimers.length) {
            this._garbageTimers.forEach(t => { if (t.id) clearTimeout(t.id); });
            this._garbageTimers = [];
        }
        this.isPaused = true;

        if (this.isTimerRunning) {
            this.elapsedTime += performance.now() - this.startTime;
            this.isTimerRunning = false;
            cancelAnimationFrame(this.timerReqId);
            this.updateTimeDisplay();
        }

        // オンライン対戦: 自分の topout を相手へ通知（versusGameOver より前に送る）
        if (window.OnlineHooks) window.OnlineHooks.gameOver(this);

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
    },

    togglePause() {
        if (this.isPaused) {
            this.playSe('resume')
            this.resume()
        } else {
            this.playSe('pause')
            this.pause()
        }
    },

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

        // おじゃま降下猶予タイマーの停止と残り時間の保存
        if (this._garbageTimers && this._garbageTimers.length) {
            for (const t of this._garbageTimers) {
                if (t.id) {
                    clearTimeout(t.id);
                    t.id = null;
                    t.remaining = Math.max(0, t.duration - (performance.now() - t.start));
                }
            }
        }

        this.showPauseOverlay()

        if (this.isTimerRunning) {
            this.elapsedTime += performance.now() - this.startTime;
            this.isTimerRunning = false;
            cancelAnimationFrame(this.timerReqId);
        }
    },

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

        // おじゃま降下猶予タイマーの再開（保存しておいた残り時間で再計時）
        if (this._garbageTimers && this._garbageTimers.length) {
            for (const t of this._garbageTimers) {
                if (!t.id) {
                    const rem = (t.remaining !== null && t.remaining !== undefined) ? t.remaining : t.duration;
                    t.duration = rem; // 以降のポーズ計算用に残り時間を基準にする
                    t.start = performance.now();
                    t.remaining = null;
                    t.id = setTimeout(t.cb, rem);
                }
            }
        }

        if (!this.isTimerRunning) {
            this.startTime = performance.now();
            this.isTimerRunning = true;
            this.startTimerLoop();
        }
    },

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
    },

    hidePauseOverlay() {
        // 対戦モードでは versus-pause-overlay を使う（router.js 側で管理）
        if (this.isVersusMode) return;
        document.getElementById('pause-overlay').classList.remove('active')
    },

    // タイマーの描画ループ（約60fps）
    startTimerLoop() {
        const loop = () => {
            if (!this.isTimerRunning) return;
            this.updateTimeDisplay();
            this.timerReqId = requestAnimationFrame(loop);
        };
        this.timerReqId = requestAnimationFrame(loop);
    },

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
    },
});
