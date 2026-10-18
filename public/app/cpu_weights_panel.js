// ─────────────────────────────────────────────
// cpu_weights_panel.js
// CPU TEST（ぷよ LV5/LV6）の重み調整パネル
//
// 設計: source_assets/memory/cpu/puyo/weights-tuning-panel-design.md
//   ・CPU TEST の間は画面右端に常に出す（開いてもポーズしない。− で見出しだけに畳める）
//   ・値を変えると CPU の build の基準値を置き換える（cpu5_weights.js applyBuildValues）。
//     weightsArray は手ごとに組み立て直すので次の思考から効く。効き始めの手は思考ログ（cpuLog()）に出る
//   ・項目は2列に詰めて並べ、セクションごとに折りたためる。説明・LV5/LV6 の値は下の欄に、
//     選んでいる（またはカーソルを当てた）項目の分だけ出す
//   ・CPU 同士（CPU TEST の OPPONENT: CPU。盤面は VERSUS のものを使う）では 1P / 2P を切り替えて編集する
//   ・LV5 / LV6 の値に戻す・JSON の書き出し（学習の best.json と同じ policy.build）・読み込み
//   ・変えた値は localStorage（tetlabo.cpuWeights）に「枠（TEST / 1P / 2P）× LV」ごとの既定との差分で残し、
//     次に同じ枠で同じ LV を動かすときにも載せる
//   ・パネル内にフォーカスがある間はキーをゲームへ流さない（Esc で入力欄から抜ける）
//
// 呼び出し: navigation.js（CPU TEST 開始・リスタート → attach(cpu)、stopAllGames → detach()）、
//           versus.js（CPU TEST から始めた CPU 同士 → attach([{slot:'1P',cpu},{slot:'2P',cpu}])、
//           コントローラの作り直し → replace(old, new)）。
// ─────────────────────────────────────────────

