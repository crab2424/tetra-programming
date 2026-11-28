// ─────────────────────────────────────────────
// clear_fx.js
// ミノのライン消去・ぷよの消去のエフェクト（設定 DISPLAY › CLEAR EFFECT: OFF / LOW / HIGH）
//
//   ・見た目だけ。盤面・時計・乱数には一切さわらない（リプレイ・オンラインの同期に影響しない）。
//     時間は実時間（performance.now）で進める。
//   ・粒・帯は最初に作った固定数の入れ物を使い回す（毎フレームのゴミを出さない。versus のカクつき対策と同じ考え）。
//   ・リプレイのシーク・1 手送り・照らし合わせ（描かない再生）・速い倍速では出さない（ClearFx.allowed）。
//   ・座標は呼ぶ側の盤面の座標（テト: ブロック px、ぷよ: 論理 px）。描く側は盤面の ctx 変換の中で draw() を呼ぶ。
//   ・テトは粒を使わない（段が光って細い線に縮み、線が左右へ走る）。粒はぷよだけ。
//   ・試合が終わって盤面のループが止まっても、出ているエフェクトは tail() で最後まで描く。次の試合の頭で clear() する。
// ─────────────────────────────────────────────

const CLEAR_FX_MAX_SPARKS = 320;
const CLEAR_FX_MAX_BANDS = 8;
const CLEAR_FX_MAX_RINGS = 48;
const CLEAR_FX_MAX_LINES = 8;

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
        this.lines = [];
        for (let i = 0; i < CLEAR_FX_MAX_LINES; i++) {
            this.lines.push({ on: false, y: 0, t: 0, life: 1, color: '#fff', width: 2, delay: 0 });
        }
        this.frame = { on: false, t: 0, life: 1, color: '#fff' }; // 盤面の縁の光（PERFECT CLEAR）
        this.screen = { on: false, t: 0, life: 1, alpha: 0, color: '#fff' };
        this._tailRaf = 0;   // 試合の後の描き足し（tail）
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
        for (const l of this.lines) l.on = false;
        this.frame.on = false;
        this.screen.on = false;
        this.active = false;
        this._stopTail();
    }

    // 盤面のループが止まった後（試合の終わり）も、出ているエフェクトが消えるまで redraw() で描き足す
    tail(redraw) {
        this._stopTail();
        if (!this.active) return;
        const step = () => {
            this._tailRaf = 0;
            if (!this.active) return;
            try { redraw(); } catch (e) { this.clear(); return; }
            if (this.active) this._tailRaf = requestAnimationFrame(step);
        };
        this._tailRaf = requestAnimationFrame(step);
    }

    _stopTail() {
        if (this._tailRaf) { cancelAnimationFrame(this._tailRaf); this._tailRaf = 0; }
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

    // 段の中心から左右へ走る光の線（テト）。delay ms 後に走り出す
    line(y, color, life, width, delay) {
        let l = this.lines.find((x) => !x.on);
        if (!l) l = this.lines[0];
        l.on = true; l.y = y; l.color = color; l.t = 0; l.life = life; l.width = width; l.delay = delay || 0;
        this._wake();
    }

    // 盤面の縁が光って消える（PERFECT CLEAR）
    edge(color, life) {
        const f = this.frame;
        f.on = true; f.color = color; f.t = 0; f.life = life;
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
            // 段いっぱいに光ってから、中心の細い線へ縮みながら消える
            const hh = b.h * Math.max(0.08, (1 - k) * (1 - k));
            ctx.globalAlpha = b.alpha * (1 - k * k);
            ctx.fillStyle = b.color;
            ctx.fillRect(0, b.y + (b.h - hh) / 2, w, hh);
        }
        if (this.frame.on) {
            const fr = this.frame;
            fr.t += dt;
            if (fr.t >= fr.life) fr.on = false;
            else {
                alive = true;
                const k = fr.t / fr.life;
                ctx.globalAlpha = 0.85 * (1 - k);
                ctx.strokeStyle = fr.color;
                const lw = 2 + 10 * (1 - k);
                ctx.lineWidth = lw;
                ctx.strokeRect(lw / 2, lw / 2, w - lw, h - lw);
            }
        }
        ctx.globalCompositeOperation = 'lighter';
        for (const l of this.lines) {
            if (!l.on) continue;
            l.t += dt;
            if (l.t >= l.delay + l.life) { l.on = false; continue; }
            alive = true;
            if (l.t < l.delay) continue;
            const k = (l.t - l.delay) / l.life;
            const e = 1 - (1 - k) * (1 - k) * (1 - k); // 速く走り出して止まる
            const half = (w / 2) * e;
            const a = 1 - k;
            ctx.fillStyle = l.color;
            ctx.globalAlpha = 0.35 * a;
            ctx.fillRect(w / 2 - half, l.y - l.width * 2, half * 2, l.width * 4);
            ctx.globalAlpha = a;
            ctx.fillRect(w / 2 - half, l.y - l.width / 2, half * 2, l.width);
        }
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

    // ─── テト: そろった段（rows: [{ y, types: [種類×10] }]）。lines・tSpin・pc で強さと色を変える（粒は使わない）───
    //   LOW : 段が光って細い線に縮む
    //   HIGH: ＋段の中心から左右へ光の線が走る・4 段 / T-Spin は盤面が軽く光る・PERFECT CLEAR は縁も光る
    tetClear(rows, lines, tSpin, pc, bs, w) {
        const high = ClearFx.level() === 'high';
        const tspin = tSpin === 'tspin';
        const mini = tSpin === 'mini';
        // 色: T-Spin は紫・4 段は水色がかった白・ほかは白
        const color = tspin ? '#d79bff' : (mini ? '#c9a4ff' : (lines >= 4 ? '#bff4ff' : '#ffffff'));
        const bandAlpha = Math.min(0.95, 0.45 + 0.12 * lines + (tspin ? 0.15 : 0));
        const life = 220 + 40 * lines + (tspin ? 60 : 0);
        for (const r of rows) {
            this.band(r.y * bs, bs, color, bandAlpha, life);
            if (high) {
                this.line(r.y * bs + bs / 2, color, 300 + 40 * lines, Math.max(2, bs * (lines >= 4 || tspin ? 0.16 : 0.1)), life * 0.35);
            }
        }
        if (pc) {
            // PERFECT CLEAR: 金色のフラッシュ（HIGH は縁も光る）
            this.flash('#ffd76a', high ? 0.4 : 0.22, high ? 650 : 420);
            if (high) this.edge('#ffd76a', 900);
        } else if (high && (lines >= 4 || tspin)) {
            this.flash(tspin ? '#c471f5' : '#9be8ff', 0.14, 300);
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
