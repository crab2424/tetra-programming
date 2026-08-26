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

        // ★ ノード再利用プール（種類別）＋ row1/row2（使い回す固定コンテナ）。
        //    全消し→作り直しだと、生成直後の要素は cloneNode 済みでも
        //    デコード済みビットマップが未紐付けのままで、更新の瞬間だけ
        //    全アイコンが一瞬空白になる（詳細は [[project_ojama_yokoku_diff]]）。
        //    既にマウント済み/プールに退避済みのノードは動かすだけなら
        //    再デコードが走らないため、位置差分で再利用してちらつきを消す。
        //    yokokuContainer 自体は使い回されることがある（_clearYokokuDOM は
        //    innerHTML='' でコンテナの中身だけ消す）ため、row1/row2 が無い
        //    （＝直前でクリアされた）場合はここで再生成する。
        if (!this._yokokuRow1 || !this._yokokuRow1.parentNode) {
            this._yokokuPool = {};
            this._yokokuMounted = [];

            // row2は空のとき display:none にするだけでDOMからは外さない。
            const makeRow = () => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.flexWrap = 'nowrap'; // 行内は折り返さない（2行目は横にはみ出してよい）
                row.style.alignItems = 'center';
                row.style.gap = '1px';
                return row;
            };
            this._yokokuRow1 = makeRow();
            this._yokokuRow2 = makeRow();
            this._yokokuRow2.style.display = 'none';
            this.yokokuContainer.appendChild(this._yokokuRow1);
            this.yokokuContainer.appendChild(this._yokokuRow2);
        }
    },

    _updateOjamaYokoku() {
        // ★ _initOjamaYokokuDOM は yokokuContainer 既存時もrow1/row2の有無だけ見て
        //   軽量に早期returnするので、呼び出しコストは無視できる（_clearYokokuDOM で
        //   row1/row2 だけ吹き飛んだケースをここで確実に拾うため毎回呼ぶ）。
        if (!this.yokokuContainer || !this._yokokuRow1 || !this._yokokuRow1.parentNode) {
            this._initOjamaYokokuDOM();
        }
        if (!this.yokokuContainer) return;

        // ★ 差分更新：表示するおじゃま総量が前回と同じなら DOM 再構築をスキップする。
        //    連鎖中は火力送信・相殺ごとに本メソッドが多発するため、ここでの早期returnが効く。
        // stage1(internal) は非表示。stage2/stage3 のみ予告として表示する
        const displayAmount = this.garbageQueue.reduce((sum, g) => sum + (g.internal ? 0 : g.amount), 0);
        if (displayAmount === this._lastYokokuAmount) return;
        this._lastYokokuAmount = displayAmount;

        let amount = displayAmount;
        if (amount <= 0) {
            this._unmountAllYokokuIcons();
            return;
        }

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
        if (icons.length === 0) {
            this._unmountAllYokokuIcons();
            return;
        }

        const GAP = 1;
        // コンテナ幅（=キャンバス表示幅）を1行目の折り返し基準にする
        const maxW = this.yokokuContainer.clientWidth || (PConfig.cols * PConfig.cellSize);

        // ── 最大2行に振り分け ──
        //    1行目: 幅 maxW を超える手前まで。残りは全て2行目へ（横はみ出し許容）
        const row1Items = [];
        const row2Items = [];
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
                row1Items.push(item);
                w += itemW + GAP;
            } else {
                row2Items.push(item);
            }
        }

        this._reconcileYokokuRow(this._yokokuRow1, row1Items, 1);
        this._reconcileYokokuRow(this._yokokuRow2, row2Items, 2);
        this._yokokuRow2.style.display = row2Items.length > 0 ? '' : 'none';
    },

    /**
     * row(1/2)を items（{u, label?}の並び）に合わせて更新する。
     * 位置ごとに既存ノードと種類(key=u.img)・ラベル有無を比較し、
     *  - 一致: そのまま使う（ラベル文字だけ更新）
     *  - 不一致: プールから同種を取り出して差し替え。無ければ新規生成
     * を行い、全消し→作り直しによるデコード待ち（ちらつき）を避ける。
     */
    _reconcileYokokuRow(rowEl, items, rowNum) {
        const prevForRow = this._yokokuMounted.filter(m => m.row === rowNum);
        const others = this._yokokuMounted.filter(m => m.row !== rowNum);

        const nextForRow = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const key = item.u.img;
            const hasLabel = !!item.label;
            const entry = prevForRow[i];

            if (entry && entry.key === key && entry.hasLabel === hasLabel) {
                if (hasLabel && entry.labelSpan) entry.labelSpan.textContent = item.label;
                nextForRow.push(entry);
                continue;
            }

            if (entry) this._releaseYokokuEntry(entry);

            const reused = this._takeYokokuFromPool(key, hasLabel);
            const newEntry = reused || this._makeYokokuEntry(item.u, hasLabel);
            newEntry.key = key;
            newEntry.hasLabel = hasLabel;
            if (hasLabel && newEntry.labelSpan) newEntry.labelSpan.textContent = item.label;
            nextForRow.push(newEntry);
        }

        // 余ったentryはプールへ退避（破棄しない＝次回同種が来たら再利用できる）
        for (let i = items.length; i < prevForRow.length; i++) {
            this._releaseYokokuEntry(prevForRow[i]);
        }

        // DOM順序をitemsの順に合わせる（既に正しい位置ならappendChildは無害な自己移動）
        for (const entry of nextForRow) {
            entry.row = rowNum;
            rowEl.appendChild(entry.el);
        }

        this._yokokuMounted = others.concat(nextForRow);
    },

    _takeYokokuFromPool(key, hasLabel) {
        const bucket = this._yokokuPool[key];
        if (!bucket || bucket.length === 0) return null;
        for (let i = 0; i < bucket.length; i++) {
            if (bucket[i].hasLabel === hasLabel) return bucket.splice(i, 1)[0];
        }
        return null;
    },

    _releaseYokokuEntry(entry) {
        if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
        if (!this._yokokuPool[entry.key]) this._yokokuPool[entry.key] = [];
        // プール肥大化防止（種類ごとに上限を設ける）
        if (this._yokokuPool[entry.key].length < 16) {
            this._yokokuPool[entry.key].push(entry);
        }
    },

    _unmountAllYokokuIcons() {
        if (!this._yokokuMounted || this._yokokuMounted.length === 0) return;
        for (const entry of this._yokokuMounted) this._releaseYokokuEntry(entry);
        this._yokokuMounted = [];
    },

    /** 先読み済みのデコード済み Image があれば clone して使い回す（再fetch/再デコード回避）。
     *  未先読み時は従来どおり都度生成（フォールバック）。 */
    _makeYokokuImg(u) {
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
    },

    // entry = { el, img, labelSpan }。label があればアイコン＋「×N」をまとめた1要素にする
    _makeYokokuEntry(u, hasLabel) {
        const img = this._makeYokokuImg(u);
        if (!hasLabel) return { el: img, img, labelSpan: null };

        const wrap = document.createElement('div');
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'center';
        wrap.appendChild(img);
        const span = document.createElement('span');
        span.style.color = '#00e5ff';
        span.style.fontFamily = '"Orbitron", monospace';
        span.style.fontWeight = '900';
        span.style.fontSize = Math.round(u.size * 0.6) + 'px';
        span.style.lineHeight = '1';
        span.style.textShadow = '0 0 4px #000, 0 0 8px #00e5ff, 2px 2px 0 #000';
        wrap.appendChild(span);
        return { el: wrap, img, labelSpan: span };
    },

    updateGarbageGauge() {
        this._updateOjamaYokoku();
    },

    // 攻撃量の累積を1回だけ加算する（APM計測用。sendGarbage/sendGarbageCrossTetはonlineで
    // 丸ごと上書きされるため、呼び出し側=_applyOjamaOffset()で送信直前に呼ぶ）
    _countAttackSent(amount) {
        if (!(amount > 0)) return;
        this.attackSent = (this.attackSent || 0) + amount;
    },

    // ポーズ時間を除いた実プレイ経過ms（APM/LPM・記録保存で使用。tet側getActiveMs()と同じ思想）
    getActiveMs() {
        let ms = this.elapsed || 0;
        if (this._timerRunning) ms += performance.now() - this._timerStart;
        return ms;
    },

    sendGarbage(amount) {
        if (!this.isVersusMode) return;
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        if (!opponent || amount <= 0) return;

        // ── 注意：火力補正乗率は _applyOjamaOffset の入口で実効火力として計算済み。ここでは再計算しない ──

        // 穴パターン・配送は BattleGarbage(src/battle/garbage_router.ts)に集約。
        // ★ stage1「内部のみ」(internal:true・非表示) として送り、500ms 後に stage2「猶予(青)」へ。
        //    stage2→stage3(ready/点滅) への確定は従来どおり _confirmSentGarbage（送り手の連鎖終了）が行う。
        const BG = window.BattleGarbage;
        const isOppPuyo = opponent instanceof PuyoGame;
        const INTERNAL_MS = 500;
        const deliver = (garbageObj) => {
            BG.deliverLocalStaged(opponent, garbageObj, INTERNAL_MS, isOppPuyo);
            // 自分が送った火力をリストに保持しておく（連鎖終了時に ready 化するため）
            this.sentGarbageThisTurn.push(garbageObj);
        };
        BG.routeGarbage({
            amount: amount,
            targetRule: isOppPuyo ? 'puyo' : 'tet',
            // テト受け手の盤面列数で穴を作る（旧実装は PConfig.cols=6 で生成しており 0〜5列にしか穴が開かなかった）
            cols: typeof COLS_COUNT !== 'undefined' ? COLS_COUNT : 10,
            holeRatePercent: this.vsGarbageHoleRate !== undefined ? this.vsGarbageHoleRate : 70,
        }, {
            sendTetLines: (lines, holes) => deliver({ amount: lines, holes: holes, ready: false }),
            sendOjama: (count) => deliver({ amount: count, holes: [], ready: false }),
        });
    },

    _confirmSentGarbage(isZenkeshi = false) {
        if (!this.isVersusMode) return;
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        // オンライン対戦では opponent オブジェクトは存在しない（送信は sendGarbage フックが担う）。
        // opponentRule が注入されていれば、端数持ち越し等のリセット処理を継続する。
        if (!opponent && !this.opponentRule) return;

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

        if (changed && opponent && typeof opponent.updateGarbageGauge === 'function') {
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
            if (this.opponentRule) return this.opponentRule === 'tet'; // オンライン: 注入ルールを優先
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
                    this._countAttackSent(sendTetAmount);
                    this.sendGarbage(sendTetAmount);
                }
            } else if (effectiveTetAmount > 0 && remaining === 0) {
                this._countAttackSent(effectiveTetAmount);
                this.sendGarbage(effectiveTetAmount);
            }
        } else {
            // 相手がぷよの場合、残った実効ぷよ基準の火力を送る
            if (remaining > 0) {
                this._countAttackSent(remaining);
                this.sendGarbage(remaining);
            }
            // ★ 混在多人数戦: 同時にテト相手へは tet ライン火力を送る（相殺で減った割合を反映）。
            //   1v1の対ぷよでは _hasTetOpp=false なので何も起きない。
            if (this._hasTetOpp && typeof this.sendGarbageCrossTet === 'function' && effectiveTetAmount > 0) {
                const ratio = originalAmount > 0 ? (remaining / originalAmount) : (remaining === 0 ? 1 : 0);
                const sendTetAmount = Math.ceil(effectiveTetAmount * ratio);
                if (sendTetAmount > 0) {
                    this._countAttackSent(sendTetAmount);
                    this.sendGarbageCrossTet(sendTetAmount);
                }
            }
        }
    },

    _generateOjama() {
        let drop = 0;
        let limit = 30;
        let appliedColumns = [];

        // 降るおじゃまは、stage3(ready:true かつ internalでない)もののみ（internal優先）
        for (let i = 0; i < this.garbageQueue.length && drop < limit; i++) {
            if (this.garbageQueue[i].ready && !this.garbageQueue[i].internal && this.garbageQueue[i].amount > 0) {
                let take = Math.min(this.garbageQueue[i].amount, limit - drop);
                const garbage = this.garbageQueue[i];
                const holes = Array.isArray(garbage.holes) ? garbage.holes : [];
                // 受信した列配列は、端数行の配置に使う。フル行は全列が埋まるため
                // 列情報を消費するだけで、盤面上の選択には影響しない。
                const holeOffset = Math.max(0, holes.length - garbage.amount);
                this.garbageQueue[i].amount -= take;
                drop += take;

                if (holes.length > 0) {
                    garbage.holes = holes.slice(Math.min(take, holes.length));
                }

                // 後段の端数行が送信側と同じ列になるよう、今回の段階で記録する。
                appliedColumns.push(...holes.slice(holeOffset, holeOffset + take));
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
            // _generateOjama は複数キューをまとめて処理するため、各キューの
            // 列情報を一時的に連結して使う。情報がない旧ローカル経路は乱数へフォールバック。
            let cols = appliedColumns.slice(rows * PConfig.cols, rows * PConfig.cols + fractions)
                .filter(c => Number.isInteger(c) && c >= 0 && c < PConfig.cols);
            while (cols.length < fractions) {
                const available = [0, 1, 2, 3, 4, 5].filter(c => !cols.includes(c));
                cols.push(available.length > 0 ? available[Math.floor(this._random() * available.length)] : Math.floor(this._random() * PConfig.cols));
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
            if (this.opponentRule) return this.opponentRule === 'tet'; // オンライン: 注入ルールを優先
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
