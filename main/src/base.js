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
    "assets/images/t_images/block-0.png", // ID 0: I型（推奨色: 水色）
    "assets/images/t_images/block-1.png", // ID 1: O型（推奨色: 黄色）
    "assets/images/t_images/block-2.png", // ID 2: T型（推奨色: 紫色）
    "assets/images/t_images/block-3.png", // ID 3: J型（推奨色: 青色）
    "assets/images/t_images/block-4.png", // ID 4: L型（推奨色: 橙色）
    "assets/images/t_images/block-5.png", // ID 5: S型（推奨色: 緑色）
    "assets/images/t_images/block-6.png", // ID 6: Z型（推奨色: 赤色）
    "assets/images/t_images/block-7.png"  // ID 7: おじゃまブロック（推奨色: 灰色）
]

window.onload = function () {
    // ── 背景演出を最初から常時起動（全ページ共通） ──
    // BGMと同様にページをまたいで途切れなく動かし続ける
    if (!window._menuParticles) {
        window._menuParticles = new MenuParticles('menu-particle-canvas');
    }

    // ★ 追加: 保存済み音量を起動時に復元
    (function() {
        const saved = localStorage.getItem('game_volume');
        if (saved) {
        try {
            const v = JSON.parse(saved);
            if (window.BgmManager && v.bgm != null) window.BgmManager.setVolume(v.bgm);
            if (window.SeManager  && v.se  != null) window.SeManager.setVolume(v.se);
        } catch(e) {}
        }
    })();
    
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

        // 初回ロード時にタイトルBGMの再生を試みる
        if (window.BgmManager) {
            window.BgmManager.play('menu_bgm');
            
            // ブラウザの自動再生制限(Autoplay Policy)対策
            // 初回ユーザー操作時にBGMが一時停止中（＝自動再生ブロック済み）なら再生する
            const unlockAudio = () => {
                const bm = window.BgmManager;
                // SE用のAudioContextも初回操作で解錠する（suspended状態だと初回SEが欠落するため）
                if (window.AudioLoader && AudioLoader._ctx && AudioLoader._ctx.state === 'suspended') {
                    AudioLoader._ctx.resume().catch(() => {});
                }
                // _audio が存在しつつ paused＝自動再生がブロックされたケース
                const isBlocked = bm._audio && bm._audio.paused;
                if (isBlocked || !bm.isCurrent('menu_bgm')) {
                    const active = document.querySelector('.page.active');
                    if (active && (active.id === 'title-page' || active.id === 'main-menu-page')) {
                        bm.play('menu_bgm');
                    }
                }
                document.removeEventListener('click', unlockAudio);
                document.removeEventListener('keydown', unlockAudio);
                document.removeEventListener('touchstart', unlockAudio);
            };
            document.addEventListener('click', unlockAudio);
            document.addEventListener('keydown', unlockAudio);
            document.addEventListener('touchstart', unlockAudio);
        }
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

        // CPU側のタイマーでも呼ばれる場合は二重再生を防ぐ
        if (window.SeManager && overlayId !== 'cpu-countdown-overlay') {
            window.SeManager.play('countdown');
        }

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

    // 既に表示中（active）のオーバーレイへ再表示する場合、親の display は
    // 変化せず finish-appear が再生されない。reflow を強制してアニメを再起動する。
    textEl.style.animation = 'none';
    void textEl.offsetWidth;
    textEl.style.animation = '';

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
    imagePath: 'assets/images/p_images/',
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
// 3. 共通データクラス（テト）
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

// ─────────────────────────────────────────────
// AudioLoader  音声ファイルのロード・キャッシュ管理
// ─────────────────────────────────────────────
class AudioLoader {
    // SEはAudioContextで扱うためArrayBufferとしてキャッシュ
    static _seBuffers  = {};  // { key: AudioBuffer }
    static _bgmSrcMap  = {};  // { key: src }
    static _ctx        = null;

    static get context() {
        if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        return this._ctx;
    }

    // BGMのsrcを登録（ロードはしない）
    static registerBgm(key, src) {
        this._bgmSrcMap[key] = src;
    }

    static getBgmSrc(key) {
        return this._bgmSrcMap[key] ?? null;
    }

    // SE群を一括プリロード（起動時に呼ぶ）
    static loadSe(seMap) {
        // seMap: { key: src, ... }
        const promises = Object.entries(seMap).map(([key, src]) => {
            return fetch(src)
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
                .then(buf => this.context.decodeAudioData(buf))
                .then(decoded => { this._seBuffers[key] = decoded; })
                // 個別ファイルの欠損/デコード失敗で全体を巻き込まないようにする
                // （音源未配置でもアプリは動作し、該当SEは無音になるだけ）
                .catch(err => { console.warn(`[AudioLoader] SE "${key}" の読み込みに失敗: ${src}`, err); });
        });
        return Promise.all(promises);
    }

    static getSeBuffer(key) {
        return this._seBuffers[key] ?? null;
    }
}

// ─────────────────────────────────────────────
// BgmManager  BGMの再生・停止・フェード制御
// ─────────────────────────────────────────────
class BgmManager {
    static _audio      = null;
    static _currentKey = null;
    static _volume     = 0.5;
    static _muted      = false;
    static _fadeTimer  = null;
    static _ducked     = false;   // ポーズ中などにBGMを小音量で流し続ける状態
    static _duckRatio  = 0.25;    // ダッキング時の音量倍率（通常音量に対する割合）

    // ── キー別の音量補正係数（素材ごとの録音レベル差を吸収）─────────────
    // 1.00 = 無補正。BGMはピークが0dB張り付きのため減衰のみで最も静かな menu に揃える。
    // コメント = 実測 mean(dBFS)。値を 1.00 に戻せば元通り（＝完全可逆・無劣化）。
    static _gain = {
        'menu_bgm':   1.00,  // -14.1
        'quiz_bgm':   0.63,  // -10.0
        'versus_bgm': 0.50,  // -8.0
    };

    static play(key) {
        const src = AudioLoader.getBgmSrc(key);
        if (!src) return;
        if (this._fadeTimer) {
            clearInterval(this._fadeTimer);
            this._fadeTimer = null;
        }

        if (this._currentKey === key && this._audio) {
            this._audio.volume = this._effectiveVolume();
            if (this._audio.paused) this._audio.play().catch(() => {});
            return;
        }

        this.stop(true);
        this._audio = new Audio();
        this._audio.loop   = true;
        // ★ 音量補正係数(_gain)は _currentKey を見て決まるので、volume を計算する前にキーを更新する。
        //   （順序が逆だと直前のBGMの係数で鳴ってしまい、versus_bgm等の補正が効かない）
        this._currentKey   = key;
        this._audio.volume = this._effectiveVolume();
        this._audio.src    = src;
        this._audio.play().catch(() => {});
    }

    static stop(immediate = false, fadeMs = 300) {
        // ダッキング状態を解除（次に流すBGMが小音量のまま始まるのを防ぐ）
        this._ducked = false;
        if (!this._audio) return;
        if (this._fadeTimer) {
            clearInterval(this._fadeTimer);
            this._fadeTimer = null;
        }
        if (immediate) {
            this._audio.pause();
            this._audio.currentTime = 0;
            this._audio = null;
            this._currentKey = null;
        } else {
            this.fadeOut(fadeMs, () => {
                if (this._audio) {
                    this._audio.currentTime = 0;
                    this._audio = null;
                }
                this._currentKey = null;
            });
        }
    }

    static pause()  { this._audio?.pause(); }
    static resume() { this._audio?.play().catch(() => {}); }
    static isCurrent(key) { return this._currentKey === key && !!this._audio; }

    // 別BGMへクロスフェード：旧BGMを ms かけてフェードアウトしつつ、新BGMを同じ ms で
    // 0→実効音量へフェードイン。ぶつ切りを避ける（リザルト→メニュー復帰などで使用）。
    // 同一キーが既に再生中なら音量だけ整えて継続（冪等）。
    static crossfadeTo(key, ms = 800) {
        const src = AudioLoader.getBgmSrc(key);
        if (!src) return;

        if (this._currentKey === key && this._audio) {
            this._applyVolume();
            if (this._audio.paused) this._audio.play().catch(() => {});
            return;
        }

        // 進行中のフェード（_fadeTimer）は止める
        if (this._fadeTimer) { clearInterval(this._fadeTimer); this._fadeTimer = null; }

        const stepCount = Math.max(1, Math.round(ms / 50));

        // 旧BGMを独立タイマーでフェードアウト（this._audio はこの後 新BGMに差し替わるため捕捉しておく）
        const old = this._audio;
        if (old) {
            const startVol = old.volume;
            let i = 0;
            const outTimer = setInterval(() => {
                i++;
                old.volume = Math.max(0, startVol * (1 - i / stepCount));
                if (i >= stepCount) {
                    clearInterval(outTimer);
                    old.pause();
                    try { old.currentTime = 0; } catch (e) {}
                }
            }, 50);
        }

        // 新BGMを 0 からフェードイン
        this._ducked = false;
        this._currentKey = key;
        this._audio = new Audio();
        this._audio.loop = true;
        this._audio.src = src;
        this._audio.volume = 0;
        this._audio.play().catch(() => {});
        const target = this._effectiveVolume();
        let j = 0;
        this._fadeTimer = setInterval(() => {
            if (!this._audio) { clearInterval(this._fadeTimer); this._fadeTimer = null; return; }
            j++;
            this._audio.volume = Math.min(target, target * (j / stepCount));
            if (j >= stepCount) {
                clearInterval(this._fadeTimer);
                this._fadeTimer = null;
                this._audio.volume = this._effectiveVolume();
            }
        }, 50);
    }

    // ミュート・ダッキングを加味した実効音量
    static _effectiveVolume() {
        if (this._muted) return 0;
        const g = this._gain[this._currentKey] ?? 1;
        const base = this._ducked ? this._volume * this._duckRatio : this._volume;
        return Math.min(1, base * g);
    }

    static _applyVolume() {
        if (this._audio) this._audio.volume = this._effectiveVolume();
    }

    // ポーズ中などにBGMを止めず小音量で流し続ける（ratio省略時は既定値）
    static duck(ratio = null) {
        if (ratio !== null) this._duckRatio = Math.max(0, Math.min(1, ratio));
        this._ducked = true;
        this._applyVolume();
    }

    static unduck() {
        this._ducked = false;
        this._applyVolume();
    }

    static setVolume(v) {
        this._volume = Math.max(0, Math.min(1, v));
        this._applyVolume();
    }

    static toggleMute() {
        this._muted = !this._muted;
        this._applyVolume();
        return this._muted;
    }

    static fadeOut(ms = 500, cb = null) {
        if (!this._audio) { cb?.(); return; }
        if (this._fadeTimer) clearInterval(this._fadeTimer);
        const step = this._audio.volume / (ms / 50);
        this._fadeTimer = setInterval(() => {
            if (!this._audio) { clearInterval(this._fadeTimer); cb?.(); return; }
            this._audio.volume = Math.max(0, this._audio.volume - step);
            if (this._audio.volume <= 0) {
                clearInterval(this._fadeTimer);
                this._audio.pause();
                cb?.();
            }
        }, 50);
    }
}

// ─────────────────────────────────────────────
// SeManager  SEの再生制御
// ─────────────────────────────────────────────
class SeManager {
    static _volume = 0.8;
    static _muted  = false;

    // ── キー別の音量補正係数（素材ごとの録音レベル差を吸収）─────────────
    // 1.00 = 無補正。実効音量 = _volume × _gain[key]（GainNodeで乗算）。
    // 初期値は ffmpeg volumedetect の実測 mean/max(dBFS) を基に、目標平均 ≈ -22dB へ
    // 寄せつつピークがクリップしない範囲に収めたもの（コメント = 実測 mean / max）。
    // 値を 1.00 に戻せば元通り（＝完全可逆・無劣化）。耳で微調整可。
    static _gain = {
        // メニュー系
        'menu_cancel':   1.90,  // -27.6 / -6.8
        'menu_decide':   1.80,  // -40.3 / -6.3
        'pause':         1.00,  // 未配置（配置後に実測して調整）
        'resume':        1.00,  // 未配置（配置後に実測して調整）
        'countdown':     1.00,  // 未配置
        // テト系
        'move':          1.00,  // -27.2 / -1.0（ピーク余裕なし＝据え置き）
        'rotate':        1.65,  // -34.8 / -5.4
        'harddrop':      2.65,  // -39.9 / -9.6
        'lock':          1.85,  // -31.6 / -6.4
        'hold':          1.25,  // -24.0 / -6.4
        'lineclear':     0.90,  // -17.7 / -0.1（ピーク張り付き＝微減衰）
        '4lines':        2.20,  // -29.0 / -8.8
        'tspin':         0.90,  // -20.2 / -0.0（ピーク張り付き＝微減衰）
        'gameover':      1.00,  // 未配置
        // ぷよ系
        'puyo_move':     3.50,  // -33.5 / -12.9
        'puyo_rotate':   1.00,  // 未配置
        'puyo_drop':     1.70,  // -15.9 / -5.6（fix.ogg）
        'puyo_fix':      1.70,  // -15.9 / -5.6
        'puyo_gameover': 1.00,  // 未配置
        // 連鎖SE（未配置。配置後に実測して調整）
        'puyo_chain1':   1.00,
        'puyo_chain2':   1.00,
        'puyo_chain3':   1.00,
        'puyo_chain4':   1.00,
        'puyo_chain5':   1.00,
        'puyo_chain6':   1.00,
        'puyo_chain7':   1.00,
    };

    // AudioContextを使うことで同時再生・連打に対応
    static play(key) {
        if (this._muted) return;
        const buf = AudioLoader.getSeBuffer(key);
        if (!buf) return;

        const ctx    = AudioLoader.context;
        const source = ctx.createBufferSource();
        const gain   = ctx.createGain();
        gain.gain.value = this._volume * (this._gain[key] ?? 1);

        source.buffer = buf;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
        // 再生終了後は自動でGCされるため明示的な破棄は不要
    }

    static setVolume(v) { this._volume = Math.max(0, Math.min(1, v)); }
    static toggleMute() { this._muted = !this._muted; return this._muted; }
}

window.AudioLoader = AudioLoader;
window.BgmManager = BgmManager;
window.SeManager = SeManager;

// ─── BGM 登録（ページロード時） ────────────────
AudioLoader.registerBgm('versus_bgm', 'assets/audio/bgm/vs_1.ogg');
AudioLoader.registerBgm('menu_bgm',   'assets/audio/bgm/menu_1.ogg');
AudioLoader.registerBgm('quiz_bgm',   'assets/audio/bgm/quiz_1.ogg');

// ─── SE 登録（ページロード時に一括プリロード） ────────────────
// 音源は assets/audio/se/{menu,tet,puyo}/ に配置する。
// 未配置のキーは loadSe 側で個別にスキップされ、該当SEは無音になるだけで動作には影響しない。
AudioLoader.loadSe({
    // メニュー系
    'countdown':    'assets/audio/se/menu/countdown.ogg',
    'menu_decide':  'assets/audio/se/menu/decide.ogg',
    'menu_cancel':  'assets/audio/se/menu/cancel.ogg',
    // ポーズ/リジューム（同一音源でも別パスでも可。未配置時は無音）
    'pause':        'assets/audio/se/menu/pause.ogg',
    'resume':       'assets/audio/se/menu/resume.ogg',
    // テト系
    'move':      'assets/audio/se/tet/move.ogg',
    'rotate':    'assets/audio/se/tet/rotate.ogg',
    'harddrop':  'assets/audio/se/tet/harddrop.ogg',
    'lock':      'assets/audio/se/tet/lock.ogg',
    'hold':      'assets/audio/se/tet/hold.ogg',
    'lineclear': 'assets/audio/se/tet/lineclear.ogg',
    '4lines':    'assets/audio/se/tet/4lines.ogg',
    'tspin':     'assets/audio/se/tet/tspin.ogg',
    'gameover':  'assets/audio/se/tet/gameover.ogg',
    // ぷよ系
    'puyo_move':     'assets/audio/se/puyo/move.ogg',
    'puyo_rotate':   'assets/audio/se/puyo/rotate.ogg',
    'puyo_drop':     'assets/audio/se/puyo/fix.ogg',
    'puyo_fix':      'assets/audio/se/puyo/fix.ogg',
    'puyo_gameover': 'assets/audio/se/puyo/gameover.ogg',
    // 連鎖SE（1〜7連鎖目で音を変える。7連鎖目以降は puyo_chain7 を共用）
    'puyo_chain1': 'assets/audio/se/puyo/chain1.ogg',
    'puyo_chain2': 'assets/audio/se/puyo/chain2.ogg',
    'puyo_chain3': 'assets/audio/se/puyo/chain3.ogg',
    'puyo_chain4': 'assets/audio/se/puyo/chain4.ogg',
    'puyo_chain5': 'assets/audio/se/puyo/chain5.ogg',
    'puyo_chain6': 'assets/audio/se/puyo/chain6.ogg',
    'puyo_chain7': 'assets/audio/se/puyo/chain7.ogg'
});

// ─── メニューSE（クリック/ホバーへイベント委譲で付与） ────────────────
// onclick の付け方に依存せず動くよう、document へキャプチャ段で1つだけ委譲する。
// 戻る/キャンセル系ボタンは menu_cancel、それ以外の確定操作は menu_decide。
(function setupMenuSe() {
    // SE対象となるクリック可能要素のセレクタ
    // .util-link = TITLE/CREDITS/CHANGELOG、.quiz-level-btn = quizのレベルセレクト（オレンジ正方形）
    const CLICK_SELECTOR = '.menu-btn, .menu-btn-icon, .mode-btn, .pause-btn, .opt-btn, .btn, #title-page, .util-link, .quiz-level-btn';

    const isCancelBtn = (el) => {
        const cls = el.className || '';
        return cls.includes('back') || cls.includes('mainmenu') || cls.includes('cancel')
            || el.dataset?.se === 'cancel';
    };

    document.addEventListener('click', (e) => {
        const btn = e.target.closest(CLICK_SELECTOR);
        if (!btn) return;
        window.SeManager?.play(isCancelBtn(btn) ? 'menu_cancel' : 'menu_decide');
    }, true);
})();

// ==========================================
// ※ メインメニュー演出（パーティクル）は src/particles.js に移動しました
// ==========================================