// ─────────────────────────────────────────────
// base.js
// 画像素材や演出、定数やデータクラスの管理を行う共通基盤ファイル
// ─────────────────────────────────────────────

// ==========================================
// 1. TET 用の共通定数
// ==========================================
const SATRT_BTN_ID = "start-btn";
const MAIN_CANVAS_ID = "main-canvas";
const NEXT_CANVAS_ID = "next-canvas";
const HOLD_CANVAS_ID = "hold-canvas";
const GAME_SPEED = 500;
const BLOCK_SIZE = 32;
const COLS_COUNT = 10;
const ROWS_COUNT = 20;
const LEVEL_SPEEDS = [
    0, // インデックス合わせのためのダミー(Level 0)
    1000, 793, 618, 473, 355, 262, 190, 135, 94, 64, 43, 28, 18, 11, 7
];
const VISIBLE_EXTRA_ROW_RATIO = 0.5;
const SCREEN_WIDTH = COLS_COUNT * BLOCK_SIZE;
const SCREEN_HEIGHT = (ROWS_COUNT + VISIBLE_EXTRA_ROW_RATIO) * BLOCK_SIZE;
const NEXT_AREA_SIZE = 160;

// ─────────────────────────────────────────────
// ★ミノのIDと画像ファイルの対応
// 画像の色が合わない場合は、ここのファイル名を実際の色に合わせて入れ替えてください。
// ─────────────────────────────────────────────
const BLOCK_SOURCES = [
    "images/t_images/block-0.png", // ID 0: I型（推奨色: 水色）
    "images/t_images/block-1.png", // ID 1: O型（推奨色: 黄色）
    "images/t_images/block-2.png", // ID 2: T型（推奨色: 紫色）
    "images/t_images/block-3.png", // ID 3: J型（推奨色: 青色）
    "images/t_images/block-4.png", // ID 4: L型（推奨色: 橙色）
    "images/t_images/block-5.png", // ID 5: S型（推奨色: 緑色）
    "images/t_images/block-6.png", // ID 6: Z型（推奨色: 赤色）
    "images/t_images/block-7.png"  // ID 7: おじゃまブロック（推奨色: 灰色）
]

window.onload = function () {
    Asset.init(function () {
        let game = new Game()
        // グローバルに保持（設定変更後に setKeyEvent を外から呼ぶため）
        window._game = game

        // 対戦用CPUゲームインスタンスを初期化（canvasPrefix='cpu'）
        let cpuGame = new Game('cpu')
        window._cpuGame = cpuGame

        // リザルト画面の「RETRY」ボタン
        // ★ 修正: puyoモードとtetモードで異なるハンドラーを設定
        document.getElementById('result-retry-btn').onclick = function () {
            if (currentGameMode && currentGameMode.id === 'puyo') {
                // puyoモード：startGameFromModeCheck を呼び出す
                startGameFromModeCheck();
            } else {
                // tetモード：従来のgame.startを呼び出す
                switchPage('game');
                game.start();
            }
            this.blur();
        }

        // 非表示のstart-btnは後方互換のため残す（非表示）
        document.getElementById(SATRT_BTN_ID).onclick = function () {
            switchPage('game');
            game.start()
            this.blur()
        }

        // 準備画面のコントロール表示を初期化（router.js の関数を呼ぶ）
        if (typeof updateMenuControlsDisplay === 'function') updateMenuControlsDisplay();
    })
}

// ─────────────────────────────────────────────
// 素材管理クラス
// ─────────────────────────────────────────────
class Asset {
    static blockImages = []

    static init(callback) {
        let loadCnt = 0
        for (let i = 0; i < BLOCK_SOURCES.length; i++) {
            let img = new Image();
            img.onload = function () {
                loadCnt++
                // ★ 修正: push() だとロード完了順に入ってしまい画像がズレる原因になるため、
                // インデックス i を使って正しい位置に確実に代入する
                Asset.blockImages[i] = img;

                if (loadCnt >= BLOCK_SOURCES.length && callback) {
                    callback()
                }
            }
            img.src = BLOCK_SOURCES[i];
        }
    }
}

