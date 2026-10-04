// ─────────────────────────────────────────────
// main.ts
// クイズエディタ本体（状態管理・Undo・各パネルの描画とイベント）
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-design.md
// ─────────────────────────────────────────────
import {
    type Rule, type EditorDoc, type Pair, type Issue,
    MINO_LETTERS, TET_GARBAGE, PUYO_OJAMA,
    cols, rows, maxColorId, newDoc, cloneDoc, docFromLevel, emptyField,
    condDefs, countDefs, findCondDef, findCountDef, autoCondDescription,
    serializeLevel, parseLevelsText, validate,
    nextToText, textToNext, pairsToText, textToPairs, randomBag,
} from './model.ts';
import {
    loadImages, drawField, fieldCellSize, drawCellSwatch, drawMinoCentered, drawPairCentered,
} from './render.ts';
import { KEY_HELP, isTextInput, isMod } from './keys.ts';
import { PlaceMode, buildStampGrid, type PlaceSub } from './place.ts';
import { loadPlaceBinds, bindLabel, sourceLabel, PLACE_ACTIONS, ACTION_NAMES } from './keybinds.ts';
import { type SolutionMap, fetchSolutions, saveSolution, canWriteFiles, today, SOLUTION_PATH } from './solutions.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ─────────────────────────────────────────────
// 状態
// ─────────────────────────────────────────────
type LevelRaw = Record<string, unknown>;
const levels: Record<Rule, LevelRaw[]> = { tet: [], puyo: [] };

let doc: EditorDoc = newDoc('tet');
let sourceId: string | null = null;   // 既存問題から開いた場合の元 id（重複判定の除外・番号算出に使う）
let cleanSnap = '';                    // 最後に開いた/新規作成した時点（未保存変更の確認用）

const ui = {
    selColor: 1,
    rowMode: false,
    cursor: { r: 0, c: 0 },
    hover: null as { r: number; c: number } | null,
    nextCaret: 0,
    pendingPuyo: 0,                    // puyo NEXT 入力の1色目（0=なし）
    preview: 'play' as 'play' | 'select',
    mode: 'paint' as 'paint' | 'place',
};

// ─── Undo / Redo（EditorDoc 丸ごとのスナップショット） ───
const undoStack: string[] = [];
const redoStack: string[] = [];
let lastCommit = { key: '', t: 0 };

function snap(): string { return JSON.stringify({ doc, sourceId }); }
function restore(s: string) {
    const o = JSON.parse(s) as { doc: EditorDoc; sourceId: string | null };
    doc = o.doc; sourceId = o.sourceId;
}

/**
 * 変更を1つ記録して反映する。
 * coalesceKey が直前と同じ変更はまとめて1回の Undo にする
 * （テキスト入力は1.5秒以内、`stroke:` で始まるキー＝ドラッグ塗りは時間無制限）
 */
function commit(mutate: () => void, coalesceKey = '') {
    const now = Date.now();
    const same = coalesceKey !== '' && coalesceKey === lastCommit.key &&
        (coalesceKey.startsWith('stroke:') || now - lastCommit.t < 1500);
    if (!same) {
        undoStack.push(snap());
        if (undoStack.length > 300) undoStack.shift();
        redoStack.length = 0;
    }
    lastCommit = { key: coalesceKey, t: now };
    mutate();
    if (doc.cond.descriptionAuto) doc.cond.description = autoCondDescription(doc.rule, doc.cond);
    renderAll();
}

function undo() {
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push(snap());
    restore(s);
    lastCommit = { key: '', t: 0 };
    afterDocReplaced();
}
function redo() {
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push(snap());
    restore(s);
    lastCommit = { key: '', t: 0 };
    afterDocReplaced();
}

/** doc を丸ごと差し替えた後の UI 状態の整合 */
function afterDocReplaced() {
    ui.cursor.r = Math.min(ui.cursor.r, rows(doc.rule) - 1);
    ui.cursor.c = Math.min(ui.cursor.c, cols(doc.rule) - 1);
    if (ui.selColor > maxColorId(doc.rule)) ui.selColor = 1;
    ui.nextCaret = Math.min(ui.nextCaret, nextLen());
    ui.pendingPuyo = 0;
    if (doc.rule !== 'tet') ui.mode = 'paint';
    place.resetActive();
    renderAll();
}

function isDirty(): boolean { return JSON.stringify(doc) !== cleanSnap; }

/** 別の問題を開く（Undo 履歴は残すので誤操作でも戻せる） */
function openDoc(d: EditorDoc, src: string | null) {
    if (isDirty() && !confirm('編集中の内容は破棄されます（UNDO で戻せます）。よろしいですか？')) {
        renderTopbar();
        return;
    }
    undoStack.push(snap());
    redoStack.length = 0;
    doc = d; sourceId = src;
    cleanSnap = JSON.stringify(doc);
    ui.nextCaret = nextLen();
    place.view = doc.steps.length;   // 続きから記録できるよう最後の手を表示
    afterDocReplaced();
}

