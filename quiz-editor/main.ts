// ─────────────────────────────────────────────
// main.ts
// クイズエディタ本体（状態管理・Undo・各パネルの描画とイベント）
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-design.md
// ─────────────────────────────────────────────
import './prod-guard.ts';
import {
    type Rule, type EditorDoc, type Pair, type Issue,
    MINO_LETTERS, TET_GARBAGE, PUYO_OJAMA,
    cols, rows, maxColorId, newDoc, cloneDoc, docFromLevel, emptyField,
    condDefs, countDefs, findCondDef, findCountDef, autoCondDescription,
    serializeLevel, buildLevel, parseLevelsText, validate, levelChanges,
    nextToText, textToNext, pairsToText, textToPairs, randomBag,
} from './model.ts';
import {
    loadImages, drawField, fieldCellSize, drawCellSwatch, drawMinoCentered, drawPairCentered,
} from './render.ts';
import { KEY_HELP, isTextInput, isMod } from './keys.ts';
import { PlaceMode, buildStampGrid, drawStampButtons } from './place.ts';
import { loadPlaceBinds, loadPlaceTuning, tuningLabel, bindLabel, sourceLabel, PLACE_ACTIONS, ACTION_NAMES } from './keybinds.ts';
import { type SolutionMap, fetchSolutions, saveSolution, canWriteFiles, today, SOLUTION_PATH, exportSolutionsFile } from './solutions.ts';
import { SyncEngine, type SyncEvent, type DraftEntry, newDraftId, guessDevice, decodeSyncHash } from './sync.ts';
import { LocalDrafts, type LocalDraft, type SentMark, draftKey, contentHash } from './local-drafts.ts';
import { initSyncUi } from './sync-ui.ts';
import { getHandle, readText, writeText } from './fsa.ts';
import { toast, dismissToasts, toastLog, onToastLog } from './toast.ts';
import { planWrite } from './levels-file.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ─────────────────────────────────────────────
// 状態
// ─────────────────────────────────────────────
type LevelRaw = Record<string, unknown>;
const levels: Record<Rule, LevelRaw[]> = { tet: [], puyo: [] };
let levelsLoaded = false;

let doc: EditorDoc = newDoc('tet');
let sourceId: string | null = null;   // 既存問題から開いた場合の元 id（重複判定の除外・番号算出に使う）
let draftId: string = newDraftId();   // 下書きの id（端末内・Gist で共通。1 問につき 1 つ。save-notify §3）

const ui = {
    selColor: 1,
    rowMode: false,
    cursor: { r: 0, c: 0 },
    hover: null as { r: number; c: number } | null,
    nextCaret: 0,
    pendingPuyo: 0,                    // puyo NEXT 入力の1色目（0=なし）
    preview: 'play' as 'play' | 'select',
    mode: 'paint' as 'paint' | 'place',
    lastEdit: 'paint' as 'paint' | 'stamp',   // P で SOLVE から戻る先
};

// ─── Undo / Redo（EditorDoc 丸ごとのスナップショット） ───
const undoStack: string[] = [];
const redoStack: string[] = [];
let lastCommit = { key: '', t: 0 };