// ─────────────────────────────────────────────
// カウントダウン演出ユーティリティ
// overlayId   : 表示するオーバーレイ要素のID
// textEl      : 数字/テキストを表示する要素
// onStart     : "START!" 表示の瞬間（入力受付開始）に呼ぶコールバック
// onComplete  : 演出が完全に終了したときのコールバック（任意）
// ─────────────────────────────────────────────
function runCountdown(overlayId, textElId, onStart, onComplete) {
    const overlay = document.getElementById(overlayId);
    const textEl = document.getElementById(textElId);
    if (!overlay || !textEl) {
        if (onStart) onStart();
        if (onComplete) onComplete();
        return;
    }

    // 前回のタイマーが動いていればキャンセル（リスタート対策）
    if (overlay.countdownTimer) clearTimeout(overlay.countdownTimer);

    const clearCountdownText = () => {
        textEl.classList.remove('countdown-pop');
        textEl.textContent = '';
        // アニメーションの合成レイヤーに START! の残像が残ることがあるため、
        // transform/opacity の最終状態をここで確実に破棄する。
        textEl.style.animation = 'none';
        void textEl.offsetWidth;
        textEl.style.animation = '';
    };

    clearCountdownText();
    overlay.classList.add('active');

    const steps = ['3', '2', '1', 'START!'];
    let stepIdx = 0;

    const showStep = () => {
        const val = steps[stepIdx];
        textEl.textContent = val;

        textEl.classList.remove('countdown-pop');
        void textEl.offsetWidth;
        textEl.classList.add('countdown-pop');

        if (val === 'START!' && onStart) {
            onStart();
        }

        stepIdx++;

        if (stepIdx < steps.length) {
            overlay.countdownTimer = setTimeout(showStep, 700);
        } else {
            overlay.countdownTimer = setTimeout(() => {
                clearCountdownText();
                overlay.classList.remove('active');
                overlay.countdownTimer = null;
                if (onComplete) onComplete();
            }, 600);
        }
    };

    showStep();
}

// ─────────────────────────────────────────────
// 終了演出ユーティリティ（リセット対応版）
// ─────────────────────────────────────────────
function showFinishOverlay(overlayId, textElId, text, className, duration, onComplete) {
    const overlay = document.getElementById(overlayId);
    const textEl = document.getElementById(textElId);
    if (!overlay || !textEl) {
        if (onComplete) setTimeout(onComplete, duration || 800);
        return;
    }

    // 前回のタイマーが動いていればキャンセル
    if (overlay.countdownTimer) clearTimeout(overlay.countdownTimer);
    if (overlay.finishTimer1) clearTimeout(overlay.finishTimer1);
    if (overlay.finishTimer2) clearTimeout(overlay.finishTimer2);

    textEl.className = 'finish-text';
    if (className) textEl.classList.add(className);
    textEl.textContent = text;

    // リスタート用にクラスをリセットしてから表示
    overlay.classList.remove('fadeout');
    overlay.classList.add('active');

    overlay.finishTimer1 = setTimeout(() => {
        overlay.classList.add('fadeout');
        overlay.finishTimer2 = setTimeout(() => {
            overlay.classList.remove('active', 'fadeout');
            textEl.textContent = '';
            if (onComplete) onComplete();
        }, 500);
    }, duration || 800);
}


// ==========================================
// 2. PUYO 用の共通定数
// ==========================================

const PConfig = {
    cols: 6,
    rows: 12,
    hiddenRows: 5,

    cellSize: 32,
    imagePath: 'images/p_images/',
    colorCount: 4,

    dropSpeedNormal: 500,
    dropSpeedFast: 500 / 12,
    splitDropSpeed: 500 / 6,
    lockDelayMs: 500,

    vibPhaseMs: 1000 / 60 * 1.2,
    fixWait5fMs: 1000 / 60 * 5,

    spawnAnimMs: 62,
    rotateDurationMs: 80,
    eraseCount: 4,

    eraseMs: 28 * 16.67,
    eraseWaitMs: 270,
    zenkeshiMs: 1500,       // (未使用になりましたが念のため残置)
    zenkeshiBonus: 2100,       // ★ 全消しスコアを2100点に変更

    scoreBase: 10,
    chainBonusTable: [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512],
    colorBonusTable: [0, 3, 6, 12, 24],
    groupBonusTable: [0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 10],

    ojamaRate: 70,
};

// ==========================================
// 3. 共通データクラス（テトリス）
// ==========================================

// ─────────────────────────────────────────────
// Block クラス
// ─────────────────────────────────────────────
class Block {
    constructor(x, y, type) {
        this.x = x
        this.y = y
        if (type >= 0) this.setType(type)
    }

    setType(type) {
        this.type = type
        this.image = Asset.blockImages[type]
    }

    draw(offsetX = 0, offsetY = 0, ctx) {
        let drawX = this.x + offsetX
        let drawY = this.y + offsetY

        if (drawX >= 0 && drawX < COLS_COUNT &&
            drawY >= -1 && drawY < ROWS_COUNT) {
            ctx.drawImage(
                this.image,
                drawX * BLOCK_SIZE,
                drawY * BLOCK_SIZE,
                BLOCK_SIZE,
                BLOCK_SIZE
            )
        }
    }

    drawNext(ctx) {
        let offsetX = 0
        let offsetY = 0
        switch (this.type) {
            case 0: offsetX = 0.5; offsetY = 1; break;
            case 1: offsetX = 0.5; offsetY = 0.5; break;
            default: offsetX = 1; offsetY = 0.5; break;
        }
        ctx.drawImage(
            this.image,
            (this.x + offsetX) * BLOCK_SIZE,
            (this.y + offsetY) * BLOCK_SIZE,
            BLOCK_SIZE,
            BLOCK_SIZE
        )
    }
}

