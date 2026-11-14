// ─────────────────────────────────────────────
// tet/board.js  ―  Game.prototype mixin
// ボード操作（ミノ生成/設置・落下/接地・移動・盤面判定）
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

// IHS で助かるときだけ出現を待つ長さ（設計 source_assets/memory/tet_zone/tetlabo-irs-ihs-design.md §3.2。仮）
const IHS_RESCUE_DELAY_MS = 100;

Object.assign(Game.prototype, {

    // ─── 乱数（設計: source_assets/memory/record/tetlabo-record-design.md §4.1 D3）───
    // 試合の頭（_initGameState）で用途別の列を作り直す。VERSUS は先に nextMatchSeed と
    // rngSide を渡して、両盤面のツモを同じ列にする（versus.js）。渡されていなければ新しいシード。
    _newRngStreams() {
        const seed = this.nextMatchSeed || GameRng.newSeed();
        this.nextMatchSeed = null;
        this.matchSeed = seed;
        const side = this.rngSide || 0;
        this._rng = {
            tumo:    GameRng.stream(seed, 'tet.tumo'),
            garbage: GameRng.stream(seed, 'tet.garbage.' + side),
        };
    },

    _rngStream(name) {
        if (!this._rng) this._newRngStreams();
        return this._rng[name];
    },

    getNextType() {
        if (this.bag.length === 0) {
            this.bag = [0, 1, 2, 3, 4, 5, 6];
            // シャッフル（Fisher-Yates）
            // オンライン対戦では this.tumoRng（共有シードRNG）が注入され、全員同じツモ列になる。
            // それ以外は試合のシードから作ったツモ用の列（VERSUS は両盤面で同じ列）
            const rng = this.tumoRng || this._rngStream('tumo');
            for (let i = this.bag.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    },

    // 内部の NEXT を n 本以上にする（CPU lv7 が確定 NEXT を深さぶん読むため。cpu/tet/lv7/cpu7.js）。
    //   同じ乱数から引くのでツモの順は変わらない。表示は先頭5個のまま。popMino は1本引いて1本足すので長さは保たれる
    ensureNextQueue(n) {
        while (this.nextQueue.length < n) {
            this.nextQueue.push(new Mino(this.getNextType()));
        }
    },

    // NEXT の末尾に 1 本足す（QUIZ は問題のミノ列から足すので差し替える。quiz/quiz.js）
    _refillNext() {
        this.nextQueue.push(new Mino(this.getNextType()));
    },

    // 新しいミノを出す
    popMino() {
        // IHS で助かるときだけ、少し待ってから出す（待ち明けにもう一度ここへ来る）
        if (this._ihsRescueWait()) return;
        // 置いた後に先行回転・先行ホールドのキーが残っているときは、DCD のあいだ隠して待つ（rotation.js §12）
        if (this._spawnHideStart()) return;

        // 出現位置での致命判定は _spawnMino の中（先行ホールド・先行回転を当てた後。rotation.js）
        if (!this._spawnMino(this.nextQueue.shift(), { allowIhs: true })) {
            // ZONE の発動中は、まず ZONE を終わらせて盤面を下げ、同じミノを出し直す（tet/zone.js）
            if (!this._zoneRespawnAfterTopOut()) {
                this.gameOver();
                return;
            }
        }

        this._refillNext();
        // 先行ホールドで出たミノは、ふつうのホールドと同じくもうホールドできない
        this.canHold = !this._spawnIhsUsed

        // 状態・タイマー・カウントの初期化
        this.isGrounded = false;
        this.lowestY = this.mino.y;
        this.moveCount = 0;
        // T-spin判定フラグのリセット
        this.lastActionWasRotation = false;
        this.lastRotUsedPoint5 = false;

        this._cancelLockTimer();
        this.startGravity(); // 重力をリセットして開始
    },

    // ミノを即座に固定する共通処理
    secureMino(viaHardDrop = false) {
        // ZONE の発動中か（この手の消去は「底へ移す」。tet/zone.js）
        const inZone = !!this.zoneActive;
        let isAllOutside = this.mino.blocks.every(block => (block.y + this.mino.y) < 0);

        // ─── T-spin判定（固定前に行う）───
        const tSpinResult = this.checkTSpin();

        this.mino.blocks.forEach(e => {
            e.x += this.mino.x
            e.y += this.mino.y
        })
        this.field.blocks = this.field.blocks.concat(this.mino.blocks)
        this.field.markDirty()

        // 固定音：ハードドロップ時は harddrop と重ねて lock_hard（小音量）、通常時は lock（通常音量）
        this.playSe(viaHardDrop ? 'lock_hard' : 'lock');

        const renForCalc = this.ren; // ★ぷよ用火力計算のために加算前のRENを保持

        // ZONE の発動中は 20 段より上も見て、そろった段を底へ移す（窒息の判定より先に数える）
        const linesCleared = inZone ? this._zoneCheckLine() : this.field.checkLine()
        // ZONE のメーター（発動中はたまらない）
        if (!inZone && this.zoneEnabled) this._zoneAddMeter(linesCleared)

        // ─── ライン消去・T-spin のSE ───
        if (tSpinResult !== null) {
            this.playSe('tspin');
        }
        
        if (inZone && linesCleared > 0) {
            this.playSe('zone_line');
        } else if (linesCleared >= 4) {
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

        // ZONE の発動中は「ZONE 段以外のブロックが 0 個」で PC
        const isPerfectClear = inZone
            ? (linesCleared > 0 && this._zoneIsPerfectClear())
            : (this.field.blocks.length === 0);
        const is4Lines = (linesCleared === 4);

        // Scoring() の戻り値として火力（段数）を受け取る
        let generatedGarbage = this.Scoring(tSpinResult, linesCleared, isPerfectClear);
        // VERSUS の ZONE 発動中は消去ごとの火力をその場では出さない（相殺もしない）。ためておき、終了時に
        // 表の火力へ足して出す（tet/zone.js _endZone。設計 tetlabo-zone-versus-cpu-design.md §11.1）
        if (inZone && this.isVersusMode) {
            this.zoneAtkPool = (this.zoneAtkPool || 0) + generatedGarbage;
            generatedGarbage = 0;
        }
        this.updateStatsDisplay();

        // APM計測（生成基準）：相殺の有無に関わらず、この設置で生成した火力を積む。
        // 対戦中は attack bias（vsAttackMultiplier）込みの実効火力（送信・相殺と同じ式）で数える。
        // 相殺で無駄になった火力も評価対象にする／シングルプレイでも計測できるようにするため、
        // 送信直前ではなくここで数える（呼び出し側で数える理由はsendGarbageがonlineで丸ごと
        // 上書きされるためだが、生成基準に変えた今はそもそも送信経路を通らなくても数えられる）。
        if (generatedGarbage > 0) {
            const _apmMult = this.isVersusMode ? (this.vsAttackMultiplier ?? 1.0) : 1.0;
            this._countAttackSent(_apmMult !== 1.0
                ? Math.floor(generatedGarbage * _apmMult + 1e-9)
                : generatedGarbage);
        }

        // ライン消去音(1line〜4lines/tspin)に重ねて鳴らすボーナス音。
        // RENは意図的に無音のまま（消去音と鳴り続けて煩いため）。
        // 録画の印: 攻撃が出たライン消去（シングルでも対戦なら送っていた量で判定。core/replay.js）
        if (this._rec && generatedGarbage > 0) {
            this._rec.attack(this, replayTetLabel(tSpinResult, linesCleared, isB2BTriggered, currentRen, isPerfectClear), generatedGarbage);
        }

        if (isB2BTriggered) this.playSe('b2b');
        if (isPerfectClear && linesCleared > 0) this.playSe('perfect_clear');

        if (tSpinResult !== null || isB2BTriggered || currentRen > 0 || isPerfectClear || is4Lines) {
            this.showActionLabels(tSpinResult, linesCleared, isB2BTriggered, currentRen, isPerfectClear, is4Lines);
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 相殺（オフセット）と送り返し処理
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (this.isVersusMode) {
            const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
            let isOpponentPuyo = false;
            if (this.opponentRule) {
                // オンライン対戦: コントローラが相手ルールを明示注入する。
                // window._cpuGame / versus* グローバルはオンラインでは未設定のため、これを最優先で使う。
                isOpponentPuyo = this.opponentRule === 'puyo';
            } else if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
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
                        ? Math.floor(generatedGarbage * _vsMultTvP + 1e-9)
                        : generatedGarbage;
                    const effectivePuyoAttack = (this.isVersusMode && puyoAttack > 0)
                        ? Math.floor(puyoAttack * _vsMultTvP + 1e-9)
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

                    // 余った火力を計算して相手に送信（対ぷよ＝おじゃま個数）
                    let sendAmount = Math.max(0, this.pendingAttack - canceledGarbage);
                    if (sendAmount > 0) {
                        //console.log(`[secureMino] -> 消去なし: 貯蓄から ${sendAmount} を相手に送信します`);
                        this.sendGarbage(sendAmount); // 実効化済み。sendGarbage内では再計算しない
                    }

                    // ★ 混在多人数戦: 同時にテト相手へは tet ライン火力（相殺後の内部火力残り）を送る。
                    //   pendingInternalAttack は generatedGarbage 相当を実効化して積んだ tet ライン量。
                    //   テト相手が居ない通常の異種戦(1v1)では _hasTetOpp=false なので何も起きない。
                    const tetLeftover = this.pendingInternalAttack;
                    if (this._hasTetOpp && tetLeftover > 0 && typeof this.sendGarbageCrossTet === 'function') {
                        this.sendGarbageCrossTet(tetLeftover);
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
                    // vsAttackMultiplier のみ適用（マージン火力増加はテーブルで処理済み）。
                    // 切り捨てで 0 になれば相殺も送信もしない（最低 1 には引き上げない。vs_settings.js）。
                    // 乗率は分数（1/3 など）なので、ちょうど割り切れる所がわずかに下へずれないよう誤差を足す
                    const _vsMultTvT = (this.vsAttackMultiplier ?? 1.0);
                    const effectiveGarbage = (this.isVersusMode && _vsMultTvT !== 1.0)
                        ? Math.floor(generatedGarbage * _vsMultTvT + 1e-9)
                        : generatedGarbage;

                    // 実効火力で相殺し、余った分を送信
                    const remainder = effectiveGarbage > 0 ? this.offsetGarbage(effectiveGarbage) : 0;

                    if (remainder > 0) {
                        this.sendGarbage(remainder);
                    }
                }
            }
        }

        // ZONE: 時間切れの後の 1 手、または窒息（全ブロックが枠の上）なら、この手の消去を数えた後で終える。
        // 窒息でも ZONE 段があれば盤面が下がるので続ける（tetlabo-zone-design.md §4.5）
        if (inZone && this.zoneActive && (this.zoneTimeUp || isAllOutside)) {
            const lowered = this.zoneLines > 0;
            this._endZone(isAllOutside ? 'topout' : 'time');
            if (isAllOutside && lowered) isAllOutside = false;
        }

        // 録画: 設置ごとの盤面のハッシュを残す／再生: 録画と照らし合わせ、合わなければ止める（core/replay.js）
        if (this._rec) this._rec.lock(this);
        else if (this._replay) this._replay.onLock(this);

        if (this.mode === 'sprint' && this.lines >= this.goalLines) {
            // 設置したミノのブロックはすでに絶対座標化されて field に追加済み。
            // this.mino を残したまま gameOver→drawAll するとミノが二重描画され、
            // mino.x/mino.y 分だけずれて（下にワープして）見えるので null にする。
            this.mino = null;
            this.gameOver(true); // クリア！
            return;
        } else if ((this.mode === 'marathon' || this.mode === 'zone') && this.goalLines !== Infinity && this.lines >= this.goalLines) {
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
        // ZONE の発動中に置いた手では着弾させない（予告には積まれ、猶予も進む。終了後の「消去しない設置」で着弾）
        if (inZone) {
            // 着弾なし
        } else if (this.isVersusMode || this.garbageQueue.length > 0) {
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
        this._cancelLockTimer();

        this.playSe('harddrop')
        // lock 音は secureMino(true) 内で lock_hard（小音量）として鳴らすため、ここでは鳴らさない
        this.secureMino(true)
        this.requestRedraw();
    },

    dropMino() {
        // ★ 保険: ミノ未生成（出現前/ゲーム間/休眠インスタンス）のとき重力tickは何もしない。
        //   取り残された gravity interval が valid()→this.mino.getNewBlocks で落ちるのを防ぐ。
        if (!this.mino) return;
        // CPU操作中は重力を無効（ソフトドロップとの干渉を防ぐ）
        // フリーズ（接地）はcheckGroundStateで別途管理されるため影響なし
        if (this.gravityDisabled) return;
        if (this.valid(0, 1)) {
            this.mino.y++;
            this.updateLowestY();
        }
        this.checkGroundState();
        this.requestRedraw();
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

            // ─── PRACTICE: 自由落下0のときの固定仕様（設計 §8.1）───
            // 「置くまで固定しない」＝ソフトドロップ押下中のみ固定タイマーを進め、
            // 離したら 0 にリセットする（リセット側は _applyGravityTick が毎フレ担当）。
            // 15回操作での強制固定も同条件下では無効化する。
            // ZONE の発動中も同じ（tetlabo-zone-design.md §4.4）
            if (this.practiceNoLock || this.zoneActive) {
                if (!(this.keyState && this.keyState.softDrop)) {
                    this._cancelLockTimer();
                    return;
                }
                this.startLockTimer();
                return;
            }

            // カウントが15回以上の場合は即座に強制固定
            if (this.moveCount >= 15) {
                this._cancelLockTimer();
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
                this._cancelLockTimer();
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
        this._cancelLockTimer();

        // ポーズ時の計算用に開始時刻と設定時間を記録
        this.lockStartTime = this.clock.now();
        this.lockRemaining = delay;

        // ゲーム時計の予約（フレームの頭の clock.advance() の中で実行される）
        this.lockTimer = this.clock.schedule(delay, () => {
            this.lockTimer = null;
            this.secureMino();
            this.requestRedraw();
        });
    },

    // 固定猶予の予約を取り消す（外から止めるときもこれを使う。lockTimer は setTimeout の ID ではない）
    // 出現待ち（IHS で助かるときの待ち）の予約も一緒に取り消す。待っている間はミノがいないので、
    // ここへ来るのは終了・リスタート・巻き戻し・盤面入れ替えなど「出現をやり直す」ときだけ
    _cancelLockTimer() {
        if (this.lockTimer) {
            this.clock.cancel(this.lockTimer);
            this.lockTimer = null;
        }
        if (this._ihsRescueTimer) {
            this.clock.cancel(this._ihsRescueTimer);
            this._ihsRescueTimer = null;
        }
        // 非表示 DCD（先行回転・先行ホールドの暴発対策。rotation.js _spawnHideStart）も同じ扱い
        if (this._spawnHideTimer) {
            this.clock.cancel(this._spawnHideTimer);
            this._spawnHideTimer = null;
        }
        this._spawnHide = null;
    },

    // おじゃま降下猶予の予約を全部取り消す
    _cancelGarbageTimers() {
        if (this._garbageTimers) {
            this._garbageTimers.forEach(t => { if (t.id) this.clock.cancel(t.id); });
        }
        this._garbageTimers = [];
    },

    valid(moveX, moveY, rot = 0) {
        const newBlocks = this.mino.getNewBlocks(moveX, moveY, rot)
        const field = this.field
        for (let i = 0; i < newBlocks.length; i++) {
            const b = newBlocks[i]
            if (b.x < 0 || b.x >= COLS_COUNT) return false
            if (b.y < -5 || b.y >= ROWS_COUNT) return false
            if (field.has(b.x, b.y)) return false
        }
        return true
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
        this.field.markDirty();
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
            this.playSe('drop'); // ソフトドロップ音（毎マス）
            return true;
        }
        return false;
    },

    // ─────────────────────────────────────────
    // CPU が盤面に触る口（設計 source_assets/memory/record/tetlabo-record-design.md §4.1 D6）
    // CPU（public/cpu/tet/*）はミノ・HOLD・重力をここを通してだけ動かす。録画（M6）ではここで手を記録する。
    // 中身は各 CPU がこれまで直接していた操作そのまま（SE・得点・T-spin 判定への影響も変えない）。
    // 呼ぶのは game.cpuSchedule / cpuFrame の中（フレームの入力の所。core/cpu_port.js）だけにする。
    //   'hold'                 HOLD
    //   'rotate', dir          回転（キックあり。tryRotate）
    //   'move', dir            1 マス移動（moveLeft / moveRight。lastActionWasRotation も下ろす）
    //   'shift', dir, se       1 マス移動だけ（lastActionWasRotation はそのまま。se=true で移動音）
    //   'softDrop'             1 マス落とす（softDropOne。得点・落下音あり）
    //   'softDropQuiet'        1 マス落とす（得点あり・落下音なし）
    //   'stepToX', x, se       x へ 1 マス寄せる。動けなければ x へ飛ばす。まだ寄せる必要があれば true
    //   'warp', x, y, rot      その位置・向きへ飛ばす（T-spin の最後の回転扱い）
    //   'teleport', rot, x, y  出現位置 y で向きを変えてから x へ飛ばす（重なるなら x はそのまま）
    //   'hardDrop'             ハードドロップ
    //   'gravity', off         CPU が操作している間の重力の停止（true で止める）
    //   'zone'                 ZONE 発動（発動できたら true）
    // 戻り値はそれぞれの操作の結果（動けたか等）。
    // ─────────────────────────────────────────
    cpuAction(type, a, b, c) {
        // 録画: CPU の手を入力として残す（再生では CPU を動かさずにこの手を流す。core/replay.js）
        if (this._rec) this._rec.cpu(this, type, [a, b, c]);
        if (this.clock && !this._cpuRunning && !this._cpuWarned) {
            this._cpuWarned = true;
            console.warn('[cpuAction] フレームの入力の所（cpuSchedule / cpuFrame）の外で呼ばれました:', type);
        }
        let r;
        const mino = this.mino;
        switch (type) {
            case 'hold': r = this.holdCurrentMino(); break;
            case 'rotate': r = this.tryRotate(a); break;
            case 'move': r = a < 0 ? this.moveLeft() : this.moveRight(); break;
            case 'shift':
                r = false;
                if (mino && this.valid(a, 0)) {
                    mino.x += a;
                    if (b) this.playSe('move');
                    r = true;
                }
                break;
            case 'softDrop': r = this.softDropOne(); break;
            case 'softDropQuiet':
                r = false;
                if (mino && this.valid(0, 1)) {
                    mino.y++;
                    this.score += 1;
                    this.updateLowestY();
                    r = true;
                }
                break;
            case 'stepToX': {
                r = false;
                if (!mino) break;
                const beforeX = mino.x;
                if (mino.x < a) {
                    const prevX = mino.x;
                    if (this.valid(1, 0)) mino.x++;
                    if (mino.x < a) {
                        if (prevX === mino.x) mino.x = a;
                        else r = true;
                    }
                } else if (mino.x > a) {
                    const prevX = mino.x;
                    if (this.valid(-1, 0)) mino.x--;
                    if (mino.x > a) {
                        if (prevX === mino.x) mino.x = a;
                        else r = true;
                    }
                }
                // 1マスでも実際に動いたら移動音を鳴らす（飛ばした補正も含む）
                if (b && mino.x !== beforeX) this.playSe('move');
                break;
            }
            case 'warp':
                if (!mino) break;
                mino.x = a;
                mino.y = b;
                while (mino.rotation !== c) {
                    mino.rotate();
                    mino.rotation = (mino.rotation + 1) % 4;
                }
                this.lastActionWasRotation = true;
                this.lastRotUsedPoint5 = true;
                break;
            case 'teleport': {
                if (!mino) break;
                // まずY座標を安全な場所（出現位置）に戻してから回転する
                if (c !== undefined) mino.y = c;
                const rotationsNeeded = (a - mino.rotation + 4) % 4;
                for (let i = 0; i < rotationsNeeded; i++) {
                    mino.rotate();
                    mino.rotation = (mino.rotation + 1) % 4;
                }
                // 移動した結果が重なる場合はX座標を元に戻す
                const prevX = mino.x;
                mino.x = b;
                if (!this.valid(0, 0)) mino.x = prevX;
                break;
            }
            case 'hardDrop': r = this.hardDrop(); break;
            case 'gravity': this.gravityDisabled = !!a; break;
            case 'zone': r = this.activateZone(); break;   // ZONE 発動（tet/zone.js）
            default:
                console.warn('[cpuAction] 知らない操作:', type);
        }
        if (this.requestRedraw) this.requestRedraw();
        return r;
    },
});
