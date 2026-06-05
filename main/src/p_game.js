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

    initGame(callback) {
        this._setupCanvas();
        this._setupStatDisplay();
        this._loadImages(() => {
            this._initActiveColors();
            this._resetState();

            this.state = 'idle';
            this._setKeyHandlers();
            this._render();
            if (callback) callback();
        });
    }

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
    }

    _startGameplay() {
        this._stopCountdownDas(); // ★ カウントダウン用DASループを止めてから本編ループへ移行（DASのチャージ量は維持）
        this.state = 'playing';
        this.lastTime = performance.now();
        this._startTimer();
        this._loop();
    }

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
    }

    _stopCountdownDas() {
        if (this._countdownLoopId) {
            cancelAnimationFrame(this._countdownLoopId);
            this._countdownLoopId = null;
        }
    }

    stop(keepCanvas = false) {
        this._stopTimer();
        this._stopCountdownDas(); // ★ カウントダウン用DASループが残っていれば止める
        this._removeKeyHandlers();
        this._clearChainTextDOM();
        this._clearYokokuDOM(); // ★ おじゃま予告をDOMからクリアする
        // ★ keepCanvas=true または versus終了演出中フラグが立っているとき、
        //    キャンバスをクリアせず描画ループも止めない（勝者側の盤面・NEXTを残すため）
        //    また state も gameover のまま維持し、_loop() の描画継続条件を保つ
        if (!keepCanvas && !this._versusFinishing) {
            this.state = 'idle';
            this._clearCanvases(); // ★ キャンバスをクリア
            if (this._loopId) {
                cancelAnimationFrame(this._loopId);
                this._loopId = null;
            }
        }
    }

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
    }

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
    }

    _initActiveColors() {
        const allColors = [1, 2, 3, 4, 5];
        for (let i = allColors.length - 1; i > 0; i--) {
            const j = Math.floor(this._random() * (i + 1));
            [allColors[i], allColors[j]] = [allColors[j], allColors[i]];
        }
        this.activeColors = allColors.slice(0, PConfig.colorCount);
    }

    // ★ 追加: キャンバスを明示的にクリア
    _clearCanvases() {
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        if (this.nextCtx && this.nextCanvas) {
            this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
        }
    }

    // ★ 追加: resetField() - stopAllGames()からのリセット要求に対応
    resetField() {
        this._clearCanvases();
        this._resetState();
    }

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
            const startMargin = () => {
                if (!this.isVersusMode) return;
                // マージン突入直後：ステップ0のレートを即時適用
                this._puyoMarginStep = 0;
                this.vsOjamaRate = PUYO_MARGIN_RATE_TABLE[0];
                const step = () => {
                    this._puyoMarginStep++;
                    if (this._puyoMarginStep < PUYO_MARGIN_RATE_TABLE.length) {
                        this.vsOjamaRate = PUYO_MARGIN_RATE_TABLE[this._puyoMarginStep];
                    }
                    // 上限（ステップ10, レート1）未満なら次のタイマーをセット
                    if (this._puyoMarginStep < PUYO_MARGIN_RATE_TABLE.length - 1) {
                        this._vsMarginTimer = setTimeout(step, 16000);
                        this._vsMarginTimerStart = performance.now();
                        this._vsMarginTimerDuration = 16000;
                        this._vsMarginTimerCb = step;
                    } else {
                        this._vsMarginTimer = null;
                    }
                };
                // ステップ0適用後、16秒後にステップ1へ
                this._vsMarginTimer = setTimeout(step, 16000);
                this._vsMarginTimerStart = performance.now();
                this._vsMarginTimerDuration = 16000;
                this._vsMarginTimerCb = step;
            };
            if (this.vsMarginTimeMs === 0) {
                startMargin();
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
    }

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
    }

    _setupStatDisplay() {
        const prefix = this.canvasPrefix ? `${this.canvasPrefix}-` : '';
        this.scoreEl = document.getElementById(`${prefix}score-value`);
        this.timeEl = document.getElementById(`${prefix}time-value`);
        this.linesEl = document.getElementById(`${prefix}lines-value`);
        this.levelEl = document.getElementById(`${prefix}level-value`);
    }

    _loadImages(callback) {
        // ★ 画像は全インスタンスで共有する（クラス静的プロパティ）
        // 　 2回目以降の initGame / start では即座に callback() を呼ぶことで
        // 　 new Image() → onload の非同期サイクルによる約200msの遅延を解消する
        if (PuyoGame._sharedImagesLoaded) {
            this._images = PuyoGame._sharedImages;
            this._imagesLoaded = true;
            callback();
            return;
        }

        // ─── 初回のみ：全画像をロードしてクラス静的プロパティに保存 ───

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
        // 初回ロード用の一時オブジェクト（完了後にクラス静的プロパティへ昇格）
        const sharedImages = {};
        targets.forEach(key => {
            const img = new Image();
            const done = () => {
                remaining--;
                if (remaining <= 0) {
                    // ★ ロード完了：クラス静的プロパティへ保存し、以降の全インスタンスで再利用
                    PuyoGame._sharedImages = sharedImages;
                    PuyoGame._sharedImagesLoaded = true;
                    this._images = sharedImages;
                    this._imagesLoaded = true;
                    callback();
                }
            };
            img.onload = done;
            img.onerror = done;
            img.src = PConfig.imagePath + key + '.png';
            sharedImages[key] = img;
        });
    }

    // ══════════════════════════════════════════════
    // ★ 連結描画ヘルパー
    // ══════════════════════════════════════════════

    /**
     * フィールド座標 (c, r) のぷよが盤面固定されている（連結表示が有効な）状態かどうかを返す
     * 有効：checkErase / erasing / eraseWait（盤面静止中・消去点滅中）
     * 無効：falling / splitting / fixAnim / fixWait5f / dropping / spawnAnim / spawn（操作中・落下中・振動中）
     */
    _isConnectMode() {
        return (
            this._gs === 'checkErase' ||
            this._gs === 'erasing' ||
            this._gs === 'eraseWait' ||
            this._gs === 'dropping'   // ★ 消去後の落下アニメ中（宙浮き期間）も連結有効
        );
    }

    /**
     * フィールド座標 (c, r) のぷよについて上下左右の同色隣接を調べ、
     * 連結画像キー（例: 'puyo-1_2a'）と回転角（ラジアン）を返す。
     * 連結画像を使用しない場合は null を返す。
     *
     * 画像の初期配置（基準方向）: 右向き (x+ 方向)
     * 回転方向: 時計回り（canvas の rotate は時計回りが正）
     *
     * @param {number} c - フィールド列（0〜cols-1）
     * @param {number} r - フィールド行（表示用 0〜rows-1）
     * @param {number} color - ぷよの色（1〜5、6=おじゃまは対象外）
     * @param {boolean} isVibrating - 振動アニメ中かどうか
     * @returns {{ key: string, angle: number } | null}
     */
    _getConnectImageInfo(c, r, color, isVibrating) {
        // ★ 修正：_isConnectMode()の条件を外し、盤面に固定されているぷよは常に連結表示させるようにしました。
        // おじゃまぷよ(color=6)・振動中は連結画像を使わない
        // if (color === 6 || isVibrating || !this._isConnectMode()) return null;
        if (color === 6 || isVibrating) return null;

        const fr = r + PConfig.hiddenRows; // field 配列インデックス

        // 各方向に同色のぷよが隣接しているか判定
        // right=右(+c), down=下(+r), left=左(-c), up=上(-r)
        const checkSame = (dc, dr) => {
            const nc = c + dc;
            const nr = fr + dr;
            if (nc < 0 || nc >= PConfig.cols) return false;
            if (nr < PConfig.hiddenRows || nr >= PConfig.rows + PConfig.hiddenRows) return false;
            if (this.field[nr][nc] !== color) return false;
            // ★ 隣のセルが振動アニメ中（設置直後）なら連結を待機する
            // 　 自分が振動中でないのに隣が振動中の場合、タイミングをそろえるため連結しない
            const neighborIsVibrating = this.activeAnims.some(a => a.fr === nr && a.c === nc);
            if (neighborIsVibrating) return false;
            return true;
        };

        const R = checkSame(1, 0); // 右
        const D = checkSame(0, 1); // 下
        const L = checkSame(-1, 0); // 左
        const U = checkSame(0, -1); // 上

        const count = (R ? 1 : 0) + (D ? 1 : 0) + (L ? 1 : 0) + (U ? 1 : 0);
        const imageIndex = color - 1;

        if (count === 0) {
            // 単体 → 通常画像（連結なし）
            return null;
        }

        if (count === 4) {
            // 全方向連結
            return { key: `puyo-${imageIndex}_4`, angle: 0 };
        }

        if (count === 3) {
            // 3方向連結：欠けている方向が画像の「後ろ」になるよう回転
            // 画像基準：右+上+下（左が欠け）→ 欠け=左のとき angle=0
            // 欠け=下のとき、基準画像を反時計回り90° (右+左+上)
            // 欠け=右のとき 180°
            // 欠け=上のとき 270°
            let angle = 0;
            if (!L) angle = 0;           // 欠け=左
            else if (!U) angle = Math.PI / 2; // 欠け=上
            else if (!R) angle = Math.PI;     // 欠け=右
            else angle = -Math.PI / 2;// 欠け=下
            return { key: `puyo-${imageIndex}_3`, angle };
        }

        if (count === 2) {
            if ((R && L) || (U && D)) {
                // 直線2方向 (2b): 左右 or 上下
                // 画像基準：上下接続（垂直）→ angle=0
                const angle = (L && R) ? Math.PI / 2 : 0;
                return { key: `puyo-${imageIndex}_2b`, angle };
            } else {
                // 直角2方向 (2a): 4パターン
                // 画像基準：右+上（右下コーナー）→ angle=0
                let angle = 0;
                if (R && U) angle = 0;            // 右+上
                else if (D && R) angle = Math.PI / 2;  // 下+右
                else if (L && D) angle = Math.PI;      // 左+下
                else angle = -Math.PI / 2; // 上+左
                return { key: `puyo-${imageIndex}_2a`, angle };
            }
        }

        if (count === 1) {
            // 1方向連結：画像基準=上向き
            let angle = 0;
            if (U) angle = 0;            // 上
            else if (R) angle = Math.PI / 2;  // 右
            else if (D) angle = Math.PI;      // 下
            else angle = -Math.PI / 2; // 左
            return { key: `puyo-${imageIndex}_1`, angle };
        }

        return null;
    }

    /**
     * ★ 宙に浮いているぷよ（_dropAnim内）の連結画像情報取得
     * eraseWait中のみ元の座標（fromR, c）を参照して連結を維持し、droppingになったら連結を切る
     */
    _getDropConnectImageInfo(targetC, targetFromR, color) {
        if (color === 6 || this._gs !== 'eraseWait') return null;

        const checkSame = (dc, dr) => {
            const nc = targetC + dc;
            const nr = targetFromR + dr;

            if (!this._dropAnim) return false;
            const colData = this._dropAnim.find(col => col.c === nc);
            if (!colData) return false;
            const cell = colData.cells.find(c => c.fromR === nr);
            if (!cell) return false;
            return cell.color === color;
        };

        const R = checkSame(1, 0); // 右
        const D = checkSame(0, 1); // 下
        const L = checkSame(-1, 0); // 左
        const U = checkSame(0, -1); // 上

        const count = (R ? 1 : 0) + (D ? 1 : 0) + (L ? 1 : 0) + (U ? 1 : 0);
        const imageIndex = color - 1;

        if (count === 0) return null;

        if (count === 4) return { key: `puyo-${imageIndex}_4`, angle: 0 };

        if (count === 3) {
            let angle = 0;
            if (!L) angle = 0;
            else if (!U) angle = Math.PI / 2;
            else if (!R) angle = Math.PI;
            else angle = -Math.PI / 2;
            return { key: `puyo-${imageIndex}_3`, angle };
        }

        if (count === 2) {
            if ((R && L) || (U && D)) {
                const angle = (L && R) ? Math.PI / 2 : 0;
                return { key: `puyo-${imageIndex}_2b`, angle };
            } else {
                let angle = 0;
                if (R && U) angle = 0;
                else if (D && R) angle = Math.PI / 2;
                else if (L && D) angle = Math.PI;
                else angle = -Math.PI / 2;
                return { key: `puyo-${imageIndex}_2a`, angle };
            }
        }

        if (count === 1) {
            let angle = 0;
            if (U) angle = 0;
            else if (R) angle = Math.PI / 2;
            else if (D) angle = Math.PI;
            else angle = -Math.PI / 2;
            return { key: `puyo-${imageIndex}_1`, angle };
        }

        return null;
    }

    // ══════════════════════════════════════════════
    // 対戦・おじゃま通信 API (tet互換)
    // ══════════════════════════════════════════════

    get pendingOjama() {
        return this.garbageQueue.reduce((sum, g) => sum + g.amount, 0);
    }

    _initOjamaYokokuDOM() {
        const canvasId = this.canvasPrefix ? `${this.canvasPrefix}-puyo-main-canvas` : 'puyo-main-canvas';
        const canvas = document.getElementById(canvasId);
        if (!canvas || !canvas.parentNode) return;

        let containerId = `${canvasId}-ojama-yokoku`;
        this.yokokuContainer = document.getElementById(containerId);

        if (!this.yokokuContainer) {
            this.yokokuContainer = document.createElement('div');
            this.yokokuContainer.id = containerId;
            this.yokokuContainer.style.position = 'absolute';
            // ★ フィールドに重ならないようにキャンバスの左上に表示
            this.yokokuContainer.style.top = '-72px';
            this.yokokuContainer.style.left = '0';
            this.yokokuContainer.style.width = '100%';
            this.yokokuContainer.style.display = 'flex';
            this.yokokuContainer.style.justifyContent = 'flex-start';
            this.yokokuContainer.style.alignItems = 'baseline';
            this.yokokuContainer.style.gap = '2px';
            this.yokokuContainer.style.fontFamily = '"Orbitron", monospace';
            this.yokokuContainer.style.fontWeight = '900';
            this.yokokuContainer.style.pointerEvents = 'none';
            this.yokokuContainer.style.zIndex = '20';

            canvas.parentNode.style.position = 'relative';
            canvas.parentNode.style.overflow = 'visible';
            canvas.parentNode.appendChild(this.yokokuContainer);
        }
    }

    _updateOjamaYokoku() {
        if (!this.yokokuContainer) this._initOjamaYokokuDOM();
        if (!this.yokokuContainer) return;
        this.yokokuContainer.innerHTML = '';

        let amount = this.pendingOjama;
        if (amount <= 0) return;

        // ★ 桁ごとに色とサイズを変更して描画する
        const units = [
            { val: 1440, color: '#00e5ff', size: '64px' }, // 水色
            { val: 720, color: '#ff8c00', size: '48px' }, // オレンジ
            { val: 360, color: '#ffd700', size: '48px' }, // 黄色
            { val: 180, color: '#ffd700', size: '48px' }, // 黄色
            { val: 30, color: '#ff0000', size: '48px' }, // 赤
            { val: 6, color: '#ffffff', size: '48px' }, // 白
            { val: 1, color: '#ffffff', size: '36px' }  // 小白
        ];

        let started = false;
        for (let u of units) {
            let q = Math.floor(amount / u.val);
            amount = amount % u.val;
            if (q > 0 || started) {
                started = true;
                let span = document.createElement('span');
                span.textContent = q;
                span.style.color = u.color;
                span.style.fontSize = u.size;
                span.style.lineHeight = '0.85';
                span.style.textShadow = `0 0 4px #000, 0 0 8px ${u.color}, 2px 2px 0 #000`;
                this.yokokuContainer.appendChild(span);
            }
        }
    }

    receiveOjama(amount) {
        this.garbageQueue.push({ amount: amount, holes: [], ready: true });
        this.updateGarbageGauge();
    }

    receiveGarbage(amount) {
        this.receiveOjama(amount);
    }

    updateGarbageGauge() {
        this._updateOjamaYokoku();
    }

    offsetGarbage(amount) { return amount; }
    applyGarbage() { }

    sendGarbage(amount) {
        if (!this.isVersusMode) return;
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        if (!opponent || amount <= 0) return;

        // ── 注意：火力補正乗率は _applyOjamaOffset の入口で実効火力として計算済み。ここでは再計算しない ──

        const holes = [];
        let prevHole = -1;
        for (let i = 0; i < amount; i++) {
            let holeX;
            if (i === 0) {
                holeX = Math.floor(Math.random() * PConfig.cols);
            } else {
                if (Math.random() < 0.7) {
                    holeX = prevHole;
                } else {
                    const offset = Math.floor(Math.random() * (PConfig.cols - 1)) + 1;
                    holeX = (prevHole + offset) % PConfig.cols;
                }
            }
            holes.push(holeX);
            prevHole = holeX;
        }

        // 常に1段階目(ready: false)として送る
        const garbageObj = { amount: amount, holes: holes, ready: false };
        opponent.garbageQueue.push(garbageObj);

        // 自分が送った火力をリストに保持しておく
        this.sentGarbageThisTurn.push(garbageObj);

        if (typeof opponent.updateGarbageGauge === 'function') {
            opponent.updateGarbageGauge();
        }
    }

    _confirmSentGarbage(isZenkeshi = false) {
        if (!this.isVersusMode) return;
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        if (!opponent) return;

        let changed = false;
        // 保持していた1段階目のおじゃまを全て2段階目(ready: true)に確定させる
        for (const g of this.sentGarbageThisTurn) {
            if (!g.ready) {
                g.ready = true;
                changed = true;
            }
        }

        // ぷよ→テトへの火力送信は_applyOjamaOffsetで処理されるため、ここでの直接送信は行わない

        // 一連の連鎖が終了したため端数処理（仕様通り：最後の端数をmod70で次ターンへ持ち越す）
        this.tetAttackCarry = this.tetAttackCarry % (this.vsOjamaRate ?? PConfig.ojamaRate);

        if (isZenkeshi) {
            this.hasTetZenkeshi = true; // ★ 全消しボーナスの2ライン送付フラグを立てる
        }

        this.tetAttackLines = 0;
        this.tetDropScore = 0; // 落下点数は連鎖終了時にリセット（次ツモから新たに積む）
        this.sentGarbageThisTurn = []; // クリア

        if (changed && typeof opponent.updateGarbageGauge === 'function') {
            opponent.updateGarbageGauge();
        }
    }

    _applyOjamaOffset(amount, tetAmount = 0) {
        if (amount <= 0 && tetAmount <= 0) return;

        // ── VS設定：火力補正乗率を「実効火力」としてここで一度だけ計算する ──
        // 相殺（garbageQueueの減算）と送信（sendGarbage）の両方に同じ実効値を使用する
        const _vsMult = (this.vsAttackMultiplier ?? 1.0) * (this.vsMarginMultiplier ?? 1.0);
        const effectiveAmount    = (this.isVersusMode && amount    > 0) ? Math.max(1, Math.floor(amount    * _vsMult)) : amount;
        const effectiveTetAmount = (this.isVersusMode && tetAmount > 0) ? Math.max(1, Math.floor(tetAmount * _vsMult)) : tetAmount;

        const originalAmount = effectiveAmount; // 相殺前の実効ぷよ火力

        // 相殺はまず確定(ready: true)しているおじゃまから優先して行う
        let remaining = effectiveAmount;
        for (let i = 0; i < this.garbageQueue.length && remaining > 0; i++) {
            if (this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                if (this.garbageQueue[i].amount <= remaining) {
                    remaining -= this.garbageQueue[i].amount;
                    this.garbageQueue[i].amount = 0;
                } else {
                    this.garbageQueue[i].amount -= remaining;
                    remaining = 0;
                }
            }
        }

        // 次に未確定(ready: false)のおじゃまを相殺する
        for (let i = 0; i < this.garbageQueue.length && remaining > 0; i++) {
            if (!this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                if (this.garbageQueue[i].amount <= remaining) {
                    remaining -= this.garbageQueue[i].amount;
                    this.garbageQueue[i].amount = 0;
                } else {
                    this.garbageQueue[i].amount -= remaining;
                    remaining = 0;
                }
            }
        }

        this.garbageQueue = this.garbageQueue.filter(g => g.amount > 0);
        this.updateGarbageGauge();

        // ★ 相殺結果の送信処理（実効値 remaining / effectiveTetAmount を使う。sendGarbage 内で再計算しない）
        const _isOppTet = (() => {
            if (!this.isVersusMode) return false;
            const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
            if (!opponent) return false;
            return !(opponent instanceof PuyoGame) && (typeof opponent.gameOver === 'function');
        })();

        if (_isOppTet) {
            // 相手がテトの場合、effectiveTetAmount（テト用の実効ライン数）を送信する。
            // ぷよ火力が相殺で減った場合は、その割合に応じて送信する tetAmount も減らす。
            if (originalAmount > 0) {
                let ratio = remaining / originalAmount; // 残った割合 (0.0 〜 1.0)
                let sendTetAmount = Math.ceil(effectiveTetAmount * ratio);
                if (sendTetAmount > 0) {
                    this.sendGarbage(sendTetAmount);
                }
            } else if (effectiveTetAmount > 0 && remaining === 0) {
                this.sendGarbage(effectiveTetAmount);
            }
        } else {
            // 相手がぷよの場合、残った実効ぷよ基準の火力を送る
            if (remaining > 0) {
                this.sendGarbage(remaining);
            }
        }
    }

    _generateOjama() {
        let drop = 0;
        let limit = 30;

        // 降るおじゃまは、2段階目(ready: true)になっているもののみ
        for (let i = 0; i < this.garbageQueue.length && drop < limit; i++) {
            if (this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                let take = Math.min(this.garbageQueue[i].amount, limit - drop);
                this.garbageQueue[i].amount -= take;
                drop += take;
            }
        }

        this.garbageQueue = this.garbageQueue.filter(g => g.amount > 0);
        this.updateGarbageGauge();

        if (drop <= 0) return false;

        let rows = Math.floor(drop / PConfig.cols);
        let fractions = drop % PConfig.cols;

        let targetRows = [];
        for (let i = 0; i < rows; i++) {
            targetRows.push(PConfig.hiddenRows - 1 - i);
        }

        for (let r of targetRows) {
            for (let c = 0; c < PConfig.cols; c++) {
                this.field[r][c] = 6;
            }
        }

        if (fractions > 0) {
            let r = PConfig.hiddenRows - 1 - rows;
            let cols = [0, 1, 2, 3, 4, 5];
            for (let i = cols.length - 1; i > 0; i--) {
                let j = Math.floor(this._random() * (i + 1));
                [cols[i], cols[j]] = [cols[j], cols[i]];
            }
            for (let i = 0; i < fractions; i++) {
                this.field[r][cols[i]] = 6;
            }
        }

        this._buildDropAnim();
        this._gs = 'dropping';
        this.hasDroppedOjamaThisTurn = true;
        return true;
    }

    // ══════════════════════════════════════════════
    // 以下、ゲームループ・コア処理
    // ══════════════════════════════════════════════

    _initField() {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        this.field = Array.from({ length: totalRows }, () => new Array(PConfig.cols).fill(0));
    }

    _getCell(col, row) {
        if (row <= -PConfig.hiddenRows) return 0;

        const r = row + PConfig.hiddenRows;
        if (r < 0 || r >= this.field.length) return undefined;
        if (col < 0 || col >= PConfig.cols) return undefined;
        return this.field[r][col];
    }

    _setCell(col, row, val) {
        const r = row + PConfig.hiddenRows;
        if (r < 0 || r >= this.field.length) return;
        if (col < 0 || col >= PConfig.cols) return;
        this.field[r][col] = val;
    }

    _isCellEmpty(c, r) {
        if (c < 0 || c >= PConfig.cols) return false;
        if (r >= PConfig.rows) return false;
        const val = this._getCell(c, r);
        return val === 0 || val === undefined;
    }

    _isFieldEmpty() {
        for (let r = PConfig.hiddenRows; r < this.field.length; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                if (this.field[r][c] !== 0) return false;
            }
        }
        return true;
    }

    _initNextQueue() {
        this.nextQueue = [];
        const pair1 = this._makePair();
        this.nextQueue.push(pair1);

        const usedInFirst = new Set(pair1);
        const unusedColors = this.activeColors.filter(c => !usedInFirst.has(c));
        let excludeColor = null;
        if (unusedColors.length > 0) {
            excludeColor = unusedColors[Math.floor(this._random() * unusedColors.length)];
        }

        const pair2 = this._makePair(excludeColor);
        this.nextQueue.push(pair2);

        // ★ 内部でNEXTを20まで拡張する
        while (this.nextQueue.length < 20) {
            this.nextQueue.push(this._makePair());
        }
    }

    _makePair(excludeColor = null) {
        let availableColors = this.activeColors;
        if (excludeColor !== null) {
            availableColors = this.activeColors.filter(c => c !== excludeColor);
        }
        const c1 = availableColors[Math.floor(this._random() * availableColors.length)];
        const c2 = availableColors[Math.floor(this._random() * availableColors.length)];
        return [c1, c2];
    }

    _dequeueNext() {
        const pair = this.nextQueue.shift();
        // ★ 消費後も常に20を維持する
        while (this.nextQueue.length < 20) {
            this.nextQueue.push(this._makePair());
        }
        return pair;
    }

    _spawnPuyo() {
        const pair = this._dequeueNext();

        this.pivotX = 2;
        this.pivotY = -0.5;
        this.targetRot = 0;
        this.targetAnimRot = 0;
        this.animRot = 0;
        this.pivotColor = pair[0];
        this.childColor = pair[1];

        this.fallTimer = 0;
        this.lockTimer = 0;
        this.scoreFloat = 0;
        this.quickTurnCount = 0;
        this.lastRotationInfo = null;
        this.moveLockCount = 0;

        this._priorityMove = false;
        if (this._keys[this._keyMap.softDrop] && (this._keys[this._keyMap.moveLeft] || this._keys[this._keyMap.moveRight])) {
            this._priorityMove = true;
        }

        if (!this._isCellEmpty(this.pivotX, 0)) {
            return false;
        }
        return true;
    }

    _addPuyoAnim(fr, c, cycles) {
        if (this.field[fr][c] === 6) return;

        let duration = cycles * 4 * PConfig.vibPhaseMs;
        let existing = this.activeAnims.find(a => a.fr === fr && a.c === c);
        if (existing) {
            existing.timer = 0;
            existing.duration = duration;
            existing.maxCycle = cycles;
        } else {
            this.activeAnims.push({ fr, c, timer: 0, duration, maxCycle: cycles });
        }
    }

    _calcFixCycles() {
        let isSoftDrop = this._keys[this._keyMap.softDrop];
        if (isSoftDrop && this.lastRotationInfo) {
            if (Math.round(this.pivotY) - Math.floor(this.lastRotationInfo.pivotY) <= 1) {
                return 1;
            }
        }
        return 2;
    }

    _beginFixAnimWait() {
        let maxDur = 0;
        for (let anim of this.activeAnims) {
            let remaining = anim.duration - anim.timer;
            if (remaining > maxDur) maxDur = remaining;
        }
        this.fixAnimTimer = 0;
        this.fixAnimDuration = maxDur;
        this._gs = 'fixAnim';
    }

    _loop() {
        // ★ versusモードのgameover中（_versusFinishing）は描画のみ継続（勝者側の盤面・NEXTを残すため）
        const continueForVersus = this.isVersusMode && this._versusFinishing;
        if (this.state !== 'playing' && !continueForVersus) return;
        this._loopId = requestAnimationFrame(() => this._loop());

        let now = performance.now();
        let dt = now - this.lastTime;
        if (dt > 100) dt = 100;
        this.lastTime = now;

        // ★ gameover中は _update をスキップして描画のみ行う
        if (this.state === 'playing') {
            this._update(dt);
        }
        this._render();
    }

    _update(dt) {
        this._updateDAS(dt);

        if (this.ojamaUpdateQueue.length > 0) {
            this.ojamaUpdateQueue[0].timer -= dt;
            if (this.ojamaUpdateQueue[0].timer <= 0) {
                let q = this.ojamaUpdateQueue.shift();
                this._applyOjamaOffset(q.amount, q.tetAmount || 0);
            }
        }

        for (let anim of this.activeAnims) {
            anim.timer += dt;
        }
        this.activeAnims = this.activeAnims.filter(a => a.timer < a.duration);

        switch (this._gs) {
            case 'spawn':
                if (!this._spawnPuyo()) {
                    this._gs = 'gameover';
                    this._beginGameOver();
                } else {
                    this._gs = 'falling';
                    this.hasDroppedOjamaThisTurn = false;

                    if (this.inputBuffer.length > 0) {
                        for (const action of this.inputBuffer) {
                            if (action === 'left') this._tryMove(-1);
                            else if (action === 'right') this._tryMove(1);
                            else if (action === 'cw') this._tryRotate(1);
                            else if (action === 'ccw') this._tryRotate(-1);
                        }
                        this.inputBuffer = [];
                    }
                }
                break;

            case 'falling':
                if (this.animRot !== this.targetAnimRot) {
                    const diff = this.targetAnimRot - this.animRot;
                    const speed = (1000 / PConfig.rotateDurationMs) * (dt / 1000);
                    if (Math.abs(diff) <= speed) {
                        this.animRot = this.targetAnimRot;
                    } else {
                        this.animRot += Math.sign(diff) * speed;
                    }
                }
                this._handleGravity(dt);
                break;

            case 'splitting':
                let splitDropDist = dt / PConfig.splitDropSpeed;
                this.splitPuyo.y += splitDropDist;

                let sLimit = this._calcLimitY_Single(this.splitPuyo.col, this.splitPuyo.y);

                if (this.splitPuyo.y >= sLimit) {
                    let fr_s = Math.round(sLimit) + PConfig.hiddenRows;
                    this.splitPuyo.y = sLimit;
                    this._setCell(this.splitPuyo.col, Math.round(this.splitPuyo.y), this.splitPuyo.color);

                    this._addPuyoAnim(fr_s, this.splitPuyo.col, 3);
                    // もう片方の操作ぷよが着地して固定による振動演出が起きた瞬間
                    this.playSe('puyo_fix');

                    this.splitPuyo = null;
                    this._beginFixAnimWait();
                }
                break;

            case 'fixAnim':
                this.fixAnimTimer += dt;
                if (this.fixAnimTimer >= this.fixAnimDuration) {
                    this._gs = 'fixWait5f';
                    this.fw5fTimer = 0;
                }
                break;

            case 'fixWait5f':
                this.fw5fTimer += dt;
                if (this.fw5fTimer >= PConfig.fixWait5fMs) {
                    this._gs = 'checkErase';
                }
                break;

            case 'checkErase': {
                const { groups, ojamaToErase } = this._findErasable();
                if (groups.length > 0) {
                    this.isAllClear = false; // ★ 1連鎖発生でALL CLEAR表示を消す
                    this._erasingCells = [...groups.flat(), ...ojamaToErase];
                    this._eraseTimer = 0;
                    this.chainCount++;
                    if (this.chainCount > this.chainMax) this.chainMax = this.chainCount;
                    // ※連鎖SEはここ（点滅開始時）ではなく、ぷよが消えて連鎖文字演出が出る瞬間
                    //   （erasing→eraseWait遷移で _prepareChainTextDOM 後）に鳴らす

                    this.pendingChainGroups = groups;
                    this._calcChainScore(groups);
                    this._gs = 'erasing';
                } else {
                    // 連鎖が終わった（または無かった）ときの処理

                    // 連鎖を行ったターンの最後なら、未送信の火力を送り、端数を持ち越す
                    if (this.chainCount > 0) {
                        this.attackScore = this.attackScore % (this.vsOjamaRate ?? PConfig.ojamaRate); // 端数持ち越し
                        this.generatedOjamaTotal = 0; // 送信済みおじゃま量をリセット
                        if (this.pendingFire > 0 || this.tetPendingFire > 0) {
                            this.ojamaUpdateQueue.push({
                                timer: 0,
                                amount: this.pendingFire,
                                tetAmount: this.tetPendingFire
                            });
                            this.pendingFire = 0;
                            this.tetPendingFire = 0;
                        }
                    }

                    let isZenkeshi = false;
                    // ★ その後で全消し判定を行い、全消し火力を新たに pendingFireに追加して持ち越す
                    if (this._isFieldEmpty() && this.chainCount > 0) {
                        this.score += PConfig.zenkeshiBonus; // 2100点追加

                        let zenkeshiOjama = Math.floor(PConfig.zenkeshiBonus / (this.vsOjamaRate ?? PConfig.ojamaRate));
                        this.pendingFire += zenkeshiOjama; // 連鎖後に火力スコア(pendingFire)に持ち越す

                        this._updateScoreDisplay();
                        this.isAllClear = true; // ★ ALL CLEARフラグON
                        isZenkeshi = true;
                    }

                    // おじゃまぷよ降下判定
                    if (!this.hasDroppedOjamaThisTurn && this.pendingOjama > 0) {
                        // 降る前にキューに残っている相殺・送信をすべて即時適用する
                        while (this.ojamaUpdateQueue.length > 0) {
                            let q = this.ojamaUpdateQueue.shift();
                            this._applyOjamaOffset(q.amount, q.tetAmount || 0);
                        }

                        // 降るおじゃま（ready: trueのもの）があれば降る
                        if (this.pendingOjama > 0) {
                            if (this._generateOjama()) {
                                break;
                            }
                        }
                    }

                    // ★ 連鎖が終わったタイミングでNEXTアニメーションに移る瞬間、
                    // 相手に送った火力全てに2段階目になるように情報を送る
                    this._confirmSentGarbage(isZenkeshi);

                    // ========================================================
                    // 【追加】QUIZモード：演出（spawnAnim）に入る前にクリア/失敗判定を行う
                    // ========================================================
                    if (window._quizManager && window._quizManager.currentLevel) {
                        let isQuizFinished = false;

                        // 1. QUIZ側の判定メソッドがあれば呼び出す（クリア条件などのチェック）
                        //    ※ 旧設計の checkCondition が実装された場合の互換呼び出しも残す
                        if (typeof window._quizManager.checkCondition === 'function') {
                            const quizResult = window._quizManager.checkCondition(this);
                            if (quizResult === 'clear' || quizResult === 'fail') {
                                isQuizFinished = true;
                            }
                        }

                        // 2. _checkClear() を直接呼び出してクリア条件を評価する
                        //    （quiz.js の QuizManager._checkClear は isClear/isFailed フラグを立てて
                        //     _onClear/_onFailed を発火する。既にどちらかが立っていれば重複呼び出しは無視される）
                        if (!isQuizFinished && !window._quizManager.isClear && !window._quizManager.isFailed) {
                            if (typeof window._quizManager._checkClear === 'function') {
                                isQuizFinished = window._quizManager._checkClear();
                            }
                        }

                        // 3. クリア済み or 失敗済みフラグが立っていれば演出をスキップする
                        if (!isQuizFinished) {
                            isQuizFinished = !!(window._quizManager.isClear || window._quizManager.isFailed);
                        }

                        // 4. 次のペアがダミー（color=7）なら NEXTが枯渇 → 失敗とする
                        //    （_dequeueNext の上書きでもダミー検出は行われるが、演出前に先回りして判定する）
                        if (!isQuizFinished) {
                            const nextPair = this.nextQueue[0];
                            const isDummyNext = nextPair && (nextPair[0] === 7 || nextPair[1] === 7);
                            if (isDummyNext) {
                                // _onFailed() を直接呼び出して失敗扱いにする
                                if (typeof window._quizManager._onFailed === 'function') {
                                    window._quizManager._onFailed();
                                }
                                isQuizFinished = true;
                            }
                        }

                        // 5. ネクストが完全に空なら、演出に入る前に即座に失敗（ゲームオーバー）とする
                        //    ※ 旧設計の互換コードも残す
                        if (this.nextQueue.length === 0 && !isQuizFinished) {
                            if (typeof this.gameOver === 'function') {
                                this.gameOver();
                            }
                            isQuizFinished = true;
                        }

                        // 判定によってクリアや失敗になった場合は、spawnAnim演出に進まずここで終了する
                        if (isQuizFinished || this._gs === 'clear' || this._gs === 'gameover') {
                            return;
                        }
                    }
                    // ========================================================
                    // 致命判定：NEXTアニメーション前にスポーン位置が埋まっていればゲームオーバー
                    if (!this._isCellEmpty(2, 0)) {
                        this._gs = 'gameover';
                        this._beginGameOver();
                        return;
                    }
                    this._gs = 'spawnAnim';
                    this.spawnAnimTimer = 0;
                }
                break;
            }

            case 'erasing':
                this._eraseTimer += dt;
                if (this._eraseTimer >= PConfig.eraseMs) {
                    this._applyErase();
                    this._buildDropAnim();

                    this._gs = 'eraseWait';
                    this.eraseWaitTimer = 0;

                    if (this.pendingChainGroups) {
                        this._prepareChainTextDOM(this.pendingChainGroups);
                        this.pendingChainGroups = null;

                        // 連鎖SE：ぷよが完全に消え、連鎖文字演出が出たこの瞬間に鳴らす
                        // （1〜7連鎖目で音を変え、7連鎖目以降は puyo_chain7 を共用）
                        this.playSe('puyo_chain' + Math.min(this.chainCount, 7));

                        // ★ 追加: 相手からの火力を相殺する時のみ、自分の火力が0でも最低1個だけ相殺する
                        let queuedOffset = this.ojamaUpdateQueue.reduce((sum, q) => sum + q.amount, 0);
                        let effectiveOjama = this.pendingOjama - queuedOffset;
                        if (effectiveOjama > 0 && this.pendingFire === 0) {
                            this.pendingFire = 1;
                        }

                        // ★ 連鎖表示が出たタイミングで、そこまでに溜まった微火力＋連鎖火力を0.5秒後に相殺・送信
                        // （全消しで持ち越されたpendingFireも、ここで1連鎖目として送られる）
                        if (this.pendingFire > 0 || this.tetPendingFire > 0) {
                            this.ojamaUpdateQueue.push({
                                timer: 500,
                                amount: this.pendingFire,
                                tetAmount: this.tetPendingFire
                            });
                            this.pendingFire = 0;
                            this.tetPendingFire = 0;
                        }
                    }
                }
                break;

            case 'eraseWait':
                this.eraseWaitTimer += dt;
                if (this.eraseWaitTimer >= PConfig.eraseWaitMs) {
                    if (this.chainScoreAdd > 0) {
                        this.score += this.chainScoreAdd;
                        this.chainScoreAdd = 0;
                        this._updateScoreDisplay();
                    }
                    this._clearChainTextDOM();

                    if (this._dropAnim) {
                        this._gs = 'dropping';
                    } else {
                        this._gs = 'checkErase';
                    }
                }
                break;

            case 'dropping':
                if (this._dropAnim) {
                    let allDone = true;
                    for (const col of this._dropAnim) {
                        for (const cell of col.cells) {
                            const targetY = (cell.toR - PConfig.hiddenRows) * PConfig.cellSize;
                            const speed = PConfig.cellSize / 50;
                            cell.py = Math.min(cell.py + speed * dt, targetY);
                            if (cell.py < targetY) allDone = false;
                        }
                    }
                    if (allDone) {
                        this._applyDropAnim();

                        let anyChainVib = false;
                        for (const col of this._dropAnim) {
                            for (const cell of col.cells) {
                                if (cell.color === 6) continue;
                                let dropDist = cell.toR - cell.fromR;
                                let cycles = dropDist >= 2 ? 4 : 3;
                                this._addPuyoAnim(cell.toR, col.c, cycles);
                                anyChainVib = true;
                            }
                        }
                        // 連鎖中に落ちてきたぷよが振動演出を行なった場合にも鳴らす
                        // （複数同時でもチャタリング防止により1盤面50ms間隔に間引かれる）
                        if (anyChainVib) this.playSe('puyo_fix');

                        this._dropAnim = null;
                        this._beginFixAnimWait();
                    }
                } else {
                    this._gs = 'checkErase';
                }
                break;

            case 'spawnAnim':
                this.spawnAnimTimer += dt;
                if (this.spawnAnimTimer >= PConfig.spawnAnimMs) {
                    this.chainCount = 0;
                    this._gs = 'spawn';
                }
                break;

            case 'gameover':
                break;
        }
    }

    _addDropScore(amount) {
        this.attackScore += amount;
        let totalOjama = Math.floor(this.attackScore / (this.vsOjamaRate ?? PConfig.ojamaRate));
        let newlyGenerated = totalOjama - this.generatedOjamaTotal;
        this.generatedOjamaTotal = totalOjama;
        // ★ 即座に相殺・送信せず、pendingFireに留めておく（連鎖まで保持）
        if (newlyGenerated > 0) {
            this.pendingFire += newlyGenerated;
        }
        // ★ ぷよ→テト火力変換用：落下点数を独立して記録（連鎖開始時の1連鎖目計算に使用）
        this.tetDropScore += amount;
    }

    _handleGravity(dt) {
        let isSoftDrop = this._keys[this._keyMap.softDrop];

        if (this._priorityMove) {
            let tryingMove = false;
            let canMove = false;

            if (this._keys[this._keyMap.moveLeft]) {
                tryingMove = true;
                if (this._canPlace(this.pivotX - 1, this.pivotY, this.targetRot)) canMove = true;
            }
            if (this._keys[this._keyMap.moveRight]) {
                tryingMove = true;
                if (this._canPlace(this.pivotX + 1, this.pivotY, this.targetRot)) canMove = true;
            }

            if (tryingMove && canMove) {
                isSoftDrop = false;
            } else {
                this._priorityMove = false;
            }
        }

        if (isSoftDrop) {
            let dropDist = dt / PConfig.dropSpeedFast;
            this.pivotY += dropDist;
            this.scoreFloat += dropDist;
            if (this.scoreFloat >= 1) {
                let add = Math.floor(this.scoreFloat);
                this.score += add;
                this.scoreFloat -= add;
                this._addDropScore(add);
                this._updateScoreDisplay();
            }
        } else {
            this.fallTimer += dt;
            while (this.fallTimer >= 250) {
                this.fallTimer -= 250;
                this.pivotY += 0.5;
                let lim = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);
                if (this.pivotY > lim) {
                    this.pivotY = lim;
                    break;
                }
            }
        }

        let limitY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);

        if (this.pivotY >= limitY) {
            this.pivotY = limitY;
            let lockSpeed = isSoftDrop ? 12 : 1;
            this.lockTimer += dt * lockSpeed;
            if (this.lockTimer >= PConfig.lockDelayMs) {
                this._fixPuyo();
            }
        } else {
            this.lockTimer = 0;
        }
    }

    _fixPuyo(viaQuickDrop = false) {
        // 設置音(fix.ogg)は固定時ではなく、操作ぷよが固定による「振動演出」を
        // 開始した瞬間（_addPuyoAnim 呼び出し直後）に鳴らす。2つとも対象なので
        // 分割落下する片割れの着地（splitting 着地）でも別途鳴らす。
        let pr = Math.round(this.pivotY);
        let pc = this.pivotX;
        const DC = [0, 1, 0, -1];
        const DR = [-1, 0, 1, 0];
        let cc = pc + DC[this.targetRot];
        let cr = pr + DR[this.targetRot];

        let pivotFloating = this._isCellEmpty(pc, pr + 1);
        let childFloating = this._isCellEmpty(cc, cr + 1);

        let fr_p = pr + PConfig.hiddenRows;
        let fr_c = cr + PConfig.hiddenRows;

        let cycles = this._calcFixCycles();

        if (pivotFloating && !childFloating) {
            this._setCell(cc, cr, this.childColor);
            this._addPuyoAnim(fr_c, cc, cycles);
            // 片方が固定して振動開始：クイックドロップ時は puyo_drop と重なるため避ける
            if (!viaQuickDrop) this.playSe('puyo_fix');

            this.splitPuyo = { col: pc, y: pr, color: this.pivotColor };
            this._gs = 'splitting';
        } else if (!pivotFloating && childFloating) {
            this._setCell(pc, pr, this.pivotColor);
            this._addPuyoAnim(fr_p, pc, cycles);
            // 片方が固定して振動開始：クイックドロップ時は puyo_drop と重なるため避ける
            if (!viaQuickDrop) this.playSe('puyo_fix');

            this.splitPuyo = { col: cc, y: cr, color: this.childColor };
            this._gs = 'splitting';
        } else {
            this._setCell(pc, pr, this.pivotColor);
            this._setCell(cc, cr, this.childColor);

            this._addPuyoAnim(fr_p, pc, cycles);
            this._addPuyoAnim(fr_c, cc, cycles);
            // 2つ同時に固定して振動開始：クイックドロップ時は puyo_drop と重なるため避ける
            if (!viaQuickDrop) this.playSe('puyo_fix');
            this._beginFixAnimWait();
        }
    }

    _findErasableInField(checkField) {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        const visited = Array.from({ length: totalRows }, () => new Array(PConfig.cols).fill(false));
        const groups = [];

        for (let r = PConfig.hiddenRows; r < totalRows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                if (visited[r][c]) continue;
                const color = checkField[r][c];
                if (color <= 0 || color === 6) continue;

                const group = [];
                const queue = [{ r, c }];
                visited[r][c] = true;
                while (queue.length > 0) {
                    const cur = queue.shift();
                    group.push({ r: cur.r, c: cur.c, color });
                    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
                    for (const [dr, dc] of dirs) {
                        const nr = cur.r + dr;
                        const nc = cur.c + dc;
                        if (nr < PConfig.hiddenRows || nr >= totalRows) continue;
                        if (nc < 0 || nc >= PConfig.cols) continue;
                        if (visited[nr][nc]) continue;
                        if (checkField[nr][nc] !== color) continue;

                        visited[nr][nc] = true;
                        queue.push({ r: nr, c: nc });
                    }
                }

                if (group.length >= (this.vsEraseCount ?? PConfig.eraseCount)) {
                    groups.push(group);
                }
            }
        }

        const ojamaToErase = [];
        const ojamaVisited = new Set();
        for (const group of groups) {
            for (const cell of group) {
                const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
                for (const [dr, dc] of dirs) {
                    const nr = cell.r + dr;
                    const nc = cell.c + dc;
                    if (nr < PConfig.hiddenRows || nr >= totalRows) continue;
                    if (nc < 0 || nc >= PConfig.cols) continue;

                    if (checkField[nr][nc] === 6) {
                        const key = `${nr},${nc}`;
                        if (!ojamaVisited.has(key)) {
                            ojamaVisited.add(key);
                            ojamaToErase.push({ r: nr, c: nc, color: 6 });
                        }
                    }
                }
            }
        }

        return { groups, ojamaToErase };
    }

    _findErasable() {
        return this._findErasableInField(this.field);
    }

    _getGhostEraseInfo() {
        const rot = this.targetRot;
        const limitY = this._calcLimitY(this.pivotX, this.pivotY, rot);
        const pr = Math.round(limitY);
        const pc = this.pivotX;
        const DC = [0, 1, 0, -1];
        const DR = [-1, 0, 1, 0];
        const cr = pr + DR[rot];
        const cc = pc + DC[rot];

        let fpR = pr;
        let fcR = cr;

        if (rot === 1 || rot === 3) {
            let pivotF = this._isCellEmpty(pc, pr + 1);
            let childF = this._isCellEmpty(cc, cr + 1);

            if (pivotF && !childF) {
                fpR = this._calcLimitY_Single(pc, pr);
            } else if (!pivotF && childF) {
                fcR = this._calcLimitY_Single(cc, cr);
            }
        }

        const totalRows = PConfig.rows + PConfig.hiddenRows;
        const vField = Array.from({ length: totalRows }, (_, r) => [...this.field[r]]);

        const actualPivotR = fpR + PConfig.hiddenRows;
        const actualChildR = fcR + PConfig.hiddenRows;

        if (actualPivotR >= 0 && actualPivotR < totalRows) vField[actualPivotR][pc] = this.pivotColor;
        if (actualChildR >= 0 && actualChildR < totalRows) vField[actualChildR][cc] = this.childColor;

        const { groups, ojamaToErase } = this._findErasableInField(vField);
        return {
            cells: [...groups.flat(), ...ojamaToErase]
        };
    }

    _applyErase() {
        if (!this._erasingCells) return;
        for (const { r, c } of this._erasingCells) {
            this.field[r][c] = 0;
        }
        this._erasingCells = null;
    }

    _calcChainScore(groups) {
        const cells = groups.flat();
        const n = cells.length;
        this.clearedPuyos += n;

        const chainIndex = Math.max(0, this.chainCount - 1);
        const cb = PConfig.chainBonusTable[Math.min(chainIndex, PConfig.chainBonusTable.length - 1)];

        const usedColors = new Set(cells.map(cell => cell.color));
        const colorIndex = Math.max(0, usedColors.size - 1);
        const colorB = PConfig.colorBonusTable[Math.min(colorIndex, PConfig.colorBonusTable.length - 1)];

        let groupB = 0;
        for (const group of groups) {
            const count = group.length;
            groupB += PConfig.groupBonusTable[Math.min(count, PConfig.groupBonusTable.length - 1)];
        }

        const bonus = Math.max(1, cb + colorB + groupB);
        const add = PConfig.scoreBase * n * bonus;

        this.chainScoreAdd = add;
        this.chainScoreStr = `${n * 10} × ${bonus}`;

        this.attackScore += add;
        let totalOjama = Math.floor(this.attackScore / (this.vsOjamaRate ?? PConfig.ojamaRate));
        let newlyGenerated = totalOjama - this.generatedOjamaTotal;
        this.generatedOjamaTotal = totalOjama;
        if (newlyGenerated > 0) {
            this.pendingFire += newlyGenerated;
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ★ ぷよ→テト火力変換処理（混合戦でのみ動作）
        //
        // 【処理の流れ】
        // 1連鎖目: 合計スコア = 前回最後の連鎖の持ち越し点(tetAttackCarry) + 落下点数(tetDropScore) + 1連鎖消去点(add)
        // x連鎖目: 合計スコア = x-1連鎖の持ち越し点(tetAttackCarry) + x連鎖消去点(add)
        // → スコア閾値テーブルと消去ぷよ数テーブルで火力ラインを決定
        // → 使用した閾値スコアを合計スコアから引いた端数を次連鎖へ持ち越す
        // → 連鎖終了時: 最後の端数をmod70で次ターンへ持ち越す（tetDropScoreはリセット）
        //
        // スコア閾値テーブル (lines, score): (1,210)(2,420)(3,700)(4,1120)(5,2240)(6,5320)(7,13300)
        //   ※ score は全て70の倍数。実際の閾値は (score/70)*おじゃまレート で算出しレート変動に追従
        // 消去ぷよ追加ラインテーブル (addLines, puyoCount): (1,8)(2,9)(3,12)(4,14)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const _isOpponentTet = (() => {
            if (!this.isVersusMode) return false;
            const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
            if (!opponent) return false;
            // PuyoGame インスタンスでなければテトとみなす
            return !(opponent instanceof PuyoGame) && (typeof opponent.gameOver === 'function');
        })();

        if (_isOpponentTet) {
            // ─── スコア閾値テーブル（降順）───
            const TET_ATTACK_SCORE_TABLE = [
                { lines: 7, score: 13300 },
                { lines: 6, score: 5320 },
                { lines: 5, score: 2240 },
                { lines: 4, score: 1120 },
                { lines: 3, score: 700 },
                { lines: 2, score: 420 },
                { lines: 1, score: 210 }
            ];

            // ─── 消去ぷよ数による追加ラインテーブル（降順）───
            // n個以上消去したとき、基本ライン数に追加ラインを上乗せする
            const TET_ATTACK_PUYO_TABLE = [
                { addLines: 4, count: 14 },
                { addLines: 3, count: 12 },
                { addLines: 2, count: 9 },
                { addLines: 1, count: 8 }
            ];

            // ★ 追加：テト戦の場合はぷよ側の火力をリセットして二重相殺を防ぐ
            this.pendingFire = 0;

            // 1連鎖目のみ落下点数と前回端数を加算する
            // 2連鎖目以降は前回端数（tetAttackCarry）のみ加算する
            let baseCarry = this.tetAttackCarry;
            if (this.chainCount === 1) {
                baseCarry += this.tetDropScore; // 落下点数を1連鎖目の計算に加算
                if (this.hasTetZenkeshi) {
                    baseCarry += PConfig.zenkeshiBonus; // ★ 全消しスコア(2100点)を1連鎖目に加算
                }
            }

            // 今連鎖の合計スコア A(n) = 前回端数 + 今回消去点
            let currentA = baseCarry + add;

            // ★ 追加：テト相手の特殊相殺ルール
            let pendingOjamaCount = this.pendingOjama;
            
            // ── VS設定：火力補正乗率を「実効火力スコア」としてここで計算する ──
            // ぷよ対テトの相殺のみ、ここでスコアを用いて相殺するため、乗率を適用してから計算する
            const _vsMult = (this.vsAttackMultiplier ?? 1.0) * (this.vsMarginMultiplier ?? 1.0);
            let effectiveA = currentA * _vsMult; // 相殺用の実効スコア

            let scoreForAttack = currentA; // デフォルトは全スコアを使用
            let carryOverFromOffset = 0; // 相殺しきれなかった場合の端数保持用

            if (pendingOjamaCount > 0) {
                let requiredOffsetScore = pendingOjamaCount * (this.vsOjamaRate ?? PConfig.ojamaRate);

                if (effectiveA >= requiredOffsetScore) {
                    // 相殺しきれる場合
                    this.garbageQueue = []; // おじゃまはなかったものとする
                    this.updateGarbageGauge();

                    // 意図的な仕様の復元：
                    // 持ち越した実効スコア(baseCarry)だけで相殺しきれない場合、不足分を今回の連鎖スコア(add)から引かず、
                    // addをまるごと攻撃に使う（異種戦におけるぷよの優位拡大のための仕様）
                    let effectiveBaseCarry = baseCarry * _vsMult;
                    if (effectiveBaseCarry < requiredOffsetScore) {
                        scoreForAttack = add; 
                    } else {
                        // 持ち越し実効スコアだけで相殺しきれた場合は、残った持ち越し分＋今回の連鎖スコアを使用
                        let remainingEffectiveA = effectiveA - requiredOffsetScore;
                        scoreForAttack = remainingEffectiveA / _vsMult;
                    }
                } else {
                    // 相殺しきれない場合
                    let offsetPuyoCount = Math.floor(effectiveA / (this.vsOjamaRate ?? PConfig.ojamaRate));
                    let carryOverEffectiveA = effectiveA % (this.vsOjamaRate ?? PConfig.ojamaRate); // 相殺後の端数
                    
                    // 次に持ち越す端数を元のスケールに戻す
                    carryOverFromOffset = carryOverEffectiveA / _vsMult;

                    // キューから offsetPuyoCount 分のおじゃまを減らす
                    let remainingToOffset = offsetPuyoCount;
                    // ready: true を優先
                    for (let i = 0; i < this.garbageQueue.length && remainingToOffset > 0; i++) {
                        if (this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                            let take = Math.min(this.garbageQueue[i].amount, remainingToOffset);
                            this.garbageQueue[i].amount -= take;
                            remainingToOffset -= take;
                        }
                    }
                    // ready: false を次に減らす
                    for (let i = 0; i < this.garbageQueue.length && remainingToOffset > 0; i++) {
                        if (!this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                            let take = Math.min(this.garbageQueue[i].amount, remainingToOffset);
                            this.garbageQueue[i].amount -= take;
                            remainingToOffset -= take;
                        }
                    }
                    this.garbageQueue = this.garbageQueue.filter(g => g.amount > 0);
                    this.updateGarbageGauge();

                    scoreForAttack = 0; // 攻撃には使えない
                }
            }

            // 以降のライン算出計算のために、currentA を決定された攻撃用スコアで上書きする
            currentA = scoreForAttack;

            // ─── スコア閾値で基本ライン数を決定 ───
            // TET_ATTACK_SCORE_TABLE のスコアは全て 70 の倍数（おじゃまレート70基準で設計）。
            // 実際の閾値は (基準スコア / 70) * 現在のおじゃまレート とし、マージンや
            // ユーザー設定でレートが変動した場合に追従させる（レート70なら従来と同値）。
            const _rate = (this.vsOjamaRate ?? PConfig.ojamaRate);
            let generatedLines = 0;
            let usedScore = 0;
            for (const threshold of TET_ATTACK_SCORE_TABLE) {
                const requiredScore = (threshold.score / 70) * _rate;
                if (currentA >= requiredScore) {
                    generatedLines = threshold.lines;
                    usedScore = requiredScore;
                    break;
                }
            }

            // ─── 消去ぷよ数で追加ライン数を決定 ───
            // n は今連鎖で消去したぷよ数（おじゃまぷよを含まない通常色のみ）
            let addLines = 0;
            for (const puyo of TET_ATTACK_PUYO_TABLE) {
                if (n >= puyo.count) {
                    addLines = puyo.addLines;
                    break;
                }
            }

            // 基本ラインが1以上のときのみ消去ぷよ追加ラインを適用する
            let totalLines = generatedLines;
            if (generatedLines >= 1) {
                totalLines += addLines;
            }

            // ★ 全消しボーナスによる追加ライン（2ライン）
            let zenkeshiAdded = 0;
            if (this.hasTetZenkeshi) {
                zenkeshiAdded = 2;
                totalLines += zenkeshiAdded;
                this.hasTetZenkeshi = false; // 消費
            }

            // ─── 次の連鎖への端数を保持 ───
            // 使用した閾値スコアを引いた残りを次連鎖のcarryとする
            this.tetAttackCarry = currentA - usedScore;

            // ★ 追加：相殺しきれなかった場合、計算上 currentA が 0 になり tetAttackCarry も 0 になってしまうため、相殺の余りを復元
            if (pendingOjamaCount > 0 && scoreForAttack === 0) {
                this.tetAttackCarry = carryOverFromOffset;
            }

            // (tetAttackLines は既存互換のため加算形式で残す)
            this.tetAttackLines += totalLines;

            if (totalLines > 0) {
                // n連鎖目で発生したラインを送信予定に追加
                this.tetPendingFire += totalLines;
                //console.log(`[p_game TetAttack] ${this.chainCount}連鎖: baseCarry=${baseCarry}, add=${add}, scoreForAttack=${scoreForAttack}, used=${usedScore}, scoredLines=${generatedLines}, puyoN=${n}, addLines=${addLines}, zkLines=${zenkeshiAdded}, totalLines=${totalLines}, nextCarry=${this.tetAttackCarry}, totalPending=${this.tetPendingFire}`);
            } else {
                //console.log(`[p_game TetAttack] ${this.chainCount}連鎖: baseCarry=${baseCarry}, add=${add}, scoreForAttack=${scoreForAttack}, scoredLines=0, puyoN=${n}, addLines=${addLines}, zkLines=${zenkeshiAdded}, totalLines=${totalLines}, nextCarry=${this.tetAttackCarry}, totalPending=${this.tetPendingFire}`);
            }
        }

        if (this.scoreEl) {
            this.scoreEl.style.fontSize = '18px';
            this.scoreEl.style.whiteSpace = 'nowrap';
            this.scoreEl.textContent = this.chainScoreStr;
        }
        this._updateChainDisplay(this.chainCount);
    }

    _prepareChainTextDOM(groups) {
        let bestR = -1;
        let bestC = 999;
        let candidates = [];

        for (const group of groups) {
            let maxR = -1;
            let minC = 999;
            for (const cell of group) {
                if (cell.r > maxR) {
                    maxR = cell.r;
                    minC = cell.c;
                } else if (cell.r === maxR) {
                    if (cell.c < minC) {
                        minC = cell.c;
                    }
                }
            }
            if (maxR > bestR) {
                bestR = maxR;
                bestC = minC;
                candidates = [group];
            } else if (maxR === bestR) {
                if (minC < bestC) {
                    bestC = minC;
                    candidates = [group];
                } else if (minC === bestC) {
                    candidates.push(group);
                }
            }
        }

        const targetGroup = candidates[Math.floor(this._random() * candidates.length)];

        let sumC = 0, sumR = 0;
        for (const cell of targetGroup) {
            sumC += cell.c;
            sumR += cell.r;
        }
        const avgC = sumC / targetGroup.length;
        const avgR = sumR / targetGroup.length;

        const targetC = avgC - 1;
        const targetR = avgR + 1;

        const logicalX = (targetC + 0.5) * PConfig.cellSize;
        const logicalY = (targetR - PConfig.hiddenRows + 0.5) * PConfig.cellSize;

        if (!this.canvas) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = rect.width / (PConfig.cols * PConfig.cellSize);
        const scaleY = rect.height / (PConfig.rows * PConfig.cellSize);

        const finalX = logicalX * scaleX;
        const finalY = logicalY * scaleY;

        this._clearChainTextDOM();

        const el = document.createElement('div');
        el.style.position = 'absolute';

        const pageX = rect.left + window.scrollX + finalX;
        const pageY = rect.top + window.scrollY + finalY;

        el.style.left = pageX + 'px';
        el.style.top = pageY + 'px';
        el.style.transform = 'translate(-50%, -50%)';
        el.style.pointerEvents = 'none';
        el.style.zIndex = '9999';
        el.style.whiteSpace = 'nowrap';
        el.style.display = 'flex';
        el.style.alignItems = 'baseline';
        el.style.justifyContent = 'center';

        const numSize = 48;
        const chainSize = 24;

        el.innerHTML = `
            <span style="font-family: 'Orbitron', monospace; font-size: ${numSize}px; font-weight: bold; color: #ff8c00; text-shadow: 0 0 4px #fff, 0 0 8px rgba(255,140,0,0.8); -webkit-text-stroke: 1.5px #fff; line-height: 1;">
                ${this.chainCount}
            </span>
            <span style="font-family: 'Orbitron', monospace; font-size: ${chainSize}px; font-weight: bold; color: #ff8c00; text-shadow: 0 0 4px #fff, 0 0 8px rgba(255,140,0,0.8); -webkit-text-stroke: 1px #fff; margin-left: 6px; line-height: 1;">
                CHAIN
            </span>
        `;

        document.body.appendChild(el);

        this.chainTextInfo = {
            el: el,
            baseY: pageY
        };
    }

    _clearChainTextDOM() {
        if (this.chainTextInfo && this.chainTextInfo.el) {
            if (this.chainTextInfo.el.parentNode) {
                this.chainTextInfo.el.parentNode.removeChild(this.chainTextInfo.el);
            }
        }
        this.chainTextInfo = null;
    }

    _clearYokokuDOM() {
        // ★ おじゃま予告コンテナの中身を空にする
        // ゲーム停止・ルール切り替え時に残像が残らないようにする
        if (this.yokokuContainer) {
            this.yokokuContainer.innerHTML = '';
        }
    }

    _buildDropAnim() {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        const anims = [];

        for (let c = 0; c < PConfig.cols; c++) {
            let emptyBelow = 0;
            const cellAnims = [];
            for (let r = totalRows - 1; r >= 0; r--) {
                if (this.field[r][c] === 0) {
                    emptyBelow++;
                } else if (emptyBelow > 0) {
                    cellAnims.push({ fromR: r, toR: r + emptyBelow, color: this.field[r][c] });
                }
            }
            if (cellAnims.length > 0) {
                anims.push({ c, cells: cellAnims });
            }
        }

        if (anims.length === 0) {
            this._dropAnim = null;
            return;
        }

        for (const col of anims) {
            for (const cell of col.cells) {
                this.field[cell.fromR][col.c] = 0;
            }
        }

        for (const col of anims) {
            for (const cell of col.cells) {
                cell.py = (cell.fromR - PConfig.hiddenRows) * PConfig.cellSize;
            }
        }

        this._dropAnim = anims;
    }

    _applyDropAnim() {
        if (!this._dropAnim) return;
        for (const col of this._dropAnim) {
            for (const cell of col.cells) {
                this.field[cell.toR][col.c] = cell.color;
            }
        }
    }

    _beginGameOver() {
        this.playSe('gameover');
        this._stopTimer();
        this._removeKeyHandlers();
        this._clearChainTextDOM();
        this.isAllClear = false; // ★ ゲームオーバー時にALL CLEARを消す
        this.state = 'gameover';

        if (this.isVersusMode) {
            const loser = (this.canvasPrefix === 'cpu') ? 'cpu' : 'player';
            // ★ versusGameOver内の stopGame が stop() を呼んでも、
            //    _versusFinishing フラグによりキャンバス・ループを保持する。
            //    state は gameover のまま維持されるため、_loop() の描画継続条件を満たし続ける。
            this._versusFinishing = true;
            if (typeof versusGameOver === 'function') versusGameOver(loser);
            return;
        }

        showFinishOverlay('finish-overlay', 'finish-text', 'GAME OVER', 'finish-gameover', 1200, () => {
            this._showResult();
        });
    }

    _showResult() {
        const titleEl = document.getElementById('result-title');
        if (titleEl) {
            titleEl.textContent = 'GAME OVER';
            titleEl.style.background = "linear-gradient(90deg, var(--accent), var(--accent2))";
            titleEl.style.webkitBackgroundClip = "text";
            titleEl.style.webkitTextFillColor = "transparent";
        }

        const scoreEl = document.getElementById('result-score');
        if (scoreEl) scoreEl.textContent = this.score;

        const levelEl = document.getElementById('result-level');
        if (levelEl) {
            levelEl.textContent = this.chainMax;
            levelEl.style.fontSize = '';
        }

        const linesEl = document.getElementById('result-lines');
        if (linesEl) linesEl.textContent = this.clearedPuyos;

        const timeEl = document.getElementById('result-time');
        if (timeEl) timeEl.textContent = this._formatTime(this.elapsed);

        if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(true);
        if (typeof switchPage === 'function') switchPage('result');
    }

    _startTimer() {
        this.elapsed = 0;
        this._timerRunning = true;
        this._timerStart = performance.now();
        this._timerTick();
    }

    _stopTimer() {
        if (this._timerRunning) {
            this.elapsed += performance.now() - this._timerStart;
            this._timerRunning = false;
        }
        if (this._timerReqId) {
            cancelAnimationFrame(this._timerReqId);
            this._timerReqId = null;
        }
    }

    _timerTick() {
        if (!this._timerRunning) return;
        const now = performance.now();
        const total = this.elapsed + (now - this._timerStart);
        this._updateTimeDisplay(total);
        this._timerReqId = requestAnimationFrame(() => this._timerTick());
    }

    _formatTime(ms) {
        const total = Math.floor(ms / 10);
        const cs = total % 100;
        const s = Math.floor(total / 100) % 60;
        const m = Math.floor(total / 6000);
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    }

    _updateScoreDisplay() {
        if (this.scoreEl) {
            this.scoreEl.style.fontSize = '';
            this.scoreEl.style.whiteSpace = '';
            this.scoreEl.textContent = this.score;
        }
    }

    _updateTimeDisplay(ms) {
        if (this.timeEl) this.timeEl.textContent = this._formatTime(ms);
    }

    _updateChainDisplay(chain) {
        if (this.linesEl) this.linesEl.textContent = chain > 0 ? chain : 0;
        if (this.levelEl) this.levelEl.textContent = this.chainMax;
    }

    // ══════════════════════════════════════════════
    // キーイベントハンドラ系
    // ══════════════════════════════════════════════

    _setKeyHandlers() {
        this._removeKeyHandlers();
        // ★ CPU操作モードであっても、PauseとRestartはプレイヤーの操作を受け付けるため、ここで早期リターンはしない

        const ks = (typeof loadKeys === 'function') ? loadKeys() : {};
        this._keyMap = {
            moveLeft: ks.moveLeft ? ks.moveLeft.code : 'ArrowLeft',
            moveRight: ks.moveRight ? ks.moveRight.code : 'ArrowRight',
            softDrop: ks.softDrop ? ks.softDrop.code : 'ArrowDown',
            quickDrop: ks.hardDrop ? ks.hardDrop.code : 'Space', // ★ クイックドロップ追加
            rotateCW: ks.rotateCW ? ks.rotateCW.code : 'ArrowUp',
            rotateCCW: ks.rotateCCW ? ks.rotateCCW.code : 'KeyZ',
            pause: ks.pause ? ks.pause.code : 'Escape',
            restart: ks.restart ? ks.restart.code : 'KeyR',
        };

        this._keyHandlerDown = (e) => {
            // ★ 【修正】待機中のインスタンスは無視
            if (this.state === 'idle') return;

            const activePageId = this.isVersusMode ? 'versus-page' : 'game-page';
            const gamePage = document.getElementById(activePageId);
            if (!gamePage || !gamePage.classList.contains('active')) return;

            // ★ PauseとRestartキーは、CPU操作時であっても処理を優先して通す
            if (e.code === this._keyMap.restart) {
                e.preventDefault();
                if (!this.isVersusMode) {
                    const pauseOverlay = document.getElementById('pause-overlay');
                    if (pauseOverlay) pauseOverlay.classList.remove('active');
                    this.start();
                }
                return;
            }

            if (e.code === this._keyMap.pause) {
                e.preventDefault();
                if (!this.isVersusMode) {
                    this._onPauseKey();
                }
                return;
            }

            // ★ これ以降の操作（移動、回転、ドロップ等）は、CPU制御時にはプレイヤーの入力を無視する
            if (this.isCpuControlled) return;

            const isRepeat = e.repeat;
            this._keys[e.code] = true;

            if (this._gs === 'spawnAnim' && !isRepeat) {
                if (e.code === this._keyMap.moveLeft) this.inputBuffer.push('left');
                if (e.code === this._keyMap.moveRight) this.inputBuffer.push('right');
                if (e.code === this._keyMap.rotateCW) this.inputBuffer.push('cw');
                if (e.code === this._keyMap.rotateCCW) this.inputBuffer.push('ccw');
            }

            if (e.code === this._keyMap.moveLeft) {
                e.preventDefault();
                if (this._dasDir !== -1) {
                    this._dasDir = -1;
                    this._dasTimer = 0;
                    this._arrTimer = 0;
                    if (this._gs === 'falling') this._tryMove(-1);
                }
            } else if (e.code === this._keyMap.moveRight) {
                e.preventDefault();
                if (this._dasDir !== 1) {
                    this._dasDir = 1;
                    this._dasTimer = 0;
                    this._arrTimer = 0;
                    if (this._gs === 'falling') this._tryMove(1);
                }
            }

            if (this._gs !== 'falling') return;

            // ★ クイックドロップ処理の追加
            // ★ キーリピート（長押し）時は受け付けない（1回押し直したときのみ有効）
            if (e.code === this._keyMap.quickDrop) {
                e.preventDefault();
                if (!isRepeat) this._tryQuickDrop();
                return;
            }

            // ★ 回転もキーリピート時は受け付けない（1回押し直したときのみ有効）
            if (e.code === this._keyMap.rotateCW) {
                e.preventDefault();
                if (!isRepeat) this._tryRotate(1);
            } else if (e.code === this._keyMap.rotateCCW) {
                e.preventDefault();
                if (!isRepeat) this._tryRotate(-1);
            }
        };

        this._keyHandlerUp = (e) => {
            // ★ CPU制御時はキーの解放も無視する
            if (this.isCpuControlled) return;

            delete this._keys[e.code];
            if (e.code === this._keyMap.moveLeft && this._dasDir === -1) this._dasDir = 0;
            if (e.code === this._keyMap.moveRight && this._dasDir === 1) this._dasDir = 0;
        };

        document.addEventListener('keydown', this._keyHandlerDown);
        document.addEventListener('keyup', this._keyHandlerUp);

        this._setupGamepadHandlers();
    }

    _removeKeyHandlers() {
        if (this._keyHandlerDown) {
            document.removeEventListener('keydown', this._keyHandlerDown);
            this._keyHandlerDown = null;
        }
        if (this._keyHandlerUp) {
            document.removeEventListener('keyup', this._keyHandlerUp);
            this._keyHandlerUp = null;
        }
        this._removeGamepadHandlers();
    }

    _setupGamepadHandlers() {
        this._removeGamepadHandlers();

        const DEFAULT_GAMEPAD = {
            moveLeft: [{ type: 'button', index: 14 }],
            moveRight: [{ type: 'button', index: 15 }],
            softDrop: [{ type: 'button', index: 13 }],
            hardDrop: [{ type: 'button', index: 12 }],
            rotateCW: [{ type: 'button', index: 0 }],
            rotateCCW: [{ type: 'button', index: 1 }],
            hold: [{ type: 'button', index: 4 }, { type: 'button', index: 5 }],
            pause: [{ type: 'button', index: 9 }],
            restart: [{ type: 'button', index: 8 }],
        };

        const normalizeConfig = (cfg) => {
            const out = {};
            for (const action in DEFAULT_GAMEPAD) {
                const v = cfg && cfg[action];
                if (Array.isArray(v)) out[action] = v.slice(0, 2);
                else if (v && typeof v === 'object') out[action] = [v];
                else out[action] = DEFAULT_GAMEPAD[action];
            }
            return out;
        };

        let gpConfig = DEFAULT_GAMEPAD;
        if (typeof currentGamepadConfig !== 'undefined' && currentGamepadConfig) {
            gpConfig = currentGamepadConfig;
        } else {
            const raw = localStorage.getItem('game_gamepadconfig');
            if (raw) {
                try {
                    gpConfig = { ...DEFAULT_GAMEPAD, ...JSON.parse(raw) };
                } catch (e) {
                    localStorage.removeItem('game_gamepadconfig');
                }
            }
        }
        gpConfig = normalizeConfig(gpConfig);

        let deadzone = 0.45;
        if (typeof loadGamepadOptions === 'function') {
            const opt = loadGamepadOptions();
            if (opt && Number.isFinite(opt.deadzone)) {
                deadzone = Math.min(0.95, Math.max(0.05, opt.deadzone));
            }
        } else {
            const rawOpt = localStorage.getItem('game_gamepad_options');
            if (rawOpt) {
                try {
                    const parsed = JSON.parse(rawOpt);
                    if (parsed && Number.isFinite(parsed.deadzone)) {
                        deadzone = Math.min(0.95, Math.max(0.05, parsed.deadzone));
                    }
                } catch (e) {
                    localStorage.removeItem('game_gamepad_options');
                }
            }
        }

        this._gpPrevState = this._gpPrevState || {};

        this._gpConnectedHandler = (e) => {
            this._gamepadIndex = e.gamepad.index;
            if (typeof showGlobalToast === 'function') {
                showGlobalToast('Gamepad connected: ' + (e.gamepad.id || ''));
            }
        };
        this._gpDisconnectedHandler = (e) => {
            if (this._gamepadIndex === e.gamepad.index) this._gamepadIndex = null;
            if (typeof showGlobalToast === 'function') {
                showGlobalToast('Gamepad disconnected');
            }
        };

        window.addEventListener('gamepadconnected', this._gpConnectedHandler);
        window.addEventListener('gamepaddisconnected', this._gpDisconnectedHandler);

        const isPressedByMappings = (pad, mappings) => {
            if (!pad || !Array.isArray(mappings)) return false;
            let pressed = false;
            for (const m of mappings) {
                if (!m) continue;
                if (m.type === 'button') {
                    const b = pad.buttons[m.index];
                    pressed = pressed || !!(b && b.pressed);
                } else if (m.type === 'axis') {
                    const a = pad.axes[m.index];
                    pressed = pressed || !!(a && Math.abs(a) > 0.5);
                }
            }
            return pressed;
        };

        const setKeyHeld = (code, held) => {
            if (!code) return;
            if (held) this._keys[code] = true;
            else delete this._keys[code];
        };

        this._gamepadLoop = setInterval(() => {
            const activePageId = this.isVersusMode ? 'versus-page' : 'game-page';
            const gamePage = document.getElementById(activePageId);
            if (!gamePage || !gamePage.classList.contains('active')) return;

            const pads = (navigator.getGamepads) ? navigator.getGamepads() : [];
            let pad = null;
            if (this._gamepadIndex !== null && pads[this._gamepadIndex]) {
                pad = pads[this._gamepadIndex];
            } else {
                for (let i = 0; i < pads.length; i++) {
                    if (pads[i]) { pad = pads[i]; break; }
                }
            }
            if (!pad) return;

            const stickX = (pad.axes && pad.axes.length > 0) ? pad.axes[0] : 0;
            const stickY = (pad.axes && pad.axes.length > 1) ? pad.axes[1] : 0;

            // Pause / Restart はCPUモードでも許可
            const pausePressed = isPressedByMappings(pad, gpConfig.pause);
            const restartPressed = isPressedByMappings(pad, gpConfig.restart);
            const prevPause = !!this._gpPrevState.pause;
            const prevRestart = !!this._gpPrevState.restart;

            if (restartPressed && !prevRestart) {
                if (!this.isVersusMode) {
                    const pauseOverlay = document.getElementById('pause-overlay');
                    if (pauseOverlay) pauseOverlay.classList.remove('active');
                    this.start();
                }
            }

            if (pausePressed && !prevPause) {
                if (!this.isVersusMode) {
                    this._onPauseKey();
                }
            }

            this._gpPrevState.pause = pausePressed;
            this._gpPrevState.restart = restartPressed;

            if (this.isCpuControlled) return;

            const leftPressed = isPressedByMappings(pad, gpConfig.moveLeft) || (stickX <= -deadzone);
            const rightPressed = isPressedByMappings(pad, gpConfig.moveRight) || (stickX >= deadzone);
            const softPressed = isPressedByMappings(pad, gpConfig.softDrop) || (stickY >= deadzone);
            const quickPressed = isPressedByMappings(pad, gpConfig.hardDrop) || (stickY <= -deadzone);
            const cwPressed = isPressedByMappings(pad, gpConfig.rotateCW);
            const ccwPressed = isPressedByMappings(pad, gpConfig.rotateCCW);

            const prevLeft = !!this._gpPrevState.moveLeft;
            const prevRight = !!this._gpPrevState.moveRight;
            const prevQuick = !!this._gpPrevState.hardDrop;
            const prevCW = !!this._gpPrevState.rotateCW;
            const prevCCW = !!this._gpPrevState.rotateCCW;

            setKeyHeld(this._keyMap.moveLeft, leftPressed);
            setKeyHeld(this._keyMap.moveRight, rightPressed);
            setKeyHeld(this._keyMap.softDrop, softPressed);

            if (leftPressed && !rightPressed) {
                if (this._dasDir !== -1) {
                    this._dasDir = -1;
                    this._dasTimer = 0;
                    this._arrTimer = 0;
                    if (this._gs === 'falling') this._tryMove(-1);
                }
            } else if (rightPressed && !leftPressed) {
                if (this._dasDir !== 1) {
                    this._dasDir = 1;
                    this._dasTimer = 0;
                    this._arrTimer = 0;
                    if (this._gs === 'falling') this._tryMove(1);
                }
            } else {
                this._dasDir = 0;
            }

            if (this._gs === 'spawnAnim') {
                if (leftPressed && !prevLeft) this.inputBuffer.push('left');
                if (rightPressed && !prevRight) this.inputBuffer.push('right');
                if (cwPressed && !prevCW) this.inputBuffer.push('cw');
                if (ccwPressed && !prevCCW) this.inputBuffer.push('ccw');
            }

            if (this._gs === 'falling') {
                if (quickPressed && !prevQuick) this._tryQuickDrop();
                if (cwPressed && !prevCW) this._tryRotate(1);
                if (ccwPressed && !prevCCW) this._tryRotate(-1);
            }

            this._gpPrevState.moveLeft = leftPressed;
            this._gpPrevState.moveRight = rightPressed;
            this._gpPrevState.softDrop = softPressed;
            this._gpPrevState.hardDrop = quickPressed;
            this._gpPrevState.rotateCW = cwPressed;
            this._gpPrevState.rotateCCW = ccwPressed;
        }, 16);
    }

    _removeGamepadHandlers() {
        if (this._gamepadLoop) {
            clearInterval(this._gamepadLoop);
            this._gamepadLoop = null;
        }
        if (this._gpConnectedHandler) {
            window.removeEventListener('gamepadconnected', this._gpConnectedHandler);
            this._gpConnectedHandler = null;
        }
        if (this._gpDisconnectedHandler) {
            window.removeEventListener('gamepaddisconnected', this._gpDisconnectedHandler);
            this._gpDisconnectedHandler = null;
        }
    }

    _onPauseKey() {
        // UIの表示非表示、ボタンのバインドはすべて router.js に委譲
        if (typeof toggleGamePause === 'function') {
            toggleGamePause();
        }
    }

    _updateDAS(dt) {
        const tuning = (typeof loadTuning === 'function') ? loadTuning() : { das: 9, arr: 1.5 };
        const dasMs = tuning.das * 16.67;
        const arrMs = tuning.arr * 16.67;

        if (this._dasDir !== 0) {
            this._dasTimer += dt;
            if (this._dasTimer >= dasMs) {
                this._arrTimer += dt;
                if (this._gs === 'falling') {
                    while (this._arrTimer >= arrMs) {
                        this._arrTimer -= arrMs;
                        this._tryMove(this._dasDir);
                    }
                } else {
                    if (this._arrTimer >= arrMs) {
                        this._arrTimer = arrMs;
                    }
                }
            }
        }
    }

    // SE再生の薄いラッパ。CPU操作の盤面でもSEを鳴らす（プレイヤーとの二重再生は許容する）
    playSe(key) {
        // fix.ogg（puyo_fix / puyo_drop）のみ、特殊なチャタリング防止を行う。
        // ・「1盤面につき」50ms間隔（この timer はインスタンス毎なので盤面ごとに独立）。
        // ・vsで両方ぷよでも、プレイヤー盤面とCPU盤面は別インスタンス＝別 timer のため、
        //   両者の fix 間隔が50ms未満でも互いに抑制されず鳴る。
        if (key === 'puyo_fix' || key === 'puyo_drop') {
            const now = performance.now();
            if (this._lastFixSeTime != null && now - this._lastFixSeTime < 50) return;
            this._lastFixSeTime = now;
        }

        window.SeManager?.play(key);
    }

    _tryMove(dir) {
        if (this._gs !== 'falling') return;
        const newCol = this.pivotX + dir;
        if (this._canPlace(newCol, this.pivotY, this.targetRot)) {
            this.pivotX = newCol;
            this.lockTimer = 0;
            this.quickTurnCount = 0;
            this.lastRotationInfo = null;
            this.playSe('puyo_move');
            this._checkMoveLock();
        }
    }

    _tryRotate(dir) {
        if (this._gs !== 'falling') return;
        const isVertical = (this.targetRot === 0 || this.targetRot === 2);
        const newRot = ((this.targetRot + dir) % 4 + 4) % 4;
        let tempY = this.pivotY;
        let success = false;

        if (newRot === 2 && !isVertical) {
            if (this._canPlace(this.pivotX, tempY, newRot)) {
                success = true;
            } else if (this._canPlace(this.pivotX, tempY - 1, newRot)) {
                this.pivotY -= 1;
                success = true;
            }
        } else {
            if (this._canPlace(this.pivotX, tempY, newRot)) {
                success = true;
            } else {
                for (const kick of [-1, 1]) {
                    if (this._canPlace(this.pivotX + kick, tempY, newRot)) {
                        this.pivotX += kick;
                        success = true;
                        break;
                    }
                }
            }
        }

        if (success) {
            this.targetRot = newRot;
            this.targetAnimRot += dir;
            this.lockTimer = 0;
            this.quickTurnCount = 0;
            this.lastRotationInfo = { pivotY: this.pivotY };
            this.playSe('puyo_rotate');
            this._checkMoveLock();
        } else {
            if (isVertical) {
                this.quickTurnCount++;
                if (this.quickTurnCount >= 2) {
                    let qtRot = ((this.targetRot + 2) % 4 + 4) % 4;
                    let qtSuccess = false;
                    let nextY = tempY;

                    if (this.targetRot === 0) {
                        nextY -= 1;
                        if (this._canPlace(this.pivotX, nextY, qtRot)) {
                            this.pivotY = nextY;
                            qtSuccess = true;
                        }
                    } else if (this.targetRot === 2) {
                        if (this._canPlace(this.pivotX, nextY, qtRot)) {
                            qtSuccess = true;
                        }
                    }

                    if (qtSuccess) {
                        this.targetRot = qtRot;
                        this.targetAnimRot += dir * 2;
                        this.lockTimer = 0;
                        this.quickTurnCount = 0;
                        this.lastRotationInfo = { pivotY: this.pivotY };
                        this.playSe('puyo_rotate');
                        this._checkMoveLock();
                    }
                }
            }
        }
    }

    // ★ クイックドロップ（ハードドロップ）処理の実装
    _tryQuickDrop() {
        if (this._gs !== 'falling') return;

        // 接地する限界のY座標を計算
        let limitY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);

        /* // 落下距離に応じてスコア加算（任意：ソフトドロップと同様の基準）
        let dropDist = limitY - this.pivotY;
        if (dropDist > 0) {
            let add = Math.floor(dropDist);
            if (add > 0) {
                this.score += add;
                this._addDropScore(add);
                this._updateScoreDisplay();
            }
        }
        */

        // Y座標を限界まで一気に移動（クイックドロップによるスコア加算はなし）
        this.pivotY = limitY;

        // 設置猶予時間をカットして即時設置
        this.lockTimer = PConfig.lockDelayMs;
        this.playSe('puyo_drop');
        this._fixPuyo(true);
    }

    _checkMoveLock() {
        let limitY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);
        if (this.pivotY >= limitY) {
            this.moveLockCount++;
            if (this.moveLockCount >= 15) {
                this._fixPuyo();
            }
        }
    }

    _canPlace(pc, py, rot) {
        let r1 = Math.floor(py);
        let r2 = Math.ceil(py);

        if (!this._canPlaceGrid(pc, r1, rot)) return false;
        if (r1 !== r2 && !this._canPlaceGrid(pc, r2, rot)) return false;

        return true;
    }

    _canPlaceGrid(pc, pr, rot) {
        const DC = [0, 1, 0, -1];
        const DR = [-1, 0, 1, 0];
        const cc = pc + DC[rot];
        const cr = pr + DR[rot];

        if (pc < 0 || pc >= PConfig.cols) return false;
        if (cc < 0 || cc >= PConfig.cols) return false;
        if (pr >= PConfig.rows) return false;
        if (cr >= PConfig.rows) return false;

        const pv = this._getCell(pc, pr);
        if (pv !== 0 && pv !== undefined) return false;

        const cv = this._getCell(cc, cr);
        if (cv !== 0 && cv !== undefined) return false;

        return true;
    }

    _calcLimitY(pc, py, rot) {
        const DC = [0, 1, 0, -1];
        const DR = [-1, 0, 1, 0];
        const cc = pc + DC[rot];

        let pr = Math.floor(py);
        while (pr < PConfig.rows && this._isCellEmpty(pc, pr + 1)) {
            pr++;
        }

        let cr = Math.floor(py) + DR[rot];
        while (cr < PConfig.rows && this._isCellEmpty(cc, cr + 1)) {
            cr++;
        }

        return Math.min(pr, cr - DR[rot]);
    }

    _calcLimitY_Single(c, y) {
        let r = Math.floor(y);
        while (r < PConfig.rows && this._isCellEmpty(c, r + 1)) {
            r++;
        }
        return r;
    }

    // ══════════════════════════════════════════════
    // 描画・その他
    // ══════════════════════════════════════════════

    _render() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const W = this.canvas.width;
        const H = this.canvas.height;

        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, W, H);

        ctx.save();

        const logicalW = PConfig.cols * PConfig.cellSize;
        const logicalH = PConfig.rows * PConfig.cellSize;
        ctx.scale(W / logicalW, H / logicalH);

        const cs = PConfig.cellSize;

        const deadX = 2 * cs;
        const deadY = 0 * cs;

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.7)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const pad = 6;
        ctx.moveTo(deadX + pad, deadY + pad);
        ctx.lineTo(deadX + cs - pad, deadY + cs - pad);
        ctx.moveTo(deadX + cs - pad, deadY + pad);
        ctx.lineTo(deadX + pad, deadY + cs - pad);
        ctx.stroke();
        ctx.restore();

        let ghostEraseInfo = null;
        if (this._gs === 'falling') {
            ghostEraseInfo = this._getGhostEraseInfo();
        }

        for (let r = 0; r < PConfig.rows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                const fr = r + PConfig.hiddenRows;
                const color = this.field[fr][c];
                if (color === 0) continue;

                let flashType = 0;

                if (this._erasingCells) {
                    const isErasing = this._erasingCells.some(ec => ec.r === fr && ec.c === c);
                    if (isErasing) {
                        if (Math.floor(this._eraseTimer / 66.68) % 2 === 1) continue;
                    }
                }
                else if (ghostEraseInfo && ghostEraseInfo.cells.length > 0) {
                    if (ghostEraseInfo.cells.some(ec => ec.r === fr && ec.c === c)) {
                        // ★ ゴースト時、おじゃまぷよ(color===6)は白光りさせない
                        if (color !== 6) {
                            flashType = 2;
                        }
                    }
                }

                const animState = this.activeAnims.find(a => a.fr === fr && a.c === c);
                // ★ 振動アニメ中（animState あり）は連結画像を無効にする
                const isVibrating = !!animState;
                const connectInfo = this._getConnectImageInfo(c, r, color, isVibrating);
                this._drawPuyo(ctx, c * cs, r * cs, color, cs, flashType, animState, connectInfo);
            }
        }

        if (this._dropAnim) {
            for (const col of this._dropAnim) {
                for (const cell of col.cells) {
                    // ★ _getDropConnectImageInfoで連結情報を取得する
                    const connectInfo = this._getDropConnectImageInfo(col.c, cell.fromR, cell.color);
                    this._drawPuyo(ctx, col.c * cs, cell.py, cell.color, cs, 0, null, connectInfo);
                }
            }
        }

        if (this._gs === 'falling') {
            const targetDC = [0, 1, 0, -1];
            const targetDR = [-1, 0, 1, 0];
            const childCol = this.pivotX + targetDC[this.targetRot];

            let ghostPivotY, ghostChildY;
            if (this.targetRot === 0) {
                ghostPivotY = this._calcLimitY_Single(this.pivotX, this.pivotY);
                ghostChildY = ghostPivotY - 1;
            } else if (this.targetRot === 2) {
                ghostChildY = this._calcLimitY_Single(this.pivotX, this.pivotY + 1);
                ghostPivotY = ghostChildY - 1;
            } else {
                ghostPivotY = this._calcLimitY_Single(this.pivotX, this.pivotY);
                ghostChildY = this._calcLimitY_Single(childCol, this.pivotY);
            }

            ctx.globalAlpha = 0.22;
            this._drawPuyo(ctx, this.pivotX * cs, ghostPivotY * cs, this.pivotColor, cs, 0);
            this._drawPuyo(ctx, childCol * cs, ghostChildY * cs, this.childColor, cs, 0);
            ctx.globalAlpha = 1.0;

            const angle = -Math.PI / 2 + this.animRot * (Math.PI / 2);
            const childOffsetX = Math.cos(angle);
            const childOffsetY = Math.sin(angle);

            const px = this.pivotX * cs;
            const py = this.pivotY * cs;
            const cx = px + childOffsetX * cs;
            const cy = py + childOffsetY * cs;

            const limitY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);
            const isFloating = (this.pivotY < limitY);

            let pivotFlash = isFloating ? 1 : 0;

            this._drawPuyo(ctx, px, py, this.pivotColor, cs, pivotFlash);
            this._drawPuyo(ctx, cx, cy, this.childColor, cs, 0);
        }

        if (this.splitPuyo && this._gs === 'splitting') {
            this._drawPuyo(ctx, this.splitPuyo.col * cs, this.splitPuyo.y * cs, this.splitPuyo.color, cs, 0);
        }

        ctx.restore();

        if (this._gs === 'eraseWait' && this.chainTextInfo && this.chainTextInfo.el) {
            const remaining = PConfig.eraseWaitMs - this.eraseWaitTimer;
            const alpha = Math.max(0, Math.min(1, remaining / 150));

            const progress = this.eraseWaitTimer / PConfig.eraseWaitMs;
            const slideY = -12 * progress;

            this.chainTextInfo.el.style.opacity = alpha;
            this.chainTextInfo.el.style.top = (this.chainTextInfo.baseY + slideY) + 'px';
        }

        // ★ ALL CLEAR 永続表示
        if (this.isAllClear) {
            ctx.save();
            // 時間経過でアルファ値を少し揺らす (0.85 〜 1.0)
            const alpha = 0.85 + 0.15 * Math.sin(this.elapsed / 150);
            ctx.globalAlpha = alpha;
            ctx.font = 'bold 26px "Orbitron", monospace';
            ctx.fillStyle = '#ffea00';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(255,234,0,1)';
            ctx.shadowBlur = 15;

            // 少しだけ黒縁をつけて見やすくする
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 4;
            ctx.strokeText('ALL CLEAR', W / 2, H / 3);
            ctx.fillText('ALL CLEAR', W / 2, H / 3);
            ctx.restore();
        }

        this._renderNext();
    }

    /**
     * ぷよ1個を描画する。
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x - 描画左上X（論理座標）
     * @param {number} y - 描画左上Y（論理座標）
     * @param {number} color - ぷよ色（1〜6）
     * @param {number} size - セルサイズ
     * @param {number} flashType - 0:なし 1:操作中光り 2:消去予告光り
     * @param {object|null} animState - 振動アニメ状態
     * @param {{ key: string, angle: number }|null} connectInfo - ★ 連結画像情報（null=通常画像）
     */
    _drawPuyo(ctx, x, y, color, size, flashType = 0, animState = null, connectInfo = null) {
        const imageIndex = color - 1;
        const key = 'puyo-' + imageIndex;
        const img = this._images[key];

        ctx.save();

        // ── 振動アニメによるスケール変換 ──
        let cx = x + size / 2;
        let cy = y + size;

        let scaleX = 1;
        let scaleY = 1;

        if (animState) {
            let phase = Math.floor(animState.timer / PConfig.vibPhaseMs) % 4;
            if (phase === 0) scaleX = 0.8;
            else if (phase === 2) scaleY = 0.8;
        }

        ctx.translate(cx, cy);
        ctx.scale(scaleX, scaleY);
        ctx.translate(-cx, -cy);

        // ★ サブピクセルレンダリングによる隙間（1pxの境界線）を埋めるためのオーバーラップ値
        // 論理座標(32px)に対して少し広げて描画することで、物理座標での小数の丸め誤差による隙間を重ね合わせて消す
        const overlap = 0.6;
        const dx = x - overlap / 2;
        const dy = y - overlap / 2;
        const dw = size + overlap;
        const dh = size + overlap;

        // ── 画像描画（連結あり / なし の分岐） ──
        if (connectInfo) {
            // ★ 連結画像：angle ラジアン分だけセル中心を軸に時計回り回転して描画
            const connectImg = this._images[connectInfo.key];
            if (connectImg && connectImg.complete && connectImg.naturalWidth > 0) {
                // 連結画像を回転して描画（セル中心を回転軸とする）
                const centerX = x + size / 2;
                const centerY = y + size / 2;
                ctx.translate(centerX, centerY);
                ctx.rotate(connectInfo.angle);
                ctx.translate(-centerX, -centerY);
                ctx.drawImage(connectImg, dx, dy, dw, dh);
            } else if (img && img.complete && img.naturalWidth > 0) {
                // 連結画像が未ロードの場合は通常画像にフォールバック
                ctx.drawImage(img, dx, dy, dw, dh);
            }
        } else if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, dx, dy, dw, dh);
        }

        // ── フラッシュエフェクト ──
        if (flashType > 0) {
            const isErase = (flashType === 2);
            const speed = isErase ? 40 : 60;
            const maxAlpha = isErase ? 0.85 : 0.7;
            const alpha = (Math.sin(this.elapsed / speed) + 1) / 2 * maxAlpha;

            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            // エフェクトの中心とサイズは元のサイズのままでOK
            ctx.arc(x + size * 0.5, y + size * 0.5, size * 0.45, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    /**
     * ★ 画像未ロード時のフォールバック描画（丸＋目）
     */
    _drawPuyoFallback(ctx, x, y, size, imageIndex) {
        const COLORS = ['#e74c3c', '#3498db', '#9b59b6', '#2ecc71', '#f1c40f', '#bdc3c7'];
        ctx.fillStyle = COLORS[imageIndex] || '#000';
        ctx.beginPath();
        ctx.arc(x + size * 0.5, y + size * 0.5, size * 0.42, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.beginPath();
        ctx.arc(x + size * 0.35, y + size * 0.38, size * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + size * 0.65, y + size * 0.38, size * 0.1, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(0,0,0,0)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x + size * 0.5, y + size * 0.5, size * 0.42, 0, Math.PI * 2);
        ctx.stroke();
    }

    _renderNext() {
        if (!this.nextCtx || this.nextQueue.length === 0) return;
        const ctx = this.nextCtx;
        const W = this.nextCanvas.width;
        const H = this.nextCanvas.height;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, W, H);

        const drawCs = 42;
        const offsetX = (W - drawCs) / 2;

        ctx.save();

        let offsetY = 0;
        let showThree = false;
        const shiftDist = drawCs * 2.5;

        if (this._gs === 'spawnAnim') {
            const progress = Math.min(1, this.spawnAnimTimer / PConfig.spawnAnimMs);
            offsetY = -shiftDist * progress;
            showThree = true;
        }

        const next1 = this.nextQueue[0];
        if (next1) {
            this._drawPuyo(ctx, offsetX, 20 + offsetY, next1[1], drawCs, 0);
            this._drawPuyo(ctx, offsetX, 20 + drawCs + offsetY, next1[0], drawCs, 0);
        }

        const next2 = this.nextQueue[1];
        if (next2) {
            this._drawPuyo(ctx, offsetX, 20 + drawCs * 2.5 + offsetY, next2[1], drawCs, 0);
            this._drawPuyo(ctx, offsetX, 20 + drawCs * 3.5 + offsetY, next2[0], drawCs, 0);
        }

        if (showThree) {
            const next3 = this.nextQueue[2];
            if (next3) {
                this._drawPuyo(ctx, offsetX, 20 + drawCs * 5.0 + offsetY, next3[1], drawCs, 0);
                this._drawPuyo(ctx, offsetX, 20 + drawCs * 6.0 + offsetY, next3[0], drawCs, 0);
            }
        }

        ctx.restore();
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