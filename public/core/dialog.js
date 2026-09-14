// ─────────────────────────────────────────────
// dialog.js
// 汎用の確認ダイアログ（TetDialog）。ブラウザ標準の confirm() の代わりに使う
// （設定画面の「未保存の変更」確認・RESET RECORDS 確認など）。
// online対戦の Modal（src/online/online.tsx）と役割は同じだが、こちらは
// プレーンJS側（PRACTICE以前からの画面群）向けの薄い実装。
// マウント先は index.html の #app-dialog（1つを使い回す）。
// ─────────────────────────────────────────────
const TetDialog = (() => {
    let activeResolve = null;
    let prevPageId = null;   // ダイアログを開く直前にアクティブだった FocusNav ページ

    function root() {
        return document.getElementById('app-dialog');
    }

    function close(value) {
        const r = root();
        if (!r) return;
        r.classList.remove('is-open');
        r.innerHTML = '';
        // online の Modal.hideModal() と同じ理由: 開く前のページへ明示的に activate し直す。
        // deactivate() だけだと FocusNav がどこにも属さないまま固定され、以後キー操作が
        // 一切効かなくなる（設計 source_assets/memory/tetlabo-v2.2.1-design.md §3.4(a) 参照）。
        if (window.FocusNav) {
            window.FocusNav.deactivate();
            if (prevPageId) window.FocusNav.activate(prevPageId);
        }
        prevPageId = null;
        const resolve = activeResolve;
        activeResolve = null;
        if (resolve) resolve(value);
    }

    /**
     * ダイアログを表示し、押されたボタンの value で解決する Promise を返す。
     * @param {{title?:string, message:string, buttons:Array<{label:string, value:*, kind?:'primary'|'secondary'|'danger', cancel?:boolean}>, initial?:*}} opts
     *   kind 省略時は btn-secondary。cancel:true のボタンは背景クリック/Escapeと同じ扱いになる
     *   （SEもmenu_cancelを鳴らす）。initial は最初にフォーカスする value。
     */
    function choose(opts) {
        return new Promise((resolve) => {
            const r = root();
            if (!r) { resolve(undefined); return; }
            // 二重オープンは前のダイアログを「値なし」で畳んでから開き直す
            if (activeResolve) close(undefined);

            prevPageId = window.FocusNav ? window.FocusNav.getActivePageId() : null;
            activeResolve = resolve;

            const card = document.createElement('div');
            card.className = 'app-dialog-card';

            if (opts.title) {
                const h = document.createElement('h2');
                h.className = 'app-dialog-title';
                h.textContent = opts.title;
                card.appendChild(h);
            }
            const p = document.createElement('p');
            p.className = 'app-dialog-message';
            p.textContent = opts.message;
            card.appendChild(p);

            const btnRow = document.createElement('div');
            btnRow.className = 'app-dialog-buttons';
            let cancelBtn = null;
            let initialBtn = null;
            (opts.buttons || []).forEach((b) => {
                const el = document.createElement('button');
                el.type = 'button';
                el.className = 'btn ' + (b.kind ? ('btn-' + b.kind) : 'btn-secondary');
                el.textContent = b.label;
                if (b.cancel) { el.dataset.se = 'cancel'; cancelBtn = el; }
                el.addEventListener('click', () => close(b.value));
                btnRow.appendChild(el);
                if (opts.initial !== undefined && b.value === opts.initial) initialBtn = el;
            });
            card.appendChild(btnRow);

            r.innerHTML = '';
            r.appendChild(card);
            r.classList.add('is-open');
            // 背景（カードの外）クリックはCANCEL相当。cancelボタンが無ければ何もしない。
            r.onclick = (e) => { if (e.target === r && cancelBtn) cancelBtn.click(); };

            if (window.FocusNav) {
                window.FocusNav.register('app-dialog', {
                    root: r,
                    rootActiveClass: 'is-open',
                    getItems: () => Array.from(btnRow.querySelectorAll('button')),
                    initialIndex: initialBtn ? Array.from(btnRow.children).indexOf(initialBtn) : 0,
                    escapeAction: () => cancelBtn,
                });
                window.FocusNav.activate('app-dialog');
            }
        });
    }

    return { choose };
})();

window.TetDialog = TetDialog;
