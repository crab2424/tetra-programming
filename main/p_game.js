// ─────────────────────────────────────────────
// p_game.js
// PUYOモード用ゲームエンジン（自己完結型）
// TETLABOに統合するぷよぷよシングルプレイモジュール
// ─────────────────────────────────────────────

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PConfig : ぷよぷよ用定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PConfig = {
    // フィールドサイズ（ぷよぷよ標準 6列×12行）
    cols:             6,
    rows:             12, // 見える行数
    hiddenRows:       2,  // 隠し領域（出現・回転用）

    // 1マスのピクセルサイズ（内部論理計算用）
    cellSize:         32,

    // 画像パス
    imagePath:        'images/p_images/',

    // ぷよの色数（4色使用）
    colorCount:       4,

    // 時間設定 (ms)
    dropSpeedNormal:  500,        // 自由落下速度（1マス/500ms）
    dropSpeedFast:    500 / 12,   // 下入力時（重力の12倍速）
    splitDropSpeed:   500 / 6,    // 単独ちぎり落下（重力の6倍速）
    lockDelayMs:      500,        // 接地猶予時間
    
    // ★ 振動アニメーションの速度（1フェーズ = 約20ms）
    vibPhaseMs:       1000 / 60 * 1.2, 
    // ★ 設置アニメーション後の待機時間
    fixWait5fMs:      1000 / 60 * 5,   

    spawnAnimMs:      62,         // NEXT出現アニメーションの時間
    rotateDurationMs: 80,         // 回転アニメーションの時間

    // 4個以上でまとめて消える
    eraseCount:       4,

    // 消えるアニメーション長（ms）
    eraseMs:          28 * 16.67, // 約466ms
    // ★ 追加：消去後から落下開始までの待機時間（連鎖演出時間）
    eraseWaitMs:      333,

    // 全消しボーナス表示時間（ms）
    zenkeshiMs:       1500,
    zenkeshiBonus:    3600,

    // ── スコア計算テーブル（ぷよぷよ公式準拠） ──
    scoreBase:        10,
    // 連鎖ボーナス（1連鎖目〜18連鎖目）
    chainBonusTable:  [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512],
    // 色ボーナス（使用色数 1〜4）
    colorBonusTable:  [0, 3, 6, 12, 24],
    // 連結ボーナス（消えた個数ごと）
    groupBonusTable:  [0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 10],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PuyoGame : メインクラス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class PuyoGame {
    constructor() {
        this.canvas     = null;
        this.ctx        = null;
        this.nextCanvas = null;
        this.nextCtx    = null;
        this.scoreEl    = null;
        this.timeEl     = null;
        this.linesEl    = null;
        this.levelEl    = null;

        this.state      = 'idle';
        this._gs        = 'spawn';

        this.score      = 0;
        this.chainMax   = 0;
        this.chainCount = 0;

        this.elapsed        = 0;
        this._timerRunning  = false;
        this._timerStart    = 0;
        this._timerReqId    = null;

        this._loopId    = null;
        this.lastTime   = performance.now();

        this.field      = [];
        this.nextQueue  = [];
        this.activeColors = []; 

        // 操作中の組ぷよ
        this.pivotX     = 2;
        this.pivotY     = -0.5;
        this.pivotColor = 0;
        this.childColor = 0;
        
        // 回転アニメーション用の変数
        this.targetRot      = 0; // 論理的な角度 (0=上, 1=右, 2=下, 3=左)
        this.targetAnimRot  = 0; // アニメーションの目標値 (連続値)
        this.animRot        = 0; // 現在の描画角度 (連続値)
        this.quickTurnCount = 0; // クイックターン（180度回転）のための失敗カウント

        // ★ 設置・振動アニメーション用
        this.activeAnims    = [];
        this.lastRotationInfo = null; // { pivotY: number }
        this.fixAnimTimer   = 0;
        this.fixAnimDuration = 0;
        this.fw5fTimer      = 0;

        // タイマー類
        this.fallTimer  = 0;
        this.lockTimer  = 0;
        this.scoreFloat = 0;
        this.spawnAnimTimer = 0; // NEXT出現演出用タイマー

        // 入力・DAS
        this._keys           = {};
        this._keyMap         = {};
        this._keyHandlerDown = null;
        this._keyHandlerUp   = null;
        this._dasDir         = 0;
        this._dasTimer       = 0;
        this._arrTimer       = 0;
        this._priorityMove   = false; 
        
        // ★ 先行入力バッファ用配列
        this.inputBuffer     = [];

        // 消去・ちぎり・落下アニメーション
        this._erasingCells  = null;
        this._eraseTimer    = 0;
        this.eraseWaitTimer = 0; // ★ 消去後待機タイマー追加
        this._dropAnim      = null;
        this.splitPuyo      = null; 

        this._zenkeshiTimer = 0;

        this._images        = {};
        this._imagesLoaded  = false;
        this.isPaused       = false;
    }

    start() {
        this.stop();
        this._setupCanvas();
        this._setupStatDisplay();
        this._loadImages(() => {
            this._initActiveColors(); 
            this._resetState();
            
            this.state = 'idle';
            this._setKeyHandlers();
            this._render();
            
            const overlayId = 'countdown-overlay';
            const textElId = 'countdown-text';
            
            runCountdown(overlayId, textElId, () => {
                this.state = 'playing';
                this.lastTime = performance.now();
                this._startTimer();
                this._loop();
            }, null);
        });
    }

    stop() {
        this.state = 'idle';
        this._stopTimer();
        this._removeKeyHandlers();
        if (this._loopId) {
            cancelAnimationFrame(this._loopId);
            this._loopId = null;
        }
    }

    pause() {
        if (this.state !== 'playing') return;
        this.state    = 'paused';
        this.isPaused = true;
        this._stopTimer();
    }

    resume() {
        if (this.state !== 'paused') return;
        this.state    = 'playing';
        this.isPaused = false;
        this.lastTime = performance.now();
        this._startTimer();
        this._loop();
    }

    _initActiveColors() {
        const allColors = [1, 2, 3, 4, 5];
        for (let i = allColors.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allColors[i], allColors[j]] = [allColors[j], allColors[i]];
        }
        this.activeColors = allColors.slice(0, PConfig.colorCount);
    }

    _resetState() {
        this._initField();
        this._initNextQueue();
        this.score      = 0;
        this.chainMax   = 0;
        this.chainCount = 0;
        this.elapsed    = 0;
        this._gs        = 'spawn';
        this.isPaused   = false;
        
        this.splitPuyo  = null;
        this._erasingCells  = null;
        this._eraseTimer    = 0;
        this.eraseWaitTimer = 0; // ★ リセット
        this._dropAnim      = null;
        this._zenkeshiTimer = 0;
        this._dasDir    = 0;
        this._dasTimer  = 0;
        this._arrTimer  = 0;
        this._keys      = {};
        this._priorityMove = false;
        this.quickTurnCount = 0;
        this.spawnAnimTimer = 0;
        this.inputBuffer    = []; 

        this.activeAnims    = [];
        this.lastRotationInfo = null;
        this.fixAnimTimer   = 0;
        this.fixAnimDuration = 0;
        this.fw5fTimer      = 0;

        this._updateScoreDisplay();
        this._updateTimeDisplay(0);
        this._updateChainDisplay(0);
    }

    _setupCanvas() {
        this.canvas     = document.getElementById('puyo-main-canvas');
        this.nextCanvas = document.getElementById('puyo-next-canvas');
        if (!this.canvas) return;

        this.canvas.width  = 320;
        this.canvas.height = 656;
        this.ctx = this.canvas.getContext('2d');

        if (this.nextCanvas) {
            this.nextCanvas.width  = 128;
            this.nextCanvas.height = 259;
            this.nextCtx = this.nextCanvas.getContext('2d');
        }
    }

    _setupStatDisplay() {
        this.scoreEl = document.getElementById('score-value');
        this.timeEl  = document.getElementById('time-value');
        this.linesEl = document.getElementById('lines-value');
        this.levelEl = document.getElementById('level-value');
    }

    _loadImages(callback) {
        const targets = ['puyo-0', 'puyo-1', 'puyo-2', 'puyo-3', 'puyo-4', 'puyo-5'];
        let remaining = targets.length;
        targets.forEach(key => {
            const img = new Image();
            const done = () => {
                remaining--;
                if (remaining <= 0) {
                    this._imagesLoaded = true;
                    callback();
                }
            };
            img.onload  = done;
            img.onerror = done;
            img.src = PConfig.imagePath + key + '.png';
            this._images[key] = img;
        });
    }

    _initField() {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        this.field = Array.from({ length: totalRows }, () => new Array(PConfig.cols).fill(0));
    }

    _getCell(col, row) {
        const r = row + PConfig.hiddenRows;
        if (r < 0 || r >= this.field.length) return undefined;
        if (col < 0 || col >= PConfig.cols)  return undefined;
        return this.field[r][col];
    }

    _setCell(col, row, val) {
        const r = row + PConfig.hiddenRows;
        if (r < 0 || r >= this.field.length) return;
        if (col < 0 || col >= PConfig.cols)  return;
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
        
        // 1手目
        const pair1 = this._makePair();
        this.nextQueue.push(pair1);

        // 初手2手が4色バラバラになるのを防ぐ処理
        // 1手目で使われなかった色の中からランダムに1色選び、2手目の抽選から除外する
        const usedInFirst = new Set(pair1);
        const unusedColors = this.activeColors.filter(c => !usedInFirst.has(c));
        let excludeColor = null;
        if (unusedColors.length > 0) {
            excludeColor = unusedColors[Math.floor(Math.random() * unusedColors.length)];
        }

        // 2手目（除外色を指定して抽選）
        const pair2 = this._makePair(excludeColor);
        this.nextQueue.push(pair2);

        // 3手目以降は通常通り
        this.nextQueue.push(this._makePair());
    }

    _makePair(excludeColor = null) {
        let availableColors = this.activeColors;
        if (excludeColor !== null) {
            availableColors = this.activeColors.filter(c => c !== excludeColor);
        }
        const c1 = availableColors[Math.floor(Math.random() * availableColors.length)];
        const c2 = availableColors[Math.floor(Math.random() * availableColors.length)];
        return [c1, c2];
    }

    _dequeueNext() {
        const pair = this.nextQueue.shift();
        this.nextQueue.push(this._makePair());
        return pair;
    }

    _spawnPuyo() {
        const pair = this._dequeueNext();

        this.pivotX        = 2;
        this.pivotY        = -0.5; 
        this.targetRot     = 0;
        this.targetAnimRot = 0;
        this.animRot       = 0;
        this.pivotColor    = pair[0];
        this.childColor    = pair[1];

        this.fallTimer      = 0;
        this.lockTimer      = 0;
        this.scoreFloat     = 0;
        this.quickTurnCount = 0; 
        this.lastRotationInfo = null; // 回転情報リセット

        this._priorityMove = false;
        if (this._keys[this._keyMap.softDrop] && (this._keys[this._keyMap.moveLeft] || this._keys[this._keyMap.moveRight])) {
            this._priorityMove = true;
        }

        if (!this._isCellEmpty(this.pivotX, 0)) {
            return false;
        }
        return true;
    }

    // ★ 振動アニメーション登録
    _addPuyoAnim(fr, c, cycles) {
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

    // ★ 設置時のサイクル数を判定する
    _calcFixCycles() {
        let isSoftDrop = this._keys[this._keyMap.softDrop];
        if (isSoftDrop && this.lastRotationInfo) {
            // 回転開始時親ぷよの高さが設置段1段以内の高さであった場合
            if (Math.round(this.pivotY) - Math.floor(this.lastRotationInfo.pivotY) <= 1) {
                return 1;
            }
        }
        return 2;
    }

    // ★ アニメーション完了まで待機するステートへ移行
    _beginFixAnimWait() {
        let maxDur = 0;
        for(let anim of this.activeAnims) {
            let remaining = anim.duration - anim.timer;
            if(remaining > maxDur) maxDur = remaining;
        }
        this.fixAnimTimer = 0;
        this.fixAnimDuration = maxDur;
        this._gs = 'fixAnim';
    }

    // ══════════════════════════════════════════════
    // ループと状態管理
    // ══════════════════════════════════════════════

    _loop() {
        if (this.state !== 'playing') return;
        this._loopId = requestAnimationFrame(() => this._loop());
        
        let now = performance.now();
        let dt = now - this.lastTime;
        if (dt > 100) dt = 100; 
        this.lastTime = now;

        this._update(dt);
        this._render();
    }

    _update(dt) {
        if (this._zenkeshiTimer > 0) this._zenkeshiTimer -= dt;

        this._updateDAS(dt);

        // ★ フィールド上の振動アニメーション進行
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
                    
                    // ★ 操作可能になった瞬間、先行入力バッファに溜まった操作を実行
                    if (this.inputBuffer.length > 0) {
                        for (const action of this.inputBuffer) {
                            if (action === 'left') this._tryMove(-1);
                            else if (action === 'right') this._tryMove(1);
                            else if (action === 'cw') this._tryRotate(1);
                            else if (action === 'ccw') this._tryRotate(-1);
                        }
                        this.inputBuffer = []; // 実行完了したらバッファを空にする
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
                    
                    // ★ ちぎりぷよ接地：3往復
                    this._addPuyoAnim(fr_s, this.splitPuyo.col, 3);
                    
                    this.splitPuyo = null;
                    this._beginFixAnimWait();
                }
                break;

            // ★ 設置アニメーション（振動）の待機
            case 'fixAnim':
                this.fixAnimTimer += dt;
                if (this.fixAnimTimer >= this.fixAnimDuration) {
                    this._gs = 'fixWait5f';
                    this.fw5fTimer = 0;
                }
                break;

            // ★ 将来追加予定のアニメーション用（5f待機）
            case 'fixWait5f':
                this.fw5fTimer += dt;
                if (this.fw5fTimer >= PConfig.fixWait5fMs) {
                    this._gs = 'checkErase';
                }
                break;

            case 'checkErase': {
                const toErase = this._findErasable();
                if (toErase.length > 0) {
                    this._erasingCells = toErase;
                    this._eraseTimer   = 0;
                    this.chainCount++;
                    if (this.chainCount > this.chainMax) this.chainMax = this.chainCount;
                    this._addChainScore(toErase);
                    this._gs = 'erasing';
                } else {
                    if (this._isFieldEmpty() && this.chainCount > 0) {
                        this.score += PConfig.zenkeshiBonus;
                        this._updateScoreDisplay();
                        this._zenkeshiTimer = PConfig.zenkeshiMs;
                    }
                    // ★ 連鎖終了（または消去なし）でNEXT出現アニメーションへ移行
                    this._gs = 'spawnAnim';
                    this.spawnAnimTimer = 0;
                }
                break;
            }

            case 'erasing':
                this._eraseTimer += dt;
                if (this._eraseTimer >= PConfig.eraseMs) {
                    this._applyErase(); // ここでぷよを消去する
                    this._buildDropAnim(); // 落下情報の構築
                    // ★ 修正：消去した瞬間ではなく、400ms待機ステートへ移行
                    this._gs = 'eraseWait';
                    this.eraseWaitTimer = 0;
                }
                break;
            
            // ★ 追加：消去後の400ms待機（連鎖演出）
            case 'eraseWait':
                this.eraseWaitTimer += dt;
                if (this.eraseWaitTimer >= PConfig.eraseWaitMs) {
                    if (this._dropAnim) {
                        this._gs = 'dropping'; // 落下するぷよがあれば落下
                    } else {
                        // 落下するぷよがなければ、消去チェックを経由してNEXT演出へ
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
                        
                        // ★ 落下完了後の振動アニメーション登録
                        for (const col of this._dropAnim) {
                            for (const cell of col.cells) {
                                let dropDist = cell.toR - cell.fromR;
                                let cycles = dropDist >= 2 ? 4 : 3;
                                this._addPuyoAnim(cell.toR, col.c, cycles);
                            }
                        }
                        
                        this._dropAnim = null;
                        this._beginFixAnimWait(); // 落下後も振動完了を待ってから消去チェックへ
                    }
                } else {
                    this._gs = 'checkErase';
                }
                break;
                
            // ★ NEXT出現演出（NEXT枠移動）ステート
            case 'spawnAnim':
                this.spawnAnimTimer += dt;
                if (this.spawnAnimTimer >= PConfig.spawnAnimMs) {
                    this.chainCount = 0; // 次の操作に備えてリセット（連鎖リセットはここでのみ行う）
                    this._gs = 'spawn';
                }
                break;

            case 'gameover':
                break;
        }
    }

    // ══════════════════════════════════════════════
    // 入力処理と DAS
    // ══════════════════════════════════════════════

    _setKeyHandlers() {
        this._removeKeyHandlers();
        const ks = (typeof loadKeys === 'function') ? loadKeys() : {};
        this._keyMap = {
            moveLeft:  ks.moveLeft  ? ks.moveLeft.code  : 'ArrowLeft',
            moveRight: ks.moveRight ? ks.moveRight.code : 'ArrowRight',
            softDrop:  ks.softDrop  ? ks.softDrop.code  : 'ArrowDown',
            rotateCW:  ks.rotateCW  ? ks.rotateCW.code  : 'ArrowUp',
            rotateCCW: ks.rotateCCW ? ks.rotateCCW.code : 'KeyZ',
            pause:     ks.pause     ? ks.pause.code     : 'Escape',
            restart:   ks.restart   ? ks.restart.code   : 'KeyR', 
        };

        this._keyHandlerDown = (e) => {
            const gamePage = document.getElementById('game-page');
            if (!gamePage || !gamePage.classList.contains('active')) return;

            // ★ OSキーリピートによる連続入力を先行入力として過剰カウントしないための処理
            const isRepeat = e.repeat;
            this._keys[e.code] = true;

            if (e.code === this._keyMap.restart) {
                e.preventDefault();
                const pauseOverlay = document.getElementById('pause-overlay');
                if (pauseOverlay) pauseOverlay.classList.remove('active');
                this.start();
                return;
            }

            if (e.code === this._keyMap.pause) {
                e.preventDefault();
                this._onPauseKey();
                return;
            }

            // ★ 出現演出中(62ms)の先行入力バッファリング
            if (this._gs === 'spawnAnim' && !isRepeat) {
                if (e.code === this._keyMap.moveLeft)  this.inputBuffer.push('left');
                if (e.code === this._keyMap.moveRight) this.inputBuffer.push('right');
                if (e.code === this._keyMap.rotateCW)  this.inputBuffer.push('cw');
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

            if (e.code === this._keyMap.rotateCW) {
                e.preventDefault();
                this._tryRotate(1);
            } else if (e.code === this._keyMap.rotateCCW) {
                e.preventDefault();
                this._tryRotate(-1);
            }
        };

        this._keyHandlerUp = (e) => {
            delete this._keys[e.code];
            if (e.code === this._keyMap.moveLeft  && this._dasDir === -1) this._dasDir = 0;
            if (e.code === this._keyMap.moveRight && this._dasDir ===  1) this._dasDir = 0;
        };

        document.addEventListener('keydown', this._keyHandlerDown);
        document.addEventListener('keyup',   this._keyHandlerUp);
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
    }

    _onPauseKey() {
        const overlay = document.getElementById('pause-overlay');
        if (!overlay) return;

        if (this.state === 'paused') {
            overlay.classList.remove('active');
            this.resume();
        } else if (this.state === 'playing') {
            this.pause();
            overlay.classList.add('active');

            const resumeBtn = overlay.querySelector('.btn-resume');
            if (resumeBtn) {
                resumeBtn.onclick = () => {
                    overlay.classList.remove('active');
                    this.resume();
                };
            }
            const restartBtn = overlay.querySelector('.btn-restart');
            if (restartBtn) {
                restartBtn.onclick = () => {
                    overlay.classList.remove('active');
                    this.start();
                };
            }
            const mainmenuBtn = overlay.querySelector('.btn-mainmenu');
            if (mainmenuBtn) {
                mainmenuBtn.onclick = () => {
                    overlay.classList.remove('active');
                    this.stop();
                    _switchToPuyoLayout(false);
                    if (typeof switchPage === 'function') switchPage('main-menu');
                };
            }
        }
    }

    _updateDAS(dt) {
        const tuning  = (typeof loadTuning === 'function') ? loadTuning() : { das: 9, arr: 1.5 };
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

    // ══════════════════════════════════════════════
    // 移動・回転と当たり判定
    // ══════════════════════════════════════════════

    _tryMove(dir) {
        const newCol = this.pivotX + dir;
        if (this._canPlace(newCol, this.pivotY, this.targetRot)) {
            this.pivotX = newCol;
            this.lockTimer = 0; 
            this.quickTurnCount = 0; 
            this.lastRotationInfo = null; // 移動したら回転フラグ折る
        }
    }

    _tryRotate(dir) {
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
            this.lastRotationInfo = { pivotY: this.pivotY }; // 回転開始時の高さを記録
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
                        this.lastRotationInfo = { pivotY: this.pivotY }; // クイックターンでも記録
                    }
                }
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
    // 重力落下 / 接地 / 固定
    // ══════════════════════════════════════════════

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

    _fixPuyo() {
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
            this._addPuyoAnim(fr_c, cc, cycles); // 先に接地した子ぷよのアニメ開始
            
            this.splitPuyo = { col: pc, y: pr, color: this.pivotColor };
            this._gs = 'splitting';
        } else if (!pivotFloating && childFloating) {
            this._setCell(pc, pr, this.pivotColor);
            this._addPuyoAnim(fr_p, pc, cycles); // 先に接地した親ぷよのアニメ開始
            
            this.splitPuyo = { col: cc, y: cr, color: this.childColor };
            this._gs = 'splitting';
        } else {
            this._setCell(pc, pr, this.pivotColor);
            this._setCell(cc, cr, this.childColor);
            
            this._addPuyoAnim(fr_p, pc, cycles);
            this._addPuyoAnim(fr_c, cc, cycles);
            this._beginFixAnimWait();
        }
    }

    // ══════════════════════════════════════════════
    // 消去チェック・仮想消去チェック
    // ══════════════════════════════════════════════

    _findErasableInField(checkField) {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        const visited   = Array.from({ length: totalRows }, () => new Array(PConfig.cols).fill(false));
        const result = [];

        for (let r = 1; r < totalRows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                if (visited[r][c]) continue;
                const color = checkField[r][c];
                if (color <= 0) continue;

                const group = [];
                const queue = [{ r, c }];
                visited[r][c] = true;
                while (queue.length > 0) {
                    const cur = queue.shift();
                    group.push({ r: cur.r, c: cur.c, color });
                    const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
                    for (const [dr, dc] of dirs) {
                        const nr = cur.r + dr;
                        const nc = cur.c + dc;
                        if (nr <= 0 || nr >= totalRows) continue;
                        if (nc < 0 || nc >= PConfig.cols)  continue;
                        if (visited[nr][nc]) continue;
                        if (checkField[nr][nc] !== color) continue;
                        visited[nr][nc] = true;
                        queue.push({ r: nr, c: nc });
                    }
                }

                if (group.length >= PConfig.eraseCount) {
                    result.push(...group);
                }
            }
        }
        return result;
    }

    _findErasable() {
        return this._findErasableInField(this.field);
    }

    // ★ 修正：現在のゴースト位置で固定された場合の消去セルを取得（貫通バグの修正）
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

        // 縦置き(0, 2)の場合はちぎれないためそのまま確定。横置き(1, 3)のみちぎりを計算。
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

        const erasingCells = this._findErasableInField(vField);
        return {
            cells: erasingCells
        };
    }

    _applyErase() {
        if (!this._erasingCells) return;
        for (const { r, c } of this._erasingCells) {
            this.field[r][c] = 0;
        }
        this._erasingCells = null;
    }

    _addChainScore(cells) {
        const n = cells.length;
        const cb = PConfig.chainBonusTable[Math.min(this.chainCount, PConfig.chainBonusTable.length - 1)];
        const usedColors = new Set(cells.map(cell => cell.color));
        const colorB = PConfig.colorBonusTable[Math.min(usedColors.size, PConfig.colorBonusTable.length - 1)];
        const groupB = PConfig.groupBonusTable[Math.min(n, PConfig.groupBonusTable.length - 1)];

        const bonus = Math.max(1, cb + colorB + groupB);
        const add   = PConfig.scoreBase * n * bonus;
        this.score += add;
        this._updateScoreDisplay();
        this._updateChainDisplay(this.chainCount);
    }

    // ══════════════════════════════════════════════
    // 落下アニメーション（消去後の浮きぷよ）
    // ══════════════════════════════════════════════

    _buildDropAnim() {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        const anims     = [];

        for (let c = 0; c < PConfig.cols; c++) {
            let emptyBelow = 0;
            const cellAnims = [];
            for (let r = totalRows - 1; r >= 0; r--) {
                if (r === 0) {
                    continue;
                }
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
            this._dropAnim  = null;
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

        this._dropAnim  = anims;
    }

    _applyDropAnim() {
        if (!this._dropAnim) return;
        for (const col of this._dropAnim) {
            for (const cell of col.cells) {
                this.field[cell.toR][col.c] = cell.color;
            }
        }
    }

    // ══════════════════════════════════════════════
    // ゲームオーバー
    // ══════════════════════════════════════════════

    _beginGameOver() {
        this._stopTimer();
        this._removeKeyHandlers();
        this.state = 'gameover';

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
            levelEl.textContent = this.chainMax + ' CHAIN';
            levelEl.style.fontSize = '18px';
        }

        const linesEl = document.getElementById('result-lines');
        if (linesEl) linesEl.textContent = '—';

        const timeEl = document.getElementById('result-time');
        if (timeEl) timeEl.textContent = this._formatTime(this.elapsed);

        const retryBtn = document.getElementById('result-retry-btn');
        if (retryBtn) {
            retryBtn.onclick = () => {
                if (typeof goToModeCheck === 'function') goToModeCheck('puyo');
            };
        }

        if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(false);
        if (typeof switchPage === 'function') switchPage('result');
    }

    // ══════════════════════════════════════════════
    // タイマー・統計
    // ══════════════════════════════════════════════

    _startTimer() {
        this.elapsed        = 0;
        this._timerRunning  = true;
        this._timerStart    = performance.now();
        this._timerTick();
    }

    _stopTimer() {
        if (this._timerRunning) {
            this.elapsed      += performance.now() - this._timerStart;
            this._timerRunning = false;
        }
        if (this._timerReqId) {
            cancelAnimationFrame(this._timerReqId);
            this._timerReqId = null;
        }
    }

    _timerTick() {
        if (!this._timerRunning) return;
        const now   = performance.now();
        const total = this.elapsed + (now - this._timerStart);
        this._updateTimeDisplay(total);
        this._timerReqId = requestAnimationFrame(() => this._timerTick());
    }

    _formatTime(ms) {
        const total = Math.floor(ms / 10);
        const cs    = total % 100;
        const s     = Math.floor(total / 100) % 60;
        const m     = Math.floor(total / 6000);
        return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
    }

    _updateScoreDisplay() {
        if (this.scoreEl) this.scoreEl.textContent = this.score;
    }

    _updateTimeDisplay(ms) {
        if (this.timeEl) this.timeEl.textContent = this._formatTime(ms);
    }

    _updateChainDisplay(chain) {
        if (this.linesEl) this.linesEl.textContent = chain > 0 ? chain : 0;
        if (this.levelEl) this.levelEl.textContent = this.chainMax;
    }

    // ══════════════════════════════════════════════
    // 描画
    // ══════════════════════════════════════════════

    _render() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const W   = this.canvas.width;  
        const H   = this.canvas.height; 

        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        
        const logicalW = PConfig.cols * PConfig.cellSize;
        const logicalH = PConfig.rows * PConfig.cellSize;
        ctx.scale(W / logicalW, H / logicalH);

        const cs  = PConfig.cellSize;

        // 連鎖予告用情報取得
        let ghostEraseInfo = null;
        if (this._gs === 'falling') {
            ghostEraseInfo = this._getGhostEraseInfo();
        }

        // フィールドの固定ぷよ
        for (let r = 0; r < PConfig.rows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                const fr    = r + PConfig.hiddenRows;
                const color = this.field[fr][c];
                if (color === 0) continue;

                let flashType = 0;

                // 実際の消去中
                if (this._erasingCells) {
                    const isErasing = this._erasingCells.some(ec => ec.r === fr && ec.c === c);
                    if (isErasing) {
                        if (Math.floor(this._eraseTimer / 66.68) % 2 === 1) continue;
                    }
                } 
                // ★ 連鎖予告：フィールドに実在する固定ぷよだけを強く点滅
                else if (ghostEraseInfo && ghostEraseInfo.cells.length > 0) {
                    if (ghostEraseInfo.cells.some(ec => ec.r === fr && ec.c === c)) {
                        flashType = 2; // 強く点滅
                    }
                }

                const animState = this.activeAnims.find(a => a.fr === fr && a.c === c);
                this._drawPuyo(ctx, c * cs, r * cs, color, cs, flashType, animState);
            }
        }

        // 落下アニメーション中のぷよ
        if (this._dropAnim) {
            for (const col of this._dropAnim) {
                for (const cell of col.cells) {
                    this._drawPuyo(ctx, col.c * cs, cell.py, cell.color, cs, 0);
                }
            }
        }

        // 操作中の組ぷよとゴースト
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

            // ★ ゴーストには点滅(flashType=0)を渡す
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

            // ★ 実ぷよ（空中親ぷよ）には、落下中ならゆったり点滅（flashType=1）を渡す
            let pivotFlash = isFloating ? 1 : 0;

            this._drawPuyo(ctx, px, py, this.pivotColor, cs, pivotFlash);
            this._drawPuyo(ctx, cx, cy, this.childColor, cs, 0);
        }

        // 単独ちぎり落下のぷよ
        if (this.splitPuyo && this._gs === 'splitting') {
            this._drawPuyo(ctx, this.splitPuyo.col * cs, this.splitPuyo.y * cs, this.splitPuyo.color, cs, 0);
        }

        ctx.restore(); 

        // 全消しバナー
        if (this._zenkeshiTimer > 0) {
            const alpha = Math.min(1, this._zenkeshiTimer / 150);
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.font        = 'bold 22px "Orbitron", monospace';
            ctx.fillStyle   = '#ffea00';
            ctx.textAlign   = 'center';
            ctx.shadowColor = 'rgba(255,234,0,0.9)';
            ctx.shadowBlur  = 20;
            ctx.fillText('ALL CLEAR!', W / 2, H / 2);
            ctx.restore();
        }

        this._renderNext();
    }

    _drawPuyo(ctx, x, y, color, size, flashType = 0, animState = null) {
        const imageIndex = color - 1;
        const key = 'puyo-' + imageIndex;
        const img = this._images[key];

        ctx.save();

        let cx = x + size / 2;
        let cy = y + size; // 下端基準

        let scaleX = 1;
        let scaleY = 1;

        // ★ 振動アニメーションのスケール計算
        if (animState) {
            let phase = Math.floor(animState.timer / PConfig.vibPhaseMs) % 4;
            if (phase === 0) {
                // 縦長: 幅0.8
                scaleX = 0.8;
            } else if (phase === 2) {
                // 横長: 高さ0.8
                scaleY = 0.8;
            }
        }

        ctx.translate(cx, cy);
        ctx.scale(scaleX, scaleY);
        ctx.translate(-cx, -cy);

        if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, x, y, size, size);
        } else {
            const COLORS = ['#e74c3c', '#2ecc71', '#3498db', '#f1c40f', '#9b59b6'];
            ctx.fillStyle   = COLORS[imageIndex] || '#fff';
            ctx.beginPath();
            ctx.arc(x + size * 0.5, y + size * 0.5, size * 0.42, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.beginPath();
            ctx.arc(x + size * 0.35, y + size * 0.38, size * 0.1, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + size * 0.65, y + size * 0.38, size * 0.1, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.strokeStyle = 'rgba(0,0,0,0.35)';
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.arc(x + size * 0.5, y + size * 0.5, size * 0.42, 0, Math.PI * 2);
            ctx.stroke();
        }

        // エフェクト描画 (0: なし, 1: 空中親ぷよのゆったり点滅, 2: 連鎖予告の強め点滅)
        if (flashType > 0) {
            const isErase = (flashType === 2);
            const speed = isErase ? 40 : 60; 
            const maxAlpha = isErase ? 0.85 : 0.7; 
            const alpha = (Math.sin(this.elapsed / speed) + 1) / 2 * maxAlpha; 
            
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            ctx.arc(x + size * 0.5, y + size * 0.5, size * 0.45, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    _renderNext() {
        if (!this.nextCtx || this.nextQueue.length === 0) return;
        const ctx = this.nextCtx;
        const W   = this.nextCanvas.width;
        const H   = this.nextCanvas.height;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, W, H);

        const drawCs = 42; 
        const offsetX = (W - drawCs) / 2;
        
        ctx.save();
        
        // ★ NEXTぷよせり上がりアニメーションの計算
        let offsetY = 0;
        let showThree = false;
        const shiftDist = drawCs * 2.5; // NEXTぷよ1段分のシフト距離

        // ★ 新設した spawnAnim ステート中にのみアニメーションを実行
        if (this._gs === 'spawnAnim') {
            const progress = Math.min(1, this.spawnAnimTimer / PConfig.spawnAnimMs);
            offsetY = -shiftDist * progress;
            showThree = true;
        } 
        // falling, checkErase, erasing, dropping など他の状態では offsetY = 0 のまま動かない

        // NEXT1の描画
        const next1 = this.nextQueue[0];
        if (next1) {
            this._drawPuyo(ctx, offsetX, 20 + offsetY, next1[1], drawCs, 0); 
            this._drawPuyo(ctx, offsetX, 20 + drawCs + offsetY, next1[0], drawCs, 0); 
        }

        // NEXT2の描画
        const next2 = this.nextQueue[1];
        if (next2) {
            this._drawPuyo(ctx, offsetX, 20 + drawCs * 2.5 + offsetY, next2[1], drawCs, 0); 
            this._drawPuyo(ctx, offsetX, 20 + drawCs * 3.5 + offsetY, next2[0], drawCs, 0); 
        }
        
        // アニメーション中などは下から湧いてくるNEXT3も描画する
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