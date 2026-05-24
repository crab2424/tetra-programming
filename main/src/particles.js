// ─────────────────────────────────────────────
// particles.js
// メインメニュー背景パーティクル演出
// base.js から切り出した独立ファイル
// ─────────────────────────────────────────────

// ==========================================
// メインメニュー演出
// ==========================================

// ─────────────────────────────────────────────
// MenuParticles  パーティクル降下
// main-menu-page の背景canvasに光の粒を降らせる
// ─────────────────────────────────────────────
class MenuParticles {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.animId = null;
        this._resize = this._resize.bind(this);
        this._loop   = this._loop.bind(this);
        window.addEventListener('resize', this._resize);
        // 先にリサイズでcanvasサイズを確定してから初期パーティクルを生成する
        this._resize();
        this._spawn();
        // 立ち上げと同時にループを開始する（常時動作）
        this.start();
    }

    _resize() {
        this.canvas.width  = this.canvas.offsetWidth  || window.innerWidth;
        this.canvas.height = this.canvas.offsetHeight || window.innerHeight;
    }

    // 初期パーティクルを画面全体にばらまく（起動時の空白感をなくす）
    _spawn() {
        // リサイズ後に呼ぶので this.canvas.width/height は必ず正の値になっている
        const W = this.canvas.width;
        const H = this.canvas.height;
        const COUNT = 150;
        for (let i = 0; i < COUNT; i++) {
            this.particles.push(this._make(W, H, true));
        }
    }

    _make(W, H, randomY = false) {
        const size  = Math.random() * 2.5 + 0.5;      // 0.5〜3px
        const speed = Math.random() * 0.6 + 0.2;      // ゆっくり落下
        const drift = (Math.random() - 0.5) * 0.3;    // わずかに横ブレ
        // 色: シアン / ホワイト / パープル の3トーンをランダムに
        const palette = [
            `rgba(180, 220, 255, `,  // 薄青
            `rgba(255, 255, 255, `,  // 白
            `rgba(196, 113, 245, `,  // パープル
        ];
        const color = palette[Math.floor(Math.random() * palette.length)];
        return {
            x:     Math.random() * W,
            y:     randomY ? Math.random() * H : -size,
            size,
            speed,
            drift,
            color,
            alpha: Math.random() * 0.5 + 0.2,   // 0.2〜0.7
            twinkle: Math.random() * Math.PI * 2, // ちらつき位相
        };
    }

    _loop() {
        const W = this.canvas.width;
        const H = this.canvas.height;
        this.ctx.clearRect(0, 0, W, H);

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];

            // ちらつき: sinで alpha をゆっくり変動
            p.twinkle += 0.02;
            const a = p.alpha * (0.7 + 0.3 * Math.sin(p.twinkle));

            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            this.ctx.fillStyle = p.color + a + ')';
            this.ctx.fill();

            // 移動
            p.y += p.speed;
            p.x += p.drift;

            // 画面外に出たら上から再生成
            if (p.y > H + p.size) {
                this.particles[i] = this._make(W, H, false);
            }
        }

        // 上限未満のときだけ新粒子を追加（古い粒子を強制削除しない）
        if (this.particles.length < 200 && Math.random() < 0.6) {
            this.particles.push(this._make(W, H, false));
        }

        this.animId = requestAnimationFrame(this._loop);
    }

    start() {
        if (this.animId) return;
        this.animId = requestAnimationFrame(this._loop);
    }

    stop() {
        if (this.animId) cancelAnimationFrame(this.animId);
        this.animId = null;
        if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    destroy() {
        this.stop();
        window.removeEventListener('resize', this._resize);
    }
}