// ─── 下書き自動保存（ブラウザ単位の利便機能。失っても困らない範囲） ───
const DRAFT_KEY = 'tetlabo.quizEditor.draft';
let draftTimer = 0;
function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ doc, sourceId, cleanSnap })); } catch { /* 保存不可でも動作に影響なし */ }
    }, 300);
}
function loadDraft(): boolean {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return false;
        const o = JSON.parse(raw) as { doc: EditorDoc; sourceId: string | null; cleanSnap: string };
        if (!o.doc || !Array.isArray(o.doc.field)) return false;
        o.doc.steps ??= [];
        o.doc.solutionNote ??= '';
        doc = o.doc; sourceId = o.sourceId; cleanSnap = o.cleanSnap ?? '';
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────
function nextLen(): number { return doc.rule === 'tet' ? doc.next.length : doc.pairs.length; }

function otherIds(): string[] {
    return levels[doc.rule].map(l => String(l.id ?? '')).filter(id => id !== sourceId);
}

/** 選択画面での番号（既存なら元の位置、新規なら末尾） */
function levelNumber(): number {
    const list = levels[doc.rule];
    const i = sourceId === null ? -1 : list.findIndex(l => l.id === sourceId);
    return i >= 0 ? i + 1 : list.length + 1;
}

function suggestId(): string {
    const used = new Set(levels[doc.rule].map(l => String(l.id)));
    let n = levels[doc.rule].length + 1;
    while (used.has(`${doc.rule}-${n}`)) n++;
    return `${doc.rule}-${n}`;
}

function paletteColors(): number[] {
    return doc.rule === 'tet' ? [1, 2, 3, 4, 5, 6, 7, TET_GARBAGE, 0] : [1, 2, 3, 4, 5, PUYO_OJAMA, 0];
}

function colorName(v: number): string {
    if (v === 0) return '空';
    if (doc.rule === 'tet') return v === TET_GARBAGE ? 'おじゃま' : `${MINO_LETTERS[v - 1]}`;
    return v === PUYO_OJAMA ? 'おじゃま' : `色${v}`;
}

function setVal(el: HTMLInputElement | HTMLSelectElement, v: string) {
    if (document.activeElement !== el && el.value !== v) el.value = v;
}

const fieldCanvas = $<HTMLCanvasElement>('field');
function focusField() { fieldCanvas.focus({ preventScroll: true }); }

// ─── PLACE モード・キー同期・解答ファイル ───
const place = new PlaceMode({
    doc: () => doc,
    commit: (m, key) => commit(m, key),
    renderAll: () => renderAll(),
    renderField: () => renderField(),
    status: msg => setStatus(msg),
});
let binds = loadPlaceBinds();
let solutions: SolutionMap = {};
let solutionsLoaded = false;

/** 既存問題を開く時に解答ファイルの手順を付ける */
function withSolution(d: EditorDoc): EditorDoc {
    const e = d.rule === 'tet' ? solutions[d.id] : undefined;
    if (e) { d.steps = e.steps.map(s => ({ ...s })); d.solutionNote = e.note ?? ''; }
    return d;
}

/** 解答ファイルに保存済みの内容と一致するか */
function solutionSaved(): boolean {
    const e = solutions[doc.id];
    if (!e) return doc.steps.length === 0;
    return JSON.stringify(e.steps) === JSON.stringify(doc.steps) && (e.note ?? '') === doc.solutionNote;
}

function setMode(mode: 'paint' | 'place') {
    if (mode === 'place' && doc.rule !== 'tet') { setStatus('ぷよのミノ配置は未対応です（段階4）'); return; }
    ui.mode = mode;
    place.resetActive();
    renderAll();
    focusField();
}

// ─────────────────────────────────────────────
// 描画
// ─────────────────────────────────────────────
function renderAll() {
    renderPlace();
    renderTopbar();
    renderInfo();
    renderCond();
    renderField();
    renderPalette();
    renderNext();
    renderPreview();
    renderOutput();
    saveDraftSoon();
}

function renderPlace() {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) {
        const on = b.dataset.mode === ui.mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        if (b.dataset.mode === 'place') {
            b.disabled = doc.rule !== 'tet';
            b.title = doc.rule === 'tet' ? 'ミノを置く (P で切替)' : 'ぷよのミノ配置は未対応（段階4）';
        }
    }
    $('paint-box').hidden = ui.mode !== 'paint';
    $('place-box').hidden = ui.mode !== 'place';
    if (ui.mode !== 'place') return;
    $('bind-src').textContent = `操作キー: ${sourceLabel(binds.source)}（? で一覧）`;
    place.renderPanel($('place-box'));
    setVal($<HTMLInputElement>('sol-note'), doc.solutionNote);
    const st = $('sol-status');
    if (!solutionsLoaded) st.textContent = `${SOLUTION_PATH} を読み込めませんでした（新規作成されます）`;
    else st.textContent = solutionSaved() ? '保存済み' : '未保存の変更があります';
    st.classList.toggle('warn', !solutionSaved());
}

function renderTopbar() {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#rule-seg button')) {
        const on = b.dataset.rule === doc.rule;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
    }
    const sel = $<HTMLSelectElement>('level-select');
    const opts: string[] = ['<option value="">— NEW / 編集中 —</option>'];
    for (const rule of ['tet', 'puyo'] as Rule[]) {
        opts.push(`<optgroup label="${rule.toUpperCase()}">`);
        levels[rule].forEach((l, i) => {
            const stars = typeof l.diff === 'number' ? ' ' + '★'.repeat(Math.round(l.diff)) : '';
            opts.push(`<option value="${rule}:${i}">${i + 1}. ${escapeHtml(String(l.id))}  ${escapeHtml(String(l.description ?? ''))}${stars}</option>`);
        });
        opts.push('</optgroup>');
    }
    const html = opts.join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    const idx = sourceId === null ? -1 : levels[doc.rule].findIndex(l => l.id === sourceId);
    sel.value = idx >= 0 ? `${doc.rule}:${idx}` : '';
    $<HTMLButtonElement>('btn-undo').disabled = undoStack.length === 0;
    $<HTMLButtonElement>('btn-redo').disabled = redoStack.length === 0;
}

function renderInfo() {
    setVal($<HTMLInputElement>('in-id'), doc.id);
    setVal($<HTMLInputElement>('in-desc'), doc.description);
    $<HTMLInputElement>('in-id').placeholder = suggestId();
    const stars = $('diff-stars');
    const parts = [`<button type="button" data-diff="0" class="${doc.diff === null ? 'on' : ''}" title="未指定 (Alt+0)">—</button>`];
    for (let i = 1; i <= 5; i++) {
        const on = doc.diff !== null && i <= doc.diff;
        parts.push(`<button type="button" data-diff="${i}" class="star ${on ? 'on' : ''}" title="★${i} (Alt+${i})">${on ? '★' : '☆'}</button>`);
    }
    stars.innerHTML = parts.join('');
    $('hold-wrap').hidden = doc.rule !== 'tet';
    $<HTMLInputElement>('in-hold').checked = doc.allowHold;
}

