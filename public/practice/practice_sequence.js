// ─────────────────────────────────────────────
// practice_sequence.js
// PRACTICEモードのツモ順設定（Phase 3 §7）
//
// 設計: source_assets/memory/tetlabo-practice-mode-design.md §7
//   ・モデル: bags[1〜10] × order('loop'|'random')。枠は確定値または'?'（一様ランダム）
//   ・tet: バッグ長 1〜10（値=ミノ種別0-6） / puyo: バッグ長 1〜25（値=[上色,下色]、色1〜5）
//   ・重複・欠けを許す。'?'だけの1バッグ・random で完全ランダムと等価
//   ・巻き戻し対象（カスタム列＋消費位置）。RULEを切り替えても他方の列は消えない
//
// このファイルは3つの役割を持つ:
//   1) PracticeSequence: ランタイムの消費ロジック（getNextType/_makePair のフック先）
//   2) 準備画面（mode-check-page）のSEQUENCE行・エディタモーダルのUI
//   3) 編集操作（バッグ数/長さ/枠の値/order の変更）
// ─────────────────────────────────────────────

const PracticeSequence = (() => {
    const TET_TYPES = ['I', 'O', 'T', 'J', 'L', 'S', 'Z'];       // index 0-6
    const PUYO_COLOR_LABELS = { 1: 'R', 2: 'B', 3: 'P', 4: 'G', 5: 'Y' };
    const PUYO_COLOR_LIST = [1, 2, 3, 4, 5];

    const BAG_COUNT_MAX = 10;
    const BAG_LEN_MAX = { tet: 10, puyo: 25 };

    function config(rule) {
        if (typeof practiceSequence === 'undefined') return null;
        return practiceSequence[rule];
    }

    // ══════════════════════════════════════════════
    // ランタイム：バッグ列の消費（PracticeManager.attach() から使う）
    // ══════════════════════════════════════════════

    function shuffleInPlace(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    }

    // 巻き戻しで復元できるよう、状態は {bagOrder, bagPos, itemPos} という素の値だけで持つ
    function createRunner(seqConfig) {
        const bagOrder = seqConfig.bags.map((_, i) => i);
        if (seqConfig.order === 'random') shuffleInPlace(bagOrder);
        return { bagOrder, bagPos: 0, itemPos: 0 };
    }

    function cloneRunnerState(runner) {
        return { bagOrder: runner.bagOrder.slice(), bagPos: runner.bagPos, itemPos: runner.itemPos };
    }

    function applyRunnerState(runner, state) {
        runner.bagOrder = state.bagOrder.slice();
        runner.bagPos = state.bagPos;
        runner.itemPos = state.itemPos;
    }

    // 現在位置の枠を読んでから、次の位置へポインタを進める
    function _advance(runner, seqConfig) {
        const bag = seqConfig.bags[runner.bagOrder[runner.bagPos]];
        runner.itemPos++;
        if (runner.itemPos >= bag.items.length) {
            runner.itemPos = 0;
            runner.bagPos++;
            if (runner.bagPos >= runner.bagOrder.length) {
                runner.bagPos = 0;
                if (seqConfig.order === 'random') shuffleInPlace(runner.bagOrder);
            }
        }
    }

    function nextTetType(seqConfig, runner) {
        if (!seqConfig || !seqConfig.bags.length) return Math.floor(Math.random() * 7);
        const bag = seqConfig.bags[runner.bagOrder[runner.bagPos]];
        if (!bag || !bag.items.length) return Math.floor(Math.random() * 7);
        const slot = bag.items[runner.itemPos];
        _advance(runner, seqConfig);
        return (slot === null || slot === undefined) ? Math.floor(Math.random() * 7) : slot;
    }

    // 呼び出し側の activeColors から'?'を一様抽選する。戻り値 null は「バッグが無い＝通常生成にフォールバック」の合図
    function nextPuyoPair(seqConfig, runner, activeColors) {
        if (!seqConfig || !seqConfig.bags.length) return null;
        const bag = seqConfig.bags[runner.bagOrder[runner.bagPos]];
        if (!bag || !bag.items.length) return null;
        const pairSlot = bag.items[runner.itemPos];
        _advance(runner, seqConfig);
        const colors = (activeColors && activeColors.length) ? activeColors : PUYO_COLOR_LIST;
        const resolve = (v) => (v === null || v === undefined) ? colors[Math.floor(Math.random() * colors.length)] : v;
        return [resolve(pairSlot[0]), resolve(pairSlot[1])];
    }

    // カスタム列で使われている色の集合（'?'は含まない）。§7.5の色数自動引き上げ用
    function usedPuyoColors(seqConfig) {
        const s = new Set();
        if (!seqConfig) return s;
        seqConfig.bags.forEach(b => b.items.forEach(pair => {
            if (pair[0] !== null && pair[0] !== undefined) s.add(pair[0]);
            if (pair[1] !== null && pair[1] !== undefined) s.add(pair[1]);
        }));
        return s;
    }

    // ══════════════════════════════════════════════
    // 編集操作（準備画面のエディタから呼ぶ）
    // ══════════════════════════════════════════════

    function isEnabled(rule) {
        const c = config(rule);
        return !!(c && c.enabled);
    }

    function setEnabled(rule, on) {
        const c = config(rule);
        if (!c) return;
        c.enabled = on;
    }

    function setOrder(rule, order) {
        const c = config(rule);
        if (!c) return;
        c.order = (order === 'random') ? 'random' : 'loop';
    }

    function defaultItems(rule) {
        return (rule === 'puyo') ? [null, null] : null;
    }

    function setBagCount(rule, n) {
        const c = config(rule);
        if (!c) return;
        n = Math.max(1, Math.min(BAG_COUNT_MAX, n));
        while (c.bags.length < n) {
            const lastLen = c.bags.length ? c.bags[c.bags.length - 1].items.length : 1;
            c.bags.push({ items: new Array(lastLen).fill(null).map(() => defaultItems(rule)) });
        }
        while (c.bags.length > n) c.bags.pop();
    }

    function setBagLength(rule, bagIndex, len) {
        const c = config(rule);
        if (!c || !c.bags[bagIndex]) return;
        const max = BAG_LEN_MAX[rule];
        len = Math.max(1, Math.min(max, len));
        const items = c.bags[bagIndex].items;
        while (items.length < len) items.push(defaultItems(rule));
        while (items.length > len) items.pop();
    }

    // tet: value は 0-6 の整数 または null('?')
    function setTetSlot(rule, bagIndex, slotIndex, value) {
        const c = config('tet');
        if (!c || !c.bags[bagIndex]) return;
        c.bags[bagIndex].items[slotIndex] = value;
    }

    // puyo: row は 0(上)/1(下)、value は 1-5 または null('?')
    function setPuyoSlot(bagIndex, slotIndex, row, value) {
        const c = config('puyo');
        if (!c || !c.bags[bagIndex]) return;
        c.bags[bagIndex].items[slotIndex][row] = value;
    }

    // ══════════════════════════════════════════════
    // 準備画面のUI（SEQUENCE行はpractice.jsが描画、エディタ本体はここ）
    // ══════════════════════════════════════════════

    // グリッドの1枠を巡回する現在フォーカス。null=編集モードでない
    let editor = null; // { rule, section: 'bagcount'|'bagindex'|'length'|'order'|'slots', flatIndex, editingSlots }
    let keyHandler = null;

    function _sectionOrder() { return ['bagcount', 'bagindex', 'length', 'order', 'slots']; }

    function labelForSlot(rule, value) {
        if (value === null || value === undefined) return '?';
        return (rule === 'tet') ? TET_TYPES[value] : PUYO_COLOR_LABELS[value];
    }

    // slots を「行優先」でフラット化した個数（tet: バッグ長 / puyo: バッグ長×2）
    function _flatCount(rule, bag) {
        return (rule === 'puyo') ? bag.items.length * 2 : bag.items.length;
    }
    function _flatGet(rule, bag, flatIndex) {
        if (rule === 'tet') return bag.items[flatIndex];
        const len = bag.items.length;
        const row = flatIndex < len ? 0 : 1;
        const col = flatIndex < len ? flatIndex : flatIndex - len;
        return bag.items[col][row];
    }
    function _flatSet(rule, bagIndex, bag, flatIndex, value) {
        if (rule === 'tet') { setTetSlot(rule, bagIndex, flatIndex, value); return; }
        const len = bag.items.length;
        const row = flatIndex < len ? 0 : 1;
        const col = flatIndex < len ? flatIndex : flatIndex - len;
        setPuyoSlot(bagIndex, col, row, value);
    }

    function openEditor(rule) {
        if (!config(rule)) return;
        editor = { rule, section: 'bagcount', bagIndex: 0, flatIndex: 0, editingSlots: false };
        const modal = document.getElementById('practice-seq-modal');
        if (modal) modal.classList.add('active');
        if (window.FocusNav) window.FocusNav.suspended = true;
        _installKeyHandler();
        _render();
    }

    function closeEditor() {
        if (!editor) return; // 未オープン時は何もしない（switchPage毎に呼ばれるため）
        editor = null;
        const modal = document.getElementById('practice-seq-modal');
        if (modal) modal.classList.remove('active');
        if (window.FocusNav) window.FocusNav.suspended = false;
        _removeKeyHandler();
        if (typeof renderModeCheck === 'function') renderModeCheck();
    }

    function _installKeyHandler() {
        _removeKeyHandler();
        keyHandler = (e) => {
            if (!editor) return;
            let handled = true;
            if (editor.editingSlots) {
                handled = _handleSlotKey(e);
            } else {
                handled = _handleSectionKey(e);
            }
            if (handled) { e.preventDefault(); e.stopImmediatePropagation(); _render(); }
        };
        document.addEventListener('keydown', keyHandler, true);
    }
    function _removeKeyHandler() {
        if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
    }

    function _currentBag() {
        const c = config(editor.rule);
        return c.bags[Math.min(editor.bagIndex || 0, c.bags.length - 1)];
    }

    function _handleSectionKey(e) {
        const sections = _sectionOrder();
        const c = config(editor.rule);
        const bagIndex = editor.bagIndex || 0;
        if (e.key === 'Escape') { closeEditor(); return true; }
        if (e.key === 'ArrowUp') {
            const i = sections.indexOf(editor.section);
            editor.section = sections[(i - 1 + sections.length) % sections.length];
            return true;
        }
        if (e.key === 'ArrowDown') {
            const i = sections.indexOf(editor.section);
            editor.section = sections[(i + 1) % sections.length];
            return true;
        }
        if (editor.section === 'bagcount') {
            if (e.key === 'ArrowLeft')  { setBagCount(editor.rule, c.bags.length - 1); if (bagIndex >= c.bags.length) editor.bagIndex = c.bags.length - 1; return true; }
            if (e.key === 'ArrowRight') { setBagCount(editor.rule, c.bags.length + 1); return true; }
        } else if (editor.section === 'bagindex') {
            if (e.key === 'ArrowLeft')  { editor.bagIndex = (bagIndex - 1 + c.bags.length) % c.bags.length; return true; }
            if (e.key === 'ArrowRight') { editor.bagIndex = (bagIndex + 1) % c.bags.length; return true; }
        } else if (editor.section === 'length') {
            const bag = c.bags[bagIndex];
            if (e.key === 'ArrowLeft')  { setBagLength(editor.rule, bagIndex, bag.items.length - 1); return true; }
            if (e.key === 'ArrowRight') { setBagLength(editor.rule, bagIndex, bag.items.length + 1); return true; }
        } else if (editor.section === 'order') {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter') {
                setOrder(editor.rule, c.order === 'loop' ? 'random' : 'loop');
                return true;
            }
        } else if (editor.section === 'slots') {
            if (e.key === 'Enter') { editor.editingSlots = true; editor.flatIndex = 0; return true; }
        }
        return false;
    }

    function _handleSlotKey(e) {
        const bagIndex = editor.bagIndex || 0;
        const bag = _currentBag();
        const count = _flatCount(editor.rule, bag);
        if (e.key === 'Escape' || e.key === 'Enter') { editor.editingSlots = false; return true; }
        if (e.key === 'ArrowLeft')  { editor.flatIndex = (editor.flatIndex - 1 + count) % count; return true; }
        if (e.key === 'ArrowRight') { editor.flatIndex = (editor.flatIndex + 1) % count; return true; }
        const maxVal = (editor.rule === 'tet') ? 6 : 5;
        const minVal = (editor.rule === 'tet') ? 0 : 1;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const cur = _flatGet(editor.rule, bag, editor.flatIndex);
            let nextVal;
            if (cur === null || cur === undefined) {
                nextVal = (e.key === 'ArrowUp') ? minVal : maxVal;
            } else {
                nextVal = cur + (e.key === 'ArrowUp' ? 1 : -1);
                if (nextVal > maxVal) nextVal = null;
                else if (nextVal < minVal) nextVal = null;
            }
            _flatSet(editor.rule, bagIndex, bag, editor.flatIndex, nextVal);
            return true;
        }
        if (e.key === '0') { _flatSet(editor.rule, bagIndex, bag, editor.flatIndex, null); editor.flatIndex = (editor.flatIndex + 1) % count; return true; }
        if (e.key >= '1' && e.key <= '9') {
            const n = parseInt(e.key, 10);
            const value = (editor.rule === 'tet') ? (n - 1) : n; // tet: 1-7→0-6 / puyo: 1-5→1-5
            if (value >= minVal && value <= maxVal) {
                _flatSet(editor.rule, bagIndex, bag, editor.flatIndex, value);
                editor.flatIndex = (editor.flatIndex + 1) % count;
                return true;
            }
        }
        return false;
    }

    // クリックで直接その枠へ移動＋編集モードに入る
    function focusSlot(flatIndex) {
        if (!editor) return;
        editor.editingSlots = true;
        editor.flatIndex = flatIndex;
        _render();
    }
    function setSection(section) {
        if (!editor) return;
        editor.editingSlots = false;
        editor.section = section;
        _render();
    }

    function _render() {
        const body = document.getElementById('practice-seq-modal-body');
        if (!body || !editor) return;
        const c = config(editor.rule);
        const bagIndex = editor.bagIndex || 0;
        const bag = c.bags[bagIndex];
        const cls = (sec) => (!editor.editingSlots && editor.section === sec) ? ' is-focused' : '';

        const stepRow = (sec, label, value, note) => `
          <div class="option-row practice-seq-row${cls(sec)}" onclick="PracticeSequence.setSection('${sec}')">
            <span class="option-label">${label}</span>
            <span class="practice-seq-value">${value}${note ? `<span class="practice-seq-note">${note}</span>` : ''}</span>
          </div>`;

        let html = '';
        html += stepRow('bagcount', 'BAGS', c.bags.length, ' (←→)');
        html += stepRow('bagindex', 'BAG', (bagIndex + 1) + ' / ' + c.bags.length, ' (←→)');
        html += stepRow('length', 'LENGTH', bag.items.length, ' (←→)');
        html += `
          <div class="option-row practice-seq-row${cls('order')}" onclick="PracticeSequence.setSection('order')">
            <span class="option-label">ORDER</span>
            <div class="option-toggle">
              <button class="opt-btn ${c.order === 'loop' ? 'active' : ''}" onclick="event.stopPropagation();PracticeSequence.setOrderAndRender('${editor.rule}','loop')">LOOP</button>
              <button class="opt-btn ${c.order === 'random' ? 'active' : ''}" onclick="event.stopPropagation();PracticeSequence.setOrderAndRender('${editor.rule}','random')">RANDOM</button>
            </div>
          </div>`;

        // スロットグリッド（tet: 1行 / puyo: 上下2行）
        const rows = (editor.rule === 'puyo') ? 2 : 1;
        let slotsHtml = '';
        for (let r = 0; r < rows; r++) {
            slotsHtml += '<div class="practice-seq-slot-row">';
            for (let col = 0; col < bag.items.length; col++) {
                const flatIndex = r * bag.items.length + col;
                const value = _flatGet(editor.rule, bag, flatIndex);
                const focused = editor.editingSlots && editor.flatIndex === flatIndex;
                slotsHtml += `<span class="practice-seq-slot${focused ? ' is-focused' : ''}" onclick="PracticeSequence.focusSlot(${flatIndex})">${labelForSlot(editor.rule, value)}</span>`;
            }
            slotsHtml += '</div>';
        }
        html += `
          <div class="option-row practice-seq-row practice-seq-slots-row${cls('slots')}">
            <span class="option-label">SLOTS</span>
            <div class="practice-seq-slots">${slotsHtml}</div>
          </div>`;

        const hint = editor.editingSlots
            ? '0-9で入力(0=?) / ←→で移動 / ↑↓で増減 / Enter・Escで抜ける'
            : '↑↓で項目移動 / ←→で値変更 / SLOTSでEnterして枠を編集 / Escで閉じる';
        html += `<p class="practice-value-hint" style="text-align:center;margin-top:8px;">${hint}</p>`;

        body.innerHTML = html;
    }

    function setOrderAndRender(rule, order) {
        setOrder(rule, order);
        _render();
    }

    return {
        // ランタイム
        createRunner, cloneRunnerState, applyRunnerState, nextTetType, nextPuyoPair, usedPuyoColors,
        // 状態参照
        isEnabled, setEnabled,
        config,
        // エディタ
        openEditor, closeEditor, focusSlot, setSection, setOrderAndRender,
    };
})();

// 準備画面（mode-check）の SEQUENCE 行から呼ばれる
function setPracticeSequenceEnabled(on) {
    PracticeSequence.setEnabled(practiceRule, on);
    renderModeCheck();
}
function openPracticeSequenceEditor() {
    PracticeSequence.openEditor(practiceRule);
}
