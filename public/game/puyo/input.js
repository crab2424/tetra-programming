// ─────────────────────────────────────────────
// puyo/input.js  ―  PuyoGame.prototype mixin
// キー/ゲームパッド入力・移動回転・接地判定
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(PuyoGame.prototype, {

    // ══════════════════════════════════════════════
    // キーイベントハンドラ系
    // ══════════════════════════════════════════════

    _setKeyHandlers() {
        this._removeKeyHandlers();
        // ★ CPU操作モードであっても、PauseとRestartはプレイヤーの操作を受け付けるため、ここで早期リターンはしない

        const ks = (typeof loadKeys === 'function') ? loadKeys() : {};
        // アクション名 → 割り当てキーcode一覧（1アクションに複数キーを割り当てられる）
        const keyCodes = {
            moveLeft: ks.moveLeft ? ks.moveLeft.codes : ['ArrowLeft'],
            moveRight: ks.moveRight ? ks.moveRight.codes : ['ArrowRight'],
            softDrop: ks.softDrop ? ks.softDrop.codes : ['ArrowDown'],
            quickDrop: ks.hardDrop ? ks.hardDrop.codes : ['Space'], // ★ クイックドロップ追加
            rotateCW: ks.rotateCW ? ks.rotateCW.codes : ['ArrowUp'],
            rotateCCW: ks.rotateCCW ? ks.rotateCCW.codes : ['KeyZ'],
            pause: ks.pause ? ks.pause.codes : ['Escape'],
            restart: ks.restart ? ks.restart.codes : ['KeyR'],
        };
        // _keys/engine.js からはアクション名そのものをキーとして参照する（identity map）。
        // ゲームパッド側も同じ _keyMap 経由で this._keys[action] を書き込むため、
        // キーボード/ゲームパッドどちらの入力でも同じフラグに反映される。
        this._keyMap = {
            moveLeft: 'moveLeft', moveRight: 'moveRight', softDrop: 'softDrop',
            quickDrop: 'quickDrop', rotateCW: 'rotateCW', rotateCCW: 'rotateCCW',
            pause: 'pause', restart: 'restart',
        };
        // 物理キーコードの押下状態。複数キーが同じアクションに割り当てられている場合、
        // 片方を離してももう片方が押されていればアクション継続中として扱うために使う。
        this._heldCodes = new Set();

        this._keyHandlerDown = (e) => {
            // ★ 【修正】待機中のインスタンスは無視
            if (this.state === 'idle') return;

            const activePageId = this.anchorPageId || (this.isVersusMode ? 'versus-page' : 'game-page');
            const gamePage = document.getElementById(activePageId);
            if (!gamePage || !gamePage.classList.contains('active')) return;

            // ★ PauseとRestartキーは、CPU操作時であっても処理を優先して通す
            if (keyCodes.restart.includes(e.code)) {
                e.preventDefault();
                if (!this.isVersusMode) {
                    const pauseOverlay = document.getElementById('pause-overlay');
                    if (pauseOverlay) pauseOverlay.classList.remove('active');
                    // ★ CPUテスト(ぷよ)は盤面リセットに加えてCPUコントローラも作り直す。
                    //   this.start() だけだと旧コントローラの worker / RAF / 着手予測オーバーレイが残留する。
                    if (this.currentMode === 'test' && typeof restartPuyoCpuTest === 'function') {
                        restartPuyoCpuTest();
                    } else {
                        this.start();
                    }
                }
                return;
            }

            if (keyCodes.pause.includes(e.code)) {
                e.preventDefault();
                if (!this.isVersusMode) {
                    this._onPauseKey();
                }
                return;
            }

            // ★ これ以降の操作（移動、回転、ドロップ等）は、CPU制御時にはプレイヤーの入力を無視する
            if (this.isCpuControlled) return;

            const isRepeat = e.repeat;
            this._heldCodes.add(e.code);
            for (const action in keyCodes) {
                if (keyCodes[action].includes(e.code)) this._keys[this._keyMap[action]] = true;
            }

            if (this._gs === 'spawnAnim' && !isRepeat) {
                if (keyCodes.moveLeft.includes(e.code)) this.inputBuffer.push('left');
                if (keyCodes.moveRight.includes(e.code)) this.inputBuffer.push('right');
                if (keyCodes.rotateCW.includes(e.code)) this.inputBuffer.push('cw');
                if (keyCodes.rotateCCW.includes(e.code)) this.inputBuffer.push('ccw');
            }

            if (keyCodes.moveLeft.includes(e.code)) {
                e.preventDefault();
                if (this._dasDir !== -1) {
                    this._dasDir = -1;
                    this._dasTimer = 0;
                    this._arrTimer = 0;
                    if (this._gs === 'falling') this._tryMove(-1);
                }
            } else if (keyCodes.moveRight.includes(e.code)) {
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
            if (keyCodes.quickDrop.includes(e.code)) {
                e.preventDefault();
                if (!isRepeat) this._tryQuickDrop();
                return;
            }

            // ★ 回転もキーリピート時は受け付けない（1回押し直したときのみ有効）
            if (keyCodes.rotateCW.includes(e.code)) {
                e.preventDefault();
                if (!isRepeat) this._tryRotate(1);
            } else if (keyCodes.rotateCCW.includes(e.code)) {
                e.preventDefault();
                if (!isRepeat) this._tryRotate(-1);
            }
        };

        this._keyHandlerUp = (e) => {
            // ★ CPU制御時はキーの解放も無視する
            if (this.isCpuControlled) return;

            this._heldCodes.delete(e.code);
            for (const action in keyCodes) {
                if (keyCodes[action].includes(e.code) && !keyCodes[action].some(c => this._heldCodes.has(c))) {
                    delete this._keys[this._keyMap[action]];
                }
            }
            if (keyCodes.moveLeft.includes(e.code) && this._dasDir === -1 && !this._keys[this._keyMap.moveLeft]) this._dasDir = 0;
            if (keyCodes.moveRight.includes(e.code) && this._dasDir === 1 && !this._keys[this._keyMap.moveRight]) this._dasDir = 0;
        };

        document.addEventListener('keydown', this._keyHandlerDown);
        document.addEventListener('keyup', this._keyHandlerUp);

        this._setupGamepadHandlers();
    },

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
    },

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
            const activePageId = this.anchorPageId || (this.isVersusMode ? 'versus-page' : 'game-page');
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
    },

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
    },

    _onPauseKey() {
        // UIの表示非表示、ボタンのバインドはすべて router.js に委譲
        if (typeof toggleGamePause === 'function') {
            toggleGamePause();
        }
    },

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
    },

    // SE再生の薄いラッパ。CPU操作の盤面でもSEを鳴らす（プレイヤーとの二重再生は許容する）
    // 戻り値: 実際に鳴らしたら true、チャタリング防止で間引いたら false
    // （online側の送信フックが「間引かれた音を相手にだけ送ってしまう」二重鳴りを防ぐのに使う）。
    playSe(key) {
        // fix.ogg（puyo_fix / puyo_drop）のみ、特殊なチャタリング防止を行う。
        // ・「1盤面につき」50ms間隔（この timer はインスタンス毎なので盤面ごとに独立）。
        // ・vsで両方ぷよでも、プレイヤー盤面とCPU盤面は別インスタンス＝別 timer のため、
        //   両者の fix 間隔が50ms未満でも互いに抑制されず鳴る。
        if (key === 'puyo_fix' || key === 'puyo_drop') {
            const now = performance.now();
            if (this._lastFixSeTime != null && now - this._lastFixSeTime < 50) return false;
            this._lastFixSeTime = now;
        }

        window.SeManager?.play(key);
        return true;
    },

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
    },

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
    },

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
    },

    _checkMoveLock() {
        let limitY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);
        if (this.pivotY >= limitY) {
            this.moveLockCount++;
            if (this.moveLockCount >= 15) {
                this._fixPuyo();
            }
        }
    },

    _canPlace(pc, py, rot) {
        let r1 = Math.floor(py);
        let r2 = Math.ceil(py);

        if (!this._canPlaceGrid(pc, r1, rot)) return false;
        if (r1 !== r2 && !this._canPlaceGrid(pc, r2, rot)) return false;

        return true;
    },

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
    },

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
    },

    _calcLimitY_Single(c, y) {
        let r = Math.floor(y);
        while (r < PConfig.rows && this._isCellEmpty(c, r + 1)) {
            r++;
        }
        return r;
    },
});