function renderCond() {
    const c = doc.cond;
    const typeSel = $<HTMLSelectElement>('cond-type');
    const defs = condDefs(doc.rule).filter(d => d.selectable || d.type === c.type);
    if (!findCondDef(doc.rule, c.type)) defs.push({ type: c.type, label: `${c.type}（未知）`, usesValue: true, selectable: false });
    typeSel.innerHTML = defs.map(d => `<option value="${d.type}">${escapeHtml(d.label)}</option>`).join('');
    typeSel.value = c.type;

    const def = findCondDef(doc.rule, c.type);
    $('cond-note').textContent = def?.note ?? '';
    const usesValue = c.type === 'count' || (def?.usesValue ?? true);
    $('cond-value-wrap').hidden = !usesValue;
    $('cond-value-label').textContent = def?.valueLabel ?? '値';
    setVal($<HTMLInputElement>('cond-value'), String(c.value));

    const isCount = c.type === 'count';
    $('count-wrap').hidden = !isCount;
    if (isCount) {
        const cs = $<HTMLSelectElement>('count-type');
        const cdefs = countDefs(doc.rule);
        cs.innerHTML = cdefs.map(d => `<option value="${d.type}">${escapeHtml(d.label)}</option>`).join('');
        cs.value = c.countCondition;
        const cd = findCountDef(doc.rule, c.countCondition);
        $('count-value-wrap').hidden = !(cd?.usesCountValue ?? true);
        $('count-value-label').textContent = cd?.countValueLabel ?? '閾値';
        setVal($<HTMLInputElement>('count-value'), String(c.countValue));
    }
    setVal($<HTMLInputElement>('cond-desc'), c.description);
    $<HTMLInputElement>('cond-desc-auto').checked = c.descriptionAuto;
}

function renderField() {
    if (ui.mode === 'place') {
        const fv = place.fieldView();
        drawField(fieldCanvas, {
            rule: 'tet', field: fv.field, cell: fieldCellSize('tet'),
            cursor: null, hover: null, rowMode: false, showCursor: false,
            piece: fv.piece, ghost: fv.ghost,
        });
        return;
    }
    drawField(fieldCanvas, {
        rule: doc.rule, field: doc.field, cell: fieldCellSize(doc.rule),
        cursor: ui.cursor, hover: ui.hover, rowMode: ui.rowMode,
        showCursor: document.activeElement === fieldCanvas,
    });
    $('field-size').textContent = `${cols(doc.rule)}×${rows(doc.rule)}${doc.rule === 'puyo' ? '（上5段は隠し段）' : ''}`;
}

function renderPalette() {
    const pal = $('palette');
    const colors = paletteColors();
    const key = `${doc.rule}`;
    if (pal.dataset.rule !== key) {
        pal.dataset.rule = key;
        pal.innerHTML = '';
        for (const v of colors) {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.color = String(v);
            b.setAttribute('role', 'radio');
            const cv = document.createElement('canvas');
            const s = 26, dpr = window.devicePixelRatio || 1;
            cv.width = s * dpr; cv.height = s * dpr;
            cv.style.width = `${s}px`; cv.style.height = `${s}px`;
            b.append(cv);
            const k = document.createElement('span');
            k.className = 'k';
            k.textContent = doc.rule === 'tet'
                ? (v === 0 ? '0' : v === TET_GARBAGE ? '8 G' : `${v} ${MINO_LETTERS[v - 1]}`)
                : String(v);
            b.append(k);
            b.title = colorName(v);
            pal.append(b);
        }
    }
    for (const b of pal.querySelectorAll<HTMLButtonElement>('button')) {
        const v = Number(b.dataset.color);
        const on = v === ui.selColor;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        const cv = b.querySelector('canvas')!;
        const ctx = cv.getContext('2d')!;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCellSwatch(ctx, doc.rule, v, 26);
    }
    $('btn-row').classList.toggle('on', ui.rowMode);
}

function renderNext() {
    const box = $('next-box');
    box.innerHTML = '';
    const n = nextLen();
    const dpr = window.devicePixelRatio || 1;
    const addCaret = (i: number) => {
        const c = document.createElement('span');
        c.className = 'caret' + (i === ui.nextCaret ? ' on' : '');
        box.append(c);
    };
    for (let i = 0; i < n; i++) {
        addCaret(i);
        const item = document.createElement('span');
        item.className = 'next-item';
        item.draggable = true;
        item.dataset.index = String(i);
        const cv = document.createElement('canvas');
        const w = doc.rule === 'tet' ? 44 : 20, h = doc.rule === 'tet' ? 24 : 40;
        cv.width = w * dpr; cv.height = h * dpr;
        cv.style.width = `${w}px`; cv.style.height = `${h}px`;
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (doc.rule === 'tet') drawMinoCentered(ctx, doc.next[i], w / 2, h / 2, 10);
        else drawPairCentered(ctx, doc.pairs[i], w / 2, h / 2, 18);
        const no = document.createElement('span');
        no.className = 'no';
        no.textContent = String(i + 1);
        item.append(cv, no);
        box.append(item);
    }
    addCaret(n);
    if (ui.pendingPuyo) {
        const p = document.createElement('span');
        p.className = 'pending';
        p.textContent = `${ui.pendingPuyo}…`;
        box.append(p);
    }
    $('next-count').textContent = `${n}${doc.rule === 'tet' ? '個' : 'ペア'}`;
    setVal($<HTMLInputElement>('next-text'), doc.rule === 'tet' ? nextToText(doc.next) : pairsToText(doc.pairs));
    $<HTMLInputElement>('next-text').placeholder = doc.rule === 'tet' ? '例: TSZJ' : '例: 12 34 11（軸・子）';

    const tools = $('next-tools');
    if (tools.dataset.rule !== doc.rule) {
        tools.dataset.rule = doc.rule;
        tools.innerHTML = doc.rule === 'tet'
            ? MINO_LETTERS.map((L, t) => `<button type="button" data-mino="${t}" title="挿入 (${L})">${L}</button>`).join('') +
              '<button type="button" id="btn-bag" title="7種1巡を追加 (B)">+BAG</button>' +
              '<button type="button" id="btn-next-clear">CLEAR</button>'
            : [1, 2, 3, 4, 5].map(v => `<button type="button" data-puyo="${v}" title="${v}">${v}</button>`).join('') +
              '<button type="button" id="btn-swap" title="直前のペアの軸/子を入れ替え (X)">SWAP</button>' +
              '<button type="button" id="btn-next-clear">CLEAR</button>';
    }
}

