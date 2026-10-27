// ─────────────────────────────────────────────
// assist/assist_overlay.js  ―  アシストの盤面表示（DOM + SVG の層）
//   盤面キャンバスの親に、盤面と同じ大きさ(320x656)の絶対配置の層を置く。
//   CPU TEST の予想手表示と同じ方式（キャンバスの再描画都合に巻き込まれない）。
//   座標は盤面のセル座標。tet: left=x*32, top=(y+0.5)*32 / puyo: left=c*cs, top=r*cs。
// ─────────────────────────────────────────────

(function () {
    const W = 320, H = 656;

    const Overlay = {
        layer: null,
        canvas: null,
        banner: null,

        mount(game, rule) {
            this.unmount();
            const prefix = game.canvasPrefix ? `${game.canvasPrefix}-` : '';
            const canvasId = rule === 'puyo' ? `${prefix}puyo-main-canvas` : `${prefix}main-canvas`;
            const canvas = document.getElementById(canvasId);
            if (!canvas || !canvas.parentNode) return;
            const layer = document.createElement('div');
            layer.className = 'assist-overlay';
            layer.id = `${canvasId}-assist-overlay`;
            layer.style.width = W + 'px';
            layer.style.height = H + 'px';
            canvas.parentNode.appendChild(layer);
            this.layer = layer;
            this.canvas = canvas;
            this.fit();
        },

        // 層をキャンバスの描画領域(枠の内側)にぴったり重ねる。
        //   VERSUS は CSS で 320x656 を border-box 指定しているため、枠 3px ぶん描画領域が縮む(314x650)。
        //   PRACTICE は枠の外側に 3px 余る。どちらも「枠の内側 = 320x656 の盤面座標」に合うよう
        //   位置を枠ぶんずらし、描画領域の実寸との比で縮尺する。
        fit() {
            const c = this.canvas, l = this.layer;
            if (!c || !l) return;
            const sx = c.clientWidth ? c.clientWidth / W : 1;
            const sy = c.clientHeight ? c.clientHeight / H : 1;
            l.style.left = (c.offsetLeft + c.clientLeft) + 'px';
            l.style.top = (c.offsetTop + c.clientTop) + 'px';
            l.style.transformOrigin = '0 0';
            l.style.transform = (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) ? `scale(${sx}, ${sy})` : '';
        },

        unmount() {
            if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
            this.layer = null;
            this.banner = null;
        },

        clear() {
            if (this.layer) this.layer.innerHTML = '';
            this.banner = null;
        },

        // plan の描画は assist_tet.js / assist_puyo.js が提供する drawTet / drawPuyo が担う
        render(plan, game, rule) {
            if (!this.layer) return;
            this.fit();
            this.clear();
            if (!plan) return;
            if (rule === 'puyo') window.AssistPuyo?.draw?.(this, plan, game);
            else window.AssistTet?.draw?.(this, plan, game);
            if (plan.text) this.setBanner(plan.kind || '', plan.text);
        },

        // ガイド文の帯（盤面上部・半透明）
        setBanner(label, text) {
            if (!this.layer) return;
            const b = document.createElement('div');
            b.className = 'assist-banner';
            if (label) {
                const l = document.createElement('span');
                l.className = 'assist-banner-label';
                l.textContent = label;
                b.appendChild(l);
            }
            const t = document.createElement('span');
            t.className = 'assist-banner-text';
            t.textContent = text;
            b.appendChild(t);
            this.layer.appendChild(b);
            this.banner = b;
        },

        add(el) { if (this.layer) this.layer.appendChild(el); return el; },
    };

    window.AssistOverlay = Overlay;
})();
