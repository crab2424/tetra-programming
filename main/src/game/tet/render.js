// ─────────────────────────────────────────────
// tet/render.js  ―  Game.prototype mixin
// キャンバス初期化・グリッド/ゴースト/全体描画
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    initMainCanvas() {
        const id = this.canvasPrefix ? `${this.canvasPrefix}-main-canvas` : MAIN_CANVAS_ID;
        this.mainCanvas = document.getElementById(id);
        this.mainCtx = this.mainCanvas.getContext("2d");
        this.mainCanvas.width = SCREEN_WIDTH;
        this.mainCanvas.height = SCREEN_HEIGHT;

        // ページ読み込み時（ゲーム開始前）に一度だけグリッドを描画しておく
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
        this.drawGrid(this.mainCtx);
        this.mainCtx.restore();
    },

    initNextCanvas() {
        const id = this.canvasPrefix ? `${this.canvasPrefix}-next-canvas` : NEXT_CANVAS_ID;
        this.nextCanvas = document.getElementById(id);
        this.nextCtx = this.nextCanvas.getContext("2d");
        this.nextCanvas.width = BLOCK_SIZE * 4;
        this.nextCanvas.height = BLOCK_SIZE * 13.5;
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
        let ghostY = this.mino.y
        while (true) {
            let newBlocks = this.mino.blocks.map(block => ({
                x: block.x + this.mino.x,
                y: block.y + ghostY + 1
            }))
            let canMove = newBlocks.every(block =>
                block.x >= 0 &&
                block.x < COLS_COUNT &&
                block.y < ROWS_COUNT &&
                !this.field.has(block.x, block.y)
            )
            if (canMove) {
                ghostY++
            } else {
                break
            }
        }
        return ghostY
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

        // 上に少し余白を作る（-1行目の一部を表示）
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);

        // ブロックを描画する前にグリッドを描画する
        this.drawGrid(this.mainCtx);

        this.field.drawFixedBlocks(this.mainCtx);

        // this.mino が存在するときだけゴーストを描画
        if (this.mino) {
            const ghostY = this.getGhostY()
            if (ghostY !== this.mino.y) {
                this.mainCtx.globalAlpha = 0.25
                this.mino.draw(this.mainCtx, ghostY)
                this.mainCtx.globalAlpha = 1.0
            }
        }

        const minoScale = 0.8;

        // Draw next queue vertically（表示は先頭5個のみ。内部は11個保持）
        const spacing = 3;
        this.nextQueue.slice(0, 5).forEach((mino, i) => {
            this.nextCtx.save();
            this.nextCtx.translate(0, i * spacing * BLOCK_SIZE * minoScale);
            this.nextCtx.scale(minoScale, minoScale);
            mino.drawNext(this.nextCtx);
            this.nextCtx.restore();
        });

        // this.mino が存在するときだけ本体を描画
        if (this.mino) {
            this.mino.draw(this.mainCtx)
        }

        this.mainCtx.restore();

        if (this.holdMino) {
            this.holdCtx.save();
            if (!this.canHold) {
                this.holdCtx.globalAlpha = 0.4;
            }
            this.holdCtx.scale(minoScale, minoScale);
            this.holdMino.drawNext(this.holdCtx);
            this.holdCtx.restore();
        }
    },
});