function renderPreview() {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#preview-seg button')) {
        b.classList.toggle('on', b.dataset.preview === ui.preview);
    }
    const pv = $('preview');
    pv.innerHTML = '';
    const num = levelNumber();
    const stars = doc.diff === null ? '' :
        Array.from({ length: 5 }, (_, i) => `<span class="${i < Math.round(doc.diff!) ? 'sf' : 'se'}">${i < Math.round(doc.diff!) ? '★' : '☆'}</span>`).join('');

    if (ui.preview === 'select') {
        // 選択画面: 既存の並びの中にこの問題を置いた見え方（quiz-level-btn を再現）
        const list = levels[doc.rule];
        const grid = document.createElement('div');
        grid.className = 'pv-levels';
        const count = Math.max(list.length, num);
        for (let i = 1; i <= count; i++) {
            const isMe = i === num;
            const diff = isMe ? doc.diff : (typeof list[i - 1]?.diff === 'number' ? list[i - 1].diff as number : null);
            const st = diff === null ? '' :
                Array.from({ length: 5 }, (_, k) => `<span class="${k < Math.round(diff) ? 'sf' : 'se'}">${k < Math.round(diff) ? '★' : '☆'}</span>`).join('');
            const b = document.createElement('div');
            b.className = 'pv-level' + (isMe ? ' me' : '');
            b.innerHTML = `<span class="pv-num">${i}</span>${st ? `<span class="pv-diff">${st}</span>` : ''}`;
            b.title = isMe ? '編集中の問題' : String(list[i - 1]?.description ?? '');
            grid.append(b);
        }
        pv.append(grid);
        return;
    }

    // プレイ画面: 盤面上部の情報（#quiz-field-info を再現）＋HOLD＋盤面＋NEXT全表示
    const info = document.createElement('div');
    info.className = 'pv-info';
    info.innerHTML =
        `<span class="pv-rule">${doc.rule === 'tet' ? 'TET' : 'PUYO'} — ${num}${stars ? ` <span class="pv-stars">${stars}</span>` : ''}</span>` +
        `<span class="pv-desc">${escapeHtml(doc.description) || '<i>（問題名なし）</i>'}</span>` +
        `<span class="pv-goal">GOAL: ${escapeHtml(doc.cond.description)}</span>`;
    pv.append(info);

    const body = document.createElement('div');
    body.className = 'pv-body';
    if (doc.rule === 'tet') {
        const hold = document.createElement('div');
        hold.className = 'pv-hold' + (doc.allowHold ? '' : ' off');
        hold.innerHTML = `<span>HOLD</span>`;
        hold.title = doc.allowHold ? 'HOLD 可' : 'HOLD 不可（ゲームでは斜線表示）';
        body.append(hold);
    }
    const mini = document.createElement('canvas');
    mini.className = 'pv-field';
    drawField(mini, { rule: doc.rule, field: doc.field, cell: 12, cursor: null, hover: null, rowMode: false, showCursor: false });
    body.append(mini);
    pv.append(body);

    // NEXT 全表示（quiz.js _renderQuizNextAll と同じ並び: tet 1行5個 / puyo 1行9個、ぷよは子が上）
    const per = doc.rule === 'tet' ? 5 : 9;
    const n = nextLen();
    const cw = doc.rule === 'tet' ? 4 * 9 + 2 : 12 + 4;
    const ch = doc.rule === 'tet' ? 3 * 9 + 2 : 24 + 4;
    const rowsN = Math.max(1, Math.ceil(n / per));
    const nc = document.createElement('canvas');
    nc.className = 'pv-next';
    const dpr = window.devicePixelRatio || 1;
    nc.width = per * cw * dpr; nc.height = rowsN * ch * dpr;
    nc.style.width = `${per * cw}px`; nc.style.height = `${rowsN * ch}px`;
    const ctx = nc.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < n; i++) {
        const x = (i % per) * cw + cw / 2, y = Math.floor(i / per) * ch + ch / 2;
        if (doc.rule === 'tet') drawMinoCentered(ctx, doc.next[i], x, y, 9);
        else drawPairCentered(ctx, doc.pairs[i], x, y, 12);
    }
    const nl = document.createElement('div');
    nl.className = 'pv-next-wrap';
    nl.innerHTML = '<span class="pv-next-lbl">NEXT</span>';
    nl.append(nc);
    pv.append(nl);
}

let lastIssues: Issue[] = [];
function renderOutput() {
    lastIssues = validate(doc, otherIds());
    const ul = $('issues');
    ul.innerHTML = lastIssues.length
        ? lastIssues.map(i => `<li class="${i.level}">${i.level === 'error' ? 'ERROR' : i.level === 'warn' ? 'WARN' : 'INFO'} — ${escapeHtml(i.msg)}</li>`).join('')
        : '<li class="ok">OK — 問題は見つかりませんでした</li>';
    const hasError = lastIssues.some(i => i.level === 'error');
    $<HTMLButtonElement>('btn-copy').disabled = hasError;
    $<HTMLButtonElement>('btn-download').disabled = hasError;
    $<HTMLTextAreaElement>('out-json').value = outputText();
}

