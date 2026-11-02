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

        // カウントダウンはゲーム時計の予約で進むので、カウントダウン中からフレームを回す
        // （CPU 操作でキーイベントを持たない盤面も。setKeyEvent が回し始めていればそのまま）
        this.startRenderLoop();

        // カウントダウン開始
        runCountdown(overlayId, textElId, () => {
            // START! のタイミングでBGM開始（versus は startVersusGame 側で鳴らすため除外）。
            // CPU TEST(currentMode==='test')は専用BGM、それ以外のシングル(marathon/sprint/ultra)は singleBgmKey でモード別キーに解決。
            // 再生中は鳴らし直さない（BGM は再生の頭で 1 回だけ。core/replay.js）
            if (!this.isVersusMode && window.BgmManager && !this._replay) {
                window.BgmManager.play(this.currentMode === 'test'
                    ? 'test_bgm'
                    : window.BgmManager.singleBgmKey(this.currentMode));
            }
            this._startGameplay();
        }, null, undefined, false, this.clock);
    },

    // ─────────────────────────────────────────
    // ゲーム状態の初期化（カウントダウン前に呼ぶ）
    // ─────────────────────────────────────────
    _initGameState() {
        this.isFinishing = false; // 前局のGAMEOVER演出締め出しフラグをリセット

        // 前局の予約（固定猶予・おじゃま猶予・マージン）を先に全部取り消してから時計を今に合わせる。
        // 時計はフレームの頭でしか進まないので、メニューにいた間のぶんをここで進めておかないと、
        // この後に入れるマージンの予約が最初のフレームでまとめて追いつかれてすぐ発火してしまう。
        this._cancelLockTimer();
        this._cancelGarbageTimers();
        if (this._vsMarginTimer) { this.clock.cancel(this._vsMarginTimer); this._vsMarginTimer = null; }
        this.clock.resume(); // ポーズ中のリスタートなどで止まったままの時計を動かす
        this.clock.advance();
        this._inputQueue = [];

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

        // 乱数を試合ごとに作り直す（7バッグより先に）
        this._newRngStreams();

        // 録画を始める（対象のモードだけ）／再生なら録画したときの時刻と経過時間の列に合わせる（core/replay.js）
        ReplayManager.begin(this);

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
                        this._vsMarginTimer = this.clock.schedule(TET_MARGIN_INTERVAL_MS, step);
                        this._vsMarginTimerStart = this.clock.now();
                        this._vsMarginTimerDuration = TET_MARGIN_INTERVAL_MS;
                        this._vsMarginTimerCb = step;
                    } else {
                        this._vsMarginTimer = null;
                    }
                };
                if (this._tetMarginStep < TET_MARGIN_MAX_STEP) {
                    // 次ステップまでの残り（事前経過がステップ境界に満たない端数を差し引く）
                    const nextDelay = TET_MARGIN_INTERVAL_MS - (preElapsedMs % TET_MARGIN_INTERVAL_MS);
                    this._vsMarginTimer = this.clock.schedule(nextDelay, step);
                    this._vsMarginTimerStart = this.clock.now();
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
                this._vsMarginTimer = this.clock.schedule(this.vsMarginTimeMs, startMargin);
                this._vsMarginTimerStart = this.clock.now();
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
        this.attackSent = 0; // APM計測用（相手へ送った実効火力の累積）

        // リスタート時にタイマー表示をリセット
        this.updateTimeDisplay();

        // カウントダウンフラグと、ミノの未出現状態の設定
        this.isCountingDown = true;
        this.mino = null;

        // 既存のタイマーをすべて止めておく
        clearInterval(this.timer);
        this.timer = null;
        this._cancelLockTimer();

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
            cancelCountdownTimer(countdownOverlay);
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
        // フレームが回っていなかった間（QUIZ・ONLINE のカウントダウン等）のぶんを先に進めておく。
        // 進めずに startTime や重力の基準を取ると、最初のフレームでその間のぶんがまとめて落ちる。
        // カウントダウンが時計の予約のとき（シングル・VERSUS）はフレームの中なので何もしない
        this.clock.advance();

        // カウントダウンを解除し、ここで初めてミノを出現させる
        this.isCountingDown = false;
        this.popMino();
        this.drawAll();

        // rAF駆動の描画ループ＆入力ポーリング開始
        // （CPU側インスタンスも _pollInput 未設定なので描画専用ループとして回る）
        this.startRenderLoop();

        // タイマー開始
        this.startTime = this.clock.now();
        this.isTimerRunning = true;
        this.startTimerLoop();

        // 重力開始
        this.startGravity()
    },

    // ─── 重力の開始 ───
    // rAF駆動に変更：従来の setInterval は rAF と非同期で発火し、
    // 高リフレッシュレート(120Hz+)モニターで「ミノが瞬間移動」して見える原因だった。
    // フラグ+時刻だけ保持し、実際の落下は render.js の rAF ループから
    // _applyGravityTick() 経由で「経過時間に応じたマス数」を一括処理する
    // （ソフトドロップ側の方式と統一）。
    // this.timer は引き続き「重力が ON か」のフラグとして使う：truthy=ON / falsy=OFF。
    // 既存の clearInterval(this.timer) 呼び出しは安全な no-op として残してOK。
    startGravity() {
        this.timer = true;
        this._gravityLastTime = this.clock.now();
    },

    // ─── 重力 tick (rAF ループから毎フレ呼ばれる) ───
    _applyGravityTick() {
        // ─── PRACTICE: 自由落下0のときの固定仕様（設計 §8.1）───
        // ソフトドロップ押下中だけ固定タイマーを動かし、離した瞬間に 0 へ戻す。
        // 接地後は soft drop が落下距離を生まない＝_pollInput が acted を立てず
        // checkGroundState も呼ばれないため、「接地したまま押し直した」ケースの
        // 再開はこのフレーム処理が受け持つ。接地中は this.timer が falsy なので、
        // 下の早期returnより前で判定する必要がある。
        if (this.practiceNoLock && this.mino && !this.isPaused && !this.isCountingDown) {
            const softHeld = !!(this.keyState && this.keyState.softDrop);
            if (!softHeld) {
                this._cancelLockTimer();
            } else if (!this.lockTimer && this.isGrounded) {
                this.startLockTimer();
            }
        }
        if (!this.timer) return;                          // OFF
        // 動かない局面では「時刻だけ前進」させる＝ポーズ復帰やカウントダウン明け
        // の瞬間に溜まった経過時間で多重落下するのを防ぐ
        if (this.isPaused || this.isCountingDown || !this.mino || this.gravityDisabled) {
            this._gravityLastTime = this.clock.now();
            return;
        }
        // PRACTICE設定パネル：レベルに依存しない速度を直接指定できる（未指定時は通常どおりレベル依存）
        const speed = (typeof this.practiceFallSpeedMs === 'number') ? this.practiceFallSpeedMs : (LEVEL_SPEEDS[this.level] || 7);
        const now = this.clock.now();
        const elapsed = now - this._gravityLastTime;
        if (elapsed < speed) return;
        const dropCount = Math.floor(elapsed / speed);
        // 余り時間を次フレに持ち越し（高速落下時のドリフト防止）
        this._gravityLastTime = now - (elapsed % speed);
        for (let i = 0; i < dropCount; i++) {
            this.dropMino();
            // 接地で this.timer=null になったら終了
            if (!this.timer) break;
        }
    },

    // ゲームオーバー処理
    // 引数に isClear（デフォルト false）を追加
    gameOver(isClear = false) {
        this.isClear = isClear;
        // クリア(SPRINT完走/ULTRA終了/MARATHON達成)は専用のクリア音。
        // QUIZ正解・PRACTICE GOAL達成とも同じ 'clear' に統一している。
        this.playSe(isClear ? 'clear' : 'gameover');
        this.drawAll();
        // rAF描画＆入力ループを停止
        this.stopRenderLoop();
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this._cancelLockTimer();
        // おじゃま降下猶予タイマーを全て停止
        this._cancelGarbageTimers();
        this.isPaused = true;

        if (this.isTimerRunning) {
            this.elapsedTime += this.clock.now() - this.startTime;
            this.isTimerRunning = false;
            cancelAnimationFrame(this.timerReqId);
            this.updateTimeDisplay();
        }

        // 録画の締め／再生の終わり（core/replay.js）。再生のときは終了演出・リザルト・記録の保存をしない
        if (this._rec) ReplayManager.finish(this, isClear, this.isVersusMode ? { loser: replaySide(this) } : null);
        if (this._replay) { this._replay.onGameOver(this, isClear); return; }

        // 対戦モードの場合は versusGameOver() に委譲する
        if (this.isVersusMode) {
            const loser = (this.canvasPrefix === 'cpu') ? 'cpu' : 'player';
            if (typeof versusGameOver === 'function') versusGameOver(loser);
            return;
        }

        // シングルプレイの終了演出（FINISH!）を表示してからリザルトへ
        // ─── 演出中(switchPage('result')まで)のリスタート/ポーズ締め出し用フラグ ───
        // isPausedは既にtrueだが、リスタートキーは「ポーズ中・プレイ中問わず即座にやり直し」
        // 仕様のためisPausedチェックをすり抜ける。演出中に押すと詰んだ状態のままstart()が
        // 走ってしまう（MARATHON/SPRINT/ULTRA共通のバグ。設計 Phase5 §4.2 参照）。
        // _initGameState()（start()の先頭）でfalseに戻す。
        this.isFinishing = true;
        const finishText = isClear ? 'FINISH!' : 'GAME OVER';
        const finishClass = isClear ? 'finish-clear' : 'finish-gameover';
        showFinishOverlay('finish-overlay', 'finish-text', finishText, finishClass, 1200, async () => {
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

            // 最高記録の更新判定・表示（NEW RECORD!バッジ＋BEST行）。
            // switchPage('result')より前に確定させる：result-stats等の登場アニメと同じ
            // スタイル再計算パスに乗せないと、バッジだけ1フレーム遅れてアニメが生成されず
            // 出現アニメなしでポップインして見える（非同期.then()内でDOM変更していたのが原因）。
            const badge = document.getElementById('result-new-record');
            const bestRow = document.getElementById('result-best-row');
            const bestVal = document.getElementById('result-best-value');
            const rankEl = document.getElementById('result-rank');
            if (rankEl) rankEl.style.display = 'none';
            const recordKey = (this.mode === 'marathon')
                ? ((this.goalLines === Infinity) ? 'marathon:endless' : 'marathon:150')
                : (this.mode === 'sprint' ? 'sprint:40' : this.mode);
            if (typeof this._submitRecordIfEligible === 'function') {
                const res = await this._submitRecordIfEligible(isClear);
                if (badge) badge.style.display = (res && res.isNew) ? 'block' : 'none';
                if (bestRow && bestVal) {
                    if (res && res.record && window.Records) {
                        bestVal.textContent = window.Records.format(recordKey, res.record);
                        bestRow.style.display = '';
                    } else {
                        bestRow.style.display = 'none';
                    }
                }
                // ランキング対象モードでDiscordログイン中のみ、順位が非同期で届いたら表示する
                // （account.js の syncLocalBests() が records.js の submit() から裏で呼ばれる）。
                if (res && res.isNew && window.Account && window.Account.watchResultRank) {
                    window.Account.watchResultRank(recordKey, rankEl);
                }
            } else {
                if (badge) badge.style.display = 'none';
                if (bestRow) bestRow.style.display = 'none';
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
        // 録画: ポーズは次のフレームの頭の出来事として残す（再生はそこで pause() を呼ぶ。core/replay.js）
        if (this._rec) this._rec.pause(this, true)
        // ③ ポーズ中はBGMを止めず小音量で流し続ける（再生中はポーズを見せない）
        if (!this._replay) window.BgmManager?.duck()
        clearInterval(this.timer)
        // 時計を止める（設計 D7）。下の残り時間の保存は止めた時刻で計算する
        this.clock.pause()

        // 接地猶予タイマーが動いていた場合、残り時間を計算して保存する
        if (this.lockTimer) {
            this._cancelLockTimer();
            this.lockRemaining -= (this.clock.now() - this.lockStartTime);
            this._wasLockingWhenPaused = true;
        } else {
            this._wasLockingWhenPaused = false;
        }

        // マージンタイマーの停止と残り時間の保存
        if (this._vsMarginTimer) {
            this.clock.cancel(this._vsMarginTimer);
            this._vsMarginTimer = null;
            this._vsMarginTimerRemaining = this._vsMarginTimerDuration - (this.clock.now() - this._vsMarginTimerStart);
        }

        // おじゃま降下猶予タイマーの停止と残り時間の保存
        if (this._garbageTimers && this._garbageTimers.length) {
            for (const t of this._garbageTimers) {
                if (t.id) {
                    this.clock.cancel(t.id);
                    t.id = null;
                    t.remaining = Math.max(0, t.duration - (this.clock.now() - t.start));
                }
            }
        }

        if (!this._replay) this.showPauseOverlay()

        if (this.isTimerRunning) {
            this.elapsedTime += this.clock.now() - this.startTime;
            this.isTimerRunning = false;
        }
    },

    resume() {
        if (!this.isPaused) return
        this.isPaused = false
        if (this._rec) this._rec.pause(this, false)
        // 止めていた時計を動かす。止まっていた間の実時間は数えない
        this.clock.resume()
        // ③ ポーズ解除でBGM音量を元に戻す
        if (!this._replay) {
            window.BgmManager?.unduck()
            this.hidePauseOverlay()
        }

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
            this._vsMarginTimer = this.clock.schedule(this._vsMarginTimerDuration, this._vsMarginTimerCb);
            this._vsMarginTimerStart = this.clock.now();
            this._vsMarginTimerRemaining = null;
        }

        // おじゃま降下猶予タイマーの再開（保存しておいた残り時間で再計時）
        if (this._garbageTimers && this._garbageTimers.length) {
            for (const t of this._garbageTimers) {
                if (!t.id) {
                    const rem = (t.remaining !== null && t.remaining !== undefined) ? t.remaining : t.duration;
                    t.duration = rem; // 以降のポーズ計算用に残り時間を基準にする
                    t.start = this.clock.now();
                    t.remaining = null;
                    t.id = this.clock.schedule(rem, t.cb);
                }
            }
        }

        if (!this.isTimerRunning) {
            this.startTime = this.clock.now();
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

    // タイム表示は試合のループの中（render.js の _frameUpdate）で毎フレーム行う。
    // 以前は別の rAF で回していたので、ULTRA の時間切れがフレームと別のタイミングで起きていた。
    // 呼び出し側（PRACTICE など）との互換のため名前だけ残す。
    startTimerLoop() {
        this.timerReqId = null;
        this.updateTimeDisplay();
    },

    // タイムの計算とHTMLへの反映
    updateTimeDisplay() {
        let totalMs = this.elapsedTime;
        if (this.isTimerRunning) {
            totalMs += this.clock.now() - this.startTime;
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

    // ポーズ時間を除いた実プレイ経過ms（APM/LPM・記録保存で使用）
    getActiveMs() {
        let ms = this.elapsedTime;
        if (this.isTimerRunning) ms += this.clock.now() - this.startTime;
        return ms;
    },
});
