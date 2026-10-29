// ─────────────────────────────────────────────
// assist/assist.js  ―  アシスト機能（盤面ガイド）の本体
//   PRACTICE / VERSUS（ローカル）で、プレイヤー自身の盤面に「見どころ」（tet: T-spin・PC、
//   puyo: 発火）までの手順・回転の向き・ガイド文を重ねる。ONLINE は対象外（attach しない）。
//   設計: source_assets/memory/assist/assist-design.md
//
//   Assist.attach(game, ctx)  … ctx は 'practice' | 'versus'（設定の保存単位）
//   Assist.detach()           … 層・フックを止める（フックは pass-through になるだけで外さない）
//   Assist.get(ctx) / set(ctx, patch)
//
//   計算は AssistTet / AssistPuyo（assist_tet.js / assist_puyo.js）。描画は AssistOverlay。
// ─────────────────────────────────────────────

(function () {
    const STORAGE_KEY = 'tetlabo.assist';
    const MODES = ['off', 'hint', 'all'];
    const DEPTH_MIN = 1, DEPTH_MAX = 6;
    const CHAIN_MIN = 2, CHAIN_MAX = 7;
    const DEFAULTS = () => ({ mode: 'hint', depth: 3, chain: 4 });

    let store = null;

    function load() {
        if (store) return store;
        store = { practice: DEFAULTS(), versus: DEFAULTS() };
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                for (const k of ['practice', 'versus']) {
                    if (raw[k]) Object.assign(store[k], sanitize(raw[k]));
                }
            }
        } catch (e) { /* 保存先が使えなくても動く */ }
        return store;
    }

    function sanitize(s) {
        const o = {};
        if (MODES.includes(s.mode)) o.mode = s.mode;
        if (Number.isFinite(s.depth)) o.depth = Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, Math.round(s.depth)));
        if (Number.isFinite(s.chain)) o.chain = Math.max(CHAIN_MIN, Math.min(CHAIN_MAX, Math.round(s.chain)));
        return o;
    }

    function save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* 無視 */ }
    }

    const Assist = {
        MODES, DEPTH_MIN, DEPTH_MAX, CHAIN_MIN, CHAIN_MAX,

        game: null,      // attach 中のプレイヤー側ゲーム
        ctx: null,       // 'practice' | 'versus'
        rule: null,      // 'tet' | 'puyo'
        serial: 0,       // ツモが出るたびに +1（非同期結果の取り違え防止）
        plan: null,      // 現在の計画（assist_tet / assist_puyo が作る）

        get(ctx) { return Object.assign({}, load()[ctx || this.ctx || 'practice']); },

        set(ctx, patch) {
            const s = load();
            Object.assign(s[ctx], sanitize(patch));
            save();
            if (ctx === this.ctx && this.game) this.refresh();
        },

        // 設定行用の ± 操作。DEPTH/CHAIN は端で止める。MODE は OFF→HINT→ALL を回す
        stepMode(ctx, dir) {
            const cur = MODES.indexOf(this.get(ctx).mode);
            this.set(ctx, { mode: MODES[(cur + dir + MODES.length) % MODES.length] });
        },
        stepDepth(ctx, dir) {
            const max = this.depthMax(ctx);
            this.set(ctx, { depth: Math.max(DEPTH_MIN, Math.min(max, Math.min(this.get(ctx).depth, max) + dir)) });
        },
        // DEPTH の上限。puyo は NEXT が2組しか見えないので 3（設定画面もこの上限で出す）。
        //   保存値は上書きせず、puyo の間は 3 で頭打ちにして見せる（tet に戻すと元の値）
        depthMax(ctx) { return this.ruleOf(ctx) === 'puyo' ? 3 : DEPTH_MAX; },
        depthShown(ctx) { return Math.min(this.get(ctx).depth, this.depthMax(ctx)); },
        ruleOf(ctx) {
            if (ctx === 'versus') return (typeof versusPlayerRule !== 'undefined') ? versusPlayerRule : 'tet';
            return (typeof practiceRule !== 'undefined') ? practiceRule : 'tet';
        },
        stepChain(ctx, dir) { this.set(ctx, { chain: this.get(ctx).chain + dir }); },

        // 表示中 NEXT 数で頭打ち（J2）。puyo は最大3手（NEXT 2組＋手のペア。設計 §4.2・§10.6）
        effectiveDepth(cfg, g) {
            if (this.rule === 'puyo') return Math.max(1, Math.min(cfg.depth, 3, 1 + this._visibleNext(g)));
            return Math.max(1, Math.min(cfg.depth, 1 + this._visibleNext(g)));
        },

        _visibleNext(g) {
            let n = 5;
            try {
                if (this.rule === 'puyo') {
                    n = (typeof g._computeNextLayout === 'function') ? g._computeNextLayout().count : (g.practiceNextCount || 2);
                } else if (typeof g._computeNextLayout === 'function') {
                    n = g._computeNextLayout().count;
                }
            } catch (e) { /* 既定値 */ }
            const q = g.nextQueue ? g.nextQueue.length : n;
            return Math.max(0, Math.min(n, q));
        },

        isPuyo(g) { return typeof PuyoGame !== 'undefined' && g instanceof PuyoGame; },

        attach(game, ctx) {
            this.detach();
            if (!game) return;
            this.game = game;
            this.ctx = ctx;
            this.rule = this.isPuyo(game) ? 'puyo' : 'tet';
            this.plan = null;
            this.serial++;
            game.__assistOn = true;
            window.AssistOverlay?.mount(game, this.rule);
            this._installHooks(game);
        },

        detach() {
            const g = this.game;
            if (g) g.__assistOn = false;
            this.game = null;
            this.ctx = null;
            this.plan = null;
            this.serial++;
            window.AssistTet?.reset();
            window.AssistPuyo?.reset();
            window.AssistOverlay?.unmount();
        },

        // フックはメソッドを包む。外さず、attach ごとのトークンで古い包みを pass-through にする
        //   （PRACTICE も同じメソッドを包み、destroy で元の関数に戻すため「1回だけ包む」では
        //    2局目以降に包みが消えている事故が起きる）
        _installHooks(g) {
            const token = this.hookToken = {};
            const wrap = (name, after) => {
                const orig = g[name];
                if (typeof orig !== 'function') return;
                g[name] = function () {
                    const r = orig.apply(this, arguments);
                    if (Assist.hookToken === token && this.__assistOn && Assist.game === this) after.call(Assist, this, name);
                    return r;
                };
            };
            if (this.rule === 'puyo') {
                wrap('_spawnPuyo', this._onSpawn);
                wrap('_initNextQueue', this._onReset);        // リスタート（start() の最初で1回呼ばれる）
            } else {
                wrap('popMino', this._onSpawn);
                wrap('holdCurrentMino', this._onSpawn);
                wrap('_initGameState', this._onReset);        // リスタート（同上）
            }
        },

        // リスタート：READY の間に前のゲームの表示が残らないよう、計画ごと消す（worker は残す）
        _onReset() {
            this.serial++;
            window.AssistTet?.forget?.();
            window.AssistPuyo?.forget?.();
            this._clear();
        },

        _onSpawn(g, via) {
            this.serial++;
            const cfg = this.get();
            if (cfg.mode === 'off') { this._clear(); return; }
            if (this.rule === 'puyo') window.AssistPuyo?.onSpawn(g, cfg, this.serial);
            else window.AssistTet?.onSpawn(g, cfg, this.serial, via);
        },

        // 設定変更・巻き戻し後など、今の局面で計算し直す
        refresh() {
            const g = this.game;
            if (!g) return;
            this.plan = null;
            const cfg = this.get();
            if (cfg.mode === 'off') { this._clear(); return; }
            const live = this.rule === 'puyo' ? (g._gs === 'falling') : !!g.mino;
            if (!live) { this._clear(); return; }
            this._onSpawn(g, 'refresh');
        },

        _clear() {
            this.plan = null;
            window.AssistOverlay?.clear();
        },

        // 計画が決まった時に計算側から呼ぶ（serial が古ければ捨てる）
        publish(serial, plan) {
            if (serial !== this.serial || !this.game) return;
            this.plan = plan;
            window.AssistOverlay?.render(plan, this.game, this.rule);
        },
    };

    window.Assist = Assist;

    // ─── VERSUS 準備画面の設定行 ───
    // disabledOf(v) が真の選択肢は、位置はそのまま薄くして押せなくする（行のボタン位置をずらさないため）
    function buildToggle(el, values, current, labelOf, onPick, disabledOf) {
        if (!el) return;
        el.innerHTML = '';
        values.forEach(v => {
            const b = document.createElement('button');
            b.className = 'opt-btn' + (v === current ? ' active' : '');
            b.textContent = labelOf(v);
            b.onclick = () => onPick(v);
            if (disabledOf && disabledOf(v)) b.disabled = true;
            el.appendChild(b);
        });
    }

    Assist.renderVersusOptions = function () {
        const cfg = Assist.get('versus');
        buildToggle(document.getElementById('versus-assist-mode-toggle'), MODES, cfg.mode,
            v => v.toUpperCase(), v => { Assist.set('versus', { mode: v }); Assist.renderVersusOptions(); });
        // DEPTH は puyo だと 4〜6 を出せない／CHAIN は puyo 専用。消さずに薄くして位置を固定する
        const depthMax = Assist.depthMax('versus');
        const isPuyo = Assist.ruleOf('versus') === 'puyo';
        const depths = []; for (let i = DEPTH_MIN; i <= DEPTH_MAX; i++) depths.push(i);
        buildToggle(document.getElementById('versus-assist-depth-toggle'), depths, Assist.depthShown('versus'),
            String, v => { Assist.set('versus', { depth: v }); Assist.renderVersusOptions(); }, v => v > depthMax);
        const chains = []; for (let i = CHAIN_MIN; i <= CHAIN_MAX; i++) chains.push(i);
        buildToggle(document.getElementById('versus-assist-chain-toggle'), chains, cfg.chain,
            String, v => { Assist.set('versus', { chain: v }); Assist.renderVersusOptions(); }, () => !isPuyo);
        const off = cfg.mode === 'off';
        const depthRow = document.getElementById('versus-assist-depth-toggle')?.closest('.assist-sub-row');
        const chainRow = document.getElementById('versus-assist-chain-toggle')?.closest('.assist-sub-row');
        if (depthRow) depthRow.classList.toggle('is-inert', off);
        if (chainRow) chainRow.classList.toggle('is-inert', off || !isPuyo);
    };

    document.addEventListener('DOMContentLoaded', () => Assist.renderVersusOptions());
    if (document.readyState !== 'loading') Assist.renderVersusOptions();
})();