function outputText(): string {
    const body = serializeLevel(doc, 1);
    return $<HTMLInputElement>('in-lead-comma').checked ? `,\n${body}` : body;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

// ─────────────────────────────────────────────
// 盤面操作
// ─────────────────────────────────────────────
function setCell(r: number, c: number, v: number, key: string) {
    if (doc.field[r][c] === v) return;
    commit(() => { doc.field[r][c] = v; }, key);
}

/** 行塗り（テト譜「行」）: c 以外を選択色、c は空にする */
function fillRow(r: number, c: number) {
    commit(() => {
        for (let x = 0; x < cols(doc.rule); x++) doc.field[r][x] = x === c ? 0 : ui.selColor;
    });
}

function shiftField(dir: 'up' | 'down' | 'left' | 'right') {
    commit(() => {
        const f = doc.field, C = cols(doc.rule);
        if (dir === 'up') { f.shift(); f.push(new Array(C).fill(0)); }
        else if (dir === 'down') { f.pop(); f.unshift(new Array(C).fill(0)); }
        else if (dir === 'left') for (const row of f) { row.shift(); row.push(0); }
        else for (const row of f) { row.pop(); row.unshift(0); }
    });
}

function mirrorField() { commit(() => { for (const row of doc.field) row.reverse(); }); }
function clearField() { commit(() => { doc.field = emptyField(doc.rule); }); }

let strokeSeq = 0;
let dragPaint: { value: number; key: string; last: { r: number; c: number } } | null = null;

function cellAt(e: MouseEvent): { r: number; c: number } | null {
    const rect = fieldCanvas.getBoundingClientRect();
    const s = fieldCellSize(doc.rule);
    const c = Math.floor((e.clientX - rect.left) / s), r = Math.floor((e.clientY - rect.top) / s);
    if (r < 0 || r >= rows(doc.rule) || c < 0 || c >= cols(doc.rule)) return null;
    return { r, c };
}

fieldCanvas.addEventListener('mousedown', e => {
    const p = cellAt(e);
    if (!p) return;
    e.preventDefault();
    focusField();
    if (ui.mode === 'place') {
        // テト譜のミノ配置: 左クリックで確定・右クリックで右回転
        place.hoverAt(p.r, p.c);
        if (e.button === 0) place.lock(); else if (e.button === 2) place.wheel(1);
        return;
    }
    ui.cursor = { ...p };
    if (ui.rowMode && e.button === 0) { fillRow(p.r, p.c); return; }
    const value = e.button === 2 ? 0 : (doc.field[p.r][p.c] === ui.selColor ? 0 : ui.selColor);
    dragPaint = { value, key: `stroke:${++strokeSeq}`, last: { ...p } };
    if (doc.field[p.r][p.c] === value) {
        // 変化しない開始点でも同じストロークの Undo 単位を作る
        commit(() => {}, dragPaint.key);
    } else setCell(p.r, p.c, value, dragPaint.key);
});
fieldCanvas.addEventListener('mousemove', e => {
    const p = cellAt(e);
    const changed = (p?.r !== ui.hover?.r) || (p?.c !== ui.hover?.c);
    ui.hover = p;
    if (ui.mode === 'place') {
        if (p && changed) place.hoverAt(p.r, p.c);
        return;
    }
    if (dragPaint && p) {
        // 素早く動かしてもマスが飛ばないよう、前回のマスから直線補間して塗る
        const { last } = dragPaint;
        const steps = Math.max(Math.abs(p.r - last.r), Math.abs(p.c - last.c));
        for (let i = 1; i <= steps; i++) {
            const r = Math.round(last.r + (p.r - last.r) * i / steps);
            const c = Math.round(last.c + (p.c - last.c) * i / steps);
            setCell(r, c, dragPaint.value, dragPaint.key);
        }
        dragPaint.last = { ...p };
        if (!steps && changed) renderField();
    } else if (changed) renderField();
});
fieldCanvas.addEventListener('mouseleave', () => { ui.hover = null; renderField(); });
fieldCanvas.addEventListener('contextmenu', e => e.preventDefault());
fieldCanvas.addEventListener('wheel', e => {
    if (ui.mode !== 'place') return;
    e.preventDefault();
    place.wheel(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
fieldCanvas.addEventListener('focus', renderField);
fieldCanvas.addEventListener('blur', renderField);
window.addEventListener('mouseup', () => { dragPaint = null; });

function handleFieldKey(e: KeyboardEvent): boolean {
    const C = cols(doc.rule), R = rows(doc.rule);
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.key in arrows) {
        const [dr, dc] = arrows[e.key];
        if (e.altKey) {
            shiftField(({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key as 'ArrowUp']);
            return true;
        }
        ui.cursor.r = Math.max(0, Math.min(R - 1, ui.cursor.r + dr));
        ui.cursor.c = Math.max(0, Math.min(C - 1, ui.cursor.c + dc));
        if (e.shiftKey) {
            if (doc.field[ui.cursor.r][ui.cursor.c] !== ui.selColor) setCell(ui.cursor.r, ui.cursor.c, ui.selColor, 'stroke:kb');
            else renderField();
        } else {
            lastCommit.key = '';   // Shift を離したらキーボード塗りの Undo 単位を区切る
            renderField();
        }
        return true;
    }
    if (e.key === ' ' || e.key === 'Enter') {
        const { r, c } = ui.cursor;
        if (ui.rowMode) fillRow(r, c);
        else setCell(r, c, doc.field[r][c] === ui.selColor ? 0 : ui.selColor, '');
        return true;
    }
    if (e.key === 'Delete' && e.shiftKey) { clearField(); return true; }

    // 色選択: 数字（JSON の ID と一致）・TET はミノ頭文字
    const digit = /^(Digit|Numpad)(\d)$/.exec(e.code);
    if (digit && !e.altKey) {
        const v = Number(digit[2]);
        if (v <= maxColorId(doc.rule)) { ui.selColor = v; renderPalette(); }
        return true;
    }
    if (e.key === 'Backspace') { ui.selColor = 0; renderPalette(); return true; }
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
    if (!letter) return false;
    if (doc.rule === 'tet') {
        const mi = (MINO_LETTERS as readonly string[]).indexOf(letter);
        if (mi >= 0) { ui.selColor = mi + 1; renderPalette(); return true; }
        if (letter === 'G') { ui.selColor = TET_GARBAGE; renderPalette(); return true; }
        if (letter === 'H') { commit(() => { doc.allowHold = !doc.allowHold; }); return true; }
    }
    if (letter === 'Q' || letter === 'E') {
        const pal = paletteColors();
        const i = pal.indexOf(ui.selColor);
        ui.selColor = pal[(i + (letter === 'E' ? 1 : -1) + pal.length) % pal.length];
        renderPalette();
        return true;
    }
    if (letter === 'R') { ui.rowMode = !ui.rowMode; renderPalette(); renderField(); return true; }
    if (letter === 'M') { mirrorField(); return true; }
    return false;
}

// ─────────────────────────────────────────────
// NEXT 操作
// ─────────────────────────────────────────────
function insertNext(items: number[] | Pair[]) {
    commit(() => {
        if (doc.rule === 'tet') doc.next.splice(ui.nextCaret, 0, ...(items as number[]));
        else doc.pairs.splice(ui.nextCaret, 0, ...(items as Pair[]));
        ui.nextCaret += items.length;
    });
}

function deleteNext(at: number) {
    if (at < 0 || at >= nextLen()) return;
    commit(() => {
        if (doc.rule === 'tet') doc.next.splice(at, 1); else doc.pairs.splice(at, 1);
        if (at < ui.nextCaret) ui.nextCaret--;
    });
}

function moveNext(from: number, to: number) {
    if (from === to) return;
    commit(() => {
        const arr: unknown[] = doc.rule === 'tet' ? doc.next : doc.pairs;
        const [it] = arr.splice(from, 1);
        arr.splice(to, 0, it);
        ui.nextCaret = to + 1;
    });
}

function swapPairBeforeCaret() {
    const i = ui.nextCaret - 1;
    if (doc.rule !== 'puyo' || i < 0) return;
    commit(() => { const p = doc.pairs[i]; doc.pairs[i] = [p[1], p[0]]; });
}

function puyoDigit(v: number) {
    if (!ui.pendingPuyo) { ui.pendingPuyo = v; renderNext(); return; }
    const pair: Pair = [ui.pendingPuyo, v];
    ui.pendingPuyo = 0;
    insertNext([pair]);
}

function handleNextKey(e: KeyboardEvent): boolean {
    const n = nextLen();
    switch (e.key) {
        case 'ArrowLeft': ui.nextCaret = Math.max(0, ui.nextCaret - 1); ui.pendingPuyo = 0; renderNext(); return true;
        case 'ArrowRight': ui.nextCaret = Math.min(n, ui.nextCaret + 1); ui.pendingPuyo = 0; renderNext(); return true;
        case 'Home': ui.nextCaret = 0; renderNext(); return true;
        case 'End': ui.nextCaret = n; renderNext(); return true;
        case 'Backspace':
            if (ui.pendingPuyo) { ui.pendingPuyo = 0; renderNext(); } else deleteNext(ui.nextCaret - 1);
            return true;
        case 'Delete': deleteNext(ui.nextCaret); return true;
    }
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
    if (doc.rule === 'tet') {
        if (!letter) return false;
        const mi = (MINO_LETTERS as readonly string[]).indexOf(letter);
        if (mi >= 0) { insertNext([mi]); return true; }
        if (letter === 'B') { insertNext(randomBag()); return true; }
        return false;
    }
    const digit = /^(Digit|Numpad)([1-5])$/.exec(e.code);
    if (digit) { puyoDigit(Number(digit[2])); return true; }
    if (letter === 'X') { swapPairBeforeCaret(); return true; }
    return false;
}

const nextBox = $('next-box');
nextBox.addEventListener('click', e => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.next-item');
    ui.nextCaret = item ? Number(item.dataset.index) + 1 : nextLen();
    ui.pendingPuyo = 0;
    nextBox.focus();
    renderNext();
});
let dragFrom = -1;
nextBox.addEventListener('dragstart', e => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.next-item');
    if (!item) return;
    dragFrom = Number(item.dataset.index);
    e.dataTransfer?.setData('text/plain', String(dragFrom));
});
nextBox.addEventListener('dragover', e => e.preventDefault());
nextBox.addEventListener('drop', e => {
    e.preventDefault();
    if (dragFrom < 0) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>('.next-item');
    const to = item ? Number(item.dataset.index) : nextLen() - 1;
    moveNext(dragFrom, to);
    dragFrom = -1;
});

$('next-tools').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.mino) insertNext([Number(b.dataset.mino)]);
    else if (b.dataset.puyo) puyoDigit(Number(b.dataset.puyo));
    else if (b.id === 'btn-bag') insertNext(randomBag());
    else if (b.id === 'btn-swap') swapPairBeforeCaret();
    else if (b.id === 'btn-next-clear') commit(() => { doc.next = []; doc.pairs = []; ui.nextCaret = 0; });
    nextBox.focus();
});