function snap(): string { return JSON.stringify({ doc, sourceId, draftId }); }
function restore(s: string) {
    const o = JSON.parse(s) as { doc: EditorDoc; sourceId: string | null; draftId?: string | null };
    doc = o.doc; sourceId = o.sourceId; draftId = o.draftId ?? newDraftId();
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

/** 別の問題を開く（開いていた問題は端末内の下書きに残る。Undo 履歴も残すので誤操作でも戻せる） */
function openDoc(d: EditorDoc, src: string | null, did: string | null = null) {
    persistLocalNow();
    hideNotice();
    undoStack.push(snap());
    redoStack.length = 0;
    doc = d; sourceId = src; draftId = did ?? newDraftId();
    ui.nextCaret = nextLen();
    place.view = doc.steps.length;   // 続きから記録できるよう最後の手を表示
    afterDocReplaced();
}

// ─── 自動保存（端末内の下書き。問題ごとに 1 つ。Gist へは SAVE を押した時だけ。save-notify §3） ───
const localDrafts = new LocalDrafts();
localDrafts.onError = () => errStatus('端末内に保存できませんでした（容量不足の可能性）。DRAFTS で不要な下書きを DISCARD してください');
let draftTimer = 0;
function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = window.setTimeout(persistLocalNow, 300);
}
function curDraftKey(): string { return draftKey(doc.rule, sourceId, draftId); }
/** 何も入っていない新規の問題（下書きにしない） */
function blankDoc(rule: Rule): EditorDoc {
    const d = newDoc(rule);
    if (d.cond.descriptionAuto) d.cond.description = autoCondDescription(rule, d.cond);
    return d;
}
/** 下書きとして残すか（ファイルの内容のまま・空の新規は残さない。問題一覧を読む前は判断できないので残す） */
function worthKeeping(): boolean {
    if (!levelsLoaded) return true;
    if (sourceId !== null && levelById(doc.rule, sourceId)) return editStateOf(doc, sourceId).kind !== 'file';
    const blank = blankDoc(doc.rule);
    return JSON.stringify(doc) !== JSON.stringify(blank) && JSON.stringify(doc) !== JSON.stringify(newDoc(doc.rule));
}
/** 開いている問題を端末内の下書きに書く（内容が同じなら書かない） */
function persistLocalNow() {
    clearTimeout(draftTimer);
    const key = curDraftKey();
    localDrafts.setCurrent({ key, rule: doc.rule, sourceId, draftId });
    const prev = localDrafts.get(key);
    const mine = prev?.draftId === draftId;
    if (!worthKeeping()) {
        if (prev && mine) { localDrafts.remove(key); syncUi?.refresh(); }
        return;
    }
    if (prev && mine && contentHash(prev.doc, prev.sourceId) === contentHash(doc, sourceId)) return;
    localDrafts.put(key, {
        doc: cloneDoc(doc), sourceId, draftId, updatedAt: new Date().toISOString(),
        sent: mine ? prev.sent : undefined,
    });
    syncUi?.refresh();
}
/** 開いている問題の下書き（無ければ undefined） */
function curLocal(): LocalDraft | undefined {
    const l = localDrafts.get(curDraftKey());
    return l?.draftId === draftId ? l : undefined;
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
function focusField() {
    // タッチ端末ではフォーカス枠（キーボード用カーソル）を出さない。キー操作は body 宛てでも盤面に届く
    if (coarsePointer()) return;
    fieldCanvas.focus({ preventScroll: true });
}
/** 主な入力がタッチの端末か（ボタンを大きくする・キー前提のフォーカス移動をしない等） */
function coarsePointer(): boolean { return matchMedia('(pointer: coarse)').matches; }

// ─── PC とスマホの同期（Gist。§14.3） ───
const sync = new SyncEngine(ev => onSyncEvent(ev), () => onSyncState());
let syncUi: { refresh(): void } | null = null;

/** Gist の下書きを開く（DRAFTS・届いたお知らせ・LEVELS から）。この端末の未保存の編集を置き換える時は確認する */
function openDraft(id: string) {
    const d = sync.draft(id);
    if (!d) return;
    const h = contentHash(d.doc, d.sourceId);
    const local = localDrafts.get(draftKey(d.doc.rule, d.sourceId, id));
    const localHash = local ? contentHash(local.doc, local.sourceId) : '';
    const unsaved = local && localHash !== h && local.sent?.hash !== localHash;
    if (unsaved && !confirm(`この端末で編集中の「${local.doc.id || '(ID なし)'}」を、${d.device} の下書きで置き換えます（UNDO で戻せます）。よろしいですか？`)) return;
    openDoc(cloneDoc(d.doc), d.sourceId, id);
    persistLocalNow();
    localDrafts.setSent(curDraftKey(), { rev: d.rev, hash: h });
    renderAll();
    focusField();
}
/** 端末内の下書きを開く（DRAFTS から） */
function openLocal(key: string) {
    const l = localDrafts.get(key);
    if (!l) return;
    openDoc(cloneDoc(l.doc), l.sourceId, l.draftId);
    focusField();
}
/** 端末内の下書きを捨てる（開いている問題ならファイルの内容・空の新規に戻す。Gist は触らない） */
function discardLocal(key: string) {
    const l = localDrafts.get(key);
    if (!l) return;
    if (!confirm(`この端末の下書き「${l.doc.id || '(ID なし)'} ${l.doc.description}」を捨てます${l.sourceId ? '（ファイルの内容に戻ります）' : ''}。Gist に保存した物は消えません。UNDO で戻せるのは開いている問題だけです。よろしいですか？`)) return;
    if (key === curDraftKey()) {
        const raw = levelById(l.doc.rule, l.sourceId);
        openDoc(raw ? withSolution(docFromLevel(raw)) : newDoc(l.doc.rule), raw ? l.sourceId : null);
    }
    if (localDrafts.get(key)?.draftId === l.draftId) localDrafts.remove(key);
    renderAll();
    syncUi?.refresh();
}

// ─── Gist の下書きとの関係（SAVED / SAVED* / 届いた。save-notify §5） ───
type SendKind = 'none' | 'saved' | 'changed' | 'incoming';
interface SendState { kind: SendKind; id?: string; entry?: DraftEntry; }
/** この問題に対応する Gist の下書き（同じ id、無ければ同じ問題の最新の物） */
function remoteFor(rule: Rule, src: string | null, did: string): [string, DraftEntry] | undefined {
    if (!sync.enabled) return undefined;
    const own = sync.draft(did);
    if (own) return [did, own];
    if (src === null) return undefined;
    return Object.entries(sync.drafts())
        .filter(([, d]) => d.doc.rule === rule && d.sourceId === src)
        .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
}
function sendStateOf(d: EditorDoc, src: string | null, did: string, sent: SentMark | undefined): SendState {
    const r = remoteFor(d.rule, src, did);
    if (!r) return { kind: 'none' };
    const [id, entry] = r;
    if (contentHash(entry.doc, entry.sourceId) === contentHash(d, src)) return { kind: 'saved', id, entry };
    if (sent && id === did && entry.rev === sent.rev) return { kind: 'changed', id, entry };
    return { kind: 'incoming', id, entry };
}
function curSendState(): SendState { return sendStateOf(doc, sourceId, draftId, curLocal()?.sent); }
function fmtTime(iso: string): string { return iso.slice(5, 16).replace('-', '/').replace('T', ' '); }

/** 開いている問題に、他の端末から別の内容の下書きが届いていたら知らせる（勝手には切り替えない。同じ物は1回だけ） */
const announced = new Set<string>();
function announceIncoming() {
    const st = curSendState();
    if (st.kind !== 'incoming' || !st.id || !st.entry) return;
    const tag = `${st.id}:${st.entry.rev}`;
    if (announced.has(tag)) return;
    announced.add(tag);
    const id = st.id;
    toast(`${st.entry.device} から「${st.entry.doc.id || '(ID なし)'}」の下書きが届いています（${fmtTime(st.entry.updatedAt)}）`, 'warn',
        { actions: [{ label: 'OPEN', title: 'その下書きを開く（UNDO で戻せます）', run: () => openDraft(id) }] });
}

/** 下書きを Gist に保存する（SAVE）。他の端末の保存と食い違う時は、上書き・別の下書き・やめる を選ぶ */
async function saveToGist(key: string) {
    if (!sync.enabled) { warnStatus('SYNC を設定すると、下書きを Gist に保存して PC とスマホで受け渡しできます'); return; }
    if (key === curDraftKey()) persistLocalNow();
    const l = localDrafts.get(key);
    if (!l) { setStatus('ファイルの内容から変更が無いため、保存する物はありません'); return; }
    const name = l.doc.id || '(ID なし)';
    try {
        await sync.refreshNow();
    } catch (err) {
        errStatus(`Gist に保存できませんでした: ${(err as Error).message}`);
        return;
    }
    const h = contentHash(l.doc, l.sourceId);
    let target = l.draftId;
    let remote = sync.draft(target);
    if (!remote && l.sourceId !== null) {
        const o = remoteFor(l.doc.rule, l.sourceId, l.draftId);
        if (o) [target, remote] = o;
    }
    if (remote && contentHash(remote.doc, remote.sourceId) === h) {
        adoptSaved(key, l, target, { rev: remote.rev, hash: h });
        setStatus(`「${name}」は Gist と同じ内容です（保存済み）`);
        renderAll();
        return;
    }
    let conflictOf: string | undefined;
    const known = !!remote && !!l.sent && target === l.draftId && remote.rev === l.sent.rev;
    if (remote && !known) {
        const st = levelsLoaded && remote.sourceId !== null ? editStateOf(remote.doc, remote.sourceId) : null;
        const what = st?.kind === 'edited' ? `（変更: ${st.changes.join('・')}）` : '';
        const choice = await choose(
            `「${name}」には ${remote.device} で ${fmtTime(remote.updatedAt)} に保存された別の内容の下書きが Gist にあります${what}。この端末の内容をどう保存しますか？`,
            [['overwrite', '上書きする'], ['copy', '別の下書きとして保存'], ['cancel', 'やめる']]);
        if (choice === 'copy') { conflictOf = target; target = newDraftId(); remote = undefined; }
        else if (choice !== 'overwrite') return;
    }
    try {
        const e = await sync.writeDraft(target, l.doc, l.sourceId, remote?.rev ?? 0, conflictOf);
        adoptSaved(key, l, target, { rev: e.rev, hash: h });
        setStatus(`「${name}」を Gist に保存しました（他の端末の DRAFTS に出ます）`);
    } catch (err) {
        errStatus(`Gist に保存できませんでした: ${(err as Error).message}`);
    }
    renderAll();
}
/** 保存した下書きの id と rev を端末内の下書きに記録する（保存先が別の id になったら付け替える） */
function adoptSaved(key: string, l: LocalDraft, target: string, sent: SentMark) {
    if (target === l.draftId) { localDrafts.setSent(key, sent); return; }
    const nkey = draftKey(l.doc.rule, l.sourceId, target);
    const cur = localDrafts.get(key) ?? l;   // 保存の待ち時間に編集が続いていたらその内容を残す
    if (nkey !== key) localDrafts.remove(key);
    localDrafts.put(nkey, { ...cur, draftId: target, sent });
    if (draftId === l.draftId) { draftId = target; localDrafts.setCurrent({ key: curDraftKey(), rule: doc.rule, sourceId, draftId }); }
}

/** 選択肢を出して選ばせる（ダイアログ。Esc・閉じるは 'cancel'） */
function choose(msg: string, opts: [string, string][]): Promise<string> {
    const dlg = $<HTMLDialogElement>('choice-dlg');
    $('choice-msg').textContent = msg;
    $('choice-btns').innerHTML = opts.map(([v, label]) => `<button value="${escapeHtml(v)}">${escapeHtml(label)}</button>`).join('');
    dlg.returnValue = '';
    dlg.showModal();
    // ボタンの click で直接決める（close イベントは画面が非表示の間は遅れて届くことがあるため、閉じる操作の保険にだけ使う）
    return new Promise(res => {
        let done = false;
        const finish = (v: string) => {
            if (done) return;
            done = true;
            $('choice-btns').removeEventListener('click', onClick);
            res(v);
        };
        const onClick = (e: Event) => {
            const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
            if (!b) return;
            e.preventDefault();
            dlg.close(b.value);
            finish(b.value);
        };
        $('choice-btns').addEventListener('click', onClick);
        dlg.addEventListener('close', () => finish(dlg.returnValue || 'cancel'), { once: true });
    });
}

function onSyncState() {
    if (sync.enabled) { solutions = sync.solutions(); solutionsLoaded = true; }
    syncUi?.refresh();
    if (ui.mode === 'place') renderPlace();
    renderTopbar();       // LEVELS の ●・↓
    renderEditState();    // SAVED / SAVED* / ↓ 端末
    renderOutput();
}

function onSyncEvent(ev: SyncEvent) {
    announceIncoming();
    if (ev.skippedSolutions.length) warnStatus(`他の端末の方が新しかったため保存しなかった解答: ${ev.skippedSolutions.join(', ')}`);
    onSyncState();
}

// ─── PLACE モード・キー同期・解答ファイル ───
const place = new PlaceMode({
    doc: () => doc,
    commit: (m, key) => commit(m, key),
    renderAll: () => renderAll(),
    renderField: () => renderField(),
    status: msg => warnStatus(msg),
});
let binds = loadPlaceBinds();
let tuning = loadPlaceTuning();
place.setTuning(tuning);
let solutions: SolutionMap = {};
let solutionsLoaded = false;

/** 既存問題を開く時に解答ファイルの手順を付ける */
function withSolution(d: EditorDoc): EditorDoc {
    const e = d.rule === 'tet' ? solutions[d.id] : undefined;
    if (e) { d.steps = e.steps.map(s => ({ ...s })); d.solutionNote = e.note ?? ''; }
    return d;
}

// ─── 編集の状態（ファイルの元の問題と比べる。§pc-ux 3）。自動保存はファイルを書かないが、変わっていることは常に見せる ───
type EditKind = 'file' | 'edited' | 'solution' | 'new';
interface EditState { kind: EditKind; changes: string[]; }
function levelById(rule: Rule, id: string | null): LevelRaw | undefined {
    return id === null ? undefined : levels[rule].find(l => l.id === id);
}
/** d（元 src）がファイルの問題からどう変わったか。問題が同じで手順・メモだけ違えば solution */
function editStateOf(d: EditorDoc, src: string | null): EditState {
    const raw = levelById(d.rule, src);
    if (!raw) return { kind: 'new', changes: [] };
    const base = withSolution(docFromLevel(raw));
    const changes = levelChanges(buildLevel(base), buildLevel(d));
    if (changes.length) return { kind: 'edited', changes };
    if (JSON.stringify([base.steps, base.solutionNote]) !== JSON.stringify([d.steps, d.solutionNote])) return { kind: 'solution', changes: ['手順'] };
    return { kind: 'file', changes: [] };
}
const EDIT_KIND_LABEL: Record<EditKind, string> = { file: 'FILE', edited: 'EDITED', solution: 'SOLUTION', new: 'NEW' };
const EDIT_KIND_TITLE: Record<EditKind, string> = {
    file: 'ファイル（tdata/pdata.json）の内容のままです',
    edited: 'ファイルの内容から変更があります（まだ書き込んでいません。自動保存はファイルを書き換えません）',
    solution: '問題はファイルのまま。解答手順・メモだけが保存済みの内容と違います',
    new: 'ファイルに無い新しい問題です',
};
function renderEditState() {
    const chip = $('state-chip');
    chip.hidden = !levelsLoaded;
    if (!levelsLoaded) return;
    const st = editStateOf(doc, sourceId);
    const send = curSendState();
    const sendLabel = send.kind === 'saved' ? 'SAVED' : send.kind === 'changed' ? 'SAVED*' : send.kind === 'incoming' ? `↓ ${send.entry!.device}` : '';
    const sendTitle = send.kind === 'saved' ? 'Gist の下書きと同じ内容です'
        : send.kind === 'changed' ? 'Gist に保存した後に変更しています（もう一度 SAVE すると反映されます）'
        : send.kind === 'incoming' ? `${send.entry!.device} で保存された別の内容の下書きが Gist にあります（DRAFTS から開けます）` : '';
    chip.className = `state-chip ${st.kind}`;
    chip.innerHTML = `<b>${EDIT_KIND_LABEL[st.kind]}</b>` +
        (st.kind === 'edited' ? `<span class="chg">${escapeHtml(st.changes.join('・'))}</span>` : '') +
        (sendLabel ? `<span class="send ${send.kind}">${escapeHtml(sendLabel)}</span>` : '');
    chip.title = EDIT_KIND_TITLE[st.kind] + (sendTitle ? `\n${sendTitle}` : '');
    $('btn-revert').hidden = st.kind === 'file' || st.kind === 'new';
}

/** ファイルの内容（と保存済みの解答手順）に戻す。UNDO で取り消せる */
function revertToFile() {
    const raw = levelById(doc.rule, sourceId);
    if (!raw) return;
    const st = editStateOf(doc, sourceId);
    if (!confirm(`「${sourceId}」をファイルの内容に戻します（変更: ${st.changes.join('・') || 'なし'}）。UNDO で取り消せます。よろしいですか？`)) return;
    const d = withSolution(docFromLevel(raw));
    commit(() => { doc = d; });
    place.view = doc.steps.length;
    afterDocReplaced();
    hideNotice();
    setStatus('ファイルの内容に戻しました（UNDO で取り消せます）');
}

// ─── 閉じるまで残るお知らせ（前回の編集の復元など）。REVERT を付けられる ───
const NOTICE_MARK = '\u200b';   // この種類のお知らせの目印（別の問題を開いた・ファイルに戻したら閉じる）
function showNotice(msg: string, withRevert: boolean) {
    hideNotice();
    toast(msg + NOTICE_MARK, 'warn', {
        sticky: true,
        actions: withRevert ? [{ label: 'REVERT', title: 'ファイルの内容に戻す（UNDO で取り消せます）', run: revertToFile }] : [],
    });
}
function hideNotice() { dismissToasts(m => m.endsWith(NOTICE_MARK)); }

/** 解答ファイルに保存済みの内容と一致するか */
function solutionSaved(): boolean {
    const e = solutions[doc.id];
    if (!e) return doc.steps.length === 0;
    return JSON.stringify(e.steps) === JSON.stringify(doc.steps) && (e.note ?? '') === doc.solutionNote;
}

/**
 * 盤面のモードは3つ。PAINT・STAMP は「問題（初期盤面）を変える」、SOLVE は「解答手順を記録するだけ（問題は変わらない）」。
 * 内部では ui.mode（paint/place）と place.sub（solve/stamp）の2段で持つ
 */
type EditMode = 'paint' | 'stamp' | 'solve';
function curMode(): EditMode { return ui.mode === 'paint' ? 'paint' : place.sub; }
function setMode(mode: EditMode) {
    if (mode !== 'paint' && doc.rule !== 'tet') { warnStatus('ぷよのミノ配置は未対応です（段階4）'); return; }
    if (mode !== 'solve') ui.lastEdit = mode;
    place.releaseAll();
    ui.mode = mode === 'paint' ? 'paint' : 'place';
    if (mode === 'paint') { place.resetActive(); renderAll(); }
    else place.setSub(mode);   // renderAll を含む
    if (mode === 'solve' && !mobileMq.matches) setPTab('steps');
    focusField();
}
const MODE_BAND: Record<EditMode, [string, string]> = {
    paint: ['EDIT · PAINT', '初期盤面を塗ります（問題が変わります）'],
    stamp: ['EDIT · STAMP', '初期盤面にミノを置きます（問題が変わります）'],
    solve: ['SOLVE', '解答手順を記録します（問題は変わりません）'],
};

// ─────────────────────────────────────────────
// 描画
// ─────────────────────────────────────────────
function renderAll() {
    renderPlace();
    renderTopbar();
    renderEditState();
    renderInfo();
    renderCond();
    renderField();
    renderPalette();
    renderNext();
    renderPreview();
    renderOutput();
    saveDraftSoon();
    renderHold();
    renderField();   // ツール・見出しの高さが確定してから盤面の大きさを合わせ直す
}

function renderPlace() {
    const mode = curMode();
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) {
        const on = b.dataset.mode === mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        if (b.dataset.mode !== 'paint') b.disabled = doc.rule !== 'tet';
    }
    body().dataset.mode = mode;
    $('mode-name').textContent = MODE_BAND[mode][0] + (mode === 'paint' && ui.rowMode ? ' · ROW' : '');
    $('mode-desc').textContent = doc.rule === 'tet' ? MODE_BAND[mode][1] : MODE_BAND[mode][1] + '・ぷよは PAINT のみ';
    $('paint-box').hidden = ui.mode !== 'paint';
    $('place-box').hidden = ui.mode !== 'place';
    $('solve-box').hidden = mode !== 'solve';
    $('steps-idle').hidden = mode === 'solve' || doc.rule !== 'tet';
    $('strict-wrap').hidden = mode !== 'solve';
    $<HTMLInputElement>('in-strict').checked = place.strict;
    const stepsNote = $('steps-note');
    stepsNote.hidden = doc.rule === 'tet';
    stepsNote.textContent = 'ぷよの解答手順の記録は未対応です（段階4）';
    if (ui.mode !== 'place') return;
    $('bind-src').textContent = `操作キー: ${sourceLabel(binds.source)}・${tuningLabel(tuning)}（? で一覧）`;
    place.renderPanel($('layout'));   // PC では #solve-box が #col-steps へ移るので、レイアウト全体から探す
    setVal($<HTMLInputElement>('sol-note'), doc.solutionNote);
    const st = $('sol-status');
    if (sync.enabled) st.textContent = solutionSaved() ? `Gist に保存済み${sync.pendingCount() ? '（送信待ち）' : ''}` : '未保存の変更があります';
    else if (!solutionsLoaded) st.textContent = `${SOLUTION_PATH} を読み込めませんでした（新規作成されます）`;
    else st.textContent = solutionSaved() ? '保存済み' : '未保存の変更があります';
    $('btn-sol-pick').textContent = sync.enabled ? 'EXPORT FILE' : 'CHOOSE FILE';
    $('btn-sol-pick').title = sync.enabled ? 'Gist の解答をローカルの tsolutions.json に書き出す' : '保存先のファイルを選び直す';
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
            opts.push(`<option value="${rule}:${i}">${levelMark(rule, String(l.id))}${i + 1}. ${escapeHtml(String(l.id))}  ${escapeHtml(String(l.description ?? ''))}${stars}</option>`);
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

/** LEVELS の印: ● = この端末に編集中の下書きがある、↓ = 他の端末の下書きが Gist に届いている */
function levelMark(rule: Rule, id: string): string {
    const local = localDrafts.get(draftKey(rule, id, ''));
    const r = remoteFor(rule, id, local?.draftId ?? '');
    let incoming = false;
    if (r) {
        const h = contentHash(r[1].doc, r[1].sourceId);
        incoming = !local || (contentHash(local.doc, local.sourceId) !== h && !(local.sent && r[0] === local.draftId && r[1].rev === local.sent.rev));
    }
    return (local ? '● ' : '') + (incoming ? '↓ ' : '');
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

// ─── モバイル配置（§14.5。幅 760px 以下は下部タブで1項目ずつ表示） ───
const mobileMq = matchMedia('(max-width: 760px)');
type MTab = 'field' | 'next' | 'goal' | 'steps' | 'out';
const MTAB_KEY = 'tetlabo.quizEditor.mtab';

/**
 * 盤面のマスの大きさ。モバイル配置では「画面幅」と「盤面以外を並べた残りの高さ」に収まるよう縮める
 * （FIELD タブはツールまで一画面に収める。STEPS タブは手順リストが長くなりうるので下に 200px ぶん見せる）
 */
function cellSize(rule: Rule): number {
    if (!mobileMq.matches) {
        // PC: 盤面エリア（#col-center）の高さに収める。高さが固定されない（低い画面）ときは従来の大きさ
        const area = $('col-center');
        if (getComputedStyle(area).overflowY !== 'auto') return fieldCellSize(rule);
        const kids = [...area.children].filter(el => (el as HTMLElement).offsetParent !== null) as HTMLElement[];
        if (!kids.length) return fieldCellSize(rule);
        const content = kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top;
        const cs = getComputedStyle(area);
        const avail = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (content - fieldCanvas.offsetHeight) - 2;
        return Math.max(12, Math.min(fieldCellSize(rule), Math.floor(avail / rows(rule))));
    }
    const C = cols(rule), R = rows(rule);
    const w = document.documentElement.clientWidth - 16 - 32;   // #layout の左右余白＋パネル・枠の余白
    const viewH = window.visualViewport?.height ?? window.innerHeight;
    const board = fieldCanvas.offsetHeight;
    const others = body().dataset.mtab === 'steps'
        ? $('topbar').offsetHeight + $('mtabs').offsetHeight + 260
        : $('topbar').offsetHeight + $('mtabs').offsetHeight + ($('layout').offsetHeight - board) + 8;
    const h = viewH - others;
    return Math.max(12, Math.min(fieldCellSize(rule), Math.floor(Math.min(w / C, h / R))));
}
function body(): HTMLElement { return document.body; }

// ─── PC のサイドパネルのタブ（pc-ux §4。data-p を持つパネルを body[data-ptab] で切り替える） ───
type PTab = 'info' | 'steps' | 'preview' | 'out';
const PTAB_KEY = 'tetlabo.quizEditor.ptab';
function setPTab(t: PTab) {
    body().dataset.ptab = t;
    try { localStorage.setItem(PTAB_KEY, t); } catch { /* 保存不可 */ }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#ptabs button')) b.classList.toggle('on', b.dataset.ptab === t);
}

function setMTab(t: MTab) {
    body().dataset.mtab = t;
    try { localStorage.setItem(MTAB_KEY, t); } catch { /* 保存不可 */ }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mtabs button')) b.classList.toggle('on', b.dataset.mtab === t);
    // STEPS は解答手順（PLACE の SOLVE）を見る場所
    if (t === 'steps' && doc.rule === 'tet' && curMode() !== 'solve') setMode('solve');
    renderAll();
    window.scrollTo({ top: 0 });
}

function renderField() {
    if (ui.mode === 'place') {
        const fv = place.fieldView();
        drawField(fieldCanvas, {
            rule: 'tet', field: fv.field, cell: cellSize('tet'),
            cursor: null, hover: null, rowMode: false, showCursor: false,
            piece: fv.piece, ghost: fv.ghost,
        });
        if (place.sub === 'stamp') drawStampButtons($('stamp-grid'), place.stampType, place.activeRot);   // 回転の表示を追従
        return;
    }
    drawField(fieldCanvas, {
        rule: doc.rule, field: doc.field, cell: cellSize(doc.rule),
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

// キャレット操作・削除・並べ替え（キーボードが無いタッチ端末用。PC でも使える）
// PC は 1 行に収めるため、CLEAR・MOVE は ⋯ の中（スマホは今どおり全部並べる。layout §1.5）
const NEXT_EDIT_BUTTONS = '<span class="next-edit">' +
    '<button type="button" data-nx="caret-left" title="キャレットを左へ (←)">◀</button>' +
    '<button type="button" data-nx="caret-right" title="キャレットを右へ (→)">▶</button>' +
    '<button type="button" data-nx="del" title="キャレットの左を削除 (Backspace)">DEL</button>' +
    '</span>' +
    '<span class="nx-more">' +
    '<button type="button" class="nx-more-btn pc-only" data-nx="more" title="その他（CLEAR・MOVE）" aria-haspopup="true">⋯</button>' +
    '<span class="nx-more-pop">' +
    '<button type="button" id="btn-next-clear" title="NEXT を全部消す">CLEAR</button>' +
    '<button type="button" data-nx="move-left" title="キャレットの左の項目を1つ前へ">MOVE ◀</button>' +
    '<button type="button" data-nx="move-right" title="キャレットの左の項目を1つ後ろへ">MOVE ▶</button>' +
    '</span></span>';

/** SOLVE 中の NEXT 列に出す個数（ゲームの NEXT 欄と同じ。public/quiz/quiz.js _startTet） */
const GAME_NEXT_SHOWN = 5;

function nextCanvas(i: number | null): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    const w = doc.rule === 'tet' ? 44 : 20, h = doc.rule === 'tet' ? 24 : 40;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    if (i === null) return cv;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (doc.rule === 'tet') drawMinoCentered(ctx, doc.next[i], w / 2, h / 2, 10);
    else drawPairCentered(ctx, doc.pairs[i], w / 2, h / 2, 18);
    return cv;
}

function renderNext() {
    const box = $('next-box');
    box.innerHTML = '';
    const n = nextLen();
    const usage = curMode() === 'solve' ? place.nextUsage() : null;
    box.classList.toggle('game', !!usage);
    box.title = usage ? 'SOLVE 中は NEXT を編集できません（EDIT に戻すには P）' : '';
    if (usage) {
        // SOLVE: ゲームと同じく「今のミノの次から 5 個」だけ。置くたびに上へ詰まり、尽きた所は空（layout §7）
        for (let k = 0; k < GAME_NEXT_SHOWN; k++) {
            const i = usage.now + k;
            const item = document.createElement('span');
            item.className = 'next-item slot';
            const no = document.createElement('span');
            no.className = 'no';
            no.textContent = i < n ? String(i + 1) : '';
            item.append(nextCanvas(i < n ? i : null), no);
            box.append(item);
        }
        $('next-count').textContent = `残り${Math.max(0, n - usage.now)}`;
    } else {
        const addCaret = (i: number) => {
            const c = document.createElement('span');
            c.className = 'caret' + (i === ui.nextCaret ? ' on' : '');
            box.append(c);
        };
        for (let i = 0; i < n; i++) {
            addCaret(i);
            const item = document.createElement('span');
            item.className = 'next-item';
            item.draggable = !coarsePointer();   // タッチは HTML5 DnD が使えない端末があるので自前のドラッグ（長押し）
            item.dataset.index = String(i);
            const no = document.createElement('span');
            no.className = 'no';
            no.textContent = String(i + 1);
            item.append(nextCanvas(i), no);
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
    }
    const text = $<HTMLInputElement>('next-text');
    setVal(text, doc.rule === 'tet' ? nextToText(doc.next) : pairsToText(doc.pairs));
    text.placeholder = doc.rule === 'tet' ? '例: TSZJ' : '例: 12 34 11（軸・子）';
    text.readOnly = !!usage;

    const tools = $('next-tools');
    if (tools.dataset.rule !== doc.rule) {
        tools.dataset.rule = doc.rule;
        tools.innerHTML = doc.rule === 'tet'
            ? MINO_LETTERS.map((L, t) => `<button type="button" data-mino="${t}" title="挿入 (${L})">${L}</button>`).join('') +
              '<button type="button" id="btn-bag" title="7種1巡を追加 (B)">+BAG</button>' + NEXT_EDIT_BUTTONS
            : [1, 2, 3, 4, 5].map(v => `<button type="button" data-puyo="${v}" title="${v}">${v}</button>`).join('') +
              '<button type="button" id="btn-swap" title="直前のペアの軸/子を入れ替え (X)">SWAP</button>' + NEXT_EDIT_BUTTONS;
    }
    for (const b of tools.querySelectorAll<HTMLButtonElement>('button')) b.disabled = !!usage;
    if (usage) tools.classList.remove('more-open');
    renderNextStrip(usage);
}

/** PC・SOLVE: 盤面の下に NEXT 全体を 1 行で（使い終えた物は暗く、今のミノに下線）。EDIT 中の編集行と同じ高さ */
function renderNextStrip(usage: { used: number; now: number } | null) {
    const strip = $('next-strip');
    strip.hidden = !usage;
    if (!usage || mobileMq.matches) return;
    const n = nextLen();
    const cw = doc.rule === 'tet' ? 30 : 14, ch = 26;
    const dpr = window.devicePixelRatio || 1;
    const cv = $<HTMLCanvasElement>('next-strip-cv');
    const W = Math.max(1, n) * cw;
    cv.width = W * dpr; cv.height = ch * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${ch}px`;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, ch);
    for (let i = 0; i < n; i++) {
        ctx.globalAlpha = i < usage.used ? 0.25 : 1;
        if (doc.rule === 'tet') drawMinoCentered(ctx, doc.next[i], i * cw + cw / 2, ch / 2 - 2, 6);
        else drawPairCentered(ctx, doc.pairs[i], i * cw + cw / 2, ch / 2 - 2, 9);
        if (i >= usage.used && i < usage.now) {
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#42c8f5';
            ctx.fillRect(i * cw + 3, ch - 3, cw - 6, 2);
        }
    }
    ctx.globalAlpha = 1;
    // 今のミノが見える位置までスクロール
    const sc = $('next-strip-scroll');
    const x = usage.used * cw;
    if (x < sc.scrollLeft || x + cw > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = Math.max(0, x - cw * 2);
}

/** PC: 盤面の下にプレイ画面の見出し（TET - n ★ / 問題名 / GOAL） */
function renderPlayHead() {
    const num = levelNumber();
    const stars = doc.diff === null ? '' : Array.from({ length: 5 }, (_, i) => (i < Math.round(doc.diff!) ? '<span class="sf">★</span>' : '<span class="se">☆</span>')).join('');
    $('play-head').innerHTML =
        `<span class="pv-rule">${doc.rule === 'tet' ? 'TET' : 'PUYO'} — ${num}${stars ? ` <span class="pv-stars">${stars}</span>` : ''}</span>` +
        `<span class="pv-desc">${escapeHtml(doc.description) || '<i>（問題名なし）</i>'}</span>` +
        `<span class="pv-goal">GOAL: ${escapeHtml(doc.cond.description)}</span>`;
}

/** PC: 盤面の左の HOLD 枠（編集中は許可の ON/OFF、SOLVE 中は持っているミノ。不許可はゲームと同じ斜線） */
function renderHold() {
    const col = $('hold-col');
    col.hidden = doc.rule !== 'tet';
    if (col.hidden || mobileMq.matches) return;
    const solving = curMode() === 'solve';
    const t = solving && doc.allowHold ? place.holdPiece() : null;
    const cv = $<HTMLCanvasElement>('hold-cv');
    const dpr = window.devicePixelRatio || 1, w = 56, h = 36;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (t !== null) drawMinoCentered(ctx, t, w / 2, h / 2, 11);
    const box = $('hold-box');
    box.classList.toggle('off', !doc.allowHold);
    $('hold-state').textContent = doc.allowHold ? (solving ? 'HOLD' : 'ON') : 'OFF';
    box.title = solving ? 'HOLD を使う/使わない（HOLD キー）' : `HOLD 許可の切替 (H)・いま ${doc.allowHold ? '許可' : '不許可'}`;
}

function renderPreview() {
    renderPlayHead();
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
    const nIssue = lastIssues.filter(i => i.level !== 'info').length;
    const badge = $('out-badge');
    badge.hidden = nIssue === 0;
    badge.textContent = String(nIssue);
    badge.classList.toggle('err', hasError);
    $<HTMLButtonElement>('btn-copy').disabled = hasError;
    $<HTMLButtonElement>('btn-download').disabled = hasError;
    $<HTMLTextAreaElement>('out-json').value = outputText();
    for (const id of ['btn-write', 'btn-test']) $<HTMLButtonElement>(id).disabled = hasError;
    const save = $<HTMLButtonElement>('btn-save-gist');
    save.hidden = !sync.enabled;
    const send = curSendState().kind;
    save.textContent = send === 'saved' ? 'SAVED' : 'SAVE';
    save.classList.toggle('on', !!curLocal() && send !== 'saved');
    renderWritePos();
}

/** 書き込み位置の選択肢（既存なら「今の位置」＝置換、新規なら「末尾」＝追加。他は n番目に移動/挿入） */
function renderWritePos() {
    const sel = $<HTMLSelectElement>('write-pos');
    const list = levels[doc.rule];
    const src = sourceId === null ? -1 : list.findIndex(l => l.id === sourceId);
    const n = src >= 0 ? list.length : list.length + 1;
    const opts = [`<option value="-1">${src >= 0 ? `今の位置（${src + 1}番・置換）` : `末尾（${n}番・追加）`}</option>`];
    for (let k = 0; k < n; k++) if (k !== src && !(src < 0 && k === n - 1)) opts.push(`<option value="${k}">${k + 1}番にする</option>`);
    const html = opts.join('');
    if (sel.dataset.html !== html) {
        const keep = sel.value;
        sel.innerHTML = html; sel.dataset.html = html;
        sel.value = [...sel.options].some(o => o.value === keep) ? keep : '-1';
    }
    const file = doc.rule === 'tet' ? 'tdata.json' : 'pdata.json';
    $('write-info').textContent = !canWriteFiles()
        ? 'ファイルへの直接書き込みは Chrome / Edge のみ対応です（COPY JSON を使ってください）'
        : `${file} に${src >= 0 ? `「${sourceId}」を置き換えて` : '新しい問題として'}書き込みます${editStateOf(doc, sourceId).kind === 'edited' ? '（未書き込みの変更あり）' : ''}`;
    $('write-info').classList.toggle('warn', editStateOf(doc, sourceId).kind === 'edited');
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
    const s = rect.width / cols(doc.rule);   // 表示サイズは画面幅で変わる（モバイル配置）
    const c = Math.floor((e.clientX - rect.left) / s), r = Math.floor((e.clientY - rect.top) / s);
    if (r < 0 || r >= rows(doc.rule) || c < 0 || c >= cols(doc.rule)) return null;
    return { r, c };
}

// マウスもタッチも Pointer Events で扱う（§14.5）。タッチは「ホバー」が無いので押している間だけ追従する
let touchDown = false;
fieldCanvas.addEventListener('pointerdown', e => {
    const p = cellAt(e);
    if (!p) return;
    e.preventDefault();
    try { fieldCanvas.setPointerCapture(e.pointerId); } catch { /* 既に離れたポインタ */ }
    const touch = e.pointerType !== 'mouse';
    touchDown = touch;
    if (!touch) focusField();
    if (ui.mode === 'place') {
        place.hoverAt(p.r, p.c);
        // テト譜のミノ配置: 左クリックで確定・右クリックで右回転。
        // タッチは誤って確定しないよう位置合わせだけ（確定は DROP / LOCK ボタン）
        if (!touch) { if (e.button === 0) place.lock(); else if (e.button === 2) place.wheel(1); }
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
fieldCanvas.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' && !touchDown) return;
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
fieldCanvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { ui.hover = null; renderField(); } });
function endPointer(e: PointerEvent) {
    dragPaint = null;
    if (e.pointerType !== 'mouse') { touchDown = false; ui.hover = null; renderField(); }
}
fieldCanvas.addEventListener('pointerup', endPointer);
fieldCanvas.addEventListener('pointercancel', endPointer);
fieldCanvas.addEventListener('contextmenu', e => e.preventDefault());
fieldCanvas.addEventListener('wheel', e => {
    if (ui.mode !== 'place') return;
    e.preventDefault();
    place.wheel(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
fieldCanvas.addEventListener('focus', renderField);
fieldCanvas.addEventListener('blur', renderField);
window.addEventListener('pointerup', () => { dragPaint = null; });

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
    if (letter === 'R') { ui.rowMode = !ui.rowMode; renderPalette(); renderPlace(); renderField(); return true; }
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
        case 'ArrowLeft': case 'ArrowUp': ui.nextCaret = Math.max(0, ui.nextCaret - 1); ui.pendingPuyo = 0; renderNext(); return true;
        case 'ArrowRight': case 'ArrowDown': ui.nextCaret = Math.min(n, ui.nextCaret + 1); ui.pendingPuyo = 0; renderNext(); return true;
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
    if (curMode() === 'solve') { warnStatus('SOLVE 中は NEXT を編集できません（EDIT に戻すには P）'); return; }
    const item = (e.target as HTMLElement).closest<HTMLElement>('.next-item');
    ui.nextCaret = item ? Number(item.dataset.index) + 1 : nextLen();
    ui.pendingPuyo = 0;
    nextBox.focus();
    renderNext();
});
// タッチでの並べ替え: 長押しで掴んで、離した位置の項目と入れ替える（iOS Safari は HTML5 DnD 非対応）
const touchDrag = { from: -1, timer: 0, active: false, x: 0, y: 0 };
function clearTouchDrag() {
    clearTimeout(touchDrag.timer);
    touchDrag.from = -1;
    touchDrag.active = false;
    nextBox.classList.remove('dragging');
    for (const el of nextBox.querySelectorAll('.drag-src, .drag-over')) el.classList.remove('drag-src', 'drag-over');
}
nextBox.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || curMode() === 'solve') return;
    const item = (e.target as HTMLElement).closest<HTMLElement>('.next-item');
    if (!item) return;
    clearTouchDrag();
    touchDrag.from = Number(item.dataset.index);
    touchDrag.x = e.clientX; touchDrag.y = e.clientY;
    touchDrag.timer = window.setTimeout(() => {
        touchDrag.active = true;
        nextBox.classList.add('dragging');
        item.classList.add('drag-src');
        navigator.vibrate?.(10);
    }, 350);
});
nextBox.addEventListener('pointermove', e => {
    if (touchDrag.from < 0) return;
    if (!touchDrag.active) {
        // 長押しが成立する前に指が動いたらスクロールとみなす
        if (Math.hypot(e.clientX - touchDrag.x, e.clientY - touchDrag.y) > 8) clearTouchDrag();
        return;
    }
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.next-item');
    for (const el of nextBox.querySelectorAll('.drag-over')) if (el !== over) el.classList.remove('drag-over');
    over?.classList.add('drag-over');
});
nextBox.addEventListener('pointerup', e => {
    if (!touchDrag.active) { clearTouchDrag(); return; }
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.next-item');
    const from = touchDrag.from;
    clearTouchDrag();
    if (over) moveNext(from, Number(over.dataset.index));
});
nextBox.addEventListener('pointercancel', clearTouchDrag);
// 掴んでいる間はページをスクロールさせない
nextBox.addEventListener('touchmove', e => { if (touchDrag.active) e.preventDefault(); }, { passive: false });
nextBox.addEventListener('contextmenu', e => { if (coarsePointer()) e.preventDefault(); });

let dragFrom = -1;
nextBox.addEventListener('dragstart', e => {
    if (curMode() === 'solve') { e.preventDefault(); return; }
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
    else if (b.dataset.nx) {
        const i = ui.nextCaret - 1, n = nextLen();
        switch (b.dataset.nx) {
            case 'caret-left': ui.nextCaret = Math.max(0, ui.nextCaret - 1); ui.pendingPuyo = 0; renderNext(); break;
            case 'caret-right': ui.nextCaret = Math.min(n, ui.nextCaret + 1); ui.pendingPuyo = 0; renderNext(); break;
            case 'del': if (ui.pendingPuyo) { ui.pendingPuyo = 0; renderNext(); } else deleteNext(i); break;
            case 'move-left': if (i > 0) moveNext(i, i - 1); break;
            case 'move-right': if (i >= 0 && i < n - 1) moveNext(i, i + 1); break;
            case 'more': $('next-tools').classList.toggle('more-open'); return;
        }
    }
    $('next-tools').classList.remove('more-open');
    if (!coarsePointer()) nextBox.focus();
});

// ⋯ の外を押したら閉じる
document.addEventListener('pointerdown', e => {
    if (!(e.target as Element).closest?.('.nx-more')) $('next-tools').classList.remove('more-open');
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
$('btn-row').addEventListener('click', () => { ui.rowMode = !ui.rowMode; renderPalette(); renderPlace(); focusField(); });
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
    if (raw) {
        // この端末に編集中の下書きがあればその続きを開く。他の端末の下書きが届いていれば、そちらを開くか聞く
        const id = String(raw.id);
        const local = localDrafts.get(draftKey(rule, id, ''));
        const incoming = levelMark(rule, id).includes('↓') ? remoteFor(rule, id, local?.draftId ?? '') : undefined;
        if (incoming && confirm(`「${id}」には ${incoming[1].device} で保存された下書きが Gist にあります（${fmtTime(incoming[1].updatedAt)}）。そちらを開きますか？\n（キャンセルで${local ? 'この端末の編集中の内容' : 'ファイルの内容'}を開きます）`)) openDraft(incoming[0]);
        else if (local) {
            openDoc(cloneDoc(local.doc), local.sourceId, local.draftId);
            const st = editStateOf(doc, sourceId);
            showNotice(`「${id}」はこの端末で編集中の内容を開きました（変更: ${st.changes.join('・') || 'なし'}）`, true);
        } else openDoc(withSolution(docFromLevel(raw)), id);
    }
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
// お知らせはトースト1か所に出す（save-notify §1。画面の部品の位置を動かさない）
function setStatus(msg: string) { toast(msg, 'info'); }
function warnStatus(msg: string) { toast(msg, 'warn'); }
function errStatus(msg: string) { toast(msg, 'error'); }
async function copyJson() {
    if (lastIssues.some(i => i.level === 'error')) { warnStatus('エラーがあるためコピーできません'); return; }
    try {
        await navigator.clipboard.writeText(outputText());
        setStatus('コピーしました。tdata/pdata.json に貼った後は ASSET_VERSION を +1 してください');
    } catch {
        const ta = $<HTMLTextAreaElement>('out-json');
        ta.select();
        warnStatus('自動コピーできませんでした。選択済みのテキストをコピーしてください');
    }
}
$('btn-copy').addEventListener('click', copyJson);

// ─── tdata.json / pdata.json への直接書き込み（この問題の範囲だけを差し替える） ───
async function writeLevelsFile(forcePick: boolean) {
    if (lastIssues.some(i => i.level === 'error')) { warnStatus('エラーがあるため書き込めません'); return; }
    if (!canWriteFiles()) { warnStatus('このブラウザはファイルへの直接書き込みに対応していません'); return; }
    const fileName = doc.rule === 'tet' ? 'tdata.json' : 'pdata.json';
    try {
        const h = await getHandle(fileName, 'open', forcePick);
        if (h.name !== fileName && !confirm(`選んだファイルは「${h.name}」です。${fileName} ではありませんが書き込みますか？`)) return;
        const text = await readText(h);
        const arr = JSON.parse(text) as unknown;
        if (!Array.isArray(arr)) throw new Error('問題の配列ではありません');
        const wrongRule = arr.find(l => (l as LevelRaw)?.rule !== doc.rule);
        if (wrongRule) throw new Error(`${doc.rule.toUpperCase()} 以外の問題が含まれています（別のファイルではありませんか？）`);
        const list = arr as LevelRaw[];
        const src = sourceId === null ? -1 : list.findIndex(l => l.id === sourceId);
        const dup = list.findIndex((l, i) => i !== src && l.id === doc.id);
        if (dup >= 0) throw new Error(`ID「${doc.id}」はファイル内の ${dup + 1}番と重複しています`);
        if (sourceId !== null && src < 0 && !confirm(`ファイル内に「${sourceId}」が見つかりません（外部で変更された可能性）。新しい問題として追加しますか？`)) return;

        const dst = Number($<HTMLSelectElement>('write-pos').value);
        const plan = planWrite(text, src, dst, serializeLevel(doc, 1), buildLevel(doc));
        const changes = src >= 0 ? levelChanges(buildLevel(docFromLevel(list[src])), buildLevel(doc)) : [];
        const changeLine = src >= 0 ? `\n変更: ${changes.join('・') || 'なし'}` : '';
        const what = plan.action === 'replace' ? `${plan.index + 1}番「${sourceId}」を置き換え`
            : plan.action === 'move' ? `「${sourceId}」を ${src + 1}番 → ${plan.index + 1}番へ移動して書き換え`
            : `${plan.index + 1}番に「${doc.id}」を追加`;
        if (!confirm(`${h.name} の ${what}ます。${changeLine}\n他の問題は変更しません。よろしいですか？`)) return;

        await writeText(h, plan.text);
        levels[doc.rule] = JSON.parse(plan.text) as LevelRaw[];
        const oldKey = curDraftKey();
        const oldSrc = sourceId;
        sourceId = doc.id;
        // 書き込んだので受け渡しは終わり: この問題の Gist の下書き（同じ id か、書いた内容と同じ物）を消す。Gist の履歴には残る
        if (sync.enabled) {
            const written = buildLevel(doc);
            const ids = Object.entries(sync.drafts())
                .filter(([id, d]) => id === draftId || (d.doc.rule === doc.rule && (d.sourceId === oldSrc || d.sourceId === doc.id) && levelChanges(buildLevel(d.doc), written).length === 0))
                .map(([id]) => id);
            if (ids.length) void sync.deleteDrafts(ids).then(() => renderAll());
        }
        if (oldKey !== curDraftKey()) localDrafts.remove(oldKey);
        persistLocalNow();   // ファイルと同じになったので端末内の下書きも消える（手順だけ違えば残る）
        setStatus(`${h.name} に書き込みました（${what}）。反映には public/core/base.js の ASSET_VERSION を +1 してください`);
    } catch (err) {
        if ((err as Error).name === 'AbortError') return;   // ファイル選択をキャンセル
        console.error(err);
        errStatus(`書き込めませんでした: ${(err as Error).message}`);
    }
    renderAll();
}
$('btn-write').addEventListener('click', () => void writeLevelsFile(false));
$('btn-write-pick').addEventListener('click', () => void writeLevelsFile(true));
$<HTMLButtonElement>('btn-write-pick').hidden = !canWriteFiles();

// ─── テストプレイ（quiz.js の _bootQuizEditorTest が受け取る。ファイルは変更しない） ───
const TEST_KEY = 'tetlabo.quizEditor.test';
$('btn-test').addEventListener('click', () => {
    if (lastIssues.some(i => i.level === 'error')) { warnStatus('エラーがあるためテストプレイできません'); return; }
    try {
        localStorage.setItem(TEST_KEY, JSON.stringify(buildLevel(doc)));
    } catch {
        errStatus('テスト用データを保存できませんでした');
        return;
    }
    // 同じ名前のタブを使い回す（2回目以降はそのタブが新しい問題で読み込み直される）
    window.open('/?quizTest=1', 'tetlabo-quiz-test');
});
// 下書きを Gist に保存する（他の端末の DRAFTS に出る＝PC で書き込み待ち）
$('btn-save-gist').addEventListener('click', () => void saveToGist(curDraftKey()));
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
        title: `STAMP・SOLVE（盤面にフォーカス）— 操作キーは ${sourceLabel(binds.source)}・${tuningLabel(tuning)}`,
        rows: [
            ...PLACE_ACTIONS.map(a => ({ keys: bindLabel(binds, a), desc: ACTION_NAMES[a] })),
            { keys: 'Alt+↑（未割当なら ↑ も可）', desc: '1段上（自由配置）' },
            { keys: 'Alt+↓', desc: '一番下まで落とす（確定しない）' },
            { keys: 'Enter', desc: '今の位置で確定（浮いていても置く）' },
            { keys: 'Backspace', desc: '最後の手を取り消す（SOLVE）' },
            { keys: '[ ・ ] ・ Home ・ End', desc: '前の手 ・ 次の手 ・ 初期盤面 ・ 最後の手' },
            { keys: 'I O T J L S Z', desc: '置くミノを選ぶ（STAMP）' },
            { keys: 'マウス: 移動 ・ ホイール ・ 左クリック ・ 右クリック', desc: '位置 ・ 回転 ・ 確定 ・ 右回転（T-Spin は推定扱い）' },
            { keys: 'P / Shift+P', desc: 'EDIT ⇔ SOLVE 切替 / PAINT ⇔ STAMP 切替' },
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
    b.addEventListener('click', () => setMode(b.dataset.mode as EditMode));
}
function placeCtl(ctl: string | undefined) {
    switch (ctl) {
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
}
// 移動ボタンは押し続けると連続で動く（タッチ操作用）。押した時点で1回動かし、続く click は無視する
const REPEAT_CTL = new Set(['left', 'right', 'down', 'up']);
let ctlRepeat = { timer: 0, swallowClick: false };
function stopCtlRepeat() { clearTimeout(ctlRepeat.timer); clearInterval(ctlRepeat.timer); ctlRepeat.timer = 0; }
$('ctl-pad').addEventListener('pointerdown', e => {
    const ctl = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.ctl;
    ctlRepeat.swallowClick = false;
    if (!ctl || !REPEAT_CTL.has(ctl) || e.button !== 0) return;
    e.preventDefault();
    stopCtlRepeat();
    placeCtl(ctl);
    ctlRepeat.swallowClick = true;
    ctlRepeat.timer = window.setTimeout(() => { ctlRepeat.timer = window.setInterval(() => placeCtl(ctl), 70); }, 300);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) $('ctl-pad').addEventListener(ev, stopCtlRepeat);
$('ctl-pad').addEventListener('click', e => {
    const ctl = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.ctl;
    if (ctlRepeat.swallowClick && e.detail !== 0 && ctl && REPEAT_CTL.has(ctl)) ctlRepeat.swallowClick = false;
    else placeCtl(ctl);
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
// STAMP: 選んでいるミノをもう一度押すと右回転、右クリックで左回転（layout §5）
function stampPick(e: MouseEvent, dir: 1 | -1) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-stamp]');
    if (!b) return;
    e.preventDefault();
    const t = Number(b.dataset.stamp);
    if (t !== place.stampType) { place.setStamp(t); if (dir === -1) place.rotate(-1); }
    else place.rotate(dir);
    focusField();
}
$('stamp-grid').addEventListener('click', e => stampPick(e, 1));
$('stamp-grid').addEventListener('contextmenu', e => stampPick(e, -1));
$<HTMLInputElement>('sol-note').addEventListener('input', e => {
    const v = (e.target as HTMLInputElement).value;
    commit(() => { doc.solutionNote = v; }, 'sol-note');
});

async function saveSolutionFile(forcePick: boolean) {
    if (!doc.id.trim()) { warnStatus('ID を入力してから保存してください'); return; }
    if (doc.rule !== 'tet') return;
    const oldId = sourceId && sourceId !== doc.id && solutions[sourceId] ? sourceId : null;
    if (sync.enabled) {
        const skipped = await sync.setSolution(doc.id, oldId, { steps: doc.steps, note: doc.solutionNote, updated: today() });
        solutions = sync.solutions();
        warnStatus(skipped.includes(doc.id) ? '他の端末で、より新しい解答が保存されていたため保存しませんでした'
            : sync.state === 'synced' ? `Gist に保存しました${oldId ? `（旧 ID「${oldId}」の解答は削除）` : ''}`
            : `端末内に保存しました。${sync.message || '通信できたら Gist に送ります'}`);
        renderAll();
        return;
    }
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
        errStatus(`保存できませんでした: ${(err as Error).message}`);
    }
    renderAll();
}
$('btn-sol-save').addEventListener('click', () => void saveSolutionFile(false));
$('btn-sol-pick').addEventListener('click', () => {
    if (!sync.enabled) { void saveSolutionFile(true); return; }
    void exportSolutionsFile(sync.solutions()).then(
        r => setStatus(r.via === 'file' ? `${r.fileName} に書き出しました` : 'ダウンロードしました'),
        err => { if ((err as Error).name !== 'AbortError') errStatus(`書き出せませんでした: ${(err as Error).message}`); });
});
$<HTMLButtonElement>('btn-sol-pick').hidden = !canWriteFiles();

// TETLABO 側で KEY CONFIG を保存したら即反映（別タブの変更は storage イベントで届く）
window.addEventListener('storage', e => {
    if (e.key === 'game_binds' || e.key === 'game_keyconfig' || e.key === 'game_tuning' || e.key === null) {
        binds = loadPlaceBinds();
        tuning = loadPlaceTuning();
        place.setTuning(tuning);
        renderAll();
        if (helpDlg.open) renderHelp();
    }
});

// ─────────────────────────────────────────────
// グローバルキー
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;   // ダイアログ内はブラウザ標準
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
    if (isMod(e) && k === 's' && e.shiftKey) { e.preventDefault(); void saveToGist(curDraftKey()); return; }
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
    if (target === nextBox) handled = curMode() !== 'solve' && handleNextKey(e);   // SOLVE 中は NEXT を編集しない（layout §7）
    else if (onField && ui.mode === 'place') handled = place.handleKey(e, binds);
    else if (onField) handled = handleFieldKey(e);
    // P: EDIT（最後に使った PAINT/STAMP）⇔ SOLVE、Shift+P: PAINT ⇔ STAMP（同期キーに割り当てられていれば上で処理済み）
    if (!handled && onField && e.code === 'KeyP' && !e.altKey) {
        const m = curMode();
        if (e.shiftKey) setMode(m === 'paint' ? 'stamp' : m === 'stamp' ? 'paint' : ui.lastEdit === 'paint' ? 'stamp' : 'paint');
        else setMode(m === 'solve' ? ui.lastEdit : 'solve');
        handled = true;
    }
    if (handled) e.preventDefault();
});

// 連続移動（DAS/ARR）の押下状態は、どこで離しても・フォーカスが外れても解除する
document.addEventListener('keyup', e => place.keyUp(e.code));
window.addEventListener('blur', () => place.releaseAll());

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
            errStatus(`${file} を読み込めませんでした`);
        }
    }
}

// ─── PC 配置: 一部の部品を PC では盤面の横・サイドパネルのタブへ移す（スマホでは元の場所＝下部タブの仕組みのまま） ───
const relocations: [HTMLElement, HTMLElement][] = [
    [$('next-h'), $('next-col')], [$('next-box'), $('next-col')],
    [$('steps-note'), $('col-steps')], [$('solve-box'), $('col-steps')],
    [$('preview-wrap'), $('col-preview')],
];
const relocationHomes = relocations.map(([el]) => { const c = document.createComment(el.id); el.before(c); return c; });
function applyLayout() {
    const pc = !mobileMq.matches;
    relocations.forEach(([el, pcParent], i) => {
        if (pc) pcParent.append(el);
        else relocationHomes[i].after(el);
    });
}
applyLayout();
for (const b of document.querySelectorAll<HTMLButtonElement>('#ptabs button')) {
    b.addEventListener('click', () => setPTab(b.dataset.ptab as PTab));
}
{
    let saved: string | null = null;
    try { saved = localStorage.getItem(PTAB_KEY); } catch { /* 読めない */ }
    setPTab(saved && ['info', 'steps', 'preview', 'out'].includes(saved) ? saved as PTab : 'info');
}
// SOLVE の STRICT（端末ごとの設定）
const STRICT_KEY = 'tetlabo.quizEditor.strict';
try { place.strict = localStorage.getItem(STRICT_KEY) === '1'; } catch { /* 読めない */ }
$<HTMLInputElement>('in-strict').addEventListener('change', e => {
    place.strict = (e.target as HTMLInputElement).checked;
    try { localStorage.setItem(STRICT_KEY, place.strict ? '1' : '0'); } catch { /* 保存不可 */ }
    place.resetActive();   // 出現位置からやり直す（マウスで動かした位置を残さない）
    renderAll();
    focusField();
});
$('hold-box').addEventListener('click', () => {
    if (curMode() === 'solve') place.toggleHold();
    else commit(() => { doc.allowHold = !doc.allowHold; });
    focusField();
});

loadImages(() => { renderField(); renderPalette(); renderNext(); renderPreview(); buildStampGrid($('stamp-grid')); });
buildStampGrid($('stamp-grid'));
const restored = restoreOnBoot();
ui.nextCaret = nextLen();
place.view = doc.steps.length;
renderAll();
void loadLevels().then(() => {
    levelsLoaded = true;
    // 前回はファイルの内容のまま開いていた → その問題をファイルから開き直す
    const cur = localDrafts.current();
    if (restored === 'file' && cur && cur.sourceId !== null) {
        const raw = levelById(cur.rule, cur.sourceId);
        if (raw) { doc = withSolution(docFromLevel(raw)); sourceId = cur.sourceId; draftId = cur.draftId; ui.nextCaret = nextLen(); place.view = doc.steps.length; afterDocReplaced(); }
    }
    renderAll();
    // 前回の編集を黙って復元しない（ファイルの内容だと思って続けないように）
    if (restored === 'draft') {
        const st = editStateOf(doc, sourceId);
        const name = doc.id || '(ID なし)';
        if (st.kind === 'edited' || st.kind === 'solution') showNotice(`前回の編集を開きました（${name}・変更: ${st.changes.join('・')}）`, true);
        else if (st.kind === 'new') showNotice(`前回の編集を開きました（${name}・新しい問題）`, false);
    }
});
$('btn-revert').addEventListener('click', revertToFile);

/**
 * 起動時に前回の問題を開く。端末内の下書きがあればそれ（'draft'）、無ければ問題一覧を読んだ後にファイルから開く（'file'）。
 * 旧版の保存形式（開いている 1 問だけ・自動送信の未送信キュー）は端末内の下書きへ移す
 */
function restoreOnBoot(): 'draft' | 'file' | null {
    const legacy = localDrafts.takeLegacy();
    if (legacy) {
        const did = legacy.draftId ?? newDraftId();
        legacy.doc.steps ??= [];
        legacy.doc.solutionNote ??= '';
        const key = draftKey(legacy.doc.rule, legacy.sourceId, did);
        if (!localDrafts.get(key)) localDrafts.put(key, { doc: legacy.doc, sourceId: legacy.sourceId, draftId: did, updatedAt: new Date().toISOString() });
        localDrafts.setCurrent({ key, rule: legacy.doc.rule, sourceId: legacy.sourceId, draftId: did });
    }
    for (const [id, e] of sync.takeLegacyDrafts()) {
        const key = draftKey(e.doc.rule, e.sourceId, id);
        if (!localDrafts.get(key)) localDrafts.put(key, { doc: e.doc, sourceId: e.sourceId, draftId: id, updatedAt: e.updatedAt || new Date().toISOString() });
    }
    const cur = localDrafts.current();
    if (!cur) return null;
    const l = localDrafts.get(cur.key);
    if (l) {
        doc = cloneDoc(l.doc); sourceId = l.sourceId; draftId = l.draftId;
        doc.steps ??= [];
        doc.solutionNote ??= '';
        return 'draft';
    }
    if (cur.sourceId !== null) { doc = newDoc(cur.rule); draftId = cur.draftId; return 'file'; }
    return null;
}
// ─── お知らせの履歴（LOG。トーストは消えるので後から読めるように） ───
const logDlg = $<HTMLDialogElement>('log-dlg');
function renderLog() {
    const list = toastLog();
    $('log-body').innerHTML = list.length
        ? `<ul class="log-list">${list.map(e => `<li class="${e.kind}"><time>${String(e.at.getHours()).padStart(2, '0')}:${String(e.at.getMinutes()).padStart(2, '0')}:${String(e.at.getSeconds()).padStart(2, '0')}</time> ${escapeHtml(e.msg.replace(NOTICE_MARK, ''))}</li>`).join('')}</ul>`
        : '<p class="note">お知らせはまだありません。</p>';
}
onToastLog(() => { if (logDlg.open) renderLog(); });
$('btn-log').addEventListener('click', () => { renderLog(); logDlg.showModal(); });
// モバイル配置: 下部タブ・メニュー・画面サイズの変化
for (const b of document.querySelectorAll<HTMLButtonElement>('#mtabs button')) {
    b.addEventListener('click', () => setMTab(b.dataset.mtab as MTab));
}
{
    let saved: string | null = null;
    try { saved = localStorage.getItem(MTAB_KEY); } catch { /* 読めない */ }
    body().dataset.mtab = saved && ['field', 'next', 'goal', 'steps', 'out'].includes(saved) ? saved : 'field';
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mtabs button')) b.classList.toggle('on', b.dataset.mtab === body().dataset.mtab);
}
$('btn-menu').addEventListener('click', () => {
    const open = $('topbar').classList.toggle('menu-open');
    $('btn-menu').setAttribute('aria-expanded', String(open));
});
for (const id of ['btn-new', 'btn-paste', 'btn-log']) $(id).addEventListener('click', () => $('topbar').classList.remove('menu-open'));
let resizeRaf = 0;
function onViewportResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
        // ソフトキーボードが出ている間は下部タブを隠す（表示領域が大きく縮んだかで判定）
        const vv = window.visualViewport;
        body().classList.toggle('kbd-open', !!vv && vv.height < window.innerHeight * 0.75 && isTextInput(document.activeElement));
        renderField();
    });
}
window.addEventListener('resize', onViewportResize);
window.visualViewport?.addEventListener('resize', onViewportResize);
mobileMq.addEventListener('change', () => { applyLayout(); renderAll(); });
// スマホに無い機能を隠す（ファイル直接書込は FSA が無い・テストプレイは本体がタッチ非対応）
for (const id of ['btn-write', 'write-pos']) {
    const el = $(id);
    (el.closest('label') ?? el).hidden = !canWriteFiles();
}
$('btn-test').hidden = coarsePointer();

syncUi = initSyncUi({
    engine: sync,
    localDrafts,
    currentKey: () => curDraftKey(),
    describe: (d, src) => {
        if (src === null) return '新規';
        if (!levelsLoaded) return '';
        const st = editStateOf(d, src);
        return st.kind === 'edited' ? `変更: ${st.changes.join('・')}` : st.kind === 'solution' ? '手順のみ' : st.kind === 'file' ? 'ファイルと同じ' : '元の問題がファイルに無い';
    },
    editKind: (d, src) => levelsLoaded && src !== null ? editStateOf(d, src).kind : null,
    sendLabel: l => {
        const st = sendStateOf(l.doc, l.sourceId, l.draftId, l.sent);
        return st.kind === 'saved' ? 'SAVED' : st.kind === 'changed' ? 'SAVED*' : st.kind === 'incoming' ? `↓ ${st.entry!.device}` : sync.enabled ? '未保存' : '';
    },
    openDraft,
    openLocal,
    discardLocal,
    saveLocal: key => saveToGist(key),
    afterSolutionsChanged: () => onSyncState(),
});
// QR コードから開かれた（#sync=…）なら、その設定で接続する。トークンが URL に残らないよう即座に消す
const fromQr = decodeSyncHash(location.hash);
if (fromQr) {
    history.replaceState(null, '', location.pathname + location.search);
    void sync.connect(fromQr.token, sync.config?.device ?? guessDevice(), fromQr.gistId)
        .then(() => setStatus(sync.state === 'auth' || sync.state === 'error' ? sync.message : '同期の設定をしました'), err => errStatus(`同期の設定に失敗しました: ${(err as Error).message}`));
} else if (sync.enabled) {
    sync.start();
}
onSyncState();
announceIncoming();   // 前回取得した Gist の内容（キャッシュ）で分かる分
void fetchSolutions().then(m => {
    if (sync.enabled) return;   // 同期中は Gist の解答が正本
    solutionsLoaded = m !== null;
    solutions = m ?? {};
    // 下書きが空で、開いている問題に保存済みの解答があれば付ける
    if (!doc.steps.length && solutions[doc.id]) { withSolution(doc); place.view = doc.steps.length; }
    renderAll();
});
focusField();

// デバッグ用（コンソールから状態確認）
(window as unknown as { quizEditor: unknown }).quizEditor = { get doc() { return cloneDoc(doc); } };
