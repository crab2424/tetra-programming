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
                // 出力デバイスのアイドル復帰（起床レイテンシ）対策：無音キープアライブを起動して
                // デバイスを寝かせない。SE/BGM 全体で一律に乗る遅延を防ぐ（初回操作で一度だけ）。
                if (window.AudioLoader) AudioLoader.startKeepAlive();
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

        // フォアグラウンド復帰時にAudioContextの劣化（出力レイテンシ蓄積）を点検し、
        // 必要ならコンテキストを作り直してSEの再生遅延（ズレ）をリセットする。
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && window.AudioLoader) {
                AudioLoader.recoverIfDegraded(true);
            }
        });

        // ★ ぷよ画像を起動時に先読み（tetブロック画像と同じく即時キャッシュ化）。
        //   初回 startPuyoGame() 時の画像ロード待ち（約200ms）を解消する。
        //   総容量は約250KB程度で、ゲーム開始前のこの時点なら体感に影響しない。
        //   ※ アイドル遅延（requestIdleCallback）にすると発火が序盤プレイへずれ込み、
        //     fetch/onload がメインスレッドを奪ってカクつく原因になるため即時起動する。
        if (typeof PuyoGame !== 'undefined' && PuyoGame.preloadImages) {
            PuyoGame.preloadImages();
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

        // CPU側のタイマーでも呼ばれる場合は二重再生を防ぐ。
        // カウント(3/2/1)は countdown_count、START! は countdown_start を鳴らし、
        // 演出と同タイミングで count×3 + start×1 になるようにする。
        if (window.SeManager && overlayId !== 'cpu-countdown-overlay') {
            window.SeManager.play(val === 'START!' ? 'countdown_start' : 'countdown_count');
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
    imagePath: 'assets/images/p_images/puyo/',
    ojamaImagePath: 'assets/images/p_images/Ojama/',
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
    static _keepAlive  = null;  // 無音キープアライブのbufferSource（多重起動防止＆GC防止）
    static _ctxCreatedAt = 0;
    static _lastHealthCheckAt = 0;
    static _healthCheckIntervalMs = 10000;
    static _maxContextAgeMs = 10 * 60 * 1000;

    static get context() {
        if (!this._ctx) this._ctx = this._createContext();
        return this._ctx;
    }

    // AudioContextを生成し、状態監視（②対策）を取り付けて返す。
    // ②: OSのスリープ復帰・他アプリの音声割り込み・デバイス切替などで
    // コンテキストが running から suspended/interrupted に落ちると、以降のSEが
    // 取りこぼされる。statechange を監視し、ユーザーがページを見ている間は自動で
    // resume して復帰させる（バックグラウンド中の復帰は visibilitychange 側に委譲）。
    static _createContext() {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this._ctxCreatedAt = performance.now();
        ctx.addEventListener('statechange', () => {
            if (ctx !== this._ctx) return;      // 作り直し後の旧コンテキストのイベントは無視
            if (ctx.state !== 'running' && document.visibilityState === 'visible') {
                ctx.resume().catch(() => {});
            }
        });
        return ctx;
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

    // ── 無音キープアライブ ───────────────────────────────────────────
    // macOS(CoreAudio)等では無音が続くと出力デバイスが省電力で寝てしまい、
    // 次の音で「起床レイテンシ」が一律に乗る（SE/BGM が揃って同じだけ遅れる）。
    // 実質無音のループ音源を destination へ流しっぱなしにしてデバイスを起こし続け、
    // この起床遅延を防ぐ。出力デバイスは全音声で共有されるため、これ1本で
    // Web Audio の SE も HTMLAudio の BGM も両方カバーされる。
    // 解錠時（初回ユーザー操作）に一度だけ呼ぶ。多重起動は _keepAlive で防ぐ。
    static startKeepAlive() {
        if (this._keepAlive) return;          // 既に起動済み
        const ctx = this.context;
        // 1フレーム長の無音バッファをループ再生（中身ゼロ＝完全無音。ストリームを開いたままに保つのが目的）
        const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop   = true;
        source.connect(ctx.destination);
        source.start(0);
        this._keepAlive = source;             // GC防止＆多重起動防止のため参照を保持
    }

    // ── 劣化したAudioContextの作り直し ─────────────────────────────────
    // 単一のAudioContextを長時間使い回すと、（特にタブのバックグラウンド化を経て）
    // 出力レイテンシが蓄積し、SEの発音が視覚イベントに対してジワジワ遅れる。
    // ここで劣化したコンテキストを破棄して新規生成することでリセットする。
    // BGMはHTMLAudio経由でこのコンテキストを通らないため影響を受けない＝SEのみが対象。
    // SEバッファ（decodeAudioData済みAudioBuffer）は現行ブラウザではコンテキスト間で
    // 再利用可能なため、_seBuffers は作り直さずそのまま使える。
    static recreateContext() {
        const old = this._ctx;
        if (!old) return;
        // 新しいコンテキストへ差し替え（以後の play() は新コンテキストで鳴る）
        this._ctx = this._createContext();
        // keepAlive は古いコンテキストに紐づくので新コンテキストで張り直す
        this._keepAlive = null;
        this._lastHealthCheckAt = performance.now();
        this.startKeepAlive();
        this._ctx.resume().catch(() => {});
        // 古いコンテキストは閉じて、溜まった出力レイテンシごとリソースを解放
        old.close().catch(() => {});
    }

    // フォアグラウンド復帰時やSE再生時に呼ぶ。出力レイテンシが異常に膨らんでいれば
    // コンテキストを作り直し、単に中断していただけなら resume で済ませる。
    // SE再生時は頻繁に呼ばれるため、force=false では軽量な間引きチェックにする。
    static recoverIfDegraded(force = false) {
        const ctx = this._ctx;
        if (!ctx) return;                       // 未解錠（コンテキスト未生成）なら何もしない
        const now = performance.now();
        if (!force && now - this._lastHealthCheckAt < this._healthCheckIntervalMs) return;
        this._lastHealthCheckAt = now;

        const latencyBad = typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0.05;
        // outputLatency が未対応/不正確なブラウザでも、開きっぱなしでの蓄積ズレを定期的に逃がす。
        const ageBad = document.visibilityState === 'visible'
            && this._ctxCreatedAt > 0
            && now - this._ctxCreatedAt > this._maxContextAgeMs;

        if (latencyBad || ageBad) {
            this.recreateContext();             // ①: 蓄積した出力レイテンシを作り直しで解消
        } else if (ctx.state !== 'running') {
            ctx.resume().catch(() => {});       // 中断していただけなら resume で十分
        }
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
        // シングル各モードBGM（今は同一ファイル＝同係数。モード別音源にしたら個別に実測して調整）
        'single_marathon_bgm': 0.90,
        'single_sprint_bgm':   0.90,
        'single_ultra_bgm':    0.90,
        'single_puyo_bgm':     0.90,
    };

    // ── シングルモードの mode → BGMキー対応 ───────────────────────────
    // 将来モードごとに別BGMにしたくなったら、base.js 末尾の registerBgm のパスを
    // モード別に書き換えるだけでよい（再生ロジックは変更不要）。
    // 未登録の mode は 'single_marathon_bgm'（実在キー）にフォールバックする。
    static _singleBgmKeys = {
        marathon: 'single_marathon_bgm',
        sprint:   'single_sprint_bgm',
        ultra:    'single_ultra_bgm',
        puyo:     'single_puyo_bgm',
    };
    static singleBgmKey(mode) {
        return this._singleBgmKeys[mode] || 'single_marathon_bgm';
    }

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
        'countdown_count': 0.50,  // 未配置（カウント3/2/1用）
        'countdown_start': 1.00,  // 未配置（START!用）
        'gameover':      1.00,  // 未配置（tet/puyo共通）
        // テト系
        'move':          1.00,  // -27.2 / -1.0（ピーク余裕なし＝据え置き）
        'rotate':        1.40,  // -34.8 / -5.4
        'tspin_rot':     2.00,  // 未配置（実測後に調整）
        'harddrop':      0.30,  // -39.9 / -9.6
        'drop':          0.25,  // ソフトドロップ毎マス用（未実測・高頻度のため控えめ。耳で調整）
        'lock':          1.85,  // -31.6 / -6.4（通常固定：そのまま鳴らす）
        'lock_hard':     0.32,  // ハードドロップ時の重ね鳴らし用（harddropと同時のため小音量）
        'hold':          1.25,  // -24.0 / -6.4
        '1line':         0.90,  // 未実測
        '2lines':        0.90,  // 未実測
        '3lines':        0.90,  // 未実測
        '4lines':        2.20,  // -29.0 / -8.8
        'tspin':         0.90,  // -20.2 / -0.0（ピーク張り付き＝微減衰）
        // ぷよ系
        'puyo_move':     3.50,  // -33.5 / -12.9
        'puyo_rotate':   1.00,  // 未配置
        'puyo_drop':     1.70,  // -15.9 / -5.6（fix.ogg）
        'puyo_fix':      1.70,  // -15.9 / -5.6
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

        AudioLoader.recoverIfDegraded();
        const ctx    = AudioLoader.context;
        // 中断（suspended/interrupted）中はキューに積まず捨てる（resume は試みるがこの音は鳴らさない）。
        //   理由＝suspended のまま start(0) すると、ブラウザによっては再生されず内部キューに溜まり、
        //   次に running へ戻った瞬間（多くは自分の操作＝ユーザージェスチャでの resume 時）に
        //   溜まった音が一斉に鳴る「バースト」になる。オンライン対戦では自分が無操作で相手のSEが
        //   流れ続ける間にコンテキストが suspended に落ちると、自分のキー操作で相手の溜まった操作SEが
        //   一斉に鳴る症状が出る。中断中の音は取りこぼし（無音）にして、復帰後の音だけ正しく鳴らす。
        if (ctx.state !== 'running') { ctx.resume().catch(() => {}); return; }
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
// シングル4モード（marathon/sprint/ultra/puyo）は将来モードごとに別BGMにできるよう
// 個別キーで登録する。今は全モード同一ファイル(single_1.ogg)を指す。
// → モード別BGMにしたくなったら、下記4行のパスをそれぞれ差し替えるだけで適用される
//   （再生ロジック・キー対応は BgmManager.singleBgmKey 側で完結済み）。
AudioLoader.registerBgm('single_marathon_bgm', 'assets/audio/bgm/single_1.ogg');
AudioLoader.registerBgm('single_sprint_bgm',   'assets/audio/bgm/challenge_1.ogg');
AudioLoader.registerBgm('single_ultra_bgm',    'assets/audio/bgm/challenge_1.ogg');
AudioLoader.registerBgm('single_puyo_bgm',     'assets/audio/bgm/single_1.ogg');
AudioLoader.registerBgm('versus_bgm', 'assets/audio/bgm/vs_1.ogg');
AudioLoader.registerBgm('menu_bgm',   'assets/audio/bgm/menu_1.ogg');
AudioLoader.registerBgm('quiz_bgm',   'assets/audio/bgm/quiz_1.ogg');
AudioLoader.registerBgm('test_bgm',   'assets/audio/bgm/cputest_1.ogg');

// ─── SE 登録（ページロード時に一括プリロード） ────────────────
// 音源は assets/audio/se/{menu,tet,puyo}/ に配置する。
// 未配置のキーは loadSe 側で個別にスキップされ、該当SEは無音になるだけで動作には影響しない。
AudioLoader.loadSe({
    // メニュー系
    'countdown_count': 'assets/audio/se/menu/countdown_count.ogg',
    'countdown_start': 'assets/audio/se/menu/countdown_start.ogg',
    'menu_decide':  'assets/audio/se/menu/decide.ogg',
    'menu_cancel':  'assets/audio/se/menu/cancel.ogg',
    // ポーズ/リジューム（同一音源でも別パスでも可。未配置時は無音）
    'pause':        'assets/audio/se/menu/pause.ogg',
    'resume':       'assets/audio/se/menu/pause.ogg',
    // ゲームオーバー（tet/puyo共通の統一SE）
    'gameover':     'assets/audio/se/menu/gameover.ogg',
    // テト系
    'move':      'assets/audio/se/tet/move.ogg',
    'rotate':    'assets/audio/se/tet/rotate.ogg',
    'tspin_rot': 'assets/audio/se/tet/tspin_rot.ogg',
    'harddrop':  'assets/audio/se/tet/harddrop.ogg',
    'drop':      'assets/audio/se/tet/drop.ogg', // ソフトドロップ（毎マス）
    'lock':      'assets/audio/se/tet/lock.ogg',
    'lock_hard': 'assets/audio/se/tet/lock.ogg', // 同一音源・別音量（ハードドロップ重ね用）
    'hold':      'assets/audio/se/tet/hold.ogg',
    '1line':     'assets/audio/se/tet/1line.ogg',
    '2lines':    'assets/audio/se/tet/2lines.ogg',
    '3lines':    'assets/audio/se/tet/3lines.ogg',
    '4lines':    'assets/audio/se/tet/4lines.ogg',
    'tspin':     'assets/audio/se/tet/tspin.ogg',
    // ぷよ系
    'puyo_move':     'assets/audio/se/puyo/move.ogg',
    'puyo_rotate':   'assets/audio/se/puyo/rotate.ogg',
    'puyo_drop':     'assets/audio/se/puyo/fix.ogg',
    'puyo_fix':      'assets/audio/se/puyo/fix.ogg',
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
// ※ メインメニュー演出（パーティクル）は src/core/particles.js に移動しました
// ==========================================