$<HTMLInputElement>('next-text').addEventListener('input', e => {
    const t = (e.target as HTMLInputElement).value;
    commit(() => {
        if (doc.rule === 'tet') doc.next = textToNext(t); else doc.pairs = textToPairs(t);
        ui.nextCaret = nextLen();
    }, 'next-text');
});

// ─────────────────────────────────────────────
// 問題情報・条件のフォーム
// ─────────────────────────────────────────────
$<HTMLInputElement>('in-id').addEventListener('input', e => {
    const v = (e.target as HTMLInputElement).value;
    commit(() => { doc.id = v; }, 'id');
});
$('btn-auto-id').addEventListener('click', () => commit(() => { doc.id = suggestId(); }));
$<HTMLInputElement>('in-desc').addEventListener('input', e => {
    const v = (e.target as HTMLInputElement).value;
    commit(() => { doc.description = v; }, 'desc');
});
$('diff-stars').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    const v = Number(b.dataset.diff);
    commit(() => { doc.diff = v === 0 ? null : v; });
});
$<HTMLInputElement>('in-hold').addEventListener('change', e => {
    const v = (e.target as HTMLInputElement).checked;
    commit(() => { doc.allowHold = v; });
});

$<HTMLSelectElement>('cond-type').addEventListener('change', e => {
    const t = (e.target as HTMLSelectElement).value;
    commit(() => {
        doc.cond.type = t;
        const def = findCondDef(doc.rule, t);
        if ((def?.usesValue || t === 'count') && doc.cond.value < 1) doc.cond.value = 1;
        if (t === 'count' && !findCountDef(doc.rule, doc.cond.countCondition)) {
            doc.cond.countCondition = countDefs(doc.rule)[0].type;
        }
    });
});
$<HTMLInputElement>('cond-value').addEventListener('input', e => {
    const v = Number((e.target as HTMLInputElement).value);
    commit(() => { doc.cond.value = v; }, 'cond-value');
});
$<HTMLSelectElement>('count-type').addEventListener('change', e => {
    const t = (e.target as HTMLSelectElement).value;
    commit(() => { doc.cond.countCondition = t; if (doc.cond.countValue < 1) doc.cond.countValue = 1; });
});
$<HTMLInputElement>('count-value').addEventListener('input', e => {
    const v = Number((e.target as HTMLInputElement).value);
    commit(() => { doc.cond.countValue = v; }, 'count-value');
});
$<HTMLInputElement>('cond-desc').addEventListener('input', e => {
    const v = (e.target as HTMLInputElement).value;
    commit(() => { doc.cond.description = v; doc.cond.descriptionAuto = false; }, 'cond-desc');
});
$<HTMLInputElement>('cond-desc-auto').addEventListener('change', e => {
    const on = (e.target as HTMLInputElement).checked;
    commit(() => { doc.cond.descriptionAuto = on; });
});

