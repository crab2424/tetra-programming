// ─────────────────────────────────────────────
// clear_fx.js
// ミノのライン消去・ぷよの消去のエフェクト（設定 DISPLAY › CLEAR EFFECT: OFF / LOW / HIGH）
//
//   ・見た目だけ。盤面・時計・乱数には一切さわらない（リプレイ・オンラインの同期に影響しない）。
//     時間は実時間（performance.now）で進める。
//   ・粒・帯は最初に作った固定数の入れ物を使い回す（毎フレームのゴミを出さない。versus のカクつき対策と同じ考え）。
//   ・リプレイのシーク・1 手送り・照らし合わせ（描かない再生）・速い倍速では出さない（ClearFx.allowed）。
//   ・座標は呼ぶ側の盤面の座標（テト: ブロック px、ぷよ: 論理 px）。描く側は盤面の ctx 変換の中で draw() を呼ぶ。
// ─────────────────────────────────────────────

const CLEAR_FX_MAX_SPARKS = 320;
const CLEAR_FX_MAX_BANDS = 8;
const CLEAR_FX_MAX_RINGS = 48;

// テトのブロックの種類ごとの粒の色（block-0〜7.png の推奨色）
const CLEAR_FX_TET_COLORS = ['#4fd8ff', '#ffe14d', '#c471f5', '#4f7dff', '#ff9a3c', '#5be36b', '#ff5050', '#a0a0a8'];
// ぷよの色（1〜5。draw.js の GHOST_OUTLINE_PUYO と同じ並び）・6=おじゃま
const CLEAR_FX_PUYO_COLORS = ['#e74c3c', '#3498db', '#9b59b6', '#2ecc71', '#f1c40f', '#c8c8d0'];