// ─────────────────────────────────────────────
// Mino クラス
// ─────────────────────────────────────────────
class Mino {

    // mino の種類を決定してブロックを初期化
    constructor(type = null) {
        this.pivot = { x: 1.5, y: 1.5 }; // デフォルトの回転軸（4x4中心）
        this.type = (type !== null) ? type : Math.floor(Math.random() * 7);
        this.rotation = 0; // 0:上 1:右 2:下 3:左
        this.initBlocks()
    }

    initBlocks() {
        let t = this.type
        switch (t) {
            case 0: // I型
                this.blocks = [new Block(0, 1, t), new Block(1, 1, t), new Block(2, 1, t), new Block(3, 1, t)]
                this.pivot = { x: 1.5, y: 1.5 }
                break;
            case 1: // O型（回転しないので中心固定）
                this.blocks = [new Block(1, 1, t), new Block(2, 1, t), new Block(1, 2, t), new Block(2, 2, t)]
                this.pivot = { x: 1.5, y: 1.5 }
                break;
            case 2: // T型
                this.blocks = [new Block(1, 1, t), new Block(0, 2, t), new Block(1, 2, t), new Block(2, 2, t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 3: // J型
                this.blocks = [new Block(0, 1, t), new Block(0, 2, t), new Block(1, 2, t), new Block(2, 2, t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 4: // L型
                this.blocks = [new Block(2, 1, t), new Block(0, 2, t), new Block(1, 2, t), new Block(2, 2, t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 5: // S型
                this.blocks = [new Block(1, 1, t), new Block(2, 1, t), new Block(0, 2, t), new Block(1, 2, t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 6: // Z型
                this.blocks = [new Block(0, 1, t), new Block(1, 1, t), new Block(1, 2, t), new Block(2, 2, t)]
                this.pivot = { x: 1, y: 2 }
                break;
        }
    }

    spawn() {
        this.x = COLS_COUNT / 2 - 2
        // Iミノ(type:0)はブロック定義が1段高いため、yを1段下げる
        this.y = (this.type === 0) ? -1 : -2;
        this.rotation = 0
    }

    draw(ctx, overrideY = null) {
        const drawY = overrideY !== null ? overrideY : this.y
        this.blocks.forEach(block => {
            block.draw(this.x, drawY, ctx)
        })
    }

    drawNext(ctx) {
        this.blocks.forEach(block => {
            block.drawNext(ctx)
        })
    }

    // 右回転（時計回り）
    rotate() {
        this.blocks.forEach(block => {
            let relX = block.x - this.pivot.x
            let relY = block.y - this.pivot.y

            let newX = -relY
            let newY = relX

            block.x = Math.round(newX + this.pivot.x)
            block.y = Math.round(newY + this.pivot.y)
        })
    }

    // 左回転（反時計回り）
    rotateCCW() {
        this.blocks.forEach(block => {
            let relX = block.x - this.pivot.x
            let relY = block.y - this.pivot.y

            let newX = relY
            let newY = -relX

            block.x = Math.round(newX + this.pivot.x)
            block.y = Math.round(newY + this.pivot.y)
        })
    }

    getNewBlocks(moveX, moveY, rot) {
        let newBlocks = this.blocks.map(block => {
            return new Block(block.x, block.y)
        })
        newBlocks.forEach(block => {
            if (moveX || moveY) {
                block.x += moveX
                block.y += moveY
            }
            if (rot === 1 || rot === -1) {
                let relX = block.x - this.pivot.x
                let relY = block.y - this.pivot.y

                let newX, newY
                if (rot === 1) {
                    newX = -relY
                    newY = relX
                } else {
                    newX = relY
                    newY = -relX
                }

                block.x = Math.round(newX + this.pivot.x)
                block.y = Math.round(newY + this.pivot.y)
            }
            block.x += this.x
            block.y += this.y
        })
        return newBlocks
    }
}

// ─────────────────────────────────────────────
// Field クラス
// ─────────────────────────────────────────────
class Field {
    constructor() {
        this.blocks = []
    }

    drawFixedBlocks(ctx) {
        this.blocks.forEach(block => block.draw(0, 0, ctx))
    }

    checkLine() {
        let linesCleared = 0
        for (var r = 0; r < ROWS_COUNT; r++) {
            var c = this.blocks.filter(block => block.y === r).length
            if (c === COLS_COUNT) {
                this.blocks = this.blocks.filter(block => block.y !== r)
                this.blocks.filter(block => block.y < r).forEach(upper => upper.y++)
                linesCleared++
                r--
            }
        }
        return linesCleared
    }

    has(x, y) {
        return this.blocks.some(block => block.x == x && block.y == y)
    }
}


// ==========================================
// ※ 今後、画像読み込み機能(preload)や、
// テト・ぷよ共通の演出クラス(EffectManager等)を作成する場合は
// ここに追記していくと綺麗にまとまります。
// ==========================================
