// ─────────────────────────────────────────────
// tet/input.js  ―  Game.prototype mixin
// 入力（キー/ゲームパッド）・SE再生
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    // ポーズ切り替え
    // SE再生の薄いラッパ（A案）。人間・CPUどちらの盤面でもそれぞれの操作音を鳴らす。
    // 戻り値は常に true（tetにはチャタリング防止が無いため、puyo側とインターフェースを揃えるだけ）。
    playSe(key) {
        window.SeManager?.play(key);
        return true;
    },

    // ─── DAS/DCD の左右共通ヘルパ（setKeyEvent 内のキー/ゲームパッド/_pollInput から使う） ───
    _startDcd(dir, now) {
        if (this.DCD_DELAY <= 0) return
        this._dcdDir = dir
        this._dcdUntil = now + this.DCD_DELAY
    },

    _setLastMoveTime(dir, now) {
        if (dir === 'left') this._lastMoveTimeLeft = now
        else this._lastMoveTimeRight = now
    },

    // blocked=true のときは止まった時点のミノの x/rotation を記録する（DCD ②の原因判定用）
    _setDasBlocked(dir, blocked) {
        const snap = blocked ? { x: this.mino.x, rotation: this.mino.rotation } : null
        if (dir === 'left') {
            this._dasBlockedLeft = blocked
            this._dasBlockSnapLeft = snap
        } else {
            this._dasBlockedRight = blocked
            this._dasBlockSnapRight = snap
        }
    },

    // 左右キーを離したときの共通処理。その方向の DCD 中なら即解除する
    _releaseHorizontal(dir) {
        if (dir === 'left') {
            this._leftPressTime = null
            this._dasBlockedLeft = false
            this._dasBlockSnapLeft = null
        } else {
            this._rightPressTime = null
            this._dasBlockedRight = false
            this._dasBlockSnapRight = null
        }
        if (this._dcdDir === dir) {
            this._dcdDir = null
            this._dcdUntil = 0
        }
    },

    // ─────────────────────────────────────────
    // キーイベント（localStorage のキー設定を参照）
    // ─────────────────────────────────────────
    setKeyEvent() {
        // CPU制御モードの場合はキーイベントを一切設定しない
        if (this.isCpuControlled) return;

        // 押されているキーを管理
        // keyState はアクション名で管理（1アクションに複数キーを割り当てられるため）。
        // _heldCodes は物理キーコードの押下状態を保持し、keyState はそこから導出する
        // （複数キーの片方だけを離してもアクションが継続して押されている状態を保てる）。
        this.keyState = {}
        this._heldCodes = new Set()

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
        // ─── DCD (DAS Cut Delay) ───
        // 溜まったDASの暴発を防ぐため、次の2つの契機でDASの連続移動を DCD_DELAY だけ止める。
        //   ① DASを溜めたまま新しいミノが出現した（設置・ホールド）
        //   ② DASが溜まっていて壁等で止まっていた方向が、左右移動や回転で動ける状態に変わった
        //      （ソフトドロップ・自然落下で動けるようになった場合は、滑り込ませる操作を妨げないよう対象外）
        // DCDはその方向のキーを離すと即解除。止めるのは溜めた方向のDAS連続移動だけで、他の操作は止めない。
        this._dcdUntil = 0;
        this._dcdDir = null;
        this._dcdMino = undefined;     // 新ミノ出現の検知用（undefined=未観測。ゲーム開始時の初手はDCD対象外）
        this._dasBlockedLeft = false;  // DASが溜まった状態で左に動けず止まっているか
        this._dasBlockedRight = false;
        this._dasBlockSnapLeft = null; // 止まった時点のミノの x/rotation（動けるようになった原因の判定用）
        this._dasBlockSnapRight = null;

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

        // ─── キーの取り込み（設計 source_assets/memory/record/tetlabo-record-design.md §4.1 D5）───
        // keydown / keyup とゲームパッドの押す・離すは _inputQueue にためるだけにして、
        // フレームの頭（_pollInput の最初）で届いた順に処理する。
        // 以前は移動・回転・ハードドロップを keydown の中で即実行して drawAll していたが、
        // キーが届く瞬間はフレームと無関係なので、同じ操作でも固定猶予や重力との前後が毎回変わっていた。
        // 画面に出るのはどちらも次の描画なので、見える遅れは増えない。
        // ポーズ・リスタートは試合そのものの操作ではないので、今までどおり keydown の中ですぐ処理する。
        this._inputQueue = []

        // 押した瞬間の処理（以前の keydown 本体）。now はそのフレームのゲーム時刻
        const applyKeyDown = (code, repeat, now) => {
            this._heldCodes.add(code)
            for (const action in keys) {
                if (keys[action].codes.includes(code)) this.keyState[action] = true
            }

            const canActNow = this.mino && !this.isCountingDown
            let acted = false
            const wasGrounded = this.isGrounded

            if (keys.moveLeft.codes.includes(code) && this._leftPressTime === null) {
                this._leftPressTime = now
                this._lastHorizontal = 'left'
                if (canActNow) {
                    if (this.valid(-1, 0)) {
                        this.mino.x--
                        this.lastActionWasRotation = false
                        this.playSe('move')
                        acted = true
                    }
                    // DAS 計測の基準を押した時刻に揃える（_pollInput 側で
                    // _lastMoveTimeLeft===0 を「未実行」として扱わなくて済む）
                    this._lastMoveTimeLeft = now
                    this._dasBlockedLeft = false
                } else {
                    this._lastMoveTimeLeft = 0
                }
            }
            if (keys.moveRight.codes.includes(code) && this._rightPressTime === null) {
                this._rightPressTime = now
                this._lastHorizontal = 'right'
                if (canActNow) {
                    if (this.valid(1, 0)) {
                        this.mino.x++
                        this.lastActionWasRotation = false
                        this.playSe('move')
                        acted = true
                    }
                    this._lastMoveTimeRight = now
                    this._dasBlockedRight = false
                } else {
                    this._lastMoveTimeRight = 0
                }
            }

            // 回転（押した瞬間のみ単発）
            if (canActNow && keys.rotateCW.codes.includes(code) && !repeat && !this._rotCWPressed) {
                if (this.tryRotate(1)) {
                    this.updateLowestY()
                    acted = true
                }
                this._rotCWPressed = true
            }
            if (canActNow && keys.rotateCCW.codes.includes(code) && !repeat && !this._rotCCWPressed) {
                if (this.tryRotate(-1)) {
                    this.updateLowestY()
                    acted = true
                }
                this._rotCCWPressed = true
            }

            // ソフトドロップ初動（1マス）
            if (canActNow && keys.softDrop.codes.includes(code) && this._lastSoftDropTime === 0) {
                this._lastSoftDropTime = now
                if (this.valid(0, 1)) {
                    this.mino.y++
                    this.updateLowestY()
                    this.lastActionWasRotation = false
                    this.score += 1
                    this.playSe('drop')
                    this.updateStatsDisplay()
                    acted = true
                }
            }

            if (acted) {
                this.checkGroundState(true, wasGrounded)
                this.requestRedraw()
            }

            // 単発系（押した瞬間のみ。長押しの連続発火・カウントダウン中・盤面を持たない状態は無視）
            if (keys.hardDrop.codes.includes(code) && !repeat && !this.isCountingDown && this.mino) {
                // 設置後の DCD は _pollInput が新ミノの出現を検知して開始する（ゲームパッド・自然設置とも共通）
                this.hardDrop()
            }
            if (keys.hold.codes.includes(code) && !repeat && !this.isCountingDown && this.mino) {
                this.holdCurrentMino()
            }
        }

        // 離したときの処理（以前の keyup 本体）
        const applyKeyUp = (code) => {
            this._heldCodes.delete(code)
            // このコードに紐づくアクションのうち、他に押されているキーが残っていなければ解除する
            for (const action in keys) {
                if (keys[action].codes.includes(code) && !keys[action].codes.some(c => this._heldCodes.has(c))) {
                    this.keyState[action] = false
                }
            }

            if (keys.moveLeft.codes.includes(code) && !this.keyState.moveLeft) {
                this._releaseHorizontal('left')

                // 左を離したとき、右が押されていれば右を優先
                if (this.keyState.moveRight) {
                    this._lastHorizontal = 'right'
                }
            }

            if (keys.moveRight.codes.includes(code) && !this.keyState.moveRight) {
                this._releaseHorizontal('right')

                // 右を離したとき、左が押されていれば左を優先
                if (this.keyState.moveLeft) {
                    this._lastHorizontal = 'left'
                }
            }
        }

        // たまった入力を届いた順に処理する（_pollInput の頭で毎フレーム呼ぶ）。
        // 押す側はポーズ中なら捨てる（以前の keydown と同じ）。離す側は常に反映する。
        const drainInput = (now) => {
            const q = this._inputQueue
            if (!q.length) return
            for (let i = 0; i < q.length; i++) {
                const ev = q[i]
                if (ev.pad) {
                    if (!ev.down) applyPadUp(ev.action)
                    else if (!this.isPaused) applyPadDown(ev.action, now)
                } else {
                    if (!ev.down) applyKeyUp(ev.code)
                    else if (!this.isPaused) applyKeyDown(ev.code, ev.repeat, now)
                }
            }
            q.length = 0
        }

        this._keyDownHandler = (e) => {
            // 対戦モードでは versus-page がアクティブな場合のみ動作
            const activePageId = this.anchorPageId || (this.isVersusMode ? 'versus-page' : 'game-page');
            const gamePage = document.getElementById(activePageId)
            if (!gamePage || !gamePage.classList.contains('active')) return

            // GAMEOVER/FINISHの演出中（switchPage('result')まで）はリスタート/ポーズを
            // ここで奪って無効化する。isFinishingはisPausedと違いリスタートが素通りする
            // 抜け道になっていたため、演出中に押すと詰んだ状態のままstart()が走ってしまっていた
            // （MARATHON/SPRINT/ULTRA共通のバグ。設計 Phase5 §4.2）。
            if (this.isFinishing && (keys.restart.codes.includes(e.code) || keys.pause.codes.includes(e.code))) {
                e.preventDefault()
                return
            }

            // リスタート (ポーズ中・プレイ中問わず即座にやり直し)
            // 対戦モードではリスタートキーは router.js 側で管理するためスキップ
            if (!this.isVersusMode && keys.restart.codes.includes(e.code)) {
                e.preventDefault()
                if (e.repeat) return; // 長押しによる連続発火を防止
                this.start()
                return
            }

            // ポーズ
            // 対戦モードではポーズは router.js の toggleVersusPause() に委譲
            if (!this.isVersusMode && keys.pause.codes.includes(e.code)) {
                e.preventDefault()
                if (e.repeat) return; // 長押しによる連続発火を防止
                if (this.isCountingDown) return;
                this.togglePause()
                return
            }

            // ポーズ中は他のキー入力を無視
            if (this.isPaused) return

            if (keys.hardDrop.codes.includes(e.code) || keys.hold.codes.includes(e.code)) e.preventDefault()

            // フレームが回っていない（試合の外）ときは取り込まない
            if (!this._renderLoopId) return
            this._inputQueue.push({ pad: false, down: true, code: e.code, repeat: e.repeat })
        }

        this._keyUpHandler = (e) => {
            // フレームが回っていないときはその場で反映する（ためても取り込む人がいない）
            if (!this._renderLoopId) { applyKeyUp(e.code); return }
            this._inputQueue.push({ pad: false, down: false, code: e.code })
        }

        document.addEventListener('keydown', this._keyDownHandler)
        document.addEventListener('keyup', this._keyUpHandler)

        // 最適化：ループ内で毎回ID検索すると流石にチリツモで重くなるため、外で取得しておく
        // 対戦モードでは versus-page を参照する
        const activePageId = this.anchorPageId || (this.isVersusMode ? 'versus-page' : 'game-page');
        const gamePage = document.getElementById(activePageId);

        // 毎フレーム入力処理（同時入力対応）
        // ループ本体は rAF 駆動の startRenderLoop() から this._pollInput() として呼ばれる。
        // setInterval(…, 4) で 250Hz 回していた頃と違い rAF と同期するため、
        // tick が貯まらず描画と同フレームでキー反映される＝体感ラグが減る。
        this._pollInput = () => {
            if (!gamePage || !gamePage.classList.contains('active')) return
            const now = this.clock.now()
            // たまったキー・ゲームパッドの入力を先に取り込む（カウントダウン中は DAS の押した時刻を記録するだけ）
            drainInput(now)
            if (this.isPaused) return
            // カウントダウン中はDASの時間を裏で記録するだけで、操作の実行はしない
            if (this.isCountingDown) return;
            if (!this.mino) return;

            let acted = false
            let wasGrounded = this.isGrounded; // 操作前の接地状態を記憶

            const leftPressed = this.keyState.moveLeft;
            const rightPressed = this.keyState.moveRight;

            // 優先方向を決定（後押し優先）
            let dir = null;
            if (leftPressed && rightPressed) {
                dir = this._lastHorizontal;
            } else if (leftPressed) {
                dir = 'left';
            } else if (rightPressed) {
                dir = 'right';
            }

            // ─── DCD ①：新しいミノの出現（設置・ホールド） ───
            // ミノの差し替えを検知した最初のフレームで、溜まっているDASがあれば止める。
            if (this.mino !== this._dcdMino) {
                const isFirstMino = this._dcdMino === undefined
                this._dcdMino = this.mino
                this._dasBlockedLeft = false
                this._dasBlockedRight = false
                if (!isFirstMino && dir !== null) {
                    const pressTime = dir === 'left' ? this._leftPressTime : this._rightPressTime
                    if (pressTime !== null && now - pressTime >= this.DAS_DELAY) {
                        this._startDcd(dir, now)
                    }
                }
            }

            if (dir !== null) {
                const isLeft = dir === 'left'
                const dx = isLeft ? -1 : 1
                const pressTime = isLeft ? this._leftPressTime : this._rightPressTime
                if (pressTime !== null) {
                    const heldTime = now - pressTime
                    const lastMoveTime = isLeft ? this._lastMoveTimeLeft : this._lastMoveTimeRight

                    // 初回入力（押した瞬間）
                    if (lastMoveTime === 0) {
                        if (this.valid(dx, 0)) {
                            this.mino.x += dx
                            this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                            this.playSe('move')
                            acted = true
                        }
                        this._setLastMoveTime(dir, now)
                        this._setDasBlocked(dir, false)
                    }
                    // DAS後の連続移動
                    else if (heldTime >= this.DAS_DELAY &&
                        now - lastMoveTime >= this.ARR_INTERVAL) {
                        if (!(this._dcdDir === dir && now < this._dcdUntil)) {
                            if (this.valid(dx, 0)) {
                                // DCD ②：止まっていた方向が左右移動・回転で動けるようになった
                                const snap = isLeft ? this._dasBlockSnapLeft : this._dasBlockSnapRight
                                const blocked = isLeft ? this._dasBlockedLeft : this._dasBlockedRight
                                this._setDasBlocked(dir, false)
                                if (this.DCD_DELAY > 0 && blocked && snap &&
                                    (snap.x !== this.mino.x || snap.rotation !== this.mino.rotation)) {
                                    this._startDcd(dir, now)
                                } else {
                                    this.mino.x += dx
                                    this.lastActionWasRotation = false; // 移動したので回転フラグを解除
                                    this.playSe('move')
                                    acted = true
                                }
                            } else {
                                this._setDasBlocked(dir, true)
                            }
                            // DCD中は更新しない（DCD明けに ARR 待ちを挟まず即動かすため）
                            this._setLastMoveTime(dir, now)
                        }
                    }
                }
            }
            // ※ 逆方向を押している間も、元の方向の「止まっていた」状態は保持する
            //   （逆方向を離して元の方向に戻ったとき、動けるようになっていれば DCD ②を掛けるため）

            // ソフトドロップ（専用ARR）
            const currentLevelSpeed = LEVEL_SPEEDS[this.level] || 7;
            const currentSoftDropArr = currentLevelSpeed / 20;

            if (this.keyState.softDrop) {
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
            if (this.keyState.rotateCW) {
                if (!this._rotCWPressed) {
                    if (this.tryRotate(1)) {
                        this.updateLowestY(); // キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCWPressed = true
                }
            }
            if (!this.keyState.rotateCW) {
                this._rotCWPressed = false
            }

            if (this.keyState.rotateCCW) {
                if (!this._rotCCWPressed) {
                    if (this.tryRotate(-1)) {
                        this.updateLowestY(); // キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCCWPressed = true
                }
            }
            if (!this.keyState.rotateCCW) {
                this._rotCCWPressed = false
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

        if (this._gamepadLoop) {
            clearInterval(this._gamepadLoop)
            cancelAnimationFrame(this._gamepadLoop)
            this._gamepadLoop = null
        }
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

        // ゲームパッドを押した瞬間の処理（drainInput から呼ぶ）。
        // 単発系（ハードドロップ・ホールド）はその場で実行、継続系は keyState に反映して
        // キーボードと同じ _pollInput のロジック（DAS・ソフトドロップ・回転）を使う。
        const applyPadDown = (action, now) => {
            if (action === 'hardDrop' || action === 'hold') {
                if (this.isCountingDown || !this.mino) return
                if (action === 'hardDrop') this.hardDrop()
                else this.holdCurrentMino()
                return
            }
            if (this.keyState[action]) return // キーボードで押している
            this.keyState[action] = true
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
                if (!this.mino) return
                if (this.valid(0, 1)) {
                    const wasGrounded = this.isGrounded
                    this.mino.y++
                    this.updateLowestY()
                    this.lastActionWasRotation = false
                    this.score += 1
                    this.playSe('drop') // ソフトドロップ音（毎マス）
                    this.updateStatsDisplay()
                    this.checkGroundState(true, wasGrounded)
                    this.requestRedraw()
                }
            }
        }

        // ゲームパッドを離した瞬間の処理（キーアップ相当）
        const applyPadUp = (action) => {
            if (action === 'hardDrop' || action === 'hold') return
            if (!this.keyState[action]) return
            this.keyState[action] = false
            if (action === 'moveLeft') {
                this._releaseHorizontal('left')
                if (this.keyState.moveRight) this._lastHorizontal = 'right'
            }
            if (action === 'moveRight') {
                this._releaseHorizontal('right')
                if (this.keyState.moveLeft) this._lastHorizontal = 'left'
            }
            if (action === 'softDrop') {
                this._lastSoftDropTime = 0
            }
        }

        // ゲームパッド用ポーリングループ。
        // setInterval は rAF と別タイミングで発火して入力反映が揺れやすいため、
        // キーボード入力・重力と同じく描画フレームへ寄せる。
        const pollGamepad = () => {
            const pads = (navigator.getGamepads) ? navigator.getGamepads() : []
            let pad = null
            if (this._gamepadIndex !== null && pads[this._gamepadIndex]) pad = pads[this._gamepadIndex]
            else {
                // 最初に見つかったパッドを採用
                for (let i = 0; i < pads.length; i++) { if (pads[i]) { pad = pads[i]; break } }
            }
            if (!pad) {
                this._gamepadLoop = requestAnimationFrame(pollGamepad)
                return
            }

            const stickX = (pad.axes && pad.axes.length > 0) ? pad.axes[0] : 0;
            const stickY = (pad.axes && pad.axes.length > 1) ? pad.axes[1] : 0;

            // 各アクションについて現在押されているかを判定
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

                const prev = !!this._prevGamepadState[action]

                // 押した・離したときだけ処理する
                if (pressed === prev) continue
                this._prevGamepadState[action] = pressed

                // ポーズ・リスタートは試合そのものの操作ではないので即時（キーボードと同じ）
                if (action === 'pause' || action === 'restart') {
                    if (pressed) {
                        try {
                            if (action === 'pause') {
                                if (!this.isVersusMode && !this.isCountingDown && !this.isFinishing) this.togglePause()
                            } else {
                                if (!this.isVersusMode && !this.isFinishing) this.start()
                            }
                        } catch (e) {/* 防御的に例外握り潰す */ }
                    }
                    continue
                }

                // それ以外はキーボードと同じく、ためておいてフレームの頭で取り込む（applyPadDown / applyPadUp）
                if (!this._renderLoopId) {
                    // フレームが回っていない（試合の外）ときは離す側だけその場で反映する
                    if (!pressed) applyPadUp(action)
                    continue
                }
                this._inputQueue.push({ pad: true, down: pressed, action })
            }
            this._gamepadLoop = requestAnimationFrame(pollGamepad)
        }
        this._gamepadLoop = requestAnimationFrame(pollGamepad)

        // カウントダウン前に呼ばれたときは、ここでフレームを回し始める。
        // キーはフレームの頭でしか取り込まないので、カウントダウン中の DAS の先行チャージには
        // フレームが回っている必要がある（_startGameplay でもう一度回し直す）。
        if (this.isCountingDown) this.startRenderLoop()
    },
});
