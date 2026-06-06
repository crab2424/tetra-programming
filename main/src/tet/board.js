// ─────────────────────────────────────────────
// tet/board.js  ―  Game.prototype mixin
// ボード操作（ミノ生成/設置・落下/接地・移動・盤面判定）
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    getNextType() {
        if (this.bag.length === 0) {
            this.bag = [0, 1, 2, 3, 4, 5, 6];
            // シャッフル（Fisher-Yates）
            for (let i = this.bag.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    },

    // 新しいミノを出す
    popMino() {
        this.mino = this.nextQueue.shift();
        this.mino.spawn();

        // 出現位置での致命判定
        if (!this.valid(0, 0)) {
            // -3 などの固定値ではなく、現在の位置から1引く
            this.mino.y -= 1;
            if (!this.valid(0, 0)) {
                this.gameOver();
                return;
            }
        }

        this.nextQueue.push(new Mino(this.getNextType()));
        this.canHold = true

        // 状態・タイマー・カウントの初期化
        this.isGrounded = false;
        this.lowestY = this.mino.y;
        this.moveCount = 0;
        // T-spin判定フラグのリセット
        this.lastActionWasRotation = false;
        this.lastRotUsedPoint5 = false;

        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
        }
        this.startGravity(); // 重力をリセットして開始
    },

    // ミノを即座に固定する共通処理
    secureMino(viaHardDrop = false) {
        let isAllOutside = this.mino.blocks.every(block => (block.y + this.mino.y) < 0);

        // ─── T-spin判定（固定前に行う）───
        const tSpinResult = this.checkTSpin();

        this.mino.blocks.forEach(e => {
            e.x += this.mino.x
            e.y += this.mino.y
        })
        this.field.blocks = this.field.blocks.concat(this.mino.blocks)

        // 固定音：ハードドロップ時は harddrop と重ねて lock_hard（小音量）、通常時は lock（通常音量）
        this.playSe(viaHardDrop ? 'lock_hard' : 'lock');

        const renForCalc = this.ren; // ★ぷよ用火力計算のために加算前のRENを保持

        const linesCleared = this.field.checkLine()

        // ─── ライン消去・T-spin のSE ───
        if (tSpinResult !== null) {
            this.playSe('tspin');
        }
        
        if (linesCleared >= 4) {
            this.playSe('4lines');
        } else if (linesCleared === 3) {
            this.playSe('3lines');
        } else if (linesCleared === 2) {
            this.playSe('2lines');
        } else if (linesCleared === 1) {
            this.playSe('1line');
        }

        const isBtBAction = (linesCleared > 0 && (linesCleared === 4 || tSpinResult !== null));
        const isB2BTriggered = isBtBAction && this.backToBack;
        const currentRen = (linesCleared > 0 && this.ren > 0) ? this.ren : 0;

        const isPerfectClear = (this.field.blocks.length === 0);
        const is4Lines = (linesCleared === 4);

        // Scoring() の戻り値として火力（段数）を受け取る
        let generatedGarbage = this.Scoring(tSpinResult, linesCleared, isPerfectClear);
        this.updateStatsDisplay();

        if (tSpinResult !== null || isB2BTriggered || currentRen > 0 || isPerfectClear || is4Lines) {
            this.showActionLabels(tSpinResult, linesCleared, isB2BTriggered, currentRen, isPerfectClear, is4Lines);
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 相殺（オフセット）と送り返し処理
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (this.isVersusMode) {
            const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
            let isOpponentPuyo = false;
            if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
                isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
            } else if (opponent) {
                isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
            }

            //console.log(`[secureMino] prefix: ${this.canvasPrefix}, isOpponentPuyo: ${isOpponentPuyo}, pendingAttack(Before): ${this.pendingAttack}, pendingInternalAttack(Before): ${this.pendingInternalAttack}`);

            if (isOpponentPuyo) {
                // ★ 今回の新仕様：ライン消去時は今回発生分のみで相殺、設置時に溜まったゲージで相殺
                if (linesCleared > 0) {
                    // ── マージンステップ取得（null = 未突入） ──
                    const _ms = this._tetMarginStep; // null or 0〜5

                    // ── 対ぷよ攻撃用火力テーブル（マージン中のみ使用） ──
                    const _puyoTables = {
                        lines1: [0, 0, 1, 1, 1, 2],
                        lines2: [1, 1, 2, 2, 3, 4],
                        lines3: [2, 2, 3, 4, 5, 6],
                        lines4: [4, 5, 5, 6, 8, 10],
                        tspinSingle: [2, 2, 3, 4, 5, 6],
                        tspinDouble: [3, 3, 4, 5, 6, 8],
                        tspinTriple: [4, 5, 5, 6, 8, 10],
                    };
                    const _puyoBtbBonus = [1, 1, 2, 2, 3, 4];
                    const _puyoPcBonus  = [7, 7, 8, 9, 10, 12];
                    // REN追加ボーナス（従来RENボーナスにさらに加算）
                    const _puyoRenBonus = [0, 0, 1, 1, 1, 1];
                    // 対テト相殺用REN追加ボーナス（Scoring()と同じ定義）
                    const _tetRenBonus  = [0, 0, 1, 1, 1, 1];

                    // 1. 対ぷよ用アタックゲージ火力を計算
                    let puyoAttack = 0;
                    if (isPerfectClear) {
                        puyoAttack = (_ms === null) ? 6 : _puyoPcBonus[_ms];
                    } else {
                        if (_ms === null) {
                            // ── マージン未突入：従来の固定値 ──
                            if (tSpinResult === 'tspin') {
                                if (linesCleared === 1) puyoAttack = 2;
                                else if (linesCleared === 2) puyoAttack = 3;
                                else if (linesCleared === 3) puyoAttack = 5;
                            } else {
                                if (linesCleared === 2) puyoAttack = 1;
                                else if (linesCleared === 3) puyoAttack = 2;
                                else if (linesCleared === 4) puyoAttack = 4;
                            }
                            if (isB2BTriggered) puyoAttack += 1;
                            // 従来RENテーブル（2REN以降）
                            const renTable = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5];
                            let renVal = (renForCalc >= renTable.length) ? 5 : renTable[renForCalc];
                            puyoAttack += renVal;
                        } else {
                            // ── マージン中：テーブル参照 ──
                            if (tSpinResult === 'tspin') {
                                if (linesCleared === 1) puyoAttack = _puyoTables.tspinSingle[_ms];
                                else if (linesCleared === 2) puyoAttack = _puyoTables.tspinDouble[_ms];
                                else if (linesCleared === 3) puyoAttack = _puyoTables.tspinTriple[_ms];
                            } else {
                                if (linesCleared === 1) puyoAttack = _puyoTables.lines1[_ms];
                                else if (linesCleared === 2) puyoAttack = _puyoTables.lines2[_ms];
                                else if (linesCleared === 3) puyoAttack = _puyoTables.lines3[_ms];
                                else if (linesCleared === 4) puyoAttack = _puyoTables.lines4[_ms];
                            }
                            if (isB2BTriggered) puyoAttack += _puyoBtbBonus[_ms];
                            // 従来RENテーブル + マージン追加ボーナス（2REN以降）
                            const renTable = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5];
                            let renVal = (renForCalc >= renTable.length) ? 5 : renTable[renForCalc];
                            if (renForCalc >= 2) renVal += _puyoRenBonus[_ms];
                            puyoAttack += renVal;
                        }
                    }

                    // 2. 相殺用の内部火力（generatedGarbage）を対ぷよ用RENボーナス基準に揃え直す
                    //    Scoring()で計算済みの generatedGarbage はテト用REN追加ボーナス込みなので、
                    //    マージン中の場合のみ対ぷよ用REN追加ボーナスへ差し替える（未突入時は両方0なので変化なし）
                    if (!isPerfectClear && linesCleared > 0 && _ms !== null) {
                        const tetRenAdd  = (renForCalc >= 2) ? _tetRenBonus[_ms] : 0;
                        const puyoRenAdd = (renForCalc >= 2) ? _puyoRenBonus[_ms] : 0;
                        // 同じ値なので差し替えは不要だが、将来の変更に備えて明示的に処理
                        generatedGarbage = generatedGarbage - tetRenAdd + puyoRenAdd;
                    }

                    // ── 乗率適用（vsAttackMultiplierのみ。vsMarginMultiplierはぷよ側が管理） ──
                    const _vsMultTvP = (this.vsAttackMultiplier ?? 1.0);
                    const effectiveGenerated = (this.isVersusMode && generatedGarbage > 0)
                        ? Math.max(1, Math.floor(generatedGarbage * _vsMultTvP))
                        : generatedGarbage;
                    const effectivePuyoAttack = (this.isVersusMode && puyoAttack > 0)
                        ? Math.max(1, Math.floor(puyoAttack * _vsMultTvP))
                        : puyoAttack;

                    // 2. 「今回発生した実効火力」のみを使って相殺を試みる（溜まっているゲージは使わない）
                    let canceledGarbage = 0;
                    let remainGenerated = effectiveGenerated;

                    if (this.garbageQueue.length > 0 && effectiveGenerated > 0) {
                        remainGenerated = this.offsetGarbage(effectiveGenerated);
                        canceledGarbage = effectiveGenerated - remainGenerated;
                    }

                    // 3. 相殺に使われなかった分(remainGenerated)を内部火力の貯蓄に追加
                    this.pendingInternalAttack += remainGenerated;

                    // アタックゲージ(送信用)に蓄える火力 = 今回の実効ぶよ用火力 - 相殺ライン(負の場合は0)
                    let attackToAdd = Math.max(0, effectivePuyoAttack - canceledGarbage);
                    this.pendingAttack += attackToAdd;

                    //console.log(`[secureMino] -> 消去あり: 実効ぶよ用火力 ${effectivePuyoAttack}(内部 ${effectiveGenerated}), 相殺使用 ${canceledGarbage}, 現在の貯蓄(表示): ${this.pendingAttack}(内部: ${this.pendingInternalAttack})`);

                } else {
                    // ライン消去がない（設置のみ）場合、溜まっているゲージ（内部火力）を放出して相殺・送信を行う
                    // 内部火力は設置のたびに実効化された値を積み上げているので、ここでは再適用しない
                    let canceledGarbage = 0;
                    if (this.garbageQueue.length > 0 && this.pendingInternalAttack > 0) {
                        let beforeInternal = this.pendingInternalAttack;
                        this.pendingInternalAttack = this.offsetGarbage(this.pendingInternalAttack);
                        canceledGarbage = beforeInternal - this.pendingInternalAttack;
                    }

                    // 余った火力を計算して相手に送信
                    let sendAmount = Math.max(0, this.pendingAttack - canceledGarbage);
                    if (sendAmount > 0) {
                        //console.log(`[secureMino] -> 消去なし: 貯蓄から ${sendAmount} を相手に送信します`);
                        this.sendGarbage(sendAmount); // 実効化済み。sendGarbage内では再計算しない
                    }

                    // 放出後は両方ともリセット
                    this.pendingAttack = 0;
                    this.pendingInternalAttack = 0;
                }
                this.updateAttackGauge();
            } else {
                // ★従来通り（テト同士）── マージンテーブル適用済みの generatedGarbage をそのまま使用
                // （Scoring()内でマージンステップに応じた値を計算済みなので乗率補正は不要）
                if (generatedGarbage > 0) {
                    // vsAttackMultiplier のみ適用（マージン火力増加はテーブルで処理済み）
                    const _vsMultTvT = (this.vsAttackMultiplier ?? 1.0);
                    const effectiveGarbage = (this.isVersusMode && _vsMultTvT !== 1.0)
                        ? Math.max(1, Math.floor(generatedGarbage * _vsMultTvT))
                        : generatedGarbage;

                    // 実効火力で相殺し、余った分を送信
                    const remainder = this.offsetGarbage(effectiveGarbage);

                    if (remainder > 0) {
                        this.sendGarbage(remainder);
                    }
                }
            }
        }

        if (this.mode === 'sprint' && this.lines >= this.goalLines) {
            // 設置したミノのブロックはすでに絶対座標化されて field に追加済み。
            // this.mino を残したまま gameOver→drawAll するとミノが二重描画され、
            // mino.x/mino.y 分だけずれて（下にワープして）見えるので null にする。
            this.mino = null;
            this.gameOver(true); // クリア！
            return;
        } else if (this.mode === 'marathon' && this.goalLines !== Infinity && this.lines >= this.goalLines) {
            this.mino = null;
            this.gameOver(true); // クリア！
            return;
        }

        if (isAllOutside) {
            this.mino = null;
            this.gameOver();
            return;
        }

        // 次のミノが出現する直前（今のミノが固定された瞬間）に、自分に届いている火力を適用
        if (this.isVersusMode || this.garbageQueue.length > 0) {
            if (this.vsGarbageDamageOnClear !== false || linesCleared === 0) {
                this.applyGarbage();
            }
        }

        this.popMino()
    },

    // ハードドロップ
    hardDrop() {
        let dropDistance = 0;
        while (this.valid(0, 1)) {
            this.mino.y++
            dropDistance++;
        }

        // ハードドロップスコア加算（距離 × 2）
        if (dropDistance > 0) {
            this.score += dropDistance * 2;
            this.updateStatsDisplay();
        }

        // 実際に落下した場合のみ回転フラグをリセット
        // （その場ハードドロップは直前の回転をT-spin判定に活かす）
        if (dropDistance > 0) this.lastActionWasRotation = false;

        // タイマーを両方停止
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }

        this.playSe('harddrop')
        // lock 音は secureMino(true) 内で lock_hard（小音量）として鳴らすため、ここでは鳴らさない
        this.secureMino(true)
        this.drawAll()
    },

    dropMino() {
        // CPU操作中は重力を無効（ソフトドロップとの干渉を防ぐ）
        // フリーズ（接地）はcheckGroundStateで別途管理されるため影響なし
        if (this.gravityDisabled) return;
        if (this.valid(0, 1)) {
            this.mino.y++;
            this.updateLowestY();
        }
        this.checkGroundState();
        this.drawAll();
    },

    // 接地状態をチェックし、重力と固定猶予タイマーを切り替える
    checkGroundState(actionHappened = false, wasGrounded = false) {
        // 接地状態からの操作ならカウントを進める
        if (actionHappened && wasGrounded) {
            this.moveCount++;
        }

        if (!this.valid(0, 1)) {
            // ▼ 接地している場合 ▼
            if (!this.isGrounded) {
                this.isGrounded = true;
                if (this.timer) {
                    clearInterval(this.timer);
                    this.timer = null;
                }
            }

            // カウントが15回以上の場合は即座に強制固定
            if (this.moveCount >= 15) {
                if (this.lockTimer) {
                    clearTimeout(this.lockTimer);
                    this.lockTimer = null;
                }
                this.secureMino();
                // secureMino()内で次のミノが呼ばれ描画されるためここで終了
                return;
            }

            // まだ余裕がある場合は猶予タイマー開始（またはリセット）
            this.startLockTimer();
        } else {
            // ▼ 空中にいる場合 ▼
            // 15回超えでも空中なら自由に動ける（接地した瞬間に上のブロックで強制固定される）
            if (this.isGrounded) {
                this.isGrounded = false;
                if (this.lockTimer) {
                    clearTimeout(this.lockTimer);
                    this.lockTimer = null;
                }
                this.startGravity();
            }
        }
    },

    // 最低Y座標を更新し、更新されたら操作回数をリセットする
    updateLowestY() {
        if (this.mino.y > this.lowestY) {
            this.lowestY = this.mino.y;
            this.moveCount = 0; // 最低位置が更新されたら15カウントをリセット
        }
    },

    // 固定猶予タイマーの起動・リセット
    startLockTimer(delay = this.lockDelay) {
        if (this.lockTimer) clearTimeout(this.lockTimer);

        // ポーズ時の計算用に開始時刻と設定時間を記録
        this.lockStartTime = performance.now();
        this.lockRemaining = delay;

        this.lockTimer = setTimeout(() => {
            this.lockTimer = null;
            this.secureMino();
            this.drawAll();
        }, delay);
    },

    valid(moveX, moveY, rot = 0) {
        let newBlocks = this.mino.getNewBlocks(moveX, moveY, rot)
        return newBlocks.every(block => {
            return (
                block.x >= 0 &&
                block.y >= -5 &&
                block.x < COLS_COUNT &&
                block.y < ROWS_COUNT &&
                !this.field.has(block.x, block.y)
            )
        })
    },

    // ─────────────────────────────────────────
    // デバッグ用：初期盤面を2D配列で設定する
    //   board: 20行×10列の配列（board[0]が最上段、board[19]が最下段）
    //          1=ブロックあり、0=なし
    // ─────────────────────────────────────────
    applyDebugBoard(board) {
        if (!board) return;
        this.field.blocks = [];
        for (let row = 0; row < 20; row++) {
            for (let col = 0; col < 10; col++) {
                if (board[row][col] === 1) {
                    this.field.blocks.push(new Block(col, row, 7)); // type7 = グレー（ゴミブロック色）
                }
            }
        }
    },

    // ─────────────────────────────────────────
    // CPU / 外部から呼び出す単純移動ヘルパー
    // ─────────────────────────────────────────
    moveLeft() {
        if (this.valid(-1, 0)) {
            this.mino.x--;
            this.lastActionWasRotation = false;
            this.playSe('move');
            return true;
        }
        return false;
    },

    moveRight() {
        if (this.valid(1, 0)) {
            this.mino.x++;
            this.lastActionWasRotation = false;
            this.playSe('move');
            return true;
        }
        return false;
    },

    softDropOne() {
        if (this.valid(0, 1)) {
            this.mino.y++;
            this.score += 1;
            this.updateLowestY();
            return true;
        }
        return false;
    },
});
