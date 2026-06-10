// ─────────────────────────────────────────────
// puyo/engine.js  ―  PuyoGame.prototype mixin
// ゲームループ・コア処理（フィールド/連鎖/落下/タイマー/表示更新）
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(PuyoGame.prototype, {

    // ══════════════════════════════════════════════
    // 以下、ゲームループ・コア処理
    // ══════════════════════════════════════════════

    _initField() {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        this.field = Array.from({ length: totalRows }, () => new Array(PConfig.cols).fill(0));
    },

    _getCell(col, row) {
        if (row <= -PConfig.hiddenRows) return 0;

        const r = row + PConfig.hiddenRows;
        if (r < 0 || r >= this.field.length) return undefined;
        if (col < 0 || col >= PConfig.cols) return undefined;
        return this.field[r][col];
    },

    _setCell(col, row, val) {
        const r = row + PConfig.hiddenRows;
        if (r < 0 || r >= this.field.length) return;
        if (col < 0 || col >= PConfig.cols) return;
        this.field[r][col] = val;
    },

    _isCellEmpty(c, r) {
        if (c < 0 || c >= PConfig.cols) return false;
        if (r >= PConfig.rows) return false;
        const val = this._getCell(c, r);
        return val === 0 || val === undefined;
    },

    _isFieldEmpty() {
        for (let r = PConfig.hiddenRows; r < this.field.length; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                if (this.field[r][c] !== 0) return false;
            }
        }
        return true;
    },

    _initNextQueue() {
        this.nextQueue = [];
        const pair1 = this._makePair();
        this.nextQueue.push(pair1);

        const usedInFirst = new Set(pair1);
        const unusedColors = this.activeColors.filter(c => !usedInFirst.has(c));
        let excludeColor = null;
        if (unusedColors.length > 0) {
            excludeColor = unusedColors[Math.floor(this._tumoRandom() * unusedColors.length)];
        }

        const pair2 = this._makePair(excludeColor);
        this.nextQueue.push(pair2);

        // ★ 内部でNEXTを20まで拡張する
        while (this.nextQueue.length < 20) {
            this.nextQueue.push(this._makePair());
        }
    },

    _makePair(excludeColor = null) {
        let availableColors = this.activeColors;
        if (excludeColor !== null) {
            availableColors = this.activeColors.filter(c => c !== excludeColor);
        }
        const c1 = availableColors[Math.floor(this._tumoRandom() * availableColors.length)];
        const c2 = availableColors[Math.floor(this._tumoRandom() * availableColors.length)];
        return [c1, c2];
    },

    _dequeueNext() {
        const pair = this.nextQueue.shift();
        // ★ 消費後も常に20を維持する
        while (this.nextQueue.length < 20) {
            this.nextQueue.push(this._makePair());
        }
        return pair;
    },

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
        // オンライン対戦: 直前ツモまでに確定した盤面スナップショット＋新ペアを相手へ送る
        //   （ここに来た時点で前ツモの連鎖・おじゃま降下は解決済み＝盤面は settled）
        if (window.OnlineHooks) {
            window.OnlineHooks.puyoLock(this);
            window.OnlineHooks.puyoSpawn(this);
        }
        return true;
    },

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
    },

    _calcFixCycles() {
        let isSoftDrop = this._keys[this._keyMap.softDrop];
        if (isSoftDrop && this.lastRotationInfo) {
            if (Math.round(this.pivotY) - Math.floor(this.lastRotationInfo.pivotY) <= 1) {
                return 1;
            }
        }
        return 2;
    },

    _beginFixAnimWait() {
        let maxDur = 0;
        for (let anim of this.activeAnims) {
            let remaining = anim.duration - anim.timer;
            if (remaining > maxDur) maxDur = remaining;
        }
        this.fixAnimTimer = 0;
        this.fixAnimDuration = maxDur;
        this._gs = 'fixAnim';
    },

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
    },

    _update(dt) {
        this._updateDAS(dt);

        if (this.ojamaUpdateQueue.length > 0) {
            this.ojamaUpdateQueue[0].timer -= dt;
            if (this.ojamaUpdateQueue[0].timer <= 0) {
                let q = this.ojamaUpdateQueue.shift();
                this._applyOjamaOffset(q.amount, q.tetAmount || 0);
            }
        }

        // ★ stage1(internal) → stage2(grace): 受け手側で dt 減算（ポーズ中は _update 非実行で自動停止）
        if (this.garbageQueue.length > 0) {
            let anyCleared = false;
            for (const g of this.garbageQueue) {
                if (g.internal && g.internalTimer !== undefined) {
                    g.internalTimer -= dt;
                    if (g.internalTimer <= 0) {
                        g.internal = false; // 青(予告)化。ready 確定は _confirmSentGarbage が行う
                        anyCleared = true;
                    }
                }
            }
            if (anyCleared) this.updateGarbageGauge();
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
                    if (window.OnlineHooks && window.OnlineHooks.puyoFixSe) window.OnlineHooks.puyoFixSe(this);

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
                    // オンライン対戦: 連鎖判定の直前＝ペア確定盤面を相手へ送る。
                    //   受信側パペットはこの盤面から連鎖演出を自前で再生する（puyo_fix もここで鳴る）。
                    //   ★ fixWait5f は連鎖の各リンク（消去→落下→再固定）ごとに再入するため、
                    //     ここを無条件で送ると N 連鎖が「1連鎖×N回」に分割され、受信側の連鎖再生が
                    //     リンクごとに中断される（＝消去点滅も飛ぶ）。連鎖前の確定盤面を1枚だけ送れば
                    //     受信側パペットが実エンジンで連鎖を自走再生できるので、ピース確定直後
                    //     （まだ連鎖していない chainCount === 0）の最初の1回だけに限定する。
                    if (this.chainCount === 0 && window.OnlineHooks && window.OnlineHooks.puyoLockChain) {
                        window.OnlineHooks.puyoLockChain(this);
                    }
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

                        // ★ ぷよ→テト：相殺＋ライン算出を「消去」のこの瞬間に確定する。
                        // （pendingOjama を今この時点で読むので、点滅〜消去間に届いたおじゃまも相殺対象に入る）
                        this._resolveTetAttack();

                        // ★ 追加: 相手からの火力を相殺する時のみ、自分の火力が0でも最低1個だけ相殺する
                        let queuedOffset = this.ojamaUpdateQueue.reduce((sum, q) => sum + q.amount, 0);
                        let effectiveOjama = this.pendingOjama - queuedOffset;
                        if (effectiveOjama > 0 && this.pendingFire === 0) {
                            this.pendingFire = 1;
                        }

                        // ★ ぷよが消えた瞬間に、その場で相殺→送信を済ませる（旧+500ms遅延を撤去）。
                        // 「常に送られた火力を送り手か受け手のどちらかに存在させる」ため、送り手キューでの
                        // 滞留をなくす。視覚遅延の500msは受け手側の stage1(internal/非表示) へ移設している。
                        // （全消しで持ち越されたpendingFireも、ここで1連鎖目として送られる）
                        if (this.pendingFire > 0 || this.tetPendingFire > 0) {
                            this._applyOjamaOffset(this.pendingFire, this.tetPendingFire);
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
    },

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
    },

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
    },

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
            if (!viaQuickDrop) {
                this.playSe('puyo_fix');
                if (window.OnlineHooks && window.OnlineHooks.puyoFixSe) window.OnlineHooks.puyoFixSe(this);
            }

            this.splitPuyo = { col: pc, y: pr, color: this.pivotColor };
            this._gs = 'splitting';
        } else if (!pivotFloating && childFloating) {
            this._setCell(pc, pr, this.pivotColor);
            this._addPuyoAnim(fr_p, pc, cycles);
            // 片方が固定して振動開始：クイックドロップ時は puyo_drop と重なるため避ける
            if (!viaQuickDrop) {
                this.playSe('puyo_fix');
                if (window.OnlineHooks && window.OnlineHooks.puyoFixSe) window.OnlineHooks.puyoFixSe(this);
            }

            this.splitPuyo = { col: cc, y: cr, color: this.childColor };
            this._gs = 'splitting';
        } else {
            this._setCell(pc, pr, this.pivotColor);
            this._setCell(cc, cr, this.childColor);

            this._addPuyoAnim(fr_p, pc, cycles);
            this._addPuyoAnim(fr_c, cc, cycles);
            // 2つ同時に固定して振動開始：クイックドロップ時は puyo_drop と重なるため避ける
            if (!viaQuickDrop) {
                this.playSe('puyo_fix');
                if (window.OnlineHooks && window.OnlineHooks.puyoFixSe) window.OnlineHooks.puyoFixSe(this);
            }
            this._beginFixAnimWait();
        }
    },

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
    },

    _findErasable() {
        return this._findErasableInField(this.field);
    },

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
    },

    _applyErase() {
        if (!this._erasingCells) return;
        for (const { r, c } of this._erasingCells) {
            this.field[r][c] = 0;
        }
        this._erasingCells = null;
    },

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

        // ★ ぷよ→テト火力変換（相殺＋ライン算出）は「消去」タイミングで _resolveTetAttack() が行う。
        // ここ（点滅）では計算素材(add, n)だけ保存し、同じ連鎖リンクの消去時に渡す。
        this._tetCalcAdd = add;
        this._tetCalcN = n;

        if (this.scoreEl) {
            this.scoreEl.style.fontSize = '18px';
            this.scoreEl.style.whiteSpace = 'nowrap';
            this.scoreEl.textContent = this.chainScoreStr;
        }
        this._updateChainDisplay(this.chainCount);
    },

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
    },

    _applyDropAnim() {
        if (!this._dropAnim) return;
        for (const col of this._dropAnim) {
            for (const cell of col.cells) {
                this.field[cell.toR][col.c] = cell.color;
            }
        }
    },

    _beginGameOver() {
        this.playSe('gameover');
        this._stopTimer();
        this._removeKeyHandlers();
        this._clearChainTextDOM();
        this.isAllClear = false; // ★ ゲームオーバー時にALL CLEARを消す
        this.state = 'gameover';

        // オンライン対戦: 自分の topout を相手へ通知
        if (window.OnlineHooks) window.OnlineHooks.gameOver(this);

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
    },

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
    },

    _startTimer() {
        this.elapsed = 0;
        this._timerRunning = true;
        this._timerStart = performance.now();
        this._timerTick();
    },

    _stopTimer() {
        if (this._timerRunning) {
            this.elapsed += performance.now() - this._timerStart;
            this._timerRunning = false;
        }
        if (this._timerReqId) {
            cancelAnimationFrame(this._timerReqId);
            this._timerReqId = null;
        }
    },

    _timerTick() {
        if (!this._timerRunning) return;
        const now = performance.now();
        const total = this.elapsed + (now - this._timerStart);
        this._updateTimeDisplay(total);
        this._timerReqId = requestAnimationFrame(() => this._timerTick());
    },

    _formatTime(ms) {
        const total = Math.floor(ms / 10);
        const cs = total % 100;
        const s = Math.floor(total / 100) % 60;
        const m = Math.floor(total / 6000);
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    },

    _updateScoreDisplay() {
        if (this.scoreEl) {
            this.scoreEl.style.fontSize = '';
            this.scoreEl.style.whiteSpace = '';
            this.scoreEl.textContent = this.score;
        }
    },

    _updateTimeDisplay(ms) {
        if (this.timeEl) this.timeEl.textContent = this._formatTime(ms);
    },

    _updateChainDisplay(chain) {
        if (this.linesEl) this.linesEl.textContent = chain > 0 ? chain : 0;
        if (this.levelEl) this.levelEl.textContent = this.chainMax;
    },
});
