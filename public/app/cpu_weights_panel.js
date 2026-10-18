// ─────────────────────────────────────────────
// cpu_weights_panel.js
// CPU TEST（ぷよ LV5/LV6）の重み調整パネル
//
// 設計: source_assets/memory/cpu/puyo/weights-tuning-panel-design.md
//   ・EVAL の下の WEIGHTS ボタンで画面右端のパネルを開閉する（開いてもポーズしない）
//   ・値を変えると CPU の build の基準値を置き換える（cpu5_weights.js applyBuildValues）。
//     weightsArray は手ごとに組み立て直すので次の思考から効く。効き始めの手は思考ログ（cpuLog()）に出る
//   ・LV5 / LV6 の値に戻す・JSON の書き出し（学習の best.json と同じ policy.build）・読み込み
//   ・変えた値は localStorage（tetlabo.cpuWeights）に LV ごとの「既定との差分」で残し、次の CPU TEST でも載せる
//   ・VERSUS では使わない（2026-10-18 決定＝後回し）。CPU TEST の開始・リスタートだけが attach する
//   ・パネル内にフォーカスがある間はキーをゲームへ流さない（Esc で入力欄から抜ける）
//
// navigation.js が attach(cpu)（CPU TEST 開始・リスタート）/ detach()（stopAllGames）を呼ぶ。
// ─────────────────────────────────────────────