// ─────────────────────────────────────────────
// ツール・トップバー
// ─────────────────────────────────────────────
$('palette').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    ui.selColor = Number(b.dataset.color);
    renderPalette();
    focusField();
});
$('btn-row').addEventListener('click', () => { ui.rowMode = !ui.rowMode; renderPalette(); focusField(); });
$('btn-mirror').addEventListener('click', () => { mirrorField(); focusField(); });
$('btn-clear').addEventListener('click', () => { clearField(); focusField(); });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-shift]')) {
    b.addEventListener('click', () => { shiftField(b.dataset.shift as 'up'); focusField(); });
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#rule-seg button')) {
    b.addEventListener('click', () => {
        const rule = b.dataset.rule as Rule;
        if (rule === doc.rule) return;
        const hasContent = doc.field.some(r => r.some(v => v)) || nextLen() > 0;
        if (hasContent && !confirm('ルールを切り替えると盤面・NEXT・クリア条件が初期化されます（UNDO で戻せます）。よろしいですか？')) return;
        commit(() => {
            const keep = { description: doc.description, diff: doc.diff };
            doc = { ...newDoc(rule), ...keep };
            sourceId = null;
            ui.nextCaret = 0;
            if (rule !== 'tet') ui.mode = 'paint';
            place.resetActive();
            if (ui.selColor > maxColorId(rule)) ui.selColor = 1;
            ui.cursor = { r: Math.min(ui.cursor.r, rows(rule) - 1), c: Math.min(ui.cursor.c, cols(rule) - 1) };
        });
    });
}

$<HTMLSelectElement>('level-select').addEventListener('change', e => {
    const v = (e.target as HTMLSelectElement).value;
    if (!v) return;
    const [rule, i] = v.split(':') as [Rule, string];
    const raw = levels[rule][Number(i)];
    if (raw) openDoc(withSolution(docFromLevel(raw)), String(raw.id));
    focusField();
});
$('btn-new').addEventListener('click', () => {
    const d = newDoc(doc.rule);
    openDoc(d, null);
    focusField();
});

for (const b of document.querySelectorAll<HTMLButtonElement>('#preview-seg button')) {
    b.addEventListener('click', () => { ui.preview = b.dataset.preview as 'play'; renderPreview(); });
}

$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

// ─── 出力 ───
function setStatus(msg: string) {
    for (const el of [$('out-status'), $('place-status')]) {
        el.textContent = msg;
        window.setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
    }
}
async function copyJson() {
    if (lastIssues.some(i => i.level === 'error')) { setStatus('エラーがあるためコピーできません'); return; }
    try {
        await navigator.clipboard.writeText(outputText());
        setStatus('コピーしました。tdata/pdata.json に貼った後は ASSET_VERSION を +1 してください');
    } catch {
        const ta = $<HTMLTextAreaElement>('out-json');
        ta.select();
        setStatus('自動コピーできませんでした。選択済みのテキストをコピーしてください');
    }
}
$('btn-copy').addEventListener('click', copyJson);
$('in-lead-comma').addEventListener('change', renderOutput);
$('btn-download').addEventListener('click', () => {
    if (lastIssues.some(i => i.level === 'error')) return;
    const blob = new Blob([serializeLevel(doc, 0) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.id || 'quiz'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
});

// ─── 貼り付け読込 ───
const pasteDlg = $<HTMLDialogElement>('paste-dlg');
$('btn-paste').addEventListener('click', () => {
    $<HTMLTextAreaElement>('paste-text').value = '';
    $('paste-error').textContent = '';
    pasteDlg.showModal();
});
$('paste-ok').addEventListener('click', e => {
    try {
        const list = parseLevelsText($<HTMLTextAreaElement>('paste-text').value);
        if (!list.length) throw new Error('問題オブジェクトが見つかりません');
        // 既存 id と一致すれば「その問題の編集」として扱う
        const raw = list[0];
        const d = withSolution(docFromLevel(raw));
        const exists = levels[d.rule].some(l => l.id === d.id);
        pasteDlg.close();
        openDoc(d, exists ? d.id : null);
        if (list.length > 1) setStatus(`${list.length}問のうち先頭の1問を読み込みました`);
    } catch (err) {
        e.preventDefault();
        $('paste-error').textContent = `読み込めません: ${(err as Error).message}`;
    }
});

// ─── キー一覧 ───
const helpDlg = $<HTMLDialogElement>('help-dlg');
function renderHelp() {
    const placeSec = {
        title: `PLACE（盤面にフォーカス）— 操作キーは ${sourceLabel(binds.source)}`,
        rows: [
            ...PLACE_ACTIONS.map(a => ({ keys: bindLabel(binds, a), desc: ACTION_NAMES[a] })),
            { keys: 'Alt+↑（未割当なら ↑ も可）', desc: '1段上（自由配置）' },
            { keys: 'Alt+↓', desc: '一番下まで落とす（確定しない）' },
            { keys: 'Enter', desc: '今の位置で確定（浮いていても置く）' },
            { keys: 'Backspace', desc: '最後の手を取り消す（SOLVE）' },
            { keys: '[ ・ ] ・ Home ・ End', desc: '前の手 ・ 次の手 ・ 初期盤面 ・ 最後の手' },
            { keys: 'I O T J L S Z', desc: '置くミノを選ぶ（STAMP）' },
            { keys: 'マウス: 移動 ・ ホイール ・ 左クリック ・ 右クリック', desc: '位置 ・ 回転 ・ 確定 ・ 右回転（T-Spin は推定扱い）' },
            { keys: 'P', desc: 'PAINT ⇔ PLACE 切替' },
        ],
    };
    const secs = [...KEY_HELP, placeSec];
    $('help-body').innerHTML = secs.map(sec =>
        `<h3>${escapeHtml(sec.title)}</h3><table>${sec.rows.map(r =>
            `<tr><th>${escapeHtml(r.keys)}</th><td>${escapeHtml(r.desc)}</td></tr>`).join('')}</table>`).join('');
}
$('btn-help').addEventListener('click', () => { renderHelp(); helpDlg.showModal(); });

// ─── PLACE モードの UI ───
for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) {
    b.addEventListener('click', () => setMode(b.dataset.mode as 'paint'));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#sub-seg button')) {
    b.addEventListener('click', () => { place.setSub(b.dataset.sub as PlaceSub); focusField(); });
}
$('ctl-pad').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    switch (b?.dataset.ctl) {
        case 'left': place.move(-1, 0); break;
        case 'right': place.move(1, 0); break;
        case 'down': place.move(0, 1); break;
        case 'up': place.move(0, -1); break;
        case 'ccw': place.rotate(-1); break;
        case 'cw': place.rotate(1); break;
        case 'hold': place.toggleHold(); break;
        case 'drop': place.hardDrop(); break;
        case 'lock': place.lock(); break;
    }
    focusField();
});
$('solve-box').addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const nav = t.closest<HTMLButtonElement>('[data-nav]')?.dataset.nav;
    const n = doc.steps.length;
    if (nav) place.goto(nav === 'first' ? 0 : nav === 'prev' ? place.view - 1 : nav === 'next' ? place.view + 1 : n);
    const li = t.closest<HTMLElement>('#step-list li');
    if (li) place.goto(Number(li.dataset.view));
    if (nav || li) focusField();
});
$('btn-truncate').addEventListener('click', () => { place.truncateAfterView(); focusField(); });
$('btn-to-initial').addEventListener('click', () => { place.viewToInitial(); focusField(); });
$('stamp-grid').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    place.setStamp(Number(b.dataset.stamp), Number(b.dataset.rot));
    focusField();
});
$<HTMLInputElement>('sol-note').addEventListener('input', e => {
    const v = (e.target as HTMLInputElement).value;
    commit(() => { doc.solutionNote = v; }, 'sol-note');
});