// ─────────────────────────────────────────────
// initMenuAnimations  メインメニュー遷移時に呼ぶ初期化
// router.js の switchPage('main-menu') から呼び出してください
//   例: if (typeof initMenuAnimations === 'function') initMenuAnimations();
// ─────────────────────────────────────────────
function initMenuAnimations(pageId = 'main-menu') {
    // 全ページ共通の常時動作レイヤーなので、初回起動時のみインスタンス作成する
    if (!window._menuParticles) {
        window._menuParticles = new MenuParticles('menu-particle-canvas');
    }

    // ── ボタン登場アニメーション ─────────────
    const page = document.getElementById(pageId + '-page');
    if (!page) return;

    let targets = [];

    if (pageId === 'main-menu') {
        targets = [
            { sel: '#main-menu-logo',           cls: 'menu-enter',  delay: 0   },
            { sel: '.mode-btn-marathon',        cls: 'menu-enter',  delay: 1   },
            { sel: '.mode-btn-sprint',          cls: 'menu-enter',  delay: 2   },
            { sel: '.mode-btn-ultra',           cls: 'menu-enter',  delay: 3   },
            { sel: '.mode-btn-versus',          cls: 'menu-enter',  delay: 2   },
            { sel: '.mode-btn-test',            cls: 'menu-enter',  delay: 3   },
            { sel: '.mode-btn-puyo',            cls: 'menu-enter',  delay: 2   },
            { sel: '.mode-btn-quiz',            cls: 'menu-enter',  delay: 3   },
            { sel: '#main-menu-footer',         cls: 'menu-enter',  delay: 4   },
        ];
    } else if (pageId === 'mode-check') {
        targets = [
            { sel: '#mode-check-header',        cls: 'menu-enter',  delay: 0   },
            { sel: '#mode-check-desc-block',    cls: 'menu-enter',  delay: 1   },
            { sel: '#mode-check-options',       cls: 'menu-enter',  delay: 2   },
            { sel: '#mode-check-controls',      cls: 'menu-enter',  delay: 3   },
            { sel: '#mode-check-buttons',       cls: 'menu-enter',  delay: 4   },
        ];
    } else if (pageId === 'versus-check') {
        targets = [
            { sel: '#versus-check-header',      cls: 'menu-enter',  delay: 0   },
            { sel: '#versus-check-desc-block',  cls: 'menu-enter',  delay: 1   },
            { sel: '#versus-rule-options',      cls: 'menu-enter',  delay: 2   },
            { sel: '#versus-cpu-options',       cls: 'menu-enter',  delay: 3   },
            { sel: '#versus-check-controls',    cls: 'menu-enter',  delay: 4   },
            { sel: '#versus-check-buttons',     cls: 'menu-enter',  delay: 5   },
        ];
    } else if (pageId === 'quiz-check') {
        targets = [
            { sel: '#quiz-check-header',        cls: 'menu-enter',  delay: 0   },
            { sel: '.mode-check-desc-ja',       cls: 'menu-enter',  delay: 1   },
            { sel: '#quiz-rule-select',         cls: 'menu-enter',  delay: 2   },
            { sel: '#quiz-level-list',          cls: 'menu-enter',  delay: 3   },
            { sel: '#quiz-check-container > div:last-child', cls: 'menu-enter', delay: 4 }, // BACK button container
        ];
    } else if (pageId === 'result' || pageId === 'versus-result' || pageId === 'quiz-result') {
        targets = [
            { sel: 'h2',                        cls: 'menu-enter',  delay: 0   },
            { sel: '#result-stats',             cls: 'menu-enter',  delay: 1   },
            { sel: '#result-buttons',           cls: 'menu-enter',  delay: 2   },
        ];
    }

    targets.forEach(({ sel, cls, delay }) => {
        const els = page.querySelectorAll(sel);
        els.forEach(el => {
            // クラスを一度外してリフローを挟み、再付与することで再アニメーション
            el.classList.remove(cls);
            el.style.animationDelay = `${delay * 0.08}s`;
            void el.offsetWidth;            // reflow
            el.classList.add(cls);
        });
    });
}

// ─────────────────────────────────────────────
// stopMenuAnimations  全ページ共通の常時動作なので何もしない
// 互換性のために関数名は残す
// ─────────────────────────────────────────────
function stopMenuAnimations() {
    // 常時動作なのでパーティクルは止めない
    // (BGMと同様に途切れなしに動かし続ける)
}

window.MenuParticles       = MenuParticles;
window.initMenuAnimations  = initMenuAnimations;
window.stopMenuAnimations  = stopMenuAnimations;
