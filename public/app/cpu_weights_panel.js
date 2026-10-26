// ─────────────────────────────────────────────
// cpu_weights_panel.js
// CPU TEST（ぷよ LV5/LV6・テト LV5/LV6）の重み調整パネル
//   テトは CPU の this.weights を直接書き換える薄いアダプタ（wrapTet）を挟み、BUILD 1モードだけの形でぷよと同じ画面を使う
//
// 設計: source_assets/memory/cpu/puyo/weights-tuning-panel-design.md
//   ・CPU TEST の間は画面右端に常に出す（開いてもポーズしない。− で見出しだけに畳める）
//   ・対象のモードを BUILD / VS TET / FAST VS TET から選ぶ。
//     BUILD は CPU の build の基準値を置き換える（cpu5_weights.js applyBuildValues）。
//     VS TET / FAST VS TET は、組み上がった対テトの値（lv5 基準＋cpu5_modes.js＋lv6 の VS_TET）へ名前で上書きする
//     （applyModeValues）。VS_TET の判断の値（重みでないもの）は DECISION に表示だけする。
//     weightsArray は手ごとに組み立て直すので次の思考から効く。効き始めの手は思考ログ（cpuLog()）に出る
//   ・項目は2列に詰めて並べ、セクションごとに折りたためる。説明・LV5/LV6 の値は下の欄に、
//     選んでいる（またはカーソルを当てた）項目の分だけ出す
//   ・CPU 同士（CPU TEST の OPPONENT: CPU。盤面は VERSUS のものを使う）では 1P / 2P を切り替えて編集する
//   ・LV5 / LV6（対テトは DEFAULT）の値に戻す・JSON の書き出し（BUILD は学習の best.json と同じ policy.build）・読み込み
//   ・変えた値は localStorage（tetlabo.cpuWeights）に「枠（TEST / 1P / 2P）× LV × モード」ごとの既定との差分で残し、
//     次に同じ枠で同じ LV を動かすときにも載せる（BUILD は「LV6」、対テトは「LV6@vsTet」のようなキー）
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
    const DESC_SRC6 = 'cpu/puyo/lv6/js/cpu6.js';                    // DECISION（VS_TET の判断の値）の説明

    // 編集できるモード（build＝対ぷよ・ソロの本線、vsTet＝対テトの本線、fastVsTet＝対テトのカウンター）
    const MODES = [
        { id: 'build',     label: 'BUILD' },
        { id: 'vsTet',     label: 'VS TET' },
        { id: 'fastVsTet', label: 'FAST VS TET' },
    ];
    const MODE_LABEL = Object.fromEntries(MODES.map(m => [m.id, m.label]));

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
    // カウンター中は受け量から毎手決め直す（fastVsTet でここを変えても効かない）
    const COUNTER_SET = ['fireChainCount', 'fireScoreThreshold'];

    let targets = [];           // 編集できる CPU（1つ＝CPU TEST、2つ＝CPU 同士）
    let cur = 0;                // 編集中の targets の添字
    let ui = loadUi();
    let dock = null, cells = {}, roCells = {}, sections = {};
    let statusEl, metaEl, warnEl, msgEl, infoEl, importBox, importText, filterInput, tabsEl, modesEl, listEl;
    let pollTimer = null;
    let focusName = null, hoverName = null;
    const pendingCommit = {};
    let descs = null, descsVt = null;

    const T = () => targets[cur];
    const S = () => (T() ? T().st[T().mode] : null);   // 編集中のモードの値
    const hasModes = (cpu) => typeof cpu.applyModeValues === 'function';
    const countChanged = (t) => Object.values(t.st).reduce((n, s) => n + Object.keys(s.changed).length, 0);

    // ── 保存 ─────────────────────────────────────
    function loadUi() {
        try { return Object.assign({ collapsed: { FIXED: true }, min: false }, JSON.parse(localStorage.getItem(UI_KEY) || 'null')); }
        catch (_) { return { collapsed: { FIXED: true }, min: false }; }
    }
    function saveUi() {
        try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (_) { /* 次回は既定の見た目 */ }
    }
    // CPU TEST（1台）は LV 名だけ、CPU 同士は「1P:LV6」のように枠を付ける。BUILD 以外は「@モード」を付ける
    const storeKey = (t, mode) => (t.slot === 'TEST' ? t.level : `${t.slot}:${t.level}`) + (mode && mode !== 'build' ? `@${mode}` : '');
    function readStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { return {}; }
    }
    function writeStore(t, mode) {
        const all = readStore();
        const diff = {};
        for (const k in t.st[mode].changed) diff[k] = t.st[mode].changed[k].to;
        if (Object.keys(diff).length) all[storeKey(t, mode)] = { weightsId: t.cpu.constructor.WEIGHTS_ID, values: diff };
        else delete all[storeKey(t, mode)];
        try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch (_) { /* 保存できなくても今回は効く */ }
    }

    // ── 説明（cpu5_weights.js の「名前: 値, // 説明」と weightsArray の「this.xxxWeights.名前, // [N] 説明」） ─────────
    function loadDescs() {
        if (descs) return Promise.resolve(descs);
        const get = (src) => fetch(src).then(r => (r.ok ? r.text() : '')).catch(() => '');
        return Promise.all([get(DESC_SRC), get(DESC_SRC6)]).then(([src, src6]) => {
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
            // 既定の重みに名前の無いもの（対テト §15・§17 など）は weightsArray の行末コメントから
            for (const line of src.split('\n')) {
                const m = /this\.\w+Weights\.(\w+)(?:\s*\|\|\s*0)?\s*,?\s*\/\/\s*\[\d+\]\s*(.+)$/.exec(line);
                if (m && !descs[m[1]]) descs[m[1]] = m[2].trim();
            }
            descsVt = {};
            const vt = /static VS_TET = \{([\s\S]*?)\n    \};/.exec(src6);
            for (const line of (vt ? vt[1] : '').split('\n')) {
                const m = /^\s*(\w+):\s*-?[\d.]+\s*,?\s*\/\/\s*(.+)$/.exec(line);
                if (m) descsVt[m[1]] = m[2].trim();
            }
            return descs;
        });
    }

    // ── テト LV5/LV6 ─────────────────────────────
    // this.weights を手ごとに weightsArray へ組み直すので、書き換えれば次の思考から効く。
    // weightsArray に入らない項目（lv5 の underSpace/singleWell/multiWell、lv6 の tsdHolePenalty）と P1_WEIGHT（小数）は出さない
    const TET_SKIP = ['P1_WEIGHT', 'underSpace', 'singleWell', 'multiWell'];
    const isTetCpu = (cpu) => !!cpu && typeof cpu.applyBuildValues !== 'function' && !!cpu.weights
        && ((window.CPU5 && cpu instanceof window.CPU5) || (window.CPU6 && cpu instanceof window.CPU6));
    function wrapTet(cpu) {
        const lv = (window.CPU6 && cpu instanceof window.CPU6) ? 'LV6' : 'LV5';
        const skip = lv === 'LV6' ? TET_SKIP.concat('tsdHolePenalty') : TET_SKIP;
        const defaults = {};
        for (const k in cpu.weights) if (typeof cpu.weights[k] === 'number' && !skip.includes(k)) defaults[k] = cpu.weights[k];
        return {
            tet: true, real: cpu, lv,
            constructor: { WEIGHTS_ID: `tet-${lv.toLowerCase()}`, LOG_NAME: `TET ${lv}` },
            _defaultBuildBaseline: { rewardWeights: {}, evalWeights: defaults, controlWeights: {} },
            getBuildDefaults() { return Object.assign({}, defaults); },
            getBuildValues() { const o = {}; for (const k in defaults) o[k] = cpu.weights[k]; return o; },
            applyBuildValues(values) {
                const changed = {};
                for (const k in defaults) {
                    const v = k in values ? Math.round(Number(values[k])) : defaults[k];
                    if (!Number.isFinite(v)) continue;
                    cpu.weights[k] = v;
                    if (v !== defaults[k]) changed[k] = { from: defaults[k], to: v };
                }
                return changed;
            },
            getBuildPolicyArray() { return []; },
            getBuildPolicyNames() { return []; },
        };
    }
    // 説明は cpu5.js / cpu6.js の weights の行末コメントから
    const descsTet = {};
    function loadTetDescs(lv) {
        if (descsTet[lv]) return Promise.resolve(descsTet[lv]);
        const src = lv === 'LV6' ? 'cpu/tet/lv6/cpu6.js' : 'cpu/tet/lv5/cpu5.js';
        return fetch(src).then(r => r.text()).then(text => {
            const d = {};
            for (const line of text.split('\n')) {
                const m = /^\s*(\w+):\s*-?[\d.]+\s*,?\s*\/\/\s*(.+)$/.exec(line);
                if (m) d[m[1]] = m[2].replace(/^★[^\s]*\s*/, '').trim();
            }
            return (descsTet[lv] = d);
        }).catch(() => (descsTet[lv] = {}));
    }
    const descOf = (t, name) => (t && t.cpu.tet ? (descsTet[t.cpu.lv] || {})[name] : descs && descs[name]) || '';

    // ── 対象の CPU ───────────────────────────────
    // そのモードの既定・今の値・並べ分けを CPU から読み直す（lv5 は build の変更が対テトの既定にも響くので毎回）
    function syncModes(t) {
        const cpu = t.cpu;
        for (const m of Object.keys(t.st)) {
            const s = t.st[m];
            const grouped = hasModes(cpu) ? cpu.getModeDefaultsGrouped(m) : cpu._defaultBuildBaseline;
            s.defaults = Object.assign({}, grouped.rewardWeights, grouped.evalWeights, grouped.controlWeights);
            s.values = hasModes(cpu) ? cpu.getModeValues(m) : cpu.getBuildValues();
            s.groups = {};
            for (const k in grouped.rewardWeights) s.groups[k] = 'reward';
            for (const k in grouped.evalWeights) s.groups[k] = 'eval';
            for (const k in grouped.controlWeights) s.groups[k] = 'control';
            s.refs = cpu.tet ? { DEFAULT: s.defaults } : m === 'build'
                ? { LV5: cpu.getBuildDefaults('LV5'), LV6: cpu.getBuildDefaults('LV6') }
                : { DEFAULT: s.defaults };
        }
    }

    function applyMode(cpu, mode, values) {
        return mode === 'build' ? cpu.applyBuildValues(values) : cpu.applyModeValues(mode, values);
    }

    function makeTarget(slot, cpu) {
        cpu.getBuildDefaults();
        const modes = hasModes(cpu) ? MODES.map(m => m.id) : ['build'];
        const t = {
            slot, cpu,
            level: cpu.constructor.LOG_NAME || 'LV5',
            mode: 'build',
            st: {}, storedWarn: '',
        };
        for (const m of modes) t.st[m] = { changed: {} };
        // 相手がテトなら対テトの本線から見せる
        try { if (t.st.vsTet && cpu._isOpponentTet && cpu._isOpponentTet()) t.mode = 'vsTet'; } catch (_) { /* build のまま */ }
        // 保存してある変更を載せる（パネルを触らなくても効く＝見出しに CUSTOM と出す）。build を先に（lv5 は対テトの既定が build に乗る）
        const store = readStore();
        const warns = [];
        for (const m of modes) {
            const st = store[storeKey(t, m)];
            if (!st || !st.values || !Object.keys(st.values).length) continue;
            t.st[m].changed = applyMode(cpu, m, st.values);
            if (st.weightsId && st.weightsId !== cpu.constructor.WEIGHTS_ID) warns.push(`${MODE_LABEL[m]} は ${st.weightsId}`);
        }
        if (warns.length) t.storedWarn = `保存した変更は別の重みの版のときのもの（${warns.join('、')}。今は ${cpu.constructor.WEIGHTS_ID}）`;
        syncModes(t);
        return t;
    }

    // cpus: CPU 1つ（CPU TEST）か [{ slot: '1P'|'2P', cpu }]（CPU 同士）
    function attach(cpus) {
        detach();
        const list = Array.isArray(cpus) ? cpus : [{ slot: 'TEST', cpu: cpus }];
        targets = list
            .map(x => (x && isTetCpu(x.cpu) ? { slot: x.slot, cpu: wrapTet(x.cpu) } : x))
            .filter(x => x && x.cpu && typeof x.cpu.applyBuildValues === 'function')   // ぷよ LV5/LV6・テト LV5/LV6 だけ
            .map(x => makeTarget(x.slot, x.cpu));
        if (!targets.length) return;
        cur = Math.min(cur, targets.length - 1);
        buildDom();
        loadDescs().then(() => { if (dock) showInfo(); });
        targets.filter(x => x.cpu.tet).forEach(x => loadTetDescs(x.cpu.lv).then(() => { if (dock) { showInfo(); applyFilter(); } }));
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
        cells = {}; roCells = {}; sections = {};
        focusName = hoverName = null;
    }

    // コントローラを作り直したとき（ウォッチドッグ・盤面入れ替え）、その枠の値を新しい CPU に載せ直す
    function replace(oldCpu, newCpu) {
        const t = targets.find(x => x.cpu === oldCpu);
        if (!t || !newCpu || typeof newCpu.applyBuildValues !== 'function') return;
        newCpu.getBuildDefaults();
        for (const m of Object.keys(t.st)) {
            const diff = {};
            for (const k in t.st[m].changed) diff[k] = t.st[m].changed[k].to;
            if (Object.keys(diff).length && (m === 'build' || hasModes(newCpu))) t.st[m].changed = applyMode(newCpu, m, diff);
        }
        t.cpu = newCpu;
        syncModes(t);
    }

    // ── 適用 ─────────────────────────────────────
    function apply(next) {
        const t = T();
        if (!t) return;
        t.st[t.mode].changed = applyMode(t.cpu, t.mode, next);
        syncModes(t);
        writeStore(t, t.mode);
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
                if (a && a.classList && a.classList.contains('cwp-input') && S() && a.dataset.name in S().values) a.value = String(S().values[a.dataset.name]);
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
                const b = button('', () => { cur = i; focusName = null; buildList(); refreshAll(); });
                b.dataset.idx = String(i);
                tabsEl.appendChild(b);
            });
            body.appendChild(tabsEl);
        }

        // 対象のモード（● はいま CPU が使っているモード）
        modesEl = el('div', 'cwp-tabs cwp-modes');
        for (const m of MODES) {
            const b = button(m.label, () => {
                const t = T();
                if (!t || !t.st[m.id]) return;
                t.mode = m.id;
                focusName = null;
                buildList();
                refreshAll();
            });
            b.dataset.mode = m.id;
            modesEl.appendChild(b);
        }
        body.appendChild(modesEl);

        metaEl = el('div', 'cwp-meta');
        body.appendChild(metaEl);
        warnEl = el('div', 'cwp-warn');
        body.appendChild(warnEl);

        const actions = el('div', 'cwp-actions');
        for (const lv of ['LV5', 'LV6', 'DEFAULT']) {
            const b = button(lv, () => { const r = S() && S().refs[lv]; if (r) apply(Object.assign({}, r)); });
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
        importText.placeholder = '学習の best.json をそのまま、または { "名前": 値 } を貼る（対テトは { "名前": 値 } だけ）';
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
        listEl = el('div', 'cwp-list');
        body.appendChild(listEl);
        buildList();

        // 説明欄（選んでいる項目の説明・LV5/LV6 の値）
        infoEl = el('div', 'cwp-info');
        body.appendChild(infoEl);

        document.body.appendChild(dock);
        document.body.classList.toggle('cwp-on', !ui.min);   // 盤面を左へ寄せて右端を空ける（CSS）
        refreshAll();
    }

    // 項目の一覧（モード・枠を切り替えたら作り直す）
    function buildList() {
        const t = T(), s = S();
        if (!listEl || !t) return;
        listEl.innerHTML = '';
        cells = {}; roCells = {}; sections = {};
        const groups = s.groups;
        const all = Object.keys(groups);
        const used = new Set();
        const pick = (names) => names.filter(k => groups[k] && !used.has(k) && used.add(k));
        const buildNames = t.st.build.groups;
        // 対テトだけの項目（§15・§17 など、build の既定に名前の無いもの）は分けて先に出す
        const vtOnly  = t.mode === 'build' ? [] : pick(all.filter(k => !buildNames[k]));
        const control = pick(CONTROL_ORDER.concat(all.filter(k => groups[k] === 'control' && !VERSUS_ONLY.includes(k) && !FIXED.includes(k))));
        const vsOnly  = pick(VERSUS_ONLY);
        const fixed   = pick(FIXED);
        const evals   = pick(all.filter(k => groups[k] === 'eval'));
        const reward  = pick(all.filter(k => groups[k] === 'reward'));
        const add = (title, names) => { if (names.length) listEl.appendChild(section(title, names)); };
        add('CONTROL', control);
        if (vtOnly.length) listEl.appendChild(section('VS TET ONLY', vtOnly));
        add('EVAL', evals);
        add('REWARD', reward);
        add('VERSUS ONLY', vsOnly);
        add('FIXED', fixed);
        // VS_TET の判断の値（重みでないもの。表示だけ）
        const vt = t.mode !== 'build' && t.cpu._vsTet;
        if (vt) {
            const names = Object.keys(vt).filter(k => typeof vt[k] === 'number');
            if (names.length) listEl.appendChild(section('DECISION', names, vt));
        }
        if (filterInput) applyFilter();
    }

    // ro: 表示だけの値（名前→値）。渡したときは入力欄を読み取り専用にする
    function section(title, names, ro) {
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
        for (const k of names) grid.appendChild(ro ? roCell(k, ro[k]) : cell(k));
        s.appendChild(grid);
        s.classList.toggle('is-collapsed', !!ui.collapsed[title]);
        sections[title] = { el: s, head: h, names: ro ? [] : names };
        return s;
    }

    function hoverable(c, name) {
        c.addEventListener('mouseenter', () => { hoverName = name; showInfo(); });
        c.addEventListener('mouseleave', () => { if (hoverName === name) { hoverName = null; showInfo(); } });
    }

    function roCell(name, value) {
        const c = el('label', 'cwp-cell is-ro');
        c.appendChild(el('span', 'cwp-name', name));
        const input = el('input', 'cwp-input');
        input.type = 'text';
        input.readOnly = true;
        input.tabIndex = -1;
        input.value = String(value);
        hoverable(c, name);
        c.appendChild(input);
        roCells[name] = { cell: c, input, value };
        return c;
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
            const v = parseInt(input.value, 10);
            const base = Number.isFinite(v) ? v : S().values[name];
            input.value = String(base + (e.key === 'ArrowUp' ? 1 : -1) * stepOf(name, e.shiftKey));
            clearTimeout(pendingCommit[name]);
            pendingCommit[name] = setTimeout(() => commit(name), 350);
        });
        hoverable(c, name);
        c.appendChild(input);
        cells[name] = { cell: c, input };
        return c;
    }

    // ↑↓ の刻み：既定値の桁に合わせる（12 なら 1、-500 なら 10、180800 なら 10000）。Shift で 1
    function stepOf(name, fine) {
        if (fine) return 1;
        const s = S();
        const mag = Math.max(Math.abs(s.defaults[name] || 0), Math.abs(s.values[name] || 0));
        if (mag < 100) return 1;
        return Math.pow(10, Math.floor(Math.log10(mag)) - 1);
    }

    function commit(name) {
        clearTimeout(pendingCommit[name]);
        delete pendingCommit[name];
        const c = cells[name], s = S();
        if (!c || !s) return;
        const v = Number(c.input.value.trim());
        if (!Number.isFinite(v) || Math.round(v) === s.values[name]) { c.input.value = String(s.values[name]); return; }
        apply(Object.assign({}, s.values, { [name]: Math.round(v) }));
    }

    function applyFilter() {
        const q = filterInput.value.trim().toLowerCase();
        const hit = (k, d) => !q || k.toLowerCase().includes(q) || d.includes(filterInput.value.trim());
        for (const k in cells) cells[k].cell.style.display = hit(k, descOf(T(), k)) ? '' : 'none';
        for (const k in roCells) roCells[k].cell.style.display = hit(k, (descsVt && descsVt[k]) || '') ? '' : 'none';
        // 絞り込み中は畳んだセクションも開いて見せる
        for (const s in sections) sections[s].el.classList.toggle('is-filtering', !!q);
    }

    function showInfo() {
        const t = T(), s = S();
        if (!infoEl || !t) return;
        const name = focusName || hoverName;
        infoEl.innerHTML = '';
        if (!name) {
            infoEl.appendChild(el('div', 'cwp-info-desc',
                '値は次の思考から効く（先読み済みの手があればその次から。効いた手は思考ログに出る）。' +
                '↑↓ で増減、Shift+↑↓ で 1 ずつ。Enter で確定、Esc で入力欄から抜ける。' +
                (t.mode === 'build' ? '' : 'ここで変えた値は、CPU がこのモードのときだけ効く（● が今のモード）。')));
            return;
        }
        infoEl.appendChild(el('div', 'cwp-info-name', name));
        if (roCells[name]) {
            const d = (descsVt && descsVt[name]) || '';
            infoEl.appendChild(el('div', 'cwp-info-desc', `${d}${d ? '。' : ''}表示だけ（cpu6.js の VS_TET で変える）`));
            infoEl.appendChild(el('div', 'cwp-info-refs', `NOW ${roCells[name].value}`));
            return;
        }
        const d = descOf(t, name);
        let note = '';
        if (VERSUS_ONLY.includes(name)) {
            if (t.mode !== 'build') note = '（相手がぷよのときだけ効く＝対テトでは効かない）';
            else note = t.slot === 'TEST' ? '（VERSUS で相手がぷよのときだけ効く＝ここでは効かない）' : '（相手がぷよのときだけ効く）';
        }
        if (t.mode === 'fastVsTet' && COUNTER_SET.includes(name)) note += '（カウンター中は受け量から毎手決め直す＝ここの値は効かない）';
        if (d || note) infoEl.appendChild(el('div', 'cwp-info-desc', d + note));
        const refs = el('div', 'cwp-info-refs');
        const parts = [`NOW ${s.values[name]}`, `DEFAULT ${s.defaults[name]}`];
        if (t.mode === 'build') {
            for (const lv of ['LV5', 'LV6']) if (s.refs[lv]) parts.push(`${lv} ${s.refs[lv][name]}`);
        } else if (name in t.st.build.values) {
            parts.push(`BUILD ${t.st.build.values[name]}`);
        }
        refs.textContent = parts.join(' · ');
        infoEl.appendChild(refs);
    }

    function refreshAll() {
        const t = T(), s = S();
        if (!dock || !t) return;
        for (const k in cells) {
            const c = cells[k];
            if (document.activeElement !== c.input && !pendingCommit[k]) c.input.value = String(s.values[k]);
            c.cell.classList.toggle('is-changed', s.values[k] !== s.defaults[k]);
        }
        for (const n in sections) {
            const c = sections[n].names.filter(k => s.values[k] !== s.defaults[k]).length;
            sections[n].head.textContent = `${n}${c ? ` · ${c}` : ''}`;
            sections[n].head.classList.toggle('is-changed', c > 0);
        }
        dock.querySelectorAll('.cwp-btn[data-ref]').forEach(b => {
            const lv = b.dataset.ref;
            const shown = Object.prototype.hasOwnProperty.call(s.refs, lv);
            const ref = s.refs[lv];
            b.style.display = shown ? '' : 'none';
            b.disabled = !ref;
            b.title = !ref ? 'LV6 を一度読み込むと使える' : lv === 'DEFAULT' ? `${MODE_LABEL[t.mode]} の既定の値に戻す` : `${lv} の値に戻す`;
            b.classList.toggle('is-active', !!ref && Object.keys(s.values).every(k => s.values[k] === ref[k]));
        });
        tabsEl.querySelectorAll('.cwp-btn').forEach(b => {
            const x = targets[+b.dataset.idx];
            const n = countChanged(x);
            b.textContent = `${x.slot} ${x.level}${n ? ' · ' + n : ''}`;
            b.classList.toggle('is-active', x === t);
        });
        modesEl.querySelectorAll('.cwp-btn').forEach(b => {
            const m = b.dataset.mode;
            const n = t.st[m] ? Object.keys(t.st[m].changed).length : 0;
            b.style.display = t.st[m] ? '' : 'none';
            b.textContent = `${MODE_LABEL[m]}${n ? ' · ' + n : ''}`;
            b.classList.toggle('is-active', m === t.mode);
        });
        metaEl.textContent = `${t.slot === 'TEST' ? '' : t.slot + ' · '}${t.level} · ${t.cpu.constructor.WEIGHTS_ID} · ${MODE_LABEL[t.mode]}`;
        warnEl.textContent = t.storedWarn;
        warnEl.style.display = t.storedWarn ? '' : 'none';
        showInfo();
        refreshStatus();
    }

    function refreshStatus() {
        const t = T();
        if (!t || !statusEl) return;
        const cpu = t.cpu;
        const n = countChanged(t);
        let applied = '';
        if ((cpu._weightsRev || 0) !== (cpu._sentWeightsRev || 0)) applied = 'PENDING';
        else if (cpu._weightsAppliedTurn) applied = `FROM #${cpu._weightsAppliedTurn}`;
        statusEl.textContent = `${n ? `CUSTOM ${n}` : 'DEFAULT'}${applied ? ' · ' + applied : ''}${cpu.tet ? '' : ` · NOW #${cpu._turnNo || 0}`}`;
        statusEl.classList.toggle('is-custom', targets.some(x => countChanged(x) > 0));
        // いま CPU が使っているモードに印（対ぷよ・ソロは build、対テトは vsTet / カウンター中は fastVsTet）
        if (modesEl) modesEl.querySelectorAll('.cwp-btn').forEach(b => {
            const live = b.dataset.mode === cpu.cpuMode;
            b.classList.toggle('is-live', live);
            b.title = live ? 'いま CPU が使っているモード' : '';
        });
    }

    function say(text, isError) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.classList.toggle('is-error', !!isError);
    }

    // ── JSON ────────────────────────────────────
    function exportJson(t) {
        const s = t.st[t.mode];
        const out = {
            slot: t.slot,
            level: t.level,
            weightsId: t.cpu.constructor.WEIGHTS_ID,
            mode: t.mode,
        };
        if (t.mode === 'build') out.policy = { build: t.cpu.getBuildPolicyArray() };
        out.named = Object.assign({}, s.values);
        out.changed = JSON.parse(JSON.stringify(s.changed));
        return out;
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
            navigator.clipboard.writeText(text).then(() => say(`COPIED: ${t.slot === 'TEST' ? '' : t.slot + ' '}${t.level} ${MODE_LABEL[t.mode]} の JSON（既定と違う ${Object.keys(t.st[t.mode].changed).length} 件）`), fallback);
        } else {
            fallback();
        }
    }

    function doImport() {
        const t = T(), s = S();
        if (!t) return;
        let obj;
        try { obj = JSON.parse(importText.value); } catch (e) { say('JSON として読めない: ' + e.message, true); return; }
        const incoming = {};
        const arr = (obj && obj.policy && Array.isArray(obj.policy.build)) ? obj.policy.build
                  : (obj && Array.isArray(obj.build)) ? obj.build
                  : Array.isArray(obj) ? obj : null;
        let unknown = 0;
        if (arr && t.mode !== 'build' && !(obj && obj.named)) { say('policy.build の並びは BUILD のときだけ読める（対テトは { "名前": 値 }）', true); return; }
        if (arr && t.mode === 'build') {
            const names = t.cpu.getBuildPolicyNames();
            if (arr.length !== names.length) { say(`policy.build の長さが ${arr.length}（${names.length} を想定）`, true); return; }
            arr.forEach((v, i) => { if (names[i]) incoming[names[i]] = v; });
        } else if (obj && typeof obj === 'object') {
            const src = (obj.named && typeof obj.named === 'object') ? obj.named : obj;
            for (const k in src) {
                if (s.groups[k] && typeof src[k] === 'number') incoming[k] = src[k];
                else unknown++;
            }
        }
        const n = Object.keys(incoming).length;
        if (!n) { say('読める重みが無い（policy.build か { "名前": 値 }）', true); return; }
        apply(Object.assign({}, s.values, incoming));
        importBox.classList.remove('is-open');
        importText.value = '';
        const notes = [];
        if (unknown) notes.push(`知らない項目 ${unknown} 件は無視`);
        if (obj && obj.policy && (obj.policy.counterTrigger != null || obj.policy.ext)) notes.push('counterTrigger / counterMargin / ext は読まない');
        if (obj && obj.mode && obj.mode !== t.mode) notes.push(`${MODE_LABEL[obj.mode] || obj.mode} の JSON を ${MODE_LABEL[t.mode]} に読んだ`);
        say(`IMPORTED: ${n} 件（既定と違う ${Object.keys(S().changed).length} 件）${notes.length ? '。' + notes.join('、') : ''}`);
    }

    return {
        attach, detach, replace,
        exportJson: () => (T() ? exportJson(T()) : null),
        select: (i) => { if (targets[i]) { cur = i; buildList(); refreshAll(); } },
        setMode: (m) => { const t = T(); if (t && t.st[m]) { t.mode = m; buildList(); refreshAll(); } },
    };
})();
