// ─────────────────────────────────────────────
// tet/render.js  ―  Game.prototype mixin
// キャンバス初期化・グリッド/ゴースト/全体描画
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    initMainCanvas() {
        const id = this.canvasPrefix ? `${this.canvasPrefix}-main-canvas` : MAIN_CANVAS_ID;
        this.mainCanvas = document.getElementById(id);
        // desynchronized: true は Chrome の Canvas2D で compositor を経由しない
        // 低遅延パスを要求するヒント。キー入力→画面反映のレイテンシ短縮に効く。
        // 非対応ブラウザは無視して通常の 2d コンテキストを返すだけ。
        this.mainCtx = this.mainCanvas.getContext("2d", { desynchronized: true });
        this.mainCanvas.width = SCREEN_WIDTH;
        this.mainCanvas.height = SCREEN_HEIGHT;

        // グリッドは完全に静的なので、オフスクリーンキャンバスに一度だけ描いて
        // 以降は drawImage 1回で貼り付ける（毎フレームの stroke を排除）
        this._buildGridCache();

        // ページ読み込み時（ゲーム開始前）に一度だけグリッドを描画しておく
        this.mainCtx.drawImage(this._gridCache, 0, 0);
    },

    // グリッドを SCREEN 全体に焼き込んだオフスクリーンキャンバスを生成
    _buildGridCache() {
        const cache = document.createElement('canvas');
        cache.width = SCREEN_WIDTH;
        cache.height = SCREEN_HEIGHT;
        const cctx = cache.getContext('2d');
        // drawAll と同じ座標系（-1行目分の余白）に合わせて描画
        cctx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
        this.drawGrid(cctx);
        this._gridCache = cache;
    },

    initNextCanvas() {
        const id = this.canvasPrefix ? `${this.canvasPrefix}-next-canvas` : NEXT_CANVAS_ID;
        this.nextCanvas = document.getElementById(id);
        this.nextCtx = this.nextCanvas.getContext("2d");
        this.nextCanvas.width = BLOCK_SIZE * 4;
        this.nextCanvas.height = BLOCK_SIZE * 13.5;
    },

    // PRACTICE設定パネル：NEXT表示数（practiceNextCount）に応じたレイアウトを計算する。
    // 既定(5個)までは現行サイズ・1列。超過分は2列にした上で、縦の枠は常に
    // PRACTICE_NEXT_MAX_HEIGHT（tetの既定NEXT高さ）で揃える。scaleは
    // 「2列でもその高さに収まる最大サイズ」を逆算するので、行数が少ないうちは
    // 縮小されない（puyo側と共通の考え方。base.js参照）。
    _computeNextLayout() {
        const count = Math.max(1, Math.min(10, this.practiceNextCount || 5));
        const cols = count > 5 ? 2 : 1;
        const rows = Math.ceil(count / cols);
        const scale = Math.min(0.8, (PRACTICE_NEXT_MAX_HEIGHT - BLOCK_SIZE * 0.8) / (rows * 3 * BLOCK_SIZE));
        return { count, cols, rows, scale };
    },

    // PRACTICE設定パネル：NEXT表示数の変更に合わせてキャンバスサイズを再計算する
    resizeNextCanvas() {
        const { cols } = this._computeNextLayout();
        this.nextCanvas.width = BLOCK_SIZE * 4 * cols;
        this.nextCanvas.height = PRACTICE_NEXT_MAX_HEIGHT;
    },

    initHoldCanvas() {
        const id = this.canvasPrefix ? `${this.canvasPrefix}-hold-canvas` : HOLD_CANVAS_ID;
        this.holdCanvas = document.getElementById(id);
        this.holdCtx = this.holdCanvas.getContext("2d");
        this.holdCanvas.width = BLOCK_SIZE * 4;
        this.holdCanvas.height = BLOCK_SIZE * 4;
    },

    // グリッド線を描画する
    drawGrid(ctx) {
        ctx.save();
        // グリッド線の色と太さ（暗い背景に馴染む薄い白）
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;

        // 縦線を引く
        for (let x = 0; x <= COLS_COUNT; x++) {
            ctx.beginPath();
            // -1行目の上端（見えている部分）から一番下まで
            ctx.moveTo(x * BLOCK_SIZE, -BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
            ctx.lineTo(x * BLOCK_SIZE, ROWS_COUNT * BLOCK_SIZE);
            ctx.stroke();
        }

        // 横線を引く（-1行目の区切り線も含むように -1 からスタート）
        for (let y = -1; y <= ROWS_COUNT; y++) {
            ctx.beginPath();
            ctx.moveTo(0, y * BLOCK_SIZE);
            ctx.lineTo(COLS_COUNT * BLOCK_SIZE, y * BLOCK_SIZE);
            ctx.stroke();
        }
        ctx.restore();
    },

    getGhostY() {
        // Field の占有 Uint8Array を直接参照して O(1) ルックアップ。
        // 旧実装は毎フレ new Set() + 'x,y' 文字列を盤面ブロック数ぶん生成しており、
        // 120Hz モニタで顕著な GC churn の原因になっていた。
        this.field.syncOcc()
        const occ = this.field._occ
        const pad = Field.TOP_PAD

        const mx = this.mino.x
        const blocks = this.mino.blocks
        let ghostY = this.mino.y
        while (true) {
            let canMove = true
            for (let i = 0; i < blocks.length; i++) {
                const bx = blocks[i].x + mx
                const by = blocks[i].y + ghostY + 1
                if (bx < 0 || bx >= COLS_COUNT || by >= ROWS_COUNT) {
                    canMove = false
                    break
                }
                const yy = by + pad
                if (yy >= 0 && occ[yy * COLS_COUNT + bx] === 1) {
                    canMove = false
                    break
                }
            }
            if (canMove) {
                ghostY++
            } else {
                break
            }
        }
        return ghostY
    },

    // ─────────────────────────────────────────
    // rAF駆動の描画ループ＆入力ポーリング統合点
    // ・hot-path側は this.requestRedraw() でダーティフラグを立てるだけにし、
    //   実際の drawAll は 1フレーム最大1回に集約する。
    // ・入力ポーリング (_pollInput) も同じ rAF で回す。
    //   従来の setInterval(…, 4) を撤廃して、描画タイミングと同期させる。
    // ─────────────────────────────────────────
    requestRedraw() {
        this._needsRedraw = true;
    },

    startRenderLoop() {
        if (this._renderLoopId) cancelAnimationFrame(this._renderLoopId);
        const loop = () => {
            // 入力ポーリング（player側のみ this._pollInput が設定される）
            if (this._pollInput) this._pollInput();
            // 重力 tick：rAF と同期して経過時間に応じた回数だけ落下を適用する。
            // 旧 setInterval ベースの実装は rAF と非同期で発火し、高Hzモニターで
            // 「ミノが瞬間移動」する原因になっていたので統合。
            this._applyGravityTick();
            // ダーティ時のみ描画
            if (this._needsRedraw) {
                this._needsRedraw = false;
                this.drawAll();
            }
            this._renderLoopId = requestAnimationFrame(loop);
        };
        this._renderLoopId = requestAnimationFrame(loop);
    },

    stopRenderLoop() {
        if (this._renderLoopId) {
            cancelAnimationFrame(this._renderLoopId);
            this._renderLoopId = null;
        }
    },

    drawAll() {
        this.mainCtx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT)
        this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height)
        this.holdCtx.clearRect(0, 0, this.holdCanvas.width, this.holdCanvas.height)

        // キャンバス背景を不透明に塗りつぶす（透明のままだと背後のパーティクルが透過して見えるため）
        this.mainCtx.fillStyle = '#0a0a0f';
        this.mainCtx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        this.nextCtx.fillStyle = '#0a0a0f';
        this.nextCtx.fillRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
        this.holdCtx.fillStyle = '#0a0a0f';
        this.holdCtx.fillRect(0, 0, this.holdCanvas.width, this.holdCanvas.height);

        // ブロックを描画する前にグリッドを貼り付ける（キャッシュ済みオフスクリーンを1回 drawImage）
        // ※グリッドキャッシュには -1行目分の余白オフセットが焼き込み済みなので translate 前に描く
        this.mainCtx.drawImage(this._gridCache, 0, 0);

        // 上に少し余白を作る（-1行目の一部を表示）
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);

        // 固定ブロックはオフスクリーンキャッシュを 1 枚 blit するだけ。
        // 中身が変わるのはロック・ライン消去・おじゃま着弾時のみで、その瞬間に
        // Field.markDirty() が呼ばれて自動再構築される。
        this.field.syncFixedCache();
        // キャッシュ内部はゲーム y=-1 ⇄ 画像 y=0 にオフセット済みなので、
        // 描画位置を 1 行ぶん上にずらして貼り付ける。
        this.mainCtx.drawImage(this.field._fixedCanvas, 0, -BLOCK_SIZE);

        // this.mino が存在するときだけゴーストを描画（PRACTICE設定パネルでOFFにできる）
        if (this.mino && this.showGhost !== false) {
            const ghostY = this.getGhostY()
            if (ghostY !== this.mino.y) {
                this.mainCtx.globalAlpha = 0.25
                this.mino.draw(this.mainCtx, ghostY)
                this.mainCtx.globalAlpha = 1.0
            }
        }

        const minoScale = 0.8;

        // Draw next queue vertically（表示は既定5個。PRACTICEでは practiceNextCount で可変。
        // 内部は11個保持。既定を超える分は2列で表示する＝_computeNextLayout参照）
        // slice + forEach は毎フレ配列とクロージャを作るため素のループに置換。
        const spacing = 3;
        const nq = this.nextQueue;
        const { count: nextCount, cols: nqCols, scale: nqScale } = this._computeNextLayout();
        const nqLen = Math.min(nextCount, nq.length);
        const colWidthPx = BLOCK_SIZE * 4;
        for (let i = 0; i < nqLen; i++) {
            const col = nqCols > 1 ? (i % 2) : 0;
            const row = nqCols > 1 ? Math.floor(i / 2) : i;
            this.nextCtx.save();
            this.nextCtx.translate(col * colWidthPx, row * spacing * BLOCK_SIZE * nqScale);
            this.nextCtx.scale(nqScale, nqScale);
            nq[i].drawNext(this.nextCtx);
            this.nextCtx.restore();
        }

        // this.mino が存在するときだけ本体を描画
        if (this.mino) {
            this.mino.draw(this.mainCtx)
        }

        this.mainCtx.restore();

        if (this.holdMino) {
            this.holdCtx.save();
            // PRACTICE設定パネル：HOLDがFREEのときは薄暗くしない（何度でも使えるため）
            if (!this.canHold && this.practiceHoldMode !== 'free') {
                this.holdCtx.globalAlpha = 0.4;
            }
            this.holdCtx.scale(minoScale, minoScale);
            this.holdMino.drawNext(this.holdCtx);
            this.holdCtx.restore();
        }
    },
});
