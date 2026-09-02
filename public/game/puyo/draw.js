// ─────────────────────────────────────────────
// puyo/draw.js  ―  PuyoGame.prototype mixin
// 描画（連鎖テキストDOM・キャンバス描画・NEXT）
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(PuyoGame.prototype, {

    _prepareChainTextDOM(groups) {
        let bestR = -1;
        let bestC = 999;
        let candidates = [];

        for (const group of groups) {
            let maxR = -1;
            let minC = 999;
            for (const cell of group) {
                if (cell.r > maxR) {
                    maxR = cell.r;
                    minC = cell.c;
                } else if (cell.r === maxR) {
                    if (cell.c < minC) {
                        minC = cell.c;
                    }
                }
            }
            if (maxR > bestR) {
                bestR = maxR;
                bestC = minC;
                candidates = [group];
            } else if (maxR === bestR) {
                if (minC < bestC) {
                    bestC = minC;
                    candidates = [group];
                } else if (minC === bestC) {
                    candidates.push(group);
                }
            }
        }

        const targetGroup = candidates[Math.floor(this._random() * candidates.length)];

        let sumC = 0, sumR = 0;
        for (const cell of targetGroup) {
            sumC += cell.c;
            sumR += cell.r;
        }
        const avgC = sumC / targetGroup.length;
        const avgR = sumR / targetGroup.length;

        const targetC = avgC - 1;
        const targetR = avgR + 1;

        const logicalX = (targetC + 0.5) * PConfig.cellSize;
        const logicalY = (targetR - PConfig.hiddenRows + 0.5) * PConfig.cellSize;

        if (!this.canvas) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = rect.width / (PConfig.cols * PConfig.cellSize);
        const scaleY = rect.height / (PConfig.rows * PConfig.cellSize);

        const finalX = logicalX * scaleX;
        const finalY = logicalY * scaleY;

        const pageX = rect.left + window.scrollX + finalX;
        const pageY = rect.top + window.scrollY + finalY;

        // ★ 連鎖文字DOMは使い回す（毎連鎖の createElement/innerHTML を廃止）。
        //   1連鎖目で Orbitron グリフ（48px+stroke+shadow）を初回ラスタライズする際の
        //   カクつきを避けるため、要素は1個だけ生成し位置と数字だけ更新する。
        const el = this._ensureChainTextEl();
        this._chainNumEl.textContent = this.chainCount;

        el.style.left = pageX + 'px';
        el.style.top = pageY + 'px';
        el.style.opacity = '1';
        el.style.display = 'flex';

        this.chainTextInfo = {
            el: el,
            baseY: pageY
        };
    },

    // 連鎖文字用の永続DOM要素を遅延生成して返す。
    // 数字部は this._chainNumEl で参照し、連鎖毎にテキストだけ書き換える。
    _ensureChainTextEl() {
        if (this._chainTextEl && this._chainTextEl.isConnected) return this._chainTextEl;

        const numSize = 48;
        const chainSize = 24;
        // ★ online対戦の相手パペットは --ol-scale に合わせてこの倍率が1未満になる
        //   （盤面全体が縮小されるのに文字だけ固定pxだと3P以降で相対的に巨大化するため）。
        //   CSS transform の scale() で丸ごと縮小すればstroke/text-shadow/marginも
        //   比率を保ったまま一緒に縮む。CPU戦(常に1)は見た目が変わらない。
        const scale = this._chainTextScale ?? 1;

        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.transform = `translate(-50%, -50%) scale(${scale})`;
        el.style.pointerEvents = 'none';
        el.style.zIndex = '9999';
        el.style.whiteSpace = 'nowrap';
        el.style.display = 'none';
        el.style.alignItems = 'baseline';
        el.style.justifyContent = 'center';

        const numEl = document.createElement('span');
        numEl.style.cssText = `font-family: 'Orbitron', monospace; font-size: ${numSize}px; font-weight: bold; color: #ff8c00; text-shadow: 0 0 4px #fff, 0 0 8px rgba(255,140,0,0.8); -webkit-text-stroke: 1.5px #fff; line-height: 1;`;

        const labelEl = document.createElement('span');
        labelEl.style.cssText = `font-family: 'Orbitron', monospace; font-size: ${chainSize}px; font-weight: bold; color: #ff8c00; text-shadow: 0 0 4px #fff, 0 0 8px rgba(255,140,0,0.8); -webkit-text-stroke: 1px #fff; margin-left: 6px; line-height: 1;`;
        labelEl.textContent = 'CHAIN';

        el.appendChild(numEl);
        el.appendChild(labelEl);
        document.body.appendChild(el);

        this._chainTextEl = el;
        this._chainNumEl = numEl;
        return el;
    },

    // ★ 連鎖文字グリフのウォームアップ。
    //   初回連鎖で Orbitron（48px+stroke+shadow）を初めて描く瞬間に発生する
    //   フォント取得＋グリフラスタライズのスパイクを、ゲーム開始前に済ませておく。
    //   グリフatlas・webフォントはページ単位で共有されるため、静的フラグで1度だけ実行する。
    _warmChainTextGlyphs() {
        if (PuyoGame._chainGlyphsWarmed) return;
        PuyoGame._chainGlyphsWarmed = true;

        const finish = () => {
            const el = this._ensureChainTextEl();
            this._chainNumEl.textContent = '0123456789';
            // 画面外で1フレームだけ実ペイントさせてグリフをラスタライズしてから隠す
            el.style.left = '-9999px';
            el.style.top = '0px';
            el.style.opacity = '1';
            el.style.display = 'flex';
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    el.style.display = 'none';
                    el.style.opacity = '0';
                });
            });
        };

        if (document.fonts && document.fonts.load) {
            Promise.all([
                document.fonts.load("bold 48px 'Orbitron'"),
                document.fonts.load("bold 24px 'Orbitron'")
            ]).then(finish).catch(finish);
        } else {
            finish();
        }
    },

    _clearChainTextDOM() {
        // 永続要素は破棄せず隠すだけ（次連鎖で再ラスタライズしないため）
        if (this._chainTextEl) {
            this._chainTextEl.style.display = 'none';
            this._chainTextEl.style.opacity = '0';
        }
        this.chainTextInfo = null;
    },

    // ゲーム停止時に連鎖文字の永続要素をDOMから完全に取り除く（インスタンス破棄時のリーク防止）
    _destroyChainTextEl() {
        if (this._chainTextEl && this._chainTextEl.parentNode) {
            this._chainTextEl.parentNode.removeChild(this._chainTextEl);
        }
        this._chainTextEl = null;
        this._chainNumEl = null;
        this.chainTextInfo = null;
    },

    _clearYokokuDOM() {
        // ★ おじゃま予告コンテナの中身を空にする
        // ゲーム停止・ルール切り替え時に残像が残らないようにする
        if (this.yokokuContainer) {
            this.yokokuContainer.innerHTML = '';
        }
        // ★ innerHTML='' は row1/row2 の固定コンテナごと・プール中のノードも道連れに
        //   吹き飛ばす。参照を持ったままにすると次回 _updateOjamaYokoku が「もう
        //   DOMに無いノード」へ appendChild し続けて描画が復活しなくなるため、
        //   ノード管理用の状態を丸ごとリセットし、次回 _initOjamaYokokuDOM 相当の
        //   再構築（row1/row2再生成）から入り直させる。
        this._yokokuRow1 = null;
        this._yokokuRow2 = null;
        this._yokokuMounted = [];
        this._yokokuPool = {};
        // ★ DOMを空にしたので差分更新キャッシュも無効化（次回の_updateOjamaYokokuで確実に再構築させる）
        this._lastYokokuAmount = -1;
    },

    // ══════════════════════════════════════════════
    // 描画・その他
    // ══════════════════════════════════════════════

    _render() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const W = this.canvas.width;
        const H = this.canvas.height;

        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, W, H);

        ctx.save();

        const logicalW = PConfig.cols * PConfig.cellSize;
        const logicalH = PConfig.rows * PConfig.cellSize;
        ctx.scale(W / logicalW, H / logicalH);

        const cs = PConfig.cellSize;

        const deadX = 2 * cs;
        const deadY = 0 * cs;

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.7)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const pad = 6;
        ctx.moveTo(deadX + pad, deadY + pad);
        ctx.lineTo(deadX + cs - pad, deadY + cs - pad);
        ctx.moveTo(deadX + cs - pad, deadY + pad);
        ctx.lineTo(deadX + pad, deadY + cs - pad);
        ctx.stroke();
        ctx.restore();

        let ghostEraseInfo = null;
        if (this._gs === 'falling') {
            ghostEraseInfo = this._getGhostEraseInfo();
        }

        // ★ セル毎の線形スキャン（activeAnims.find/some・_erasingCells.some）を排除するため、
        //   このフレームで使う (fr,c) -> 値 のルックアップを先に1回だけ構築する。
        //   インスタンスを使い回し clear() するのでフレーム毎のGC負荷も抑える。
        const cols = PConfig.cols;
        const animMap = this._animMap || (this._animMap = new Map());
        animMap.clear();
        for (const a of this.activeAnims) animMap.set(a.fr * cols + a.c, a);

        const erasingSet = this._erasingSet || (this._erasingSet = new Set());
        erasingSet.clear();
        if (this._erasingCells) {
            for (const ec of this._erasingCells) erasingSet.add(ec.r * cols + ec.c);
        }

        const erasingHidden = this._erasingCells && (Math.floor(this._eraseTimer / 66.68) % 2 === 1);

        for (let r = 0; r < PConfig.rows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                const fr = r + PConfig.hiddenRows;
                const color = this.field[fr][c];
                if (color === 0) continue;

                let flashType = 0;

                if (this._erasingCells) {
                    // 消去点滅：消去対象セルは点滅の「消えている」位相で描画スキップ
                    if (erasingHidden && erasingSet.has(fr * cols + c)) continue;
                }
                else if (ghostEraseInfo && ghostEraseInfo.cells.length > 0) {
                    if (ghostEraseInfo.cells.some(ec => ec.r === fr && ec.c === c)) {
                        // ★ ゴースト時、おじゃまぷよ(color===6)は白光りさせない
                        if (color !== 6) {
                            flashType = 2;
                        }
                    }
                }

                const animState = animMap.get(fr * cols + c);
                // ★ 振動アニメ中（animState あり）は連結画像を無効にする
                const isVibrating = !!animState;
                const connectInfo = this._getConnectImageInfo(c, r, color, isVibrating);
                this._drawPuyo(ctx, c * cs, r * cs, color, cs, flashType, animState, connectInfo);
            }
        }

        if (this._dropAnim) {
            for (const col of this._dropAnim) {
                for (const cell of col.cells) {
                    // ★ _getDropConnectImageInfoで連結情報を取得する
                    const connectInfo = this._getDropConnectImageInfo(col.c, cell.fromR, cell.color);
                    this._drawPuyo(ctx, col.c * cs, cell.py, cell.color, cs, 0, null, connectInfo);
                }
            }
        }

        if (this._gs === 'falling') {
            const targetDC = [0, 1, 0, -1];
            const targetDR = [-1, 0, 1, 0];
            const childCol = this.pivotX + targetDC[this.targetRot];

            let ghostPivotY, ghostChildY;
            if (this.targetRot === 0) {
                ghostPivotY = this._calcLimitY_Single(this.pivotX, this.pivotY);
                ghostChildY = ghostPivotY - 1;
            } else if (this.targetRot === 2) {
                ghostChildY = this._calcLimitY_Single(this.pivotX, this.pivotY + 1);
                ghostPivotY = ghostChildY - 1;
            } else {
                ghostPivotY = this._calcLimitY_Single(this.pivotX, this.pivotY);
                ghostChildY = this._calcLimitY_Single(childCol, this.pivotY);
            }

            ctx.globalAlpha = 0.22;
            this._drawPuyo(ctx, this.pivotX * cs, ghostPivotY * cs, this.pivotColor, cs, 0);
            this._drawPuyo(ctx, childCol * cs, ghostChildY * cs, this.childColor, cs, 0);
            ctx.globalAlpha = 1.0;

            const angle = -Math.PI / 2 + this.animRot * (Math.PI / 2);
            const childOffsetX = Math.cos(angle);
            const childOffsetY = Math.sin(angle);

            const px = this.pivotX * cs;
            const py = this.pivotY * cs;
            const cx = px + childOffsetX * cs;
            const cy = py + childOffsetY * cs;

            const limitY = this._calcLimitY(this.pivotX, this.pivotY, this.targetRot);
            const isFloating = (this.pivotY < limitY);

            let pivotFlash = isFloating ? 1 : 0;

            this._drawPuyo(ctx, px, py, this.pivotColor, cs, pivotFlash);
            this._drawPuyo(ctx, cx, cy, this.childColor, cs, 0);
        }

        if (this.splitPuyo && this._gs === 'splitting') {
            this._drawPuyo(ctx, this.splitPuyo.col * cs, this.splitPuyo.y * cs, this.splitPuyo.color, cs, 0);
        }

        ctx.restore();

        if (this._gs === 'eraseWait' && this.chainTextInfo && this.chainTextInfo.el) {
            const remaining = PConfig.eraseWaitMs - this.eraseWaitTimer;
            const alpha = Math.max(0, Math.min(1, remaining / 150));

            const progress = this.eraseWaitTimer / PConfig.eraseWaitMs;
            const slideY = -12 * progress;

            this.chainTextInfo.el.style.opacity = alpha;
            this.chainTextInfo.el.style.top = (this.chainTextInfo.baseY + slideY) + 'px';
        }

        // ★ ALL CLEAR 永続表示
        if (this.isAllClear) {
            ctx.save();
            // 時間経過でアルファ値を少し揺らす (0.85 〜 1.0)
            const alpha = 0.85 + 0.15 * Math.sin(this._animMs / 150);
            ctx.globalAlpha = alpha;
            ctx.font = 'bold 26px "Orbitron", monospace';
            ctx.fillStyle = '#ffea00';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(255,234,0,1)';
            ctx.shadowBlur = 15;

            // 少しだけ黒縁をつけて見やすくする
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 4;
            ctx.strokeText('ALL CLEAR', W / 2, H / 3);
            ctx.fillText('ALL CLEAR', W / 2, H / 3);
            ctx.restore();
        }

        this._renderNext();
    },

    /**
     * ぷよ1個を描画する。
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x - 描画左上X（論理座標）
     * @param {number} y - 描画左上Y（論理座標）
     * @param {number} color - ぷよ色（1〜6）
     * @param {number} size - セルサイズ
     * @param {number} flashType - 0:なし 1:操作中光り 2:消去予告光り
     * @param {object|null} animState - 振動アニメ状態
     * @param {{ key: string, angle: number }|null} connectInfo - ★ 連結画像情報（null=通常画像）
     */
    _drawPuyo(ctx, x, y, color, size, flashType = 0, animState = null, connectInfo = null) {
        const imageIndex = color - 1;
        const key = 'puyo-' + imageIndex;
        const img = this._images[key];

        ctx.save();

        // ── 振動アニメによるスケール変換 ──
        let cx = x + size / 2;
        let cy = y + size;

        let scaleX = 1;
        let scaleY = 1;

        if (animState) {
            let phase = Math.floor(animState.timer / PConfig.vibPhaseMs) % 4;
            if (phase === 0) scaleX = 0.8;
            else if (phase === 2) scaleY = 0.8;
        }

        ctx.translate(cx, cy);
        ctx.scale(scaleX, scaleY);
        ctx.translate(-cx, -cy);

        // ★ サブピクセルレンダリングによる隙間（1pxの境界線）を埋めるためのオーバーラップ値
        // 論理座標(32px)に対して少し広げて描画することで、物理座標での小数の丸め誤差による隙間を重ね合わせて消す
        const overlap = 0.6;
        const dx = x - overlap / 2;
        const dy = y - overlap / 2;
        const dw = size + overlap;
        const dh = size + overlap;

        // ── 画像描画（連結あり / なし の分岐） ──
        if (connectInfo) {
            // ★ 連結画像：angle ラジアン分だけセル中心を軸に時計回り回転して描画
            const connectImg = this._images[connectInfo.key];
            if (connectImg && connectImg.complete && connectImg.naturalWidth > 0) {
                // 連結画像を回転して描画（セル中心を回転軸とする）
                const centerX = x + size / 2;
                const centerY = y + size / 2;
                ctx.translate(centerX, centerY);
                ctx.rotate(connectInfo.angle);
                ctx.translate(-centerX, -centerY);
                ctx.drawImage(connectImg, dx, dy, dw, dh);
            } else if (img && img.complete && img.naturalWidth > 0) {
                // 連結画像が未ロードの場合は通常画像にフォールバック
                ctx.drawImage(img, dx, dy, dw, dh);
            }
        } else if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, dx, dy, dw, dh);
        }

        // ── フラッシュエフェクト ──
        if (flashType > 0 && !this.suppressBlink) {
            const isErase = (flashType === 2);
            const speed = isErase ? 40 : 60;
            const maxAlpha = isErase ? 0.85 : 0.7;
            const alpha = (Math.sin(this._animMs / speed) + 1) / 2 * maxAlpha;

            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            // エフェクトの中心とサイズは元のサイズのままでOK
            ctx.arc(x + size * 0.5, y + size * 0.5, size * 0.45, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    },

    _renderNext() {
        if (!this.nextCtx || this.nextQueue.length === 0) return;
        const ctx = this.nextCtx;
        const W = this.nextCanvas.width;
        const H = this.nextCanvas.height;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, W, H);

        // PRACTICE設定パネル：NEXT表示数（practiceNextCount）を可変化。既定は2ペア。
        // 直近5個は左列に従来どおり縦に流し、6個目以降は右列に縦に流す
        // （列優先＝tetと同じ考え方。行優先のジグザグにはしない。縮小率は_computeNextLayout参照）。
        const { count, cols, drawCs } = this._computeNextLayout();
        const colWidth = W / cols;
        const col0Count = Math.min(count, 5);

        ctx.save();

        // 左列（index 0-4）：従来どおりの縦流れ＋出現アニメのスライド演出
        {
            const offsetX = (colWidth - drawCs) / 2;
            const shiftDist = drawCs * 2.5;
            let offsetY = 0;
            let rowsToShow = col0Count;
            if (this._gs === 'spawnAnim') {
                const progress = Math.min(1, this.spawnAnimTimer / PConfig.spawnAnimMs);
                offsetY = -shiftDist * progress;
                rowsToShow = col0Count + 1; // 次の1個（右列の先頭、無ければ何も無い）を覗かせる
            }
            for (let i = 0; i < rowsToShow; i++) {
                const pair = this.nextQueue[i];
                if (!pair) continue;
                const y = 20 + i * shiftDist + offsetY;
                this._drawPuyo(ctx, offsetX, y, pair[1], drawCs, 0);
                this._drawPuyo(ctx, offsetX, y + drawCs, pair[0], drawCs, 0);
            }
        }

        // 右列（index 5以降）：アニメなしで縦に流すだけ
        if (cols > 1) {
            const offsetX = colWidth + (colWidth - drawCs) / 2;
            const shiftDist = drawCs * 2.5;
            for (let i = 5; i < count; i++) {
                const pair = this.nextQueue[i];
                if (!pair) continue;
                const y = 20 + (i - 5) * shiftDist;
                this._drawPuyo(ctx, offsetX, y, pair[1], drawCs, 0);
                this._drawPuyo(ctx, offsetX, y + drawCs, pair[0], drawCs, 0);
            }
        }

        ctx.restore();
    },

    // PRACTICE設定パネル：NEXT表示数（practiceNextCount）に応じたレイアウトを計算する。
    // 列は列優先（左列=直近5個、右列=6個目以降）で割り当てるため、列あたり
    // 最大5個。縦の枠を常にPRACTICE_NEXT_MAX_HEIGHT（tetの既定NEXT高さ）で
    // 揃えても、5個ぶんなら縮小せず収まる（base.js参照）。
    _computeNextLayout() {
        const count = Math.max(1, Math.min(10, this.practiceNextCount || 2));
        const cols = count > 5 ? 2 : 1;
        const rowsPerCol = 5;
        const drawCs = Math.max(18, Math.min(42, (PRACTICE_NEXT_MAX_HEIGHT - 20 - 42) / (rowsPerCol * 2.5)));
        return { count, cols, drawCs };
    },

    // PRACTICE設定パネル：NEXT表示数の変更に合わせてキャンバスサイズを再計算する
    resizeNextCanvas() {
        if (!this.nextCanvas) return;
        const { cols } = this._computeNextLayout();
        this.nextCanvas.width = 128 * cols;
        this.nextCanvas.height = PRACTICE_NEXT_MAX_HEIGHT;
    },
});
