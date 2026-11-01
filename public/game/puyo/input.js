// ─────────────────────────────────────────────
// puyo/input.js  ―  PuyoGame.prototype mixin
// キー/ゲームパッド入力・移動回転・接地判定
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

// ゲームパッドの押す・離すをキーと同じ処理に通すための仮のキーコード（keyCodes のアクション名 → コード）
const PUYO_PAD_CODE = {
    moveLeft: '#pad.moveLeft', moveRight: '#pad.moveRight', softDrop: '#pad.softDrop',
    quickDrop: '#pad.hardDrop', rotateCW: '#pad.rotateCW', rotateCCW: '#pad.rotateCCW',
};

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

        // ゲームパッドの押す・離すも同じ処理を通すため、アクションごとに仮のコードを足す
        // （'#pad.' で始まるコードはキーボードには無い）
        for (const action in PUYO_PAD_CODE) keyCodes[action] = keyCodes[action].concat(PUYO_PAD_CODE[action]);

        // ─── キーの取り込み（設計 source_assets/memory/record/tetlabo-record-design.md §4.1 D5）───
        // keydown / keyup とゲームパッドの押す・離すは _inputQueue にためるだけにして、
        // フレームの頭（_loop・カウントダウン中のループの最初の _drainInput）で届いた順に処理する。
        // 以前は移動・回転・クイックドロップを keydown の中で即実行していたが、キーが届く瞬間は
        // フレームと無関係なので、同じ操作でも落下・接地との前後が毎回変わっていた。
        // 画面に出るのはどちらも次の描画なので、見える遅れは増えない。
        // ポーズ・リスタートは試合そのものの操作ではないので、今までどおり keydown の中ですぐ処理する。
        this._inputQueue = [];

        // 押した瞬間の処理（以前の keydown 本体）
        const applyKeyDown = (code, isRepeat) => {
            this._heldCodes.add(code);
            for (const action in keyCodes) {
                if (keyCodes[action].includes(code)) this._keys[this._keyMap[action]] = true;
            }

            if (this._gs === 'spawnAnim' && !isRepeat) {
                if (keyCodes.moveLeft.includes(code)) this.inputBuffer.push('left');
                if (keyCodes.moveRight.includes(code)) this.inputBuffer.push('right');
                if (keyCodes.rotateCW.includes(code)) this.inputBuffer.push('cw');
                if (keyCodes.rotateCCW.includes(code)) this.inputBuffer.push('ccw');
            }

            if (keyCodes.moveLeft.includes(code)) {
                if (this._dasDir !== -1) {
                    this._dasDir = -1;
                    this._dasTimer = 0;
                    this._arrTimer = 0;
                    if (this._gs === 'falling') this._tryMove(-1);
                }
            } else if (keyCodes.moveRight.includes(code)) {
                if (this._dasDir !== 1) {
                    this._dasDir = 1;
                    this._dasTimer = 0;
                    this._arrTimer = 0;
                    if (this._gs === 'falling') this._tryMove(1);
                }
            }

            if (this._gs !== 'falling') return;

            // ★ クイックドロップ・回転はキーリピート（長押し）時は受け付けない（1回押し直したときのみ有効）
            if (keyCodes.quickDrop.includes(code)) {
                if (!isRepeat) this._tryQuickDrop();
                return;
            }
            if (keyCodes.rotateCW.includes(code)) {
                if (!isRepeat) this._tryRotate(1);
            } else if (keyCodes.rotateCCW.includes(code)) {
                if (!isRepeat) this._tryRotate(-1);
            }
        };

        // 離したときの処理（以前の keyup 本体）
        const applyKeyUp = (code) => {
            this._heldCodes.delete(code);
            for (const action in keyCodes) {
                if (keyCodes[action].includes(code) && !keyCodes[action].some(c => this._heldCodes.has(c))) {
                    delete this._keys[this._keyMap[action]];
                }
            }
            if (keyCodes.moveLeft.includes(code) && this._dasDir === -1 && !this._keys[this._keyMap.moveLeft]) this._dasDir = 0;
            if (keyCodes.moveRight.includes(code) && this._dasDir === 1 && !this._keys[this._keyMap.moveRight]) this._dasDir = 0;
        };

        this._applyInputEvent = (ev) => {
            if (ev.down) applyKeyDown(ev.code, ev.repeat);
            else applyKeyUp(ev.code);
        };

        // 押す・離すをためる。取り込むのはフレームの中（playing・starting）だけなので、
        // それ以外のときの押す側は捨て（以前の keydown と同じ）、離す側はその場で反映する。
        // ただし先にためた押す側が残っていれば、順番を崩さないよう離す側もためる。
        // VERSUS のカウントダウン中（starting）はフレームが回っていないが、ためておいて
        // 開始後の最初のフレームで取り込む（以前も押した状態だけは記録していた）。
        const enqueue = (down, code, repeat) => {
            const running = this.state === 'playing' || this.state === 'starting';
            if (down) {
                if (running) this._inputQueue.push({ down: true, code, repeat });
            } else if (running || this._inputQueue.length) {
                this._inputQueue.push({ down: false, code, repeat: false });
            } else {
                applyKeyUp(code);
            }
        };
        this._enqueueInput = enqueue;

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
            // ★ ポーズ中（PRACTICE設定パネルを開いている間を含む）は操作を無視する。
            //   これが無いとポーズ中の操作が溜まり、ポーズ解除の瞬間に一気に反映される。
            //   カウントダウン中(starting)は通す：押下状態(_keys/_dasDir)を記録して DAS チャージと
            //   下キー高速落下の先行入力を効かせるため。_gs==='spawn' なので移動/回転/ドロップは
            //   _gs 判定で不発になり、盤面は書き換わらない。
            if (this.state !== 'playing' && this.state !== 'starting') return;

            if (keyCodes.moveLeft.includes(e.code) || keyCodes.moveRight.includes(e.code) ||
                keyCodes.quickDrop.includes(e.code) || keyCodes.rotateCW.includes(e.code) ||
                keyCodes.rotateCCW.includes(e.code)) {
                e.preventDefault();
            }
            enqueue(true, e.code, e.repeat);
        };

        this._keyHandlerUp = (e) => {
            // ★ CPU制御時はキーの解放も無視する
            if (this.isCpuControlled) return;
            enqueue(false, e.code);
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
        // 押した状態（_heldCodes・_keys）は作り直したので、移動・回転などは離した扱いから始める
        // （押しっぱなしなら次の読み取りで押したとして拾い直す）。ポーズ・リスタートは押しっぱなしで繰り返さないよう残す
        for (const action in PUYO_PAD_CODE) this._gpPrevState[action] = false;

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

        // ゲームパッドの読み取りは描画フレームごと（rAF）。以前は setInterval(16) の別ループで
        // 移動・回転・クイックドロップをその場で実行していたが、キーボードと同じく押す・離すの変化だけを
        // _inputQueue にためて、ゲームのフレームの頭で取り込む。
        // ポーズ・リスタートは試合そのものの操作ではないので、今までどおりここですぐ処理する。
        const pollGamepad = () => {
            this._gamepadLoop = requestAnimationFrame(pollGamepad);

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

            const pressedNow = {
                moveLeft: isPressedByMappings(pad, gpConfig.moveLeft) || (stickX <= -deadzone),
                moveRight: isPressedByMappings(pad, gpConfig.moveRight) || (stickX >= deadzone),
                softDrop: isPressedByMappings(pad, gpConfig.softDrop) || (stickY >= deadzone),
                quickDrop: isPressedByMappings(pad, gpConfig.hardDrop) || (stickY <= -deadzone),
                rotateCW: isPressedByMappings(pad, gpConfig.rotateCW),
                rotateCCW: isPressedByMappings(pad, gpConfig.rotateCCW),
            };
            // 押した・離したときだけためる（押していないアクションのキーボード入力を離した扱いにしない）
            for (const action in pressedNow) {
                const pressed = pressedNow[action];
                if (pressed === !!this._gpPrevState[action]) continue;
                // 試合の外の押す側は捨てる。前の状態は離したままにしておき、試合が始まってから押したとして拾う
                if (pressed && this.state !== 'playing' && this.state !== 'starting') continue;
                this._gpPrevState[action] = pressed;
                this._enqueueInput(pressed, PUYO_PAD_CODE[action], false);
            }
        };
        this._gamepadLoop = requestAnimationFrame(pollGamepad);
    },

    _removeGamepadHandlers() {
        if (this._gamepadLoop) {
            cancelAnimationFrame(this._gamepadLoop);
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

    // たまったキー・ゲームパッドの入力を届いた順に処理する（フレームの頭で呼ぶ）
    _drainInput() {
        const q = this._inputQueue;
        if (!q || !q.length || !this._applyInputEvent) return;
        for (let i = 0; i < q.length; i++) this._applyInputEvent(q[i]);
        q.length = 0;
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

    // ─────────────────────────────────────────
    // CPU が盤面に触る口（設計 source_assets/memory/record/tetlabo-record-design.md §4.1 D6）
    // CPU（public/cpu/puyo/*）は操作ぷよ・高速落下キーをここを通してだけ動かす。録画（M6）ではここで手を記録する。
    // 中身は各 CPU がこれまで直接していた操作そのまま。呼ぶのは game.cpuSchedule / cpuFrame の中
    // （フレームの入力の所。core/cpu_port.js）だけにする。
    //   'move', dir          1 列移動（_tryMove）
    //   'rotate', dir        回転（_tryRotate。クイックターンも）
    //   'quickDrop'          クイックドロップ（_tryQuickDrop）
    //   'softDropStart'      CPU の高速落下の開始（自然落下のタイマーを 0 に戻す）
    //   'softDropStep', d    d マスぶん落とす（得点あり）。まだ着地していなければ true、着地したら false
    //   'forceLock'          着地位置へ下ろして固定を促す（lockTimer を満了にする）
    //   'softKey', on        高速落下キーを押す / 離す（人と同じ落ち方で置く）
    // ─────────────────────────────────────────
    cpuAction(type, a) {
        if (this.clock && !this._cpuRunning && !this._cpuWarned) {
            this._cpuWarned = true;
            console.warn('[cpuAction] フレームの入力の所（cpuSchedule / cpuFrame）の外で呼ばれました:', type);
        }
        let r;
        switch (type) {
            case 'move': r = this._tryMove(a); break;
            case 'rotate': r = this._tryRotate(a); break;
            case 'quickDrop': r = this._tryQuickDrop(); break;
            case 'softDropStart':
                // 自然落下タイマーをリセット（落下中に自然落下と競合させない）
                if (this.fallTimer !== undefined) this.fallTimer = 0;
                if (this.dropTimer !== undefined) this.dropTimer = 0;
                break;
            case 'softDropStep': {
                const limitY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);
                if (this.pivotY < limitY) {
                    const prevY = this.pivotY;
                    this.pivotY = Math.min(this.pivotY + a, limitY);
                    // ソフトドロップスコア加算（プレイヤーと同じ処理）
                    this.scoreFloat += this.pivotY - prevY;
                    if (this.scoreFloat >= 1) {
                        const add = Math.floor(this.scoreFloat);
                        this.score += add;
                        this.scoreFloat -= add;
                        if (typeof this._addDropScore === 'function') this._addDropScore(add);
                        this._updateScoreDisplay();
                    }
                    r = true;
                } else {
                    this.pivotY = limitY;
                    r = false;
                }
                break;
            }
            case 'forceLock':
                this.pivotY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);
                this.lockTimer = 99999;
                break;
            case 'softKey':
                this._keys[this._keyMap.softDrop] = !!a;
                break;
            default:
                console.warn('[cpuAction] 知らない操作:', type);
        }
        return r;
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
