// ─────────────────────────────────────────────
// puyo/lifecycle.js  ―  PuyoGame.prototype mixin
// ライフサイクル（初期化・開始/停止・状態リセット・画像ロード）
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(PuyoGame.prototype, {

    initGame(callback) {
        this._setupCanvas();
        this._setupStatDisplay();
        this._loadImages(() => {
            this._initActiveColors();
            this._resetState();

            this.state = 'idle';
            this._setKeyHandlers();
            this._render();
            this._warmChainTextGlyphs(); // ★ 連鎖文字フォントを事前ラスタライズ（1連鎖目のカクつき防止）
            if (callback) callback();
        });
    },

    start() {
        this.stop();
        this.initGame(() => {
            if (this.state !== 'idle') return;

            this.state = 'starting';
            // ★ カウントダウン中もDASをチャージしておく。これによりキー長押しでスタートした場合、
            //    ぷよ出現直後から（ぷよ出現前のカット処理を効かせた状態で）横移動が可能になる。
            this._startCountdownDas();
            const overlayId = this.isVersusMode
                ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-overlay` : 'versus-countdown-overlay')
                : 'countdown-overlay';
            const textElId = this.isVersusMode
                ? (this.canvasPrefix ? `${this.canvasPrefix}-countdown-text` : 'versus-countdown-text')
                : 'countdown-text';

            runCountdown(overlayId, textElId, () => {
                if (this.state !== 'starting') return;
                // START! のタイミングでBGM開始（versus は startVersusGame 側で鳴らすため除外）。
                // CPU TEST(currentMode==='test')は専用BGM、それ以外のシングル(puyo)は singleBgmKey でモード別キーに解決。
                if (!this.isVersusMode && window.BgmManager) {
                    window.BgmManager.play(this.currentMode === 'test'
                        ? 'test_bgm'
                        : window.BgmManager.singleBgmKey(this.currentMode));
                }
                this._startGameplay();
            }, null);
        });
    },

    _startGameplay() {
        this._stopCountdownDas(); // ★ カウントダウン用DASループを止めてから本編ループへ移行（DASのチャージ量は維持）
        this.state = 'playing';
        this.lastTime = performance.now();
        this._startTimer();
        this._loop();
    },

    // カウントダウン中（state==='starting'）だけ回す軽量ループ。
    // _updateDAS のみを呼び、ぷよはまだ falling ではない（_gs==='spawn'）ため、
    // _updateDAS 内の「出現前カット」分岐が働き _arrTimer は arrMs でキャップされる。
    // その結果、本編開始時には DAS がチャージ済みとなり、スタート直後から横移動できる。
    _startCountdownDas() {
        this._stopCountdownDas();
        this.lastTime = performance.now();
        const tick = () => {
            if (this.state !== 'starting') { this._countdownLoopId = null; return; }
            this._countdownLoopId = requestAnimationFrame(tick);
            const now = performance.now();
            let dt = now - this.lastTime;
            if (dt > 100) dt = 100;
            this.lastTime = now;
            this._updateDAS(dt);
            this._render();
        };
        this._countdownLoopId = requestAnimationFrame(tick);
    },

    _stopCountdownDas() {
        if (this._countdownLoopId) {
            cancelAnimationFrame(this._countdownLoopId);
            this._countdownLoopId = null;
        }
    },

    stop(keepCanvas = false) {
        this._stopTimer();
        this._stopCountdownDas(); // ★ カウントダウン用DASループが残っていれば止める
        this._removeKeyHandlers();
        this._destroyChainTextEl(); // ★ 連鎖文字の永続要素をDOMから完全に除去（リーク防止）
        // ★ keepCanvas=true または versus終了演出中フラグが立っているとき、
        //    キャンバスをクリアせず描画ループも止めない（勝者側の盤面・NEXTを残すため）
        //    また state も gameover のまま維持し、_loop() の描画継続条件を保つ
        if (!keepCanvas && !this._versusFinishing) {
            this.state = 'idle';
            this._clearCanvases(); // ★ キャンバスをクリア
            // ★ おじゃま予告のDOMクリアはこの「完全停止」経路でのみ行う。
            //    決着時の停止（keepCanvas=true／_versusFinishing）では、盤面と同じく
            //    予告もその瞬間のまま残す＝「予告を受けた状態で力尽きた」画面を保つ。
            //    次戦は _resetState が garbageQueue を空にし _lastYokokuAmount=-1 で
            //    必ず再構築するため、持ち越されることはない。
            this._clearYokokuDOM();
            if (this._loopId) {
                cancelAnimationFrame(this._loopId);
                this._loopId = null;
            }
        }
    },

    pause() {
        if (typeof isVersusCountingDown !== 'undefined' && isVersusCountingDown) return;
        if (typeof isCountingDown !== 'undefined' && isCountingDown) return;
        if (this.state !== 'playing') return;
        this.state = 'paused';
        this.isPaused = true;
        this._stopTimer();

        // マージンタイマーの停止と残り時間の保存
        if (this._vsMarginTimer) {
            clearTimeout(this._vsMarginTimer);
            this._vsMarginTimer = null;
            this._vsMarginTimerRemaining = this._vsMarginTimerDuration - (performance.now() - this._vsMarginTimerStart);
        }
    },

    resume() {
        if (this.state !== 'paused') return;
        this.state = 'playing';
        this.isPaused = false;
        this.lastTime = performance.now();

        // マージンタイマーの再開
        if (this._vsMarginTimerRemaining !== null && this._vsMarginTimerCb) {
            this._vsMarginTimerDuration = Math.max(0, this._vsMarginTimerRemaining);
            this._vsMarginTimer = setTimeout(this._vsMarginTimerCb, this._vsMarginTimerDuration);
            this._vsMarginTimerStart = performance.now();
            this._vsMarginTimerRemaining = null;
        }

        // ★ 修正箇所：再開時は this.elapsed をリセットしない
        this._timerRunning = true;
        this._timerStart = performance.now();
        this._timerTick();
        this._loop();
    },

    _initActiveColors() {
        const allColors = [1, 2, 3, 4, 5];
        for (let i = allColors.length - 1; i > 0; i--) {
            const j = Math.floor(this._random() * (i + 1));
            [allColors[i], allColors[j]] = [allColors[j], allColors[i]];
        }
        this.activeColors = allColors.slice(0, PConfig.colorCount);
    },

    // ★ 追加: キャンバスを明示的にクリア
    _clearCanvases() {
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        if (this.nextCtx && this.nextCanvas) {
            this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
        }
    },

    // ★ 追加: resetField() - stopAllGames()からのリセット要求に対応
    resetField() {
        this._clearCanvases();
        this._resetState();
    },

    _resetState() {
        this._initField();
        this._initNextQueue();
        this._initOjamaYokokuDOM();

        this.score = 0;
        this.chainMax = 0;
        this.chainCount = 0;
        this.clearedPuyos = 0;
        this.chainScoreAdd = 0;
        this.chainScoreStr = "";

        this.attackScore = 0;
        this.generatedOjamaTotal = 0;
        this.pendingFire = 0;

        // ★ ぷよ→テト変換用変数のリセット
        this.tetAttackCarry = 0;
        this.tetAttackLines = 0;
        this.tetPendingFire = 0;
        this.tetDropScore = 0;
        this.hasTetZenkeshi = false;

        this.garbageQueue = [];
        this._lastYokokuAmount = -1; // ★ おじゃま予告の差分更新キャッシュ（-1=未描画でリセット時に必ず再構築）
        this.ojamaUpdateQueue = [];
        this.sentGarbageThisTurn = [];
        this.hasDroppedOjamaThisTurn = false;

        this.elapsed = 0;
        this._gs = 'spawn';
        this.isPaused = false;

        // VS設定：マージンタイム管理
        // ぷよのマージンは vsMarginMultiplier ではなく vsOjamaRate をテーブルで段階的に下げる方式
        // テーブル: マージン突入から16秒ごとに [52, 34, 25, 16, 12, 8, 6, 4, 3, 2, 1] へ移行（160秒で上限）
        this.vsMarginMultiplier = 1.0; // ぷよ側では常に1.0固定（テト側との互換のため残す）
        this._puyoMarginStep = 0;      // 現在のマージンステップ（0=突入直後の最初値適用済み）
        if (this._vsMarginTimer) { clearTimeout(this._vsMarginTimer); this._vsMarginTimer = null; }
        this._vsMarginTimerStart = 0;
        this._vsMarginTimerDuration = 0;
        this._vsMarginTimerCb = null;
        this._vsMarginTimerRemaining = null;

        if (this.isVersusMode && typeof this.vsMarginTimeMs === 'number' && this.vsMarginTimeMs !== null) {
            const PUYO_MARGIN_RATE_TABLE = [52, 34, 25, 16, 12, 8, 6, 4, 3, 2, 1];
            const PUYO_MARGIN_INTERVAL_MS = 16000; // 16秒ごとにステップアップ
            const PUYO_MARGIN_MAX_STEP = PUYO_MARGIN_RATE_TABLE.length - 1; // 上限ステップ(10, レート1)
            // preElapsedMs: マージン突入時点で「すでに経過したものとして扱う」ミリ秒数。
            // 負のマージンタイムで、テーブルを進めた状態でVSを開始するために使う。
            const startMargin = (preElapsedMs = 0) => {
                if (!this.isVersusMode) return;
                // 事前経過ぶんステップを進めた状態で突入（上限はクランプ）
                this._puyoMarginStep = Math.min(
                    Math.floor(preElapsedMs / PUYO_MARGIN_INTERVAL_MS),
                    PUYO_MARGIN_MAX_STEP
                );
                this.vsOjamaRate = PUYO_MARGIN_RATE_TABLE[this._puyoMarginStep];
                const step = () => {
                    this._puyoMarginStep++;
                    if (this._puyoMarginStep < PUYO_MARGIN_RATE_TABLE.length) {
                        this.vsOjamaRate = PUYO_MARGIN_RATE_TABLE[this._puyoMarginStep];
                    }
                    // 上限（ステップ10, レート1）未満なら次のタイマーをセット
                    if (this._puyoMarginStep < PUYO_MARGIN_MAX_STEP) {
                        this._vsMarginTimer = setTimeout(step, PUYO_MARGIN_INTERVAL_MS);
                        this._vsMarginTimerStart = performance.now();
                        this._vsMarginTimerDuration = PUYO_MARGIN_INTERVAL_MS;
                        this._vsMarginTimerCb = step;
                    } else {
                        this._vsMarginTimer = null;
                    }
                };
                if (this._puyoMarginStep < PUYO_MARGIN_MAX_STEP) {
                    // 次ステップまでの残り（事前経過がステップ境界に満たない端数を差し引く）
                    const nextDelay = PUYO_MARGIN_INTERVAL_MS - (preElapsedMs % PUYO_MARGIN_INTERVAL_MS);
                    this._vsMarginTimer = setTimeout(step, nextDelay);
                    this._vsMarginTimerStart = performance.now();
                    this._vsMarginTimerDuration = nextDelay;
                    this._vsMarginTimerCb = step;
                } else {
                    this._vsMarginTimer = null;
                }
            };
            if (this.vsMarginTimeMs === 0) {
                startMargin();
            } else if (this.vsMarginTimeMs < 0) {
                startMargin(-this.vsMarginTimeMs); // 負=テーブルを進めた状態で即突入
            } else {
                this._vsMarginTimer = setTimeout(startMargin, this.vsMarginTimeMs);
                this._vsMarginTimerStart = performance.now();
                this._vsMarginTimerDuration = this.vsMarginTimeMs;
                this._vsMarginTimerCb = startMargin;
            }
        }

        this.splitPuyo = null;
        this._erasingCells = null;
        this._eraseTimer = 0;
        this.eraseWaitTimer = 0;
        this._dropAnim = null;
        this._clearChainTextDOM();

        this.pendingChainGroups = null;
        this.moveLockCount = 0;

        this.isAllClear = false; // ★ 全消し表示フラグをリセット

        this._versusFinishing = false; // ★ versus終了演出中フラグをリセット

        this._dasDir = 0;
        this._dasTimer = 0;
        this._arrTimer = 0;
        this._keys = {};
        this._priorityMove = false;
        this.quickTurnCount = 0;
        this.spawnAnimTimer = 0;
        this.inputBuffer = [];

        this.activeAnims = [];
        this.lastRotationInfo = null;
        this.fixAnimTimer = 0;
        this.fixAnimDuration = 0;
        this.fw5fTimer = 0;

        this._updateScoreDisplay();
        this._updateTimeDisplay(0);
        this._updateChainDisplay(0);
        this._updateOjamaYokoku();
    },

    _setupCanvas() {
        const mainId = this.canvasPrefix ? `${this.canvasPrefix}-puyo-main-canvas` : 'puyo-main-canvas';
        const nextId = this.canvasPrefix ? `${this.canvasPrefix}-puyo-next-canvas` : 'puyo-next-canvas';

        this.canvas = document.getElementById(mainId);
        this.nextCanvas = document.getElementById(nextId);
        if (!this.canvas) return;

        this.canvas.width = 320;
        this.canvas.height = 656;
        this.ctx = this.canvas.getContext('2d');

        if (this.nextCanvas) {
            this.nextCanvas.width = 128;
            this.nextCanvas.height = 259;
            this.nextCtx = this.nextCanvas.getContext('2d');
        }
    },

    _setupStatDisplay() {
        const prefix = this.canvasPrefix ? `${this.canvasPrefix}-` : '';
        this.scoreEl = document.getElementById(`${prefix}score-value`);
        this.timeEl = document.getElementById(`${prefix}time-value`);
        this.linesEl = document.getElementById(`${prefix}lines-value`);
        this.levelEl = document.getElementById(`${prefix}level-value`);
    },

    _loadImages(callback) {
        // ★ 画像は全インスタンスで共有する（クラス静的プロパティ）。
        // 　 実体のロードは静的 PuyoGame.preloadImages に委譲する。起動時に先読み済み
        // 　 ならここで即座に callback() が呼ばれ、new Image()→onload の遅延を回避できる。
        PuyoGame.preloadImages(() => {
            this._images = PuyoGame._sharedImages;
            this._imagesLoaded = true;
            callback();
        });
    },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 画像プリロード（静的）
//    全インスタンス共有のクラス静的キャッシュ（PuyoGame._sharedImages）を1回だけ生成する。
//    起動時（window.onload）に裏で先読みしておくと、初回 start() の画像待ちが消える。
//    ・ロード済み      → 即 callback
//    ・ロード中        → 完了待ちキューに callback を積む（先読みと初回 start() の二重ロード防止）
//    ・未ロード        → 全画像をロードして静的プロパティへ保存
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PuyoGame.preloadImages = function (callback) {
    if (PuyoGame._sharedImagesLoaded) {
        if (callback) callback();
        return;
    }
    if (PuyoGame._sharedImagesLoading) {
        if (callback) PuyoGame._sharedImagesPending.push(callback);
        return;
    }
    PuyoGame._sharedImagesLoading = true;
    PuyoGame._sharedImagesPending = callback ? [callback] : [];

    // おじゃま予告アイコンも併せて先読みする（盤面ぷよ画像と同じ扱い）。
    // gameplay 描画には不要なので start() の callback ゲートには含めず fire-and-forget。
    PuyoGame.preloadOjamaImages();

    // ベース画像（おじゃま含む6色）
    const baseTargets = ['puyo-0', 'puyo-1', 'puyo-2', 'puyo-3', 'puyo-4', 'puyo-5'];

    // ★ 連結用画像キー
    // puyo-x_1  : 1方向（右向き基準）
    // puyo-x_2a : 2方向直角（右+下基準）
    // puyo-x_2b : 2方向直線（右+左基準、つまり左右）
    // puyo-x_3  : 3方向（右+上+下基準）
    // puyo-x_4  : 4方向（全方向）
    // ※ x は色インデックス 0〜4（おじゃまぷよ=color6 は連結対象外）
    const connectSuffixes = ['_1', '_2a', '_2b', '_3', '_4'];
    const connectTargets = [];
    for (let i = 0; i <= 4; i++) {
        for (const suffix of connectSuffixes) {
            connectTargets.push(`puyo-${i}${suffix}`);
        }
    }

    const targets = [...baseTargets, ...connectTargets];
    let remaining = targets.length;
    // ロード用の一時オブジェクト（完了後にクラス静的プロパティへ昇格）
    const sharedImages = {};
    targets.forEach(key => {
        const img = new Image();
        const done = () => {
            remaining--;
            if (remaining <= 0) {
                // ★ ロード完了：クラス静的プロパティへ保存し、以降の全インスタンスで再利用
                PuyoGame._sharedImages = sharedImages;
                PuyoGame._sharedImagesLoaded = true;
                PuyoGame._sharedImagesLoading = false;
                const pending = PuyoGame._sharedImagesPending;
                PuyoGame._sharedImagesPending = [];
                pending.forEach(cb => cb());
            }
        };
        img.onload = done;
        img.onerror = done;
        img.src = PConfig.imagePath + key + '.png';
        // ★ ピクセルデコードを前倒しし、各画像が初めて drawImage される瞬間の
        //   同期デコードによるカクつきを防ぐ（おじゃまアイコンと同じ手法）。
        //   連結画像（puyo-x_1/_2a/...）は色×形が初登場するたびに点々とスパイクを
        //   出すため、起動時にまとめて潰しておく。失敗は無視（onload/onerror で done 済み）。
        if (img.decode) img.decode().catch(() => {});
        sharedImages[key] = img;
    });
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ おじゃま予告アイコンのプリロード（静的）
//    予告表示（_updateOjamaYokoku）は更新が頻繁で、都度 <img> を作ると再fetch/再デコードが
//    走りカクつきの原因になる。盤面ぷよ画像と同様に、デコード済み Image を一度だけ用意して
//    PuyoGame._sharedOjamaImages にキャッシュし、表示時は cloneNode で使い回す。
//    ※ アイコン名は _updateOjamaYokoku の units[].img と一致させること。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PuyoGame.preloadOjamaImages = function () {
    if (PuyoGame._sharedOjamaImages) return; // 先読み済み
    const names = ['comet', 'crown', 'moon', 'star', 'rock', 'big', 'small'];
    const cache = {};
    names.forEach(name => {
        const img = new Image();
        img.src = PConfig.ojamaImagePath + name + '.png';
        // デコードを前倒しして初回表示時の同期デコードを避ける（失敗は無視）
        if (img.decode) img.decode().catch(() => {});
        cache[name] = img;
    });
    PuyoGame._sharedOjamaImages = cache;
};