window.CpuWeightsPanel = (() => {
    const STORE_KEY = 'tetlabo.cpuWeights';
    const DESC_SRC  = 'cpu/puyo/lv5/js/weights/cpu5_weights.js';   // 説明はこのファイルの行末コメントから取る

    // 並べ方。CONTROL はこの順、残りは cpu5_weights.js の定義順
    const CONTROL_ORDER = [
        'fireChainCount', 'fireScoreThreshold', 'growthFireForbidChains',
        'emergencyHeight', 'emergencyFireMinRatio', 'emergencyHardCol2',
        'expChainWeight', 'pruneChainScore', 'expMaxDepth', 'expBeamWidth',
    ];
    // VERSUS で相手がぷよのときだけ効く（催促 H1・対応 H2）
    const VERSUS_ONLY = ['harassMinOjama', 'harassMaxChains', 'harassKeepPct', 'harassMinReach', 'counterKeepReach'];
    // 参照されない・切り替えたら別物になるもの（畳んでおく）
    const FIXED = ['ignitionThreshold', 'ignitionScoreThreshold', 'expBranch', 'amaEvalMode', 'p1Weight'];

    let cpu = null;
    let level = '';
    let defaults = {};          // この CPU の既定値（名前→値）
    let refs = {};              // { LV5: {...}, LV6: {...} | null }
    let values = {};            // 今の値
    let changed = {};           // 既定と違う値 { 名前: {from,to} }
    let groups = {};            // 名前 → 'reward' | 'eval' | 'control'
    let storedWarn = '';
    let isOpen = false;         // ページ内で覚える（リスタートしても開いたまま）
    let dock = null, toggleBtn = null, rows = {}, statusEl = null, warnEl = null, msgEl = null;
    let importBox = null, importText = null, filterInput = null;
    let pollTimer = null;
    const pendingCommit = {};
    let descs = null;

    // ── 保存（LV ごとに「既定との差分」） ─────────────────
    function readStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { return {}; }
    }
    function writeStore() {
        if (!cpu) return;
        const all = readStore();
        const diff = {};
        for (const k in changed) diff[k] = changed[k].to;
        if (Object.keys(diff).length) all[level] = { weightsId: cpu.constructor.WEIGHTS_ID, values: diff };
        else delete all[level];
        try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch (_) { /* 保存できなくても今回は効く */ }
    }

    // ── 説明（cpu5_weights.js の「名前: 値, // 説明」） ─────────
    function loadDescs() {
        if (descs) return Promise.resolve(descs);
        return fetch(DESC_SRC).then(r => (r.ok ? r.text() : '')).then(src => {
            descs = {};
            for (const line of src.split('\n')) {
                const m = /^\s*(\w+):\s*-?\d+\s*,?\s*\/\/\s*(.+)$/.exec(line);
                if (!m) continue;
                descs[m[1]] = m[2]
                    .replace(/[。、]?\s*詳細: ?cpu5_weights\.md/g, '')
                    .replace(/[（(]\s*[）)]/g, '')
                    .replace(/。\s*$/, '')
                    .trim();
            }
            return descs;
        }).catch(() => (descs = {}));
    }

    // ── 適用 ─────────────────────────────────────
    function apply(next) {
        if (!cpu) return;
        changed = cpu.applyBuildValues(next);
        values  = cpu.getBuildValues();
        writeStore();
        refreshRows();
        refreshStatus();
    }

    function attach(c) {
        detach();
        if (!c || typeof c.applyBuildValues !== 'function') return;   // ぷよ LV5/LV6 だけ
        cpu = c;
        level = c.constructor.LOG_NAME || 'LV5';
        defaults = c.getBuildDefaults();
        refs = { LV5: c.getBuildDefaults('LV5'), LV6: c.getBuildDefaults('LV6') };
        groups = {};
        const b = c._defaultBuildBaseline;
        for (const k in b.rewardWeights) groups[k] = 'reward';
        for (const k in b.evalWeights) groups[k] = 'eval';
        for (const k in b.controlWeights) groups[k] = 'control';

        // 保存してある変更を載せる（パネルを開かなくても効く＝WEIGHTS ボタンに CUSTOM と出す）
        storedWarn = '';
        const st = readStore()[level];
        changed = {};
        if (st && st.values && Object.keys(st.values).length) {
            changed = c.applyBuildValues(st.values);
            if (st.weightsId && st.weightsId !== c.constructor.WEIGHTS_ID) {
                storedWarn = `保存した変更は重みの版 ${st.weightsId} のときのもの（今は ${c.constructor.WEIGHTS_ID}）`;
            }
        }
        values = c.getBuildValues();

        buildDom();
        toggleBtn.style.display = '';
        setOpen(isOpen);
        loadDescs().then(() => { if (cpu === c) fillDescs(); });
        pollTimer = setInterval(refreshStatus, 300);
        refreshStatus();
    }

    function detach() {
        cpu = null;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        for (const k in pendingCommit) { clearTimeout(pendingCommit[k]); delete pendingCommit[k]; }
        if (toggleBtn) toggleBtn.style.display = 'none';
        if (dock) {
            if (dock.contains(document.activeElement)) document.activeElement.blur();
            dock.remove();
            dock = null;
        }
        rows = {};
    }

    function setOpen(open) {
        isOpen = !!open;
        if (dock) dock.classList.toggle('is-open', isOpen && !!cpu);
        if (toggleBtn) toggleBtn.classList.toggle('is-open', isOpen);
        if (!isOpen && dock && dock.contains(document.activeElement)) document.activeElement.blur();
    }

    // ── DOM ─────────────────────────────────────
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function button(text, onClick, cls) {
        const b = el('button', 'cwp-btn' + (cls ? ' ' + cls : ''), text);
        b.type = 'button';
        b.addEventListener('mousedown', e => e.preventDefault());   // クリックでフォーカスを奪わない＝キーはゲームへ
        b.addEventListener('click', onClick);
        return b;
    }

    function ensureToggle() {
        if (toggleBtn) return;
        const area = document.getElementById('eval-area');
        if (!area) return;
        toggleBtn = button('WEIGHTS', () => setOpen(!isOpen), 'cwp-toggle');
        toggleBtn.style.display = 'none';
        area.appendChild(toggleBtn);
    }

    function buildDom() {
        ensureToggle();
        dock = el('div', 'cwp-dock');
        const card = el('div', 'cwp-card');
        dock.appendChild(card);

        // パネル内のキーはゲームへ流さない。Esc は入力欄から抜ける（入力中の値は捨てる）
        const stopKeys = (e) => {
            if (e.type === 'keydown' && e.key === 'Escape') {
                const a = document.activeElement;
                if (a && a.classList && a.classList.contains('cwp-input')) a.value = String(values[a.dataset.name]);
                if (a && dock.contains(a)) a.blur();
                e.preventDefault();
            }
            e.stopPropagation();
        };
        dock.addEventListener('keydown', stopKeys);
        dock.addEventListener('keyup', stopKeys);

        const head = el('div', 'cwp-head');
        head.appendChild(el('div', 'cwp-title', 'CPU WEIGHTS'));
        head.appendChild(button('×', () => setOpen(false), 'cwp-close'));
        card.appendChild(head);
        card.appendChild(el('div', 'cwp-meta', `${level} · ${cpu.constructor.WEIGHTS_ID}`));
        statusEl = el('div', 'cwp-status');
        card.appendChild(statusEl);
        warnEl = el('div', 'cwp-warn');
        card.appendChild(warnEl);

        const actions = el('div', 'cwp-actions');
        for (const lv of ['LV5', 'LV6']) {
            const b = button(lv, () => { if (refs[lv]) apply(Object.assign({}, refs[lv])); });
            b.dataset.ref = lv;
            if (!refs[lv]) { b.disabled = true; b.title = 'LV6 を一度読み込むと使える'; }
            actions.appendChild(b);
        }
        actions.appendChild(button('EXPORT', doExport));
        actions.appendChild(button('IMPORT', () => {
            importBox.classList.toggle('is-open');
            if (importBox.classList.contains('is-open')) importText.focus();
        }));
        card.appendChild(actions);

        importBox = el('div', 'cwp-import');
        importText = el('textarea', 'cwp-import-text');
        importText.placeholder = '学習の best.json をそのまま、または { "名前": 値 } を貼る';
        importText.spellcheck = false;
        const importRow = el('div', 'cwp-actions');
        importRow.appendChild(button('APPLY', doImport));
        importRow.appendChild(button('CANCEL', () => { importBox.classList.remove('is-open'); importText.value = ''; }));
        importBox.appendChild(importText);
        importBox.appendChild(importRow);
        card.appendChild(importBox);
        msgEl = el('div', 'cwp-msg');
        card.appendChild(msgEl);

        card.appendChild(el('div', 'cwp-hint',
            '値は次の思考から効く（先読み済みの手があればその次から。効いた手は思考ログに出る）。' +
            '↑↓ で増減、Shift+↑↓ で 1 ずつ。Enter で確定、Esc で入力欄から抜ける。'));

        filterInput = el('input', 'cwp-filter');
        filterInput.type = 'text';
        filterInput.placeholder = 'FILTER';
        filterInput.spellcheck = false;
        filterInput.addEventListener('input', applyFilter);
        card.appendChild(filterInput);

        // 並べる
        const all = Object.keys(groups);
        const used = new Set();
        const pick = (names) => names.filter(k => groups[k] && !used.has(k) && used.add(k));
        const control = pick(CONTROL_ORDER.concat(all.filter(k => groups[k] === 'control' && !VERSUS_ONLY.includes(k) && !FIXED.includes(k))));
        const vsOnly  = pick(VERSUS_ONLY);
        const fixed   = pick(FIXED);
        const evals   = pick(all.filter(k => groups[k] === 'eval'));
        const reward  = pick(all.filter(k => groups[k] === 'reward'));

        rows = {};
        card.appendChild(section('CONTROL', '発火・緊急・探索', control));
        card.appendChild(section('EVAL', '盤面の評価', evals));
        card.appendChild(section('REWARD', '配置で現れた変化に1回足す', reward));
        card.appendChild(section('VERSUS ONLY', '催促 H1・対応 H2。VERSUS で相手がぷよのときだけ効く（CPU TEST では効かない）', vsOnly));
        const det = el('details', 'cwp-fixed');
        det.appendChild(el('summary', 'cwp-section-title', 'UNUSED / FIXED'));
        det.appendChild(el('div', 'cwp-section-desc', '使っていない重みと、変えると別の CPU になる切り替え'));
        for (const k of fixed) det.appendChild(row(k));
        card.appendChild(det);

        document.body.appendChild(dock);
        refreshRows();
        if (descs) fillDescs();
    }

    function section(title, desc, names) {
        const s = el('div', 'cwp-section');
        s.appendChild(el('div', 'cwp-section-title', title));
        s.appendChild(el('div', 'cwp-section-desc', desc));
        for (const k of names) s.appendChild(row(k));
        return s;
    }

    function row(name) {
        const r = el('div', 'cwp-row');
        const top = el('div', 'cwp-row-top');
        top.appendChild(el('span', 'cwp-name', name));
        const input = el('input', 'cwp-input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.spellcheck = false;
        input.dataset.name = name;
        input.addEventListener('change', () => commit(name));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(name); return; }
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const cur = parseInt(input.value, 10);
            const base = Number.isFinite(cur) ? cur : values[name];
            input.value = String(base + (e.key === 'ArrowUp' ? 1 : -1) * stepOf(name, e.shiftKey));
            clearTimeout(pendingCommit[name]);
            pendingCommit[name] = setTimeout(() => commit(name), 350);
        });
        top.appendChild(input);
        const ref = el('span', 'cwp-ref');
        top.appendChild(ref);
        r.appendChild(top);
        const desc = el('div', 'cwp-desc');
        r.appendChild(desc);
        rows[name] = { row: r, input, ref, desc };
        return r;
    }

    // ↑↓ の刻み：既定値の桁に合わせる（12 なら 1、-500 なら 10、180800 なら 10000）。Shift で 1
    function stepOf(name, fine) {
        if (fine) return 1;
        const mag = Math.max(Math.abs(defaults[name] || 0), Math.abs(values[name] || 0));
        if (mag < 100) return 1;
        return Math.pow(10, Math.floor(Math.log10(mag)) - 1);
    }

    function commit(name) {
        clearTimeout(pendingCommit[name]);
        delete pendingCommit[name];
        const r = rows[name];
        if (!r || !cpu) return;
        const v = Number(r.input.value.trim());
        if (!Number.isFinite(v)) { r.input.value = String(values[name]); return; }
        if (Math.round(v) === values[name]) { r.input.value = String(values[name]); return; }
        apply(Object.assign({}, values, { [name]: Math.round(v) }));
    }

    function fillDescs() {
        for (const k in rows) rows[k].desc.textContent = (descs && descs[k]) || '';
    }

    function applyFilter() {
        const q = filterInput.value.trim().toLowerCase();
        for (const k in rows) {
            const hit = !q || k.toLowerCase().includes(q) || rows[k].desc.textContent.includes(filterInput.value.trim());
            rows[k].row.style.display = hit ? '' : 'none';
        }
    }

    function refreshRows() {
        for (const k in rows) {
            const r = rows[k];
            if (document.activeElement !== r.input && !pendingCommit[k]) r.input.value = String(values[k]);
            r.row.classList.toggle('is-changed', values[k] !== defaults[k]);
            const parts = [];
            for (const lv of ['LV5', 'LV6']) {
                if (!refs[lv]) continue;
                const v = refs[lv][k];
                parts.push(`<span class="${v === values[k] ? 'is-same' : ''}">${lv.slice(2)}:${v}</span>`);
            }
            r.ref.innerHTML = parts.join(' ');
        }
        if (dock) {
            dock.querySelectorAll('.cwp-btn[data-ref]').forEach(b => {
                const ref = refs[b.dataset.ref];
                b.classList.toggle('is-active', !!ref && Object.keys(values).every(k => values[k] === ref[k]));
            });
        }
    }

    function refreshStatus() {
        if (!cpu) return;
        const n = Object.keys(changed).length;
        if (toggleBtn) {
            toggleBtn.textContent = n ? `WEIGHTS · CUSTOM ${n}` : 'WEIGHTS';
            toggleBtn.classList.toggle('is-custom', n > 0);
        }
        if (!statusEl) return;
        const head = n ? `CUSTOM · ${n} CHANGED` : 'DEFAULT';
        let applied = '';
        if ((cpu._weightsRev || 0) !== (cpu._sentWeightsRev || 0)) applied = 'PENDING（次の思考から）';
        else if (cpu._weightsAppliedTurn) applied = `FROM TURN ${cpu._weightsAppliedTurn}`;
        statusEl.textContent = `${head}${applied ? ' · ' + applied : ''} · NOW TURN ${cpu._turnNo || 0}`;
        statusEl.classList.toggle('is-custom', n > 0);
        warnEl.textContent = storedWarn;
        warnEl.style.display = storedWarn ? '' : 'none';
    }

    function say(text, isError) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.classList.toggle('is-error', !!isError);
    }

    // ── JSON ────────────────────────────────────
    function exportJson() {
        return {
            level,
            weightsId: cpu.constructor.WEIGHTS_ID,
            policy: { build: cpu.getBuildPolicyArray() },
            named: Object.assign({}, values),
            changed: JSON.parse(JSON.stringify(changed)),
        };
    }

    function doExport() {
        if (!cpu) return;
        const text = JSON.stringify(exportJson(), null, 1);
        const fallback = () => {
            importBox.classList.add('is-open');
            importText.value = text;
            importText.focus();
            importText.select();
            say('クリップボードに書けなかったので下の欄に出した（選択済み）', true);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => say(`COPIED: JSON をクリップボードへ（既定と違う ${Object.keys(changed).length} 件）`), fallback);
        } else {
            fallback();
        }
    }

    function doImport() {
        if (!cpu) return;
        let obj;
        try { obj = JSON.parse(importText.value); } catch (e) { say('JSON として読めない: ' + e.message, true); return; }
        const incoming = {};
        const arr = (obj && obj.policy && Array.isArray(obj.policy.build)) ? obj.policy.build
                  : (obj && Array.isArray(obj.build)) ? obj.build
                  : Array.isArray(obj) ? obj : null;
        let unknown = 0;
        if (arr) {
            const names = cpu.getBuildPolicyNames();
            if (arr.length !== names.length) { say(`policy.build の長さが ${arr.length}（${names.length} を想定）`, true); return; }
            arr.forEach((v, i) => { if (names[i]) incoming[names[i]] = v; });
        } else if (obj && typeof obj === 'object') {
            const src = (obj.named && typeof obj.named === 'object') ? obj.named : obj;
            for (const k in src) {
                if (groups[k] && typeof src[k] === 'number') incoming[k] = src[k];
                else unknown++;
            }
        }
        const n = Object.keys(incoming).length;
        if (!n) { say('読める重みが無い（policy.build か { "名前": 値 }）', true); return; }
        apply(Object.assign({}, values, incoming));
        importBox.classList.remove('is-open');
        importText.value = '';
        const notes = [];
        if (unknown) notes.push(`知らない項目 ${unknown} 件は無視`);
        if (obj && obj.policy && (obj.policy.counterTrigger != null || obj.policy.ext)) notes.push('counterTrigger / counterMargin / ext は VERSUS 専用なので読まない');
        say(`IMPORTED: ${n} 件（既定と違う ${Object.keys(changed).length} 件）${notes.length ? '。' + notes.join('、') : ''}`);
    }

    return { attach, detach, open: () => setOpen(true), close: () => setOpen(false), exportJson: () => cpu && exportJson() };
})();