async function saveSolutionFile(forcePick: boolean) {
    if (!doc.id.trim()) { setStatus('ID を入力してから保存してください'); return; }
    if (doc.rule !== 'tet') return;
    const oldId = sourceId && sourceId !== doc.id && solutions[sourceId] ? sourceId : null;
    try {
        const res = await saveSolution(doc.id, oldId,
            { steps: doc.steps, note: doc.solutionNote, updated: today() }, solutions, forcePick);
        solutions = res.map;
        solutionsLoaded = true;
        setStatus(res.via === 'file'
            ? `${res.fileName} に保存しました${oldId ? `（旧 ID「${oldId}」の解答は削除）` : ''}`
            : `ダウンロードしました。${SOLUTION_PATH} に置き換えてください`);
    } catch (err) {
        if ((err as Error).name === 'AbortError') return;   // ファイル選択をキャンセル
        console.error(err);
        setStatus(`保存できませんでした: ${(err as Error).message}`);
    }
    renderAll();
}
$('btn-sol-save').addEventListener('click', () => void saveSolutionFile(false));
$('btn-sol-pick').addEventListener('click', () => void saveSolutionFile(true));
$<HTMLButtonElement>('btn-sol-pick').hidden = !canWriteFiles();

// TETLABO 側で KEY CONFIG を保存したら即反映（別タブの変更は storage イベントで届く）
window.addEventListener('storage', e => {
    if (e.key === 'game_binds' || e.key === 'game_keyconfig' || e.key === null) {
        binds = loadPlaceBinds();
        renderAll();
        if (helpDlg.open) renderHelp();
    }
});

// ─────────────────────────────────────────────
// グローバルキー
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (pasteDlg.open || helpDlg.open) return;   // ダイアログ内はブラウザ標準
    const target = e.target as Element | null;
    const text = isTextInput(target);
    const k = e.key.toLowerCase();

    if (isMod(e) && k === 'z') {
        if (text) return;   // テキスト欄の Undo はブラウザ標準に任せる
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
    }
    if (isMod(e) && k === 'y') { if (!text) { e.preventDefault(); redo(); } return; }
    if (isMod(e) && k === 's') { e.preventDefault(); void copyJson(); return; }
    if (isMod(e)) return;

    if (text) {
        if (e.key === 'Escape') { (target as HTMLElement).blur(); focusField(); }
        return;
    }
    if (e.key === '?') { e.preventDefault(); helpDlg.showModal(); return; }
    if (e.key === 'Escape') { focusField(); return; }
    const diffKey = /^(Digit|Numpad)([0-5])$/.exec(e.code);
    if (e.altKey && diffKey) {
        e.preventDefault();
        const v = Number(diffKey[2]);
        commit(() => { doc.diff = v === 0 ? null : v; });
        return;
    }

    let handled = false;
    const onField = target === fieldCanvas || target === document.body || target === null;
    if (target === nextBox) handled = handleNextKey(e);
    else if (onField && ui.mode === 'place') handled = place.handleKey(e, binds);
    else if (onField) handled = handleFieldKey(e);
    // P: PAINT ⇔ PLACE（PLACE で同期キーに割り当てられていれば上で処理済み）
    if (!handled && onField && e.code === 'KeyP' && !e.altKey) {
        setMode(ui.mode === 'paint' ? 'place' : 'paint');
        handled = true;
    }
    if (handled) e.preventDefault();
});

// ─────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────
async function loadLevels() {
    for (const [rule, file] of [['tet', 'tdata.json'], ['puyo', 'pdata.json']] as [Rule, string][]) {
        try {
            const res = await fetch(`/assets/quizlevels/${file}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const arr = await res.json() as unknown;
            levels[rule] = Array.isArray(arr) ? arr as LevelRaw[] : [];
        } catch (err) {
            console.error(`${file} の読み込みに失敗しました`, err);
            setStatus(`${file} を読み込めませんでした（pnpm dev:client で開いていますか？）`);
        }
    }
}

loadImages(() => { renderField(); renderPalette(); renderNext(); renderPreview(); buildStampGrid($('stamp-grid')); });
buildStampGrid($('stamp-grid'));
if (!loadDraft()) cleanSnap = JSON.stringify(doc);
ui.nextCaret = nextLen();
place.view = doc.steps.length;
renderAll();
void loadLevels().then(renderAll);
void fetchSolutions().then(m => {
    solutionsLoaded = m !== null;
    solutions = m ?? {};
    // 下書きが空で、開いている問題に保存済みの解答があれば付ける
    if (!doc.steps.length && solutions[doc.id]) { withSolution(doc); place.view = doc.steps.length; }
    renderAll();
});
focusField();

// デバッグ用（コンソールから状態確認）
(window as unknown as { quizEditor: unknown }).quizEditor = { get doc() { return cloneDoc(doc); } };