window.CpuWeightsPanel = (() => {
    const STORE_KEY = 'tetlabo.cpuWeights';
    const UI_KEY    = 'tetlabo.cpuWeightsUi';   // 折りたたみ・畳んだ状態（見た目の好みだけ）
    const DESC_SRC  = 'cpu/puyo/lv5/js/weights/cpu5_weights.js';   // 説明はこのファイルの行末コメントから取る

    // 並べ方。CONTROL はこの順、残りは cpu5_weights.js の定義順
    const CONTROL_ORDER = [
        'fireChainCount', 'fireScoreThreshold', 'growthFireForbidChains', 'fireEmergency',
        'emergencyHeight', 'emergencyFireMinRatio', 'emergencyHardCol2',
        'expChainWeight', 'pruneChainScore', 'expMaxDepth', 'expBeamWidth',
    ];
    // VERSUS で相手がぷよのときだけ効く（催促 H1・対応 H2）
    const VERSUS_ONLY = ['harassMinOjama', 'harassMaxChains', 'harassKeepPct', 'harassMinReach', 'counterKeepReach'];
    // 参照されない・切り替えたら別物になるもの
    const FIXED = ['ignitionThreshold', 'ignitionScoreThreshold', 'expBranch', 'amaEvalMode', 'p1Weight'];

    let targets = [];           // 編集できる CPU（1つ＝CPU TEST、2つ＝CPU 同士）
    let cur = 0;                // 編集中の targets の添字
    let ui = loadUi();
    let dock = null, cells = {}, sections = {};
    let statusEl, metaEl, warnEl, msgEl, infoEl, importBox, importText, filterInput, tabsEl;
    let pollTimer = null;
    let focusName = null, hoverName = null;
    const pendingCommit = {};
    let descs = null;

    const T = () => targets[cur];

    // ── 保存 ─────────────────────────────────────
    function loadUi() {
        try { return Object.assign({ collapsed: { FIXED: true }, min: false }, JSON.parse(localStorage.getItem(UI_KEY) || 'null')); }
        catch (_) { return { collapsed: { FIXED: true }, min: false }; }
    }
    function saveUi() {
        try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (_) { /* 次回は既定の見た目 */ }
    }
    // CPU TEST（1台）は LV 名だけ、CPU 同士は「1P:LV6」のように枠を付ける
    const storeKey = (t) => (t.slot === 'TEST' ? t.level : `${t.slot}:${t.level}`);
    function readStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { return {}; }
    }
    function writeStore(t) {
        const all = readStore();
        const diff = {};
        for (const k in t.changed) diff[k] = t.changed[k].to;
        if (Object.keys(diff).length) all[storeKey(t)] = { weightsId: t.cpu.constructor.WEIGHTS_ID, values: diff };
        else delete all[storeKey(t)];
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

    // ── 対象の CPU ───────────────────────────────
    function makeTarget(slot, cpu) {
        const t = {
            slot, cpu,
            level: cpu.constructor.LOG_NAME || 'LV5',
            defaults: cpu.getBuildDefaults(),
            refs: { LV5: cpu.getBuildDefaults('LV5'), LV6: cpu.getBuildDefaults('LV6') },
            groups: {}, changed: {}, values: null, storedWarn: '',
        };
        const b = cpu._defaultBuildBaseline;
        for (const k in b.rewardWeights) t.groups[k] = 'reward';
        for (const k in b.evalWeights) t.groups[k] = 'eval';
        for (const k in b.controlWeights) t.groups[k] = 'control';
        // 保存してある変更を載せる（パネルを触らなくても効く＝見出しに CUSTOM と出す）
        const st = readStore()[storeKey(t)];
        if (st && st.values && Object.keys(st.values).length) {
            t.changed = cpu.applyBuildValues(st.values);
            if (st.weightsId && st.weightsId !== cpu.constructor.WEIGHTS_ID) {
                t.storedWarn = `保存した変更は重みの版 ${st.weightsId} のときのもの（今は ${cpu.constructor.WEIGHTS_ID}）`;
            }
        }
        t.values = cpu.getBuildValues();
        return t;
    }

    // cpus: CPU 1つ（CPU TEST）か [{ slot: '1P'|'2P', cpu }]（CPU 同士）
    function attach(cpus) {
        detach();
        const list = Array.isArray(cpus) ? cpus : [{ slot: 'TEST', cpu: cpus }];
        targets = list
            .filter(x => x && x.cpu && typeof x.cpu.applyBuildValues === 'function')   // ぷよ LV5/LV6 だけ
            .map(x => makeTarget(x.slot, x.cpu));
        if (!targets.length) return;
        cur = Math.min(cur, targets.length - 1);
        buildDom();
        loadDescs().then(() => { if (dock) showInfo(); });
        pollTimer = setInterval(refreshStatus, 300);
    }

    function detach() {
        targets = [];
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        for (const k in pendingCommit) { clearTimeout(pendingCommit[k]); delete pendingCommit[k]; }
        if (dock) {
            if (dock.contains(document.activeElement)) document.activeElement.blur();
            dock.remove();
            dock = null;
        }
        document.body.classList.remove('cwp-on');
        cells = {}; sections = {};
        focusName = hoverName = null;
    }

    // コントローラを作り直したとき（ウォッチドッグ・盤面入れ替え）、その枠の値を新しい CPU に載せ直す
    function replace(oldCpu, newCpu) {
        const t = targets.find(x => x.cpu === oldCpu);
        if (!t || !newCpu || typeof newCpu.applyBuildValues !== 'function') return;
        const diff = {};
        for (const k in t.changed) diff[k] = t.changed[k].to;
        newCpu.getBuildDefaults();
        if (Object.keys(diff).length) t.changed = newCpu.applyBuildValues(diff);
        t.cpu = newCpu;
        t.values = newCpu.getBuildValues();
    }

    // ── 適用 ─────────────────────────────────────
    function apply(next) {
        const t = T();
        if (!t) return;
        t.changed = t.cpu.applyBuildValues(next);
        t.values  = t.cpu.getBuildValues();
        writeStore(t);
        refreshAll();
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

    function buildDom() {
        dock = el('div', 'cwp-dock');
        dock.classList.toggle('is-min', !!ui.min);
        const card = el('div', 'cwp-card');
        dock.appendChild(card);

        // パネル内のキーはゲームへ流さない。Esc は入力欄から抜ける（入力中の値は捨てる）
        const stopKeys = (e) => {
            if (e.type === 'keydown' && e.key === 'Escape') {
                const a = document.activeElement;
                if (a && a.classList && a.classList.contains('cwp-input') && T()) a.value = String(T().values[a.dataset.name]);
                if (a && dock.contains(a)) a.blur();
                e.preventDefault();
            }
            e.stopPropagation();
        };
        dock.addEventListener('keydown', stopKeys);
        dock.addEventListener('keyup', stopKeys);

        const head = el('div', 'cwp-head');
        head.appendChild(el('div', 'cwp-title', 'CPU WEIGHTS'));
        statusEl = el('div', 'cwp-status');
        head.appendChild(statusEl);
        head.appendChild(button(ui.min ? '+' : '−', (e) => {
            ui.min = !ui.min;
            saveUi();
            dock.classList.toggle('is-min', ui.min);
            document.body.classList.toggle('cwp-on', !ui.min);
            e.currentTarget.textContent = ui.min ? '+' : '−';
        }, 'cwp-min'));
        card.appendChild(head);

        const body = el('div', 'cwp-body');
        card.appendChild(body);

        tabsEl = el('div', 'cwp-tabs');
        if (targets.length > 1) {
            targets.forEach((t, i) => {
                const b = button('', () => { cur = i; focusName = null; refreshAll(); });
                b.dataset.idx = String(i);
                tabsEl.appendChild(b);
            });
            body.appendChild(tabsEl);
        }

        metaEl = el('div', 'cwp-meta');
        body.appendChild(metaEl);
        warnEl = el('div', 'cwp-warn');
        body.appendChild(warnEl);

        const actions = el('div', 'cwp-actions');
        for (const lv of ['LV5', 'LV6']) {
            const b = button(lv, () => { const r = T() && T().refs[lv]; if (r) apply(Object.assign({}, r)); });
            b.dataset.ref = lv;
            actions.appendChild(b);
        }
        actions.appendChild(button('EXPORT', doExport));
        actions.appendChild(button('IMPORT', () => {
            importBox.classList.toggle('is-open');
            if (importBox.classList.contains('is-open')) importText.focus();
        }));
        filterInput = el('input', 'cwp-filter');
        filterInput.type = 'text';
        filterInput.placeholder = 'FILTER';
        filterInput.spellcheck = false;
        filterInput.addEventListener('input', applyFilter);
        actions.appendChild(filterInput);
        body.appendChild(actions);

        importBox = el('div', 'cwp-import');
        importText = el('textarea', 'cwp-import-text');
        importText.placeholder = '学習の best.json をそのまま、または { "名前": 値 } を貼る';
        importText.spellcheck = false;
        const importRow = el('div', 'cwp-actions');
        importRow.appendChild(button('APPLY', doImport));
        importRow.appendChild(button('CANCEL', () => { importBox.classList.remove('is-open'); importText.value = ''; }));
        importBox.appendChild(importText);
        importBox.appendChild(importRow);
        body.appendChild(importBox);
        msgEl = el('div', 'cwp-msg');
        body.appendChild(msgEl);

        // 項目（ここだけスクロールする）
        const list = el('div', 'cwp-list');
        body.appendChild(list);
        const groups = T().groups;
        const all = Object.keys(groups);
        const used = new Set();
        const pick = (names) => names.filter(k => groups[k] && !used.has(k) && used.add(k));
        const control = pick(CONTROL_ORDER.concat(all.filter(k => groups[k] === 'control' && !VERSUS_ONLY.includes(k) && !FIXED.includes(k))));
        const vsOnly  = pick(VERSUS_ONLY);
        const fixed   = pick(FIXED);
        const evals   = pick(all.filter(k => groups[k] === 'eval'));
        const reward  = pick(all.filter(k => groups[k] === 'reward'));
        cells = {}; sections = {};
        list.appendChild(section('CONTROL', control));
        list.appendChild(section('EVAL', evals));
        list.appendChild(section('REWARD', reward));
        list.appendChild(section('VERSUS ONLY', vsOnly));
        list.appendChild(section('FIXED', fixed));

        // 説明欄（選んでいる項目の説明・LV5/LV6 の値）
        infoEl = el('div', 'cwp-info');
        body.appendChild(infoEl);

        document.body.appendChild(dock);
        document.body.classList.toggle('cwp-on', !ui.min);   // 盤面を左へ寄せて右端を空ける（CSS）
        refreshAll();
    }

    function section(title, names) {
        const s = el('div', 'cwp-section');
        const h = el('div', 'cwp-section-title');
        h.addEventListener('mousedown', e => e.preventDefault());
        h.addEventListener('click', () => {
            ui.collapsed[title] = !ui.collapsed[title];
            saveUi();
            s.classList.toggle('is-collapsed', !!ui.collapsed[title]);
        });
        s.appendChild(h);
        const grid = el('div', 'cwp-grid');
        for (const k of names) grid.appendChild(cell(k));
        s.appendChild(grid);
        s.classList.toggle('is-collapsed', !!ui.collapsed[title]);
        sections[title] = { el: s, head: h, names };
        return s;
    }

    function cell(name) {
        const c = el('label', 'cwp-cell');
        c.appendChild(el('span', 'cwp-name', name));
        const input = el('input', 'cwp-input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.spellcheck = false;
        input.dataset.name = name;
        input.addEventListener('change', () => commit(name));
        input.addEventListener('focus', () => { focusName = name; showInfo(); input.select(); });
        input.addEventListener('blur', () => { if (focusName === name) { focusName = null; showInfo(); } });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(name); return; }
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const t = T();
            const v = parseInt(input.value, 10);
            const base = Number.isFinite(v) ? v : t.values[name];
            input.value = String(base + (e.key === 'ArrowUp' ? 1 : -1) * stepOf(name, e.shiftKey));
            clearTimeout(pendingCommit[name]);
            pendingCommit[name] = setTimeout(() => commit(name), 350);
        });
        c.addEventListener('mouseenter', () => { hoverName = name; showInfo(); });
        c.addEventListener('mouseleave', () => { if (hoverName === name) { hoverName = null; showInfo(); } });
        c.appendChild(input);
        cells[name] = { cell: c, input };
        return c;
    }

    // ↑↓ の刻み：既定値の桁に合わせる（12 なら 1、-500 なら 10、180800 なら 10000）。Shift で 1
    function stepOf(name, fine) {
        if (fine) return 1;
        const t = T();
        const mag = Math.max(Math.abs(t.defaults[name] || 0), Math.abs(t.values[name] || 0));
        if (mag < 100) return 1;
        return Math.pow(10, Math.floor(Math.log10(mag)) - 1);
    }

    function commit(name) {
        clearTimeout(pendingCommit[name]);
        delete pendingCommit[name];
        const c = cells[name], t = T();
        if (!c || !t) return;
        const v = Number(c.input.value.trim());
        if (!Number.isFinite(v) || Math.round(v) === t.values[name]) { c.input.value = String(t.values[name]); return; }
        apply(Object.assign({}, t.values, { [name]: Math.round(v) }));
    }

    function applyFilter() {
        const q = filterInput.value.trim().toLowerCase();
        for (const k in cells) {
            const d = (descs && descs[k]) || '';
            cells[k].cell.style.display = (!q || k.toLowerCase().includes(q) || d.includes(filterInput.value.trim())) ? '' : 'none';
        }
        // 絞り込み中は畳んだセクションも開いて見せる
        for (const s in sections) sections[s].el.classList.toggle('is-filtering', !!q);
    }

    function showInfo() {
        const t = T();
        if (!infoEl || !t) return;
        const name = focusName || hoverName;
        if (!name) {
            infoEl.innerHTML = '';
            infoEl.appendChild(el('div', 'cwp-info-desc',
                '値は次の思考から効く（先読み済みの手があればその次から。効いた手は思考ログに出る）。' +
                '↑↓ で増減、Shift+↑↓ で 1 ずつ。Enter で確定、Esc で入力欄から抜ける。'));
            return;
        }
        infoEl.innerHTML = '';
        infoEl.appendChild(el('div', 'cwp-info-name', name));
        const d = (descs && descs[name]) || '';
        let note = '';
        if (VERSUS_ONLY.includes(name)) note = t.slot === 'TEST' ? '（VERSUS で相手がぷよのときだけ効く＝ここでは効かない）' : '（相手がぷよのときだけ効く）';
        if (d || note) infoEl.appendChild(el('div', 'cwp-info-desc', d + note));
        const refs = el('div', 'cwp-info-refs');
        const parts = [`NOW ${t.values[name]}`, `DEFAULT ${t.defaults[name]}`];
        for (const lv of ['LV5', 'LV6']) if (t.refs[lv]) parts.push(`${lv} ${t.refs[lv][name]}`);
        refs.textContent = parts.join(' · ');
        infoEl.appendChild(refs);
    }

    function refreshAll() {
        const t = T();
        if (!dock || !t) return;
        for (const k in cells) {
            const c = cells[k];
            if (document.activeElement !== c.input && !pendingCommit[k]) c.input.value = String(t.values[k]);
            c.cell.classList.toggle('is-changed', t.values[k] !== t.defaults[k]);
        }
        for (const s in sections) {
            const n = sections[s].names.filter(k => t.values[k] !== t.defaults[k]).length;
            sections[s].head.textContent = `${s}${n ? ` · ${n}` : ''}`;
            sections[s].head.classList.toggle('is-changed', n > 0);
        }
        dock.querySelectorAll('.cwp-btn[data-ref]').forEach(b => {
            const ref = t.refs[b.dataset.ref];
            b.disabled = !ref;
            b.title = ref ? `${b.dataset.ref} の値に戻す` : 'LV6 を一度読み込むと使える';
            b.classList.toggle('is-active', !!ref && Object.keys(t.values).every(k => t.values[k] === ref[k]));
        });
        tabsEl.querySelectorAll('.cwp-btn').forEach(b => {
            const x = targets[+b.dataset.idx];
            const n = Object.keys(x.changed).length;
            b.textContent = `${x.slot} ${x.level}${n ? ' · ' + n : ''}`;
            b.classList.toggle('is-active', x === t);
        });
        metaEl.textContent = `${t.slot === 'TEST' ? '' : t.slot + ' · '}${t.level} · ${t.cpu.constructor.WEIGHTS_ID}`;
        warnEl.textContent = t.storedWarn;
        warnEl.style.display = t.storedWarn ? '' : 'none';
        showInfo();
        refreshStatus();
    }

    function refreshStatus() {
        const t = T();
        if (!t || !statusEl) return;
        const cpu = t.cpu;
        const n = Object.keys(t.changed).length;
        let applied = '';
        if ((cpu._weightsRev || 0) !== (cpu._sentWeightsRev || 0)) applied = 'PENDING';
        else if (cpu._weightsAppliedTurn) applied = `FROM #${cpu._weightsAppliedTurn}`;
        statusEl.textContent = `${n ? `CUSTOM ${n}` : 'DEFAULT'}${applied ? ' · ' + applied : ''} · NOW #${cpu._turnNo || 0}`;
        statusEl.classList.toggle('is-custom', targets.some(x => Object.keys(x.changed).length > 0));
    }

    function say(text, isError) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.classList.toggle('is-error', !!isError);
    }

    // ── JSON ────────────────────────────────────
    function exportJson(t) {
        return {
            slot: t.slot,
            level: t.level,
            weightsId: t.cpu.constructor.WEIGHTS_ID,
            policy: { build: t.cpu.getBuildPolicyArray() },
            named: Object.assign({}, t.values),
            changed: JSON.parse(JSON.stringify(t.changed)),
        };
    }

    function doExport() {
        const t = T();
        if (!t) return;
        const text = JSON.stringify(exportJson(t), null, 1);
        const fallback = () => {
            importBox.classList.add('is-open');
            importText.value = text;
            importText.focus();
            importText.select();
            say('クリップボードに書けなかったので下の欄に出した（選択済み）', true);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => say(`COPIED: ${t.slot === 'TEST' ? '' : t.slot + ' '}${t.level} の JSON（既定と違う ${Object.keys(t.changed).length} 件）`), fallback);
        } else {
            fallback();
        }
    }

    function doImport() {
        const t = T();
        if (!t) return;
        let obj;
        try { obj = JSON.parse(importText.value); } catch (e) { say('JSON として読めない: ' + e.message, true); return; }
        const incoming = {};
        const arr = (obj && obj.policy && Array.isArray(obj.policy.build)) ? obj.policy.build
                  : (obj && Array.isArray(obj.build)) ? obj.build
                  : Array.isArray(obj) ? obj : null;
        let unknown = 0;
        if (arr) {
            const names = t.cpu.getBuildPolicyNames();
            if (arr.length !== names.length) { say(`policy.build の長さが ${arr.length}（${names.length} を想定）`, true); return; }
            arr.forEach((v, i) => { if (names[i]) incoming[names[i]] = v; });
        } else if (obj && typeof obj === 'object') {
            const src = (obj.named && typeof obj.named === 'object') ? obj.named : obj;
            for (const k in src) {
                if (t.groups[k] && typeof src[k] === 'number') incoming[k] = src[k];
                else unknown++;
            }
        }
        const n = Object.keys(incoming).length;
        if (!n) { say('読める重みが無い（policy.build か { "名前": 値 }）', true); return; }
        apply(Object.assign({}, t.values, incoming));
        importBox.classList.remove('is-open');
        importText.value = '';
        const notes = [];
        if (unknown) notes.push(`知らない項目 ${unknown} 件は無視`);
        if (obj && obj.policy && (obj.policy.counterTrigger != null || obj.policy.ext)) notes.push('counterTrigger / counterMargin / ext は読まない');
        say(`IMPORTED: ${n} 件（既定と違う ${Object.keys(T().changed).length} 件）${notes.length ? '。' + notes.join('、') : ''}`);
    }

    return {
        attach, detach, replace,
        exportJson: () => (T() ? exportJson(T()) : null),
        select: (i) => { if (targets[i]) { cur = i; refreshAll(); } },
    };
})();
