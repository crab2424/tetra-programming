// ══════════════════════════════════════════════
    // キーイベントハンドラ系
    // ══════════════════════════════════════════════

    _setKeyEvnent() {
        // CPU制御モードの場合はキーイベントを一切設定しない
        if (this.isCpuControlled) return;
        this._removeKeyHandlers();
        // ★ CPU操作モードであっても、PauseとRestartはプレイヤーの操作を受け付けるため、ここで早期リターンはしない

        // 押されているキーを管理
        this.keyState = {}

        const ks = (typeof loadKeys === 'function') ? loadKeys() : {};
        this._keyMap = {
            moveLeft: ks.moveLeft ? ks.moveLeft.code : 'ArrowLeft',
            moveRight: ks.moveRight ? ks.moveRight.code : 'ArrowRight',
            softDrop: ks.softDrop ? ks.softDrop.code : 'ArrowDown',
            quickDrop: ks.quickDrop ? ks.quickDrop.code : 'Space', // ★ クイックドロップ追加
            rotateCW: ks.rotateCW ? ks.rotateCW.code : 'ArrowUp',
            rotateCCW: ks.rotateCCW ? ks.rotateCCW.code : 'KeyZ',
            pause: ks.pause ? ks.pause.code : 'Escape',
            restart: ks.restart ? ks.restart.code : 'KeyR',
        };

        this._keyHandlerDown = (e) => {
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
            if (e.code === this._keyMap.quickDrop) {
                e.preventDefault();
                this._tryQuickDrop();
                return;
            }

            if (e.code === this._keyMap.rotateCW) {
                e.preventDefault();
                this._tryRotate(1);
            } else if (e.code === this._keyMap.rotateCCW) {
                e.preventDefault();
                this._tryRotate(-1);
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