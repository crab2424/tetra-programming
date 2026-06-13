// ─────────────────────────────────────────────
// puyo/ojama.js  ―  PuyoGame.prototype mixin
// 対戦・おじゃま通信 API
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(PuyoGame.prototype, {

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
            // ★ キャンバス上端を下限とし、そこから上方向に積む（フィールドに被らない）
            //    bottom:100% でコンテナ下端をキャンバス上端に合わせ、行が増えると上へ伸びる
            this.yokokuContainer.style.bottom = '100%';
            this.yokokuContainer.style.top = 'auto';
            this.yokokuContainer.style.left = '0';
            this.yokokuContainer.style.width = '100%';
            this.yokokuContainer.style.display = 'flex';
            this.yokokuContainer.style.flexDirection = 'column'; // 上=1行目, 下=2行目
            this.yokokuContainer.style.justifyContent = 'flex-end';
            this.yokokuContainer.style.alignItems = 'flex-start'; // 左上基準
            this.yokokuContainer.style.gap = '1px';
            this.yokokuContainer.style.pointerEvents = 'none';
            this.yokokuContainer.style.zIndex = '20';

            // ★ おじゃま予告コンテナ(position:absolute)の包含ブロックを確保する。
            //    ただし親が既に配置済み（#container は fixed、versus-container は relative）
            //    の場合は触らない。fixed を relative で上書きするとソロ画面の
            //    中央スケール（translate(-50%,-50%)）が壊れ、盤面が右上へずれてしまう。
            if (getComputedStyle(canvas.parentNode).position === 'static') {
                canvas.parentNode.style.position = 'relative';
            }
            canvas.parentNode.style.overflow = 'visible';
            canvas.parentNode.appendChild(this.yokokuContainer);
        }
    },

    _updateOjamaYokoku() {
        if (!this.yokokuContainer) this._initOjamaYokokuDOM();
        if (!this.yokokuContainer) return;

        // ★ 差分更新：表示するおじゃま総量が前回と同じなら DOM 再構築をスキップする。
        //    予告の見た目はこの総量（とコンテナ幅）のみに依存するため、総量が不変なら
        //    innerHTML破棄 → <img>全再生成（再デコード＋drop-shadow再計算）→ reflow を丸ごと省ける。
        //    連鎖中は火力送信・相殺ごとに本メソッドが多発するため、ここでの早期returnが効く。
        // stage1(internal) は非表示。stage2/stage3 のみ予告として表示する
        const displayAmount = this.garbageQueue.reduce((sum, g) => sum + (g.internal ? 0 : g.amount), 0);
        if (displayAmount === this._lastYokokuAmount) return;
        this._lastYokokuAmount = displayAmount;

        this.yokokuContainer.innerHTML = '';

        let amount = displayAmount;
        if (amount <= 0) return;

        // ★ 桁ごとに「絵(アイコン)を個数分」並べて描画する
        //    進数表記は据え置き。各桁の個数 q の分だけアイコン画像を並べる。
        //    img: assets/images/p_images/Ojama/ 配下のファイル名（拡張子なし）
        //    size: 表示サイズ(px)。彗星は大きく、小石は小さめ
        const units = [
            { val: 1440, img: 'comet', size: 60 }, // 彗星(水色)
            { val: 720, img: 'crown', size: 51 }, // 王冠(橙)
            { val: 360, img: 'moon', size: 51 }, // 月(黄)
            { val: 180, img: 'star', size: 51 }, // 星(黄/五芒星)
            { val: 30, img: 'rock', size: 51 }, // 岩(赤)
            { val: 6, img: 'big', size: 51 }, // 石(白)
            { val: 1, img: 'small', size: 51 }  // 小石(白)
        ];

        // ── 表示するアイコンを大きい桁から順に列挙 ──
        //    各要素 { u, label }。label がある場合はアイコン1個＋「×N」表記にする。
        //    ★ 彗星(1440)のみ、6個を超える大量描画を防ぐため ×N 表記に切り替える
        const COMET_MAX_ICONS = 6;
        const icons = [];
        for (let u of units) {
            let q = Math.floor(amount / u.val);
            amount = amount % u.val;
            if (q <= 0) continue;
            if (u.val === 1440 && q > COMET_MAX_ICONS) {
                icons.push({ u, label: '×' + q });
            } else {
                for (let i = 0; i < q; i++) icons.push({ u });
            }
        }
        if (icons.length === 0) return;

        const GAP = 1;
        // コンテナ幅（=キャンバス表示幅）を1行目の折り返し基準にする
        const maxW = this.yokokuContainer.clientWidth || (PConfig.cols * PConfig.cellSize);

        const makeImg = (u) => {
            // 先読み済みのデコード済み Image があれば clone して使い回す（再fetch/再デコード回避）。
            // 未先読み時は従来どおり都度生成（フォールバック）。
            const cached = PuyoGame._sharedOjamaImages && PuyoGame._sharedOjamaImages[u.img];
            const img = cached ? cached.cloneNode(false) : document.createElement('img');
            if (!cached) img.src = PConfig.ojamaImagePath + u.img + '.png';
            img.width = u.size;
            img.height = u.size;
            img.style.width = u.size + 'px';
            img.style.height = u.size + 'px';
            img.style.objectFit = 'contain';
            img.style.filter = 'drop-shadow(0 0 3px #000)';
            img.draggable = false;
            return img;
        };
        // item = { u, label? }。label があればアイコン＋「×N」をまとめた1要素を返す
        const makeIcon = (item) => {
            const img = makeImg(item.u);
            if (!item.label) return img;
            const wrap = document.createElement('div');
            wrap.style.display = 'inline-flex';
            wrap.style.alignItems = 'center';
            wrap.appendChild(img);
            const span = document.createElement('span');
            span.textContent = item.label;
            span.style.color = '#00e5ff';
            span.style.fontFamily = '"Orbitron", monospace';
            span.style.fontWeight = '900';
            span.style.fontSize = Math.round(item.u.size * 0.6) + 'px';
            span.style.lineHeight = '1';
            span.style.textShadow = '0 0 4px #000, 0 0 8px #00e5ff, 2px 2px 0 #000';
            wrap.appendChild(span);
            return wrap;
        };
        const makeRow = () => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.flexWrap = 'nowrap'; // 行内は折り返さない（2行目は横にはみ出してよい）
            row.style.alignItems = 'center';
            row.style.gap = GAP + 'px';
            return row;
        };

        // ── 最大2行に振り分け ──
        //    1行目: 幅 maxW を超える手前まで。残りは全て2行目へ（横はみ出し許容）
        const row1 = makeRow();
        const row2 = makeRow();
        let w = 0;
        let useRow2 = false;
        for (const item of icons) {
            // ×N 表記の要素はラベル幅も概算で加味する
            const itemW = item.u.size + (item.label ? item.label.length * Math.round(item.u.size * 0.6) * 0.6 : 0);
            if (!useRow2) {
                const add = itemW + (w > 0 ? GAP : 0);
                if (w > 0 && w + add > maxW) useRow2 = true;
            }
            if (!useRow2) {
                row1.appendChild(makeIcon(item));
                w += itemW + GAP;
            } else {
                row2.appendChild(makeIcon(item));
            }
        }

        this.yokokuContainer.appendChild(row1);
        if (row2.childNodes.length > 0) this.yokokuContainer.appendChild(row2);
    },

    updateGarbageGauge() {
        this._updateOjamaYokoku();
        // オンライン対戦: 自分の予告ゲージ状態を相手へ通知（相手側パペットに可視化させる）
        if (window.OnlineHooks) window.OnlineHooks.gaugeUpdate(this);
    },

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

        // オンライン対戦: 相手はネット越し。ローカルのパペットへ積まず、ネットで送る。
        if (window.OnlineHooks && window.OnlineHooks.active && this === window._game) {
            window.OnlineHooks.sendGarbage(amount, holes, true);
            return;
        }

        // ★ stage1「内部のみ」(internal:true・非表示) として送る。
        //    500ms 後に internal を解除して stage2「猶予(青)」へ移す（視覚遅延を受け手側で持つ）。
        //    stage2→stage3(ready/点滅) への確定は従来どおり _confirmSentGarbage（送り手の連鎖終了）が行う。
        const garbageObj = { amount: amount, holes: holes, ready: false, internal: true };
        opponent.garbageQueue.push(garbageObj);

        // 自分が送った火力をリストに保持しておく
        this.sentGarbageThisTurn.push(garbageObj);

        // ── stage1(internal) → stage2(grace) の 500ms タイマー ──
        const INTERNAL_MS = 500;
        if (opponent instanceof PuyoGame) {
            // ぷよ受け手：dt ベースで受け手の _update が減算する（ポーズ中は _update 非実行で自動停止）
            garbageObj.internalTimer = INTERNAL_MS;
        } else {
            // テト受け手：game.js と同じ _garbageTimers(setTimeout) 方式でポーズ対応
            if (!opponent._garbageTimers) opponent._garbageTimers = [];
            const timerEntry = { obj: garbageObj, duration: INTERNAL_MS, remaining: null, id: null };
            timerEntry.cb = () => {
                timerEntry.id = null;
                // 相殺で消滅していなければ stage2(青)へ移す
                if (opponent.garbageQueue.includes(garbageObj) && garbageObj.amount > 0) {
                    garbageObj.internal = false;
                    if (typeof opponent.updateGarbageGauge === 'function') opponent.updateGarbageGauge();
                }
                const idx = opponent._garbageTimers.indexOf(timerEntry);
                if (idx !== -1) opponent._garbageTimers.splice(idx, 1);
            };
            opponent._garbageTimers.push(timerEntry);
            if (opponent.isPaused) {
                timerEntry.remaining = INTERNAL_MS; // 受け手がポーズ中なら resume 時に計時開始
            } else {
                timerEntry.start = performance.now();
                timerEntry.id = setTimeout(timerEntry.cb, INTERNAL_MS);
            }
        }

        if (typeof opponent.updateGarbageGauge === 'function') {
            opponent.updateGarbageGauge();
        }
    },

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
    },

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
    },

    _generateOjama() {
        let drop = 0;
        let limit = 30;

        // 降るおじゃまは、stage3(ready:true かつ internalでない)もののみ（internal優先）
        for (let i = 0; i < this.garbageQueue.length && drop < limit; i++) {
            if (this.garbageQueue[i].ready && !this.garbageQueue[i].internal && this.garbageQueue[i].amount > 0) {
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
    },

    // ══════════════════════════════════════════════
    // ★ ぷよ→テト火力変換処理（混合戦でのみ動作）— 呼び出しは「消去」タイミング
    //   数式・閾値は従来どおり。相殺の評価時点を点滅→消去へ「呼ぶ場所だけ」移設。
    //   これにより相殺・基本相殺(+1)・送信が全て消去で揃い、点滅〜消去間に届いた
    //   おじゃまも相殺対象に入る。
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
    // ══════════════════════════════════════════════
    _resolveTetAttack() {
        const _isOpponentTet = (() => {
            if (!this.isVersusMode) return false;
            const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
            if (!opponent) return false;
            // PuyoGame インスタンスでなければテトとみなす
            return !(opponent instanceof PuyoGame) && (typeof opponent.gameOver === 'function');
        })();
        if (!_isOpponentTet) return;

        const add = this._tetCalcAdd;
        const n = this._tetCalcN;

        {
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
    },
});
