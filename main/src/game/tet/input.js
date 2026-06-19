// ─────────────────────────────────────────────
// tet/input.js  ―  Game.prototype mixin
// 入力（キー/ゲームパッド）・SE再生
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    // ポーズ切り替え
    // SE再生の薄いラッパ（A案）。人間・CPUどちらの盤面でもそれぞれの操作音を鳴らす。
    playSe(key) {
        window.SeManager?.play(key);
    },

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
        // 旧 setInterval ベースのループを撤去（rAF駆動に統合済み）
        if (this._keyLoop) { clearInterval(this._keyLoop); this._keyLoop = null; }
        this._pollInput = null;

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

            // ─── 即時反応させたいアクションは keydown 内で直接実行する ───
            // _pollInput は rAF 駆動のため、key イベントから最大 1 フレ分の遅延が
            // 生じていた（表示の遅延 28ms ≒ 3フレの一因）。初動とロテートを
            // 同期実行することで、入力 → 画面反映までの経路を 1 フレ短縮する。
            // DAS/ARR や soft drop の連続落下は引き続き _pollInput が担当。
            const canActNow = this.mino && !this.isCountingDown
            let immediateActed = false
            let immediateWasGrounded = this.isGrounded

            if (e.code === keys.moveLeft.code && this._leftPressTime === null) {
                this._leftPressTime = now
                this._lastHorizontal = 'left'
                if (canActNow) {
                    if (this.valid(-1, 0)) {
                        this.mino.x--
                        this.lastActionWasRotation = false
                        this.playSe('move')
                        immediateActed = true
                    }
                    // DAS 計測の基準を keydown 時刻に揃える（_pollInput 側で
                    // _lastMoveTimeLeft===0 を「未実行」として扱わなくて済む）
                    this._lastMoveTimeLeft = now
                    this._dasBlockedLeft = false
                } else {
                    this._lastMoveTimeLeft = 0
                }
            }
            if (e.code === keys.moveRight.code && this._rightPressTime === null) {
                this._rightPressTime = now
                this._lastHorizontal = 'right'
                if (canActNow) {
                    if (this.valid(1, 0)) {
                        this.mino.x++
                        this.lastActionWasRotation = false
                        this.playSe('move')
                        immediateActed = true
                    }
                    this._lastMoveTimeRight = now
                    this._dasBlockedRight = false
                } else {
                    this._lastMoveTimeRight = 0
                }
            }

            // 回転（押した瞬間のみ単発）
            if (canActNow && e.code === keys.rotateCW.code && !e.repeat && !this._rotCWPressed) {
                if (this.tryRotate(1)) {
                    this.updateLowestY()
                    immediateActed = true
                }
                this._rotCWPressed = true
            }
            if (canActNow && e.code === keys.rotateCCW.code && !e.repeat && !this._rotCCWPressed) {
                if (this.tryRotate(-1)) {
                    this.updateLowestY()
                    immediateActed = true
                }
                this._rotCCWPressed = true
            }

            // ソフトドロップ初動（1マス）も即時に
            if (canActNow && e.code === keys.softDrop.code && this._lastSoftDropTime === 0) {
                this._lastSoftDropTime = now
                if (this.valid(0, 1)) {
                    this.mino.y++
                    this.updateLowestY()
                    this.lastActionWasRotation = false
                    this.score += 1
                    this.playSe('drop')
                    this.updateStatsDisplay()
                    immediateActed = true
                }
            }

            if (immediateActed) {
                this.checkGroundState(true, immediateWasGrounded)
                this.requestRedraw()
                // _pollInput を待たずに同フレ中に描画完了させる。
                // _needsRedraw を消し、rAF が来てもダブル描画しないようにする。
                if (this._needsRedraw) {
                    this._needsRedraw = false
                    this.drawAll()
                }
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
        // ループ本体は rAF 駆動の startRenderLoop() から this._pollInput() として呼ばれる。
        // setInterval(…, 4) で 250Hz 回していた頃と違い rAF と同期するため、
        // tick が貯まらず描画と同フレームでキー反映される＝体感ラグが減る。
        this._lastFrameTime = performance.now()
        this._pollInput = () => {
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
                        this.playSe('drop'); // ソフトドロップ音（毎マス）
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
                                this.playSe('drop'); // ソフトドロップ音（毎マス）
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
                this.requestRedraw();
            }

        }; // _pollInput end — rAFループ (startRenderLoop) から毎フレーム呼ばれる

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
                                this.playSe('drop') // ソフトドロップ音（毎マス）
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
    },
});