class ClearFx {
    constructor() {
        this.sparks = [];
        for (let i = 0; i < CLEAR_FX_MAX_SPARKS; i++) {
            this.sparks.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, g: 0, t: 0, life: 1, size: 3, color: '#fff' });
        }
        this.bands = [];
        for (let i = 0; i < CLEAR_FX_MAX_BANDS; i++) {
            this.bands.push({ on: false, y: 0, h: 0, t: 0, life: 1, alpha: 1, color: '#fff' });
        }
        this.rings = [];
        for (let i = 0; i < CLEAR_FX_MAX_RINGS; i++) {
            this.rings.push({ on: false, x: 0, y: 0, r0: 0, r1: 0, t: 0, life: 1, color: '#fff', width: 3 });
        }
        this.screen = { on: false, t: 0, life: 1, alpha: 0, color: '#fff' };
        this._next = 0;      // 次に使う粒（いっぱいなら古いものから上書き）
        this._last = 0;      // 前に描いた実時刻
        this.active = false; // 動いているものがあるか（テトの描き直しの判断に使う）
    }

    // 設定の強さ: 'off' | 'low' | 'high'（未設定は low）
    static level() {
        const v = window.currentDisplay && window.currentDisplay.clearEffect;
        return (v === 'off' || v === 'high') ? v : 'low';
    }

    // この盤面でいま出してよいか。リプレイは等倍〜2 倍の再生中だけ（シーク・止めての 1 手送り・照らし合わせでは出さない）
    static allowed(g) {
        if (ClearFx.level() === 'off') return false;
        const r = g && g._replay;
        if (r && !(r.state === 'play' && (r.speed || 1) <= 2)) return false;
        return true;
    }

    clear() {
        for (const s of this.sparks) s.on = false;
        for (const b of this.bands) b.on = false;
        for (const r of this.rings) r.on = false;
        this.screen.on = false;
        this.active = false;
    }

    // 粒を n 個、(x, y) の w×h の範囲から飛ばす
    spark(x, y, w, h, color, n, speed, life, size, gravity) {
        for (let i = 0; i < n; i++) {
            const s = this.sparks[this._next];
            this._next = (this._next + 1) % CLEAR_FX_MAX_SPARKS;
            const a = Math.random() * Math.PI * 2;
            const v = speed * (0.35 + Math.random() * 0.65);
            s.on = true;
            s.x = x + Math.random() * w;
            s.y = y + Math.random() * h;
            s.vx = Math.cos(a) * v;
            s.vy = Math.sin(a) * v - speed * 0.35;
            s.g = gravity;
            s.t = 0;
            s.life = life * (0.6 + Math.random() * 0.4);
            s.size = size * (0.6 + Math.random() * 0.6);
            s.color = color;
        }
        this._wake();
    }

    // 横長の光の帯（テトの消えた段）
    band(y, h, color, alpha, life) {
        let b = this.bands.find((x) => !x.on);
        if (!b) b = this.bands[0];
        b.on = true; b.y = y; b.h = h; b.color = color; b.alpha = alpha; b.t = 0; b.life = life;
        this._wake();
    }

    // 広がる輪（ぷよが弾ける）
    ring(x, y, r0, r1, color, life, width) {
        let o = this.rings.find((q) => !q.on);
        if (!o) o = this.rings[0];
        o.on = true; o.x = x; o.y = y; o.r0 = r0; o.r1 = r1; o.color = color; o.t = 0; o.life = life; o.width = width;
        this._wake();
    }

    // 盤面全体のフラッシュ（強いものほど上書き）
    flash(color, alpha, life) {
        const f = this.screen;
        const now = f.on ? f.alpha * (1 - f.t / f.life) : 0;
        if (alpha < now) return;
        f.on = true; f.color = color; f.alpha = alpha; f.t = 0; f.life = life;
        this._wake();
    }

    _wake() {
        if (!this.active) this._last = performance.now();
        this.active = true;
    }

    // 進めて描く。w・h は盤面の大きさ（フラッシュ用）
    draw(ctx, w, h) {
        if (!this.active) return;
        const now = performance.now();
        const dt = Math.min(50, Math.max(0, now - this._last));
        this._last = now;
        let alive = false;

        ctx.save();
        const f = this.screen;
        if (f.on) {
            f.t += dt;
            if (f.t >= f.life) f.on = false;
            else {
                alive = true;
                ctx.globalAlpha = f.alpha * (1 - f.t / f.life);
                ctx.fillStyle = f.color;
                ctx.fillRect(0, 0, w, h);
            }
        }
        for (const b of this.bands) {
            if (!b.on) continue;
            b.t += dt;
            if (b.t >= b.life) { b.on = false; continue; }
            alive = true;
            const k = b.t / b.life;
            const grow = b.h * 0.6 * k; // 少しふくらみながら消える
            ctx.globalAlpha = b.alpha * (1 - k) * (1 - k);
            ctx.fillStyle = b.color;
            ctx.fillRect(0, b.y - grow / 2, w, b.h + grow);
        }
        ctx.globalCompositeOperation = 'lighter';
        for (const o of this.rings) {
            if (!o.on) continue;
            o.t += dt;
            if (o.t >= o.life) { o.on = false; continue; }
            alive = true;
            const k = o.t / o.life;
            ctx.globalAlpha = 0.9 * (1 - k);
            ctx.strokeStyle = o.color;
            ctx.lineWidth = o.width * (1 - k * 0.6);
            ctx.beginPath();
            ctx.arc(o.x, o.y, o.r0 + (o.r1 - o.r0) * (1 - (1 - k) * (1 - k)), 0, Math.PI * 2);
            ctx.stroke();
        }
        const sec = dt / 1000;
        for (const s of this.sparks) {
            if (!s.on) continue;
            s.t += dt;
            if (s.t >= s.life) { s.on = false; continue; }
            alive = true;
            s.vy += s.g * sec;
            s.x += s.vx * sec;
            s.y += s.vy * sec;
            const k = s.t / s.life;
            const sz = s.size * (1 - k * 0.5);
            ctx.globalAlpha = 1 - k;
            ctx.fillStyle = s.color;
            ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
        }
        ctx.restore();
        this.active = alive;
    }

    // ─── テト: そろった段（rows: [{ y, types: [種類×10] }]）。lines・tSpin・pc で強さと色を変える ───
    tetClear(rows, lines, tSpin, pc, bs, w) {
        const high = ClearFx.level() === 'high';
        const tspin = tSpin === 'tspin';
        const mini = tSpin === 'mini';
        // 帯の色: T-Spin は紫・4 段は水色がかった白・ほかは白
        const bandColor = tspin ? '#d79bff' : (mini ? '#c9a4ff' : (lines >= 4 ? '#bff4ff' : '#ffffff'));
        const bandAlpha = Math.min(0.95, 0.4 + 0.13 * lines + (tspin ? 0.15 : 0));
        const life = 260 + 50 * lines + (tspin ? 80 : 0);
        for (const r of rows) {
            this.band(r.y * bs, bs, bandColor, bandAlpha, life);
            // 粒: LOW は 1 ブロック 1 個前後、HIGH は段数・T-Spin で増やす
            const per = high ? (2 + lines + (tspin ? 2 : 0)) : (lines >= 4 || tspin ? 2 : 1);
            const speed = bs * (high ? 7 + lines : 5 + lines * 0.5);
            for (let x = 0; x < r.types.length; x++) {
                const c = tspin ? (Math.random() < 0.5 ? '#e2b4ff' : CLEAR_FX_TET_COLORS[r.types[x]] || '#fff')
                    : (CLEAR_FX_TET_COLORS[r.types[x]] || '#fff');
                this.spark(x * bs, r.y * bs, bs, bs, c, per, speed, 420 + lines * 60, bs * 0.22, bs * 14);
            }
        }
        if (pc) {
            // PERFECT CLEAR: 金色のフラッシュ（HIGH は盤面じゅうに粒）
            this.flash('#ffd76a', high ? 0.45 : 0.25, high ? 700 : 450);
            if (high) {
                const top = rows.length ? Math.min(...rows.map((r) => r.y)) : 0;
                this.spark(0, (top - 6) * bs, w, bs * 10, '#ffe9a8', 90, bs * 11, 900, bs * 0.26, bs * 10);
            }
        } else if (high && (lines >= 4 || tspin)) {
            this.flash(tspin ? '#c471f5' : '#9be8ff', 0.16, 320);
        }
    }

    // ─── ぷよ: 消えたぷよ（cells: [{ x, y, color }] を px で）。chain で強さを変える ───
    puyoErase(cells, chain, cs, w, h) {
        const high = ClearFx.level() === 'high';
        const boost = Math.min(10, Math.max(0, chain - 1));
        for (const p of cells) {
            const ojama = p.color === 6;
            const c = CLEAR_FX_PUYO_COLORS[p.color - 1] || '#fff';
            const cx = p.x + cs / 2, cy = p.y + cs / 2;
            const n = ojama ? (high ? 2 : 1) : (high ? 6 + Math.ceil(boost * 0.8) : 3 + Math.floor(boost / 3));
            this.spark(p.x + cs * 0.2, p.y + cs * 0.2, cs * 0.6, cs * 0.6, c, n,
                cs * (high ? 6 + boost * 0.4 : 4.5), high ? 520 : 400, cs * (ojama ? 0.14 : 0.2), cs * 12);
            if (!ojama) this.ring(cx, cy, cs * 0.2, cs * (high ? 0.85 + boost * 0.03 : 0.65), c, high ? 360 : 260, high ? 4 : 3);
        }
        if (high && chain >= 4) this.flash('#ffffff', Math.min(0.28, 0.08 + 0.025 * chain), 300);
    }
}
