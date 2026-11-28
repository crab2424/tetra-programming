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
const CLEAR_FX_ALT_COLORS = ['#ffffff', '#bff4ff', '#d79bff', '#ffd76a'];
const CLEAR_FX_GLOW_RGB = ['255,255,255', '191,244,255', '215,155,255', '255,215,106']; // 白・4 段・T-Spin・PERFECT CLEAR

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
        this.unders = [];    // 案 1: 盤面の背景側（ブロックの下）に描く光
        this.ends = [];      // 案 2: 消えた段の両端
        this.snaps = [];     // 案 3: ごく短い細線
        for (let i = 0; i < CLEAR_FX_MAX_BANDS; i++) {
            this.unders.push({ on: false, y: 0, h: 0, t: 0, life: 1, alpha: 1, color: '#fff' });
            this.ends.push({ on: false, y: 0, t: 0, life: 1, len: 1, alpha: 1, color: '#fff' });
            this.snaps.push({ on: false, y: 0, t: 0, life: 1, alpha: 1, width: 2, color: '#fff' });
        }
        this.uflash = { on: false, t: 0, life: 1, alpha: 0, color: '#fff' }; // 案 1: 背景側の盤面全体の光
        this.glow = { on: false, t: 0, life: 1, ci: 0, str: 1 };            // 案 4: 盤面の枠の外の光（DOM の box-shadow）
        this._glowEl = null; this._glowBase = ''; this._glowCache = new Map(); this._glowStep = -1;
        this.frame = { on: false, t: 0, life: 1, color: '#fff', alpha: 0.85, wide: 1 }; // 盤面の縁の光
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

    // テトの案の番号（開発用の隠し設定 currentDisplay.clearEffectStyle。0=今の版 1=UNDER 2=EDGE 3=SNAP 4=FRAME。未設定は 0）
    static style() {
        const v = window.currentDisplay && window.currentDisplay.clearEffectStyle;
        return (v === 1 || v === 2 || v === 3 || v === 4) ? v : 0;
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
        for (const b of this.unders) b.on = false;
        for (const b of this.ends) b.on = false;
        for (const b of this.snaps) b.on = false;
        this.uflash.on = false;
        this.glow.on = false;
        this._glowApply(-1, 0);
        this.frame.on = false;
        this.screen.on = false;
        this.active = false;
        this._stopTail();
    }

    // 枠の外の光（案 4）。step 0〜15 の強さ。-1 で元に戻す。文字列は強さごとに 1 度だけ作って使い回す
    _glowApply(step, ci, el) {
        if (step < 0) {
            if (this._glowEl && this._glowStep !== -1) this._glowEl.style.boxShadow = '';
            this._glowStep = -1;
            return;
        }
        if (el && el !== this._glowEl) {
            this._glowEl = el;
            const cs = getComputedStyle(el).boxShadow;
            this._glowBase = (cs && cs !== 'none') ? cs + ', ' : '';
            this._glowCache.clear();
        }
        if (!this._glowEl) return;
        const key = ci * 16 + step;
        if (key === this._glowStep) return;
        this._glowStep = key;
        let v = this._glowCache.get(key);
        if (!v) {
            const c = CLEAR_FX_GLOW_RGB[ci];
            const a = (step + 1) / 16;
            v = this._glowBase + '0 0 ' + Math.round(10 + 34 * a) + 'px ' + Math.round(2 + 10 * a) + 'px rgba(' + c + ',' + (0.75 * a).toFixed(2) + '), 0 0 3px 1px rgba(' + c + ',' + a.toFixed(2) + ')';
            this._glowCache.set(key, v);
        }
        this._glowEl.style.boxShadow = v;
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
    edge(color, life, alpha, wide) {
        const f = this.frame;
        f.on = true; f.color = color; f.t = 0; f.life = life; f.alpha = alpha || 0.85; f.wide = wide || 1;
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

    _put(arr, o) { // 空きの入れ物を取る（いっぱいなら先頭を上書き）
        for (let i = 0; i < arr.length; i++) if (!arr[i].on) return arr[i];
        return arr[0];
    }

    _wake() {
        if (!this.active) this._last = performance.now();
        this.active = true;
    }

    // 案 1: 盤面の背景側（グリッドの上・ブロックの下）に描く光。時間は draw() が進める
    drawUnder(ctx, w, h) {
        if (!this.active) return;
        ctx.save();
        const f = this.uflash;
        if (f.on) {
            ctx.globalAlpha = f.alpha * (1 - f.t / f.life);
            ctx.fillStyle = f.color;
            ctx.fillRect(0, 0, w, h);
        }
        for (const b of this.unders) {
            if (!b.on) continue;
            const k = Math.min(1, b.t / b.life);
            const a = b.alpha * (1 - k) * (1 - k);
            ctx.fillStyle = b.color;
            const grow = 0.7 + 0.9 * k; // 段の位置から上下へふくらみながら消える
            for (let i = 0; i < 4; i++) { // 外ほど薄い 4 層（グラデーションを作らない）
                const hh = b.h * grow * (1 + i * 1.6);
                ctx.globalAlpha = a * 0.34;
                ctx.fillRect(0, b.y + (b.h - hh) / 2, w, hh);
            }
        }
        ctx.restore();
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
                ctx.globalAlpha = fr.alpha * (1 - k);
                ctx.strokeStyle = fr.color;
                const lw = (2 + 10 * (1 - k)) * fr.wide;
                ctx.lineWidth = lw;
                ctx.strokeRect(lw / 2, lw / 2, w - lw, h - lw);
            }
        }
        // 案 2: 消えた段の両端（盤面の左右の縁から内へ短く伸びる）
        for (const e of this.ends) {
            if (!e.on) continue;
            e.t += dt;
            if (e.t >= e.life) { e.on = false; continue; }
            alive = true;
            const k = e.t / e.life;
            const ext = e.len * (1 - (1 - k) * (1 - k) * (1 - k)); // 縁から内へ伸びて止まる
            const a = e.alpha * (1 - k);
            ctx.fillStyle = e.color;
            for (let i = 0; i < 3; i++) { // 縁ほど濃い 3 段の階調（グラデーションを作らない）
                const ww = ext * (1 - i * 0.3);
                ctx.globalAlpha = a * (i === 0 ? 0.3 : 0.4);
                ctx.fillRect(0, e.y, ww, e.h);
                ctx.fillRect(w - ww, e.y, ww, e.h);
            }
            ctx.globalAlpha = a;
            ctx.fillRect(0, e.y, 4, e.h);
            ctx.fillRect(w - 4, e.y, 4, e.h);
        }
        // 案 3: ごく短い細線（塗らない。段の位置に線だけ）
        for (const sn of this.snaps) {
            if (!sn.on) continue;
            sn.t += dt;
            if (sn.t >= sn.life) { sn.on = false; continue; }
            alive = true;
            const k = sn.t / sn.life;
            ctx.globalAlpha = sn.alpha * (1 - k);
            ctx.fillStyle = sn.color;
            const ww = sn.width * (1 + 1.5 * k); // 線は消えながら少し太る
            ctx.fillRect(0, sn.y - ww / 2, w, ww);
        }
        // 案 4: 枠の外の光
        const gl = this.glow;
        if (gl.on) {
            gl.t += dt;
            if (gl.t >= gl.life) { gl.on = false; this._glowApply(-1, 0); }
            else {
                alive = true;
                const k = gl.t / gl.life;
                this._glowApply(Math.max(0, Math.min(15, Math.round(15 * gl.str * (1 - k) * (1 - k)))), gl.ci, ctx.canvas);
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
        const style = ClearFx.style();
        if (style !== 0) { this._tetClearAlt(style, rows, lines, tSpin, pc, bs, w); return; }
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


    // ─── テトの別案（開発用。currentDisplay.clearEffectStyle = 1〜4。重なっても盤面が見にくくならない方向）───
    //   1 UNDER: ブロックの下（背景側）に光る。ブロックは隠れず、空いたマスや溝から光が見える
    //   2 EDGE : 消えた段の両端だけが光る。HIGH は 3 段以上・T-Spin で枠も光る
    //   3 SNAP : 約 0.1 秒の細線だけ（塗らない）。HIGH は 2 本重ね・大技で枠もまたたく
    //   4 FRAME: 盤面の外（枠のまわり）が光る。盤面の中には描かない
    _tetClearAlt(style, rows, lines, tSpin, pc, bs, w) {
        const high = ClearFx.level() === 'high';
        const tspin = tSpin === 'tspin', mini = tSpin === 'mini';
        const big = lines >= 4 || tspin;
        const ci = pc ? 3 : (tspin || mini ? 2 : (lines >= 4 ? 1 : 0));
        const color = CLEAR_FX_ALT_COLORS[ci];
        const str = Math.min(1, 0.4 + 0.15 * lines + (tspin ? 0.15 : 0) + (high ? 0.1 : 0)); // 0〜1 の強さ
        if (style === 1) {
            for (const r of rows) {
                const b = this._put(this.unders);
                b.on = true; b.y = r.y * bs; b.h = bs; b.color = color; b.t = 0;
                b.life = (high ? 420 : 300) + 50 * lines; b.alpha = Math.min(1, str * (high ? 1.15 : 0.9));
            }
            if (high && (big || pc)) {
                const f = this.uflash;
                f.on = true; f.color = pc ? '#ffd76a' : color; f.alpha = pc ? 0.32 : 0.2; f.t = 0; f.life = pc ? 700 : 380;
            }
            if (pc) this.edge('#ffd76a', high ? 700 : 450, 0.85, 1);
        } else if (style === 2) {
            for (const r of rows) {
                const e = this._put(this.ends);
                e.on = true; e.y = r.y * bs; e.h = bs; e.color = color; e.t = 0;
                e.life = (high ? 380 : 260) + 30 * lines; e.alpha = Math.min(1, 0.55 + 0.1 * lines);
                e.len = bs * (high ? 1.4 + 0.5 * lines : 0.8 + 0.2 * lines) * (tspin ? 1.2 : 1);
            }
            if (pc || (big && high) || (lines >= 3 && high)) this.edge(color, pc ? 800 : 320, pc ? 0.9 : 0.55, 0.6);
            else if (big) this.edge(color, 220, 0.4, 0.4);
        } else if (style === 3) {
            for (const r of rows) {
                const y = r.y * bs + bs / 2;
                this._snap(y, color, high ? 170 : 110, Math.min(1, 0.6 + 0.1 * lines), 2);
                if (high) this._snap(y, color, 260, 0.35, 5);
            }
            if (pc) this.edge('#ffd76a', 500, 0.8, 0.5);
            else if (high && big) this.edge(color, 160, 0.45, 0.35);
        } else {
            const g = this.glow;
            g.on = true; g.ci = ci; g.t = 0;
            g.life = (high ? 520 : 340) + 60 * lines + (pc ? 300 : 0);
            g.str = Math.min(1, str * (high ? 1 : 0.75) + (pc ? 0.3 : 0));
            this._wake();
        }
        this._wake();
    }

    _snap(y, color, life, alpha, width) {
        const sn = this._put(this.snaps);
        sn.on = true; sn.y = y; sn.color = color; sn.t = 0; sn.life = life; sn.alpha = alpha; sn.width = width;
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
