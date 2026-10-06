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
    loadImages, drawField, fieldCellSize, fitCell, rowAtY, drawCellSwatch, drawMinoCentered, drawPairCentered,
} from './render.ts';
import { KEY_HELP, isTextInput, isMod } from './keys.ts';
import { PlaceMode, buildStampGrid, drawStampButtons } from './place.ts';
import { loadPlaceBinds, loadPlaceTuning, tuningLabel, bindLabel, sourceLabel, PLACE_ACTIONS, ACTION_NAMES } from './keybinds.ts';
import { type SolutionMap, fetchSolutions, saveSolution, canWriteFiles, today, SOLUTION_PATH, exportSolutionsFile } from './solutions.ts';
import { SyncEngine, type SyncEvent, type DraftEntry, newDraftId, guessDevice, decodeSyncHash } from './sync.ts';
import { LocalDrafts, type LocalDraft, type SentMark, draftKey, contentHash } from './local-drafts.ts';
import { initSyncUi } from './sync-ui.ts';
import { getHandle, readText, writeText, canPickFiles } from './fsa.ts';
import { probeDevFiles, devFilesAvailable, devRead, devWrite } from './dev-files.ts';
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
    mode: 'paint' as 'paint' | 'place' | 'next',
    lastEdit: 'paint' as 'paint' | 'stamp' | 'next',   // P で SOLVE から戻る先
    lastBoard: 'paint' as 'paint' | 'stamp',           // NEXT モードで盤面を押した時・N で戻る先
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
    if (doc.rule !== 'tet' && ui.mode === 'place') ui.mode = 'paint';
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

/** ぷよの色の名前（1〜5。画像 puyo-0〜4.png の色。キーと JSON の値は数字のまま。tools §5.3） */
const PUYO_COLOR_NAMES = ['赤', '青', '紫', '緑', '黄'];
function colorName(v: number): string {
    if (v === 0) return '空';
    if (doc.rule === 'tet') return v === TET_GARBAGE ? 'おじゃま' : `${MINO_LETTERS[v - 1]}`;
    return v === PUYO_OJAMA ? 'おじゃま' : PUYO_COLOR_NAMES[v - 1] ?? `色${v}`;
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
    renderTopbar();       // LEVELS の ●・◆・↓
    renderLevels();
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
 * モードは4つ。PAINT・STAMP・NEXT は「問題（初期盤面・NEXT）を変える」EDIT、SOLVE は「解答手順を記録するだけ（問題は変わらない）」。
 * 内部では ui.mode（paint/place/next）と place.sub（solve/stamp）の2段で持つ。
 * キーは「フォーカスの場所」ではなく「今のモード」が解釈する（tools §4。NEXT モードならミノ文字で挿入）
 */
type EditMode = 'paint' | 'stamp' | 'next' | 'solve';
function curMode(): EditMode { return ui.mode === 'place' ? place.sub : ui.mode; }
function setMode(mode: EditMode) {
    if ((mode === 'stamp' || mode === 'solve') && doc.rule !== 'tet') { warnStatus('ぷよのミノ配置は未対応です（段階4）'); return; }
    if (mode === 'next' && mobileMq.matches) mode = boardMode();   // スマホは NEXT タブで編集する（モードは PC だけ）
    if (mode !== 'solve') ui.lastEdit = mode;
    if (mode === 'paint' || mode === 'stamp') ui.lastBoard = mode;
    const prev = curMode();
    place.releaseAll();
    ui.mode = mode === 'paint' || mode === 'next' ? mode : 'place';
    ui.pendingPuyo = 0;
    if (ui.mode !== 'place') { place.resetActive(); renderAll(); }
    else place.setSub(mode as 'stamp' | 'solve');   // renderAll を含む
    if (!mobileMq.matches) sideForSolve(prev, mode);
    focusField();
}
/** 盤面を編集するモード（NEXT モードから盤面を押した時・N で戻る先） */
function boardMode(): 'paint' | 'stamp' { return doc.rule === 'tet' ? ui.lastBoard : 'paint'; }
/** Shift+P: PAINT → STAMP → NEXT → PAINT（ぷよは PAINT ⇔ NEXT） */
function cycleEditMode(from: EditMode): EditMode {
    const order: EditMode[] = doc.rule === 'tet' ? ['paint', 'stamp', 'next'] : ['paint', 'next'];
    const i = order.indexOf(from);
    return order[(i + 1) % order.length];
}
const MODE_BAND: Record<EditMode, [string, string]> = {
    paint: ['EDIT · PAINT', '初期盤面を塗ります（問題が変わります）'],
    stamp: ['EDIT · STAMP', '初期盤面にミノを置きます（問題が変わります）'],
    next: ['EDIT · NEXT', 'NEXT を編集します（問題が変わります）'],
    solve: ['SOLVE', '解答手順を記録します（問題は変わりません）'],
};
const MODE_KEY: Record<EditMode, string> = { paint: 'Shift+P', stamp: 'Shift+P', next: 'N', solve: 'P' };

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
    renderPlayHead();
    renderOutput();
    renderStatusbar();
    renderLevels();
    saveDraftSoon();
    renderHold();
    renderField();   // ツール・見出しの高さが確定してから盤面の大きさを合わせ直す
}

function renderPlace() {
    const mode = curMode();
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) {
        const m = b.dataset.mode as EditMode;
        const on = m === mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.disabled = (m === 'stamp' || m === 'solve') && doc.rule !== 'tet';
        b.title = `${MODE_BAND[m][1]}（${MODE_KEY[m]}）` + (b.disabled ? '・ぷよは未対応' : '');
    }
    body().dataset.mode = mode;
    $('mode-name').textContent = MODE_BAND[mode][0] + (mode === 'paint' && ui.rowMode ? ' · ROW' : '');
    $('mode-desc').textContent = doc.rule === 'tet' ? MODE_BAND[mode][1] : MODE_BAND[mode][1] + '・ぷよは PAINT / NEXT のみ';
    $('paint-box').hidden = ui.mode !== 'paint';
    $('place-box').hidden = ui.mode !== 'place';
    $('nexttool-box').hidden = ui.mode !== 'next';
    $('solve-pieces').hidden = mode !== 'solve';
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
    $('btn-sol-pick').hidden = sync.enabled ? !canWriteFiles() : !canPickFiles();
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
            const mk = levelMarks(rule, String(l.id));
            const mark = (mk.edit ? `${MARK_CHAR[mk.edit]} ` : '') + (mk.incoming ? '↓ ' : '');
            opts.push(`<option value="${rule}:${i}">${mark}${i + 1}. ${escapeHtml(String(l.id))}  ${escapeHtml(String(l.description ?? ''))}${stars}</option>`);
        });
        opts.push('</optgroup>');
    }
    const html = opts.join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    const idx = sourceId === null ? -1 : levels[doc.rule].findIndex(l => l.id === sourceId);
    sel.value = idx >= 0 ? `${doc.rule}:${idx}` : '';
    // PC: 開いている問題のタブ（押すと問題の一覧）
    $('doc-tab').innerHTML = `<span class="dt-rule">${doc.rule.toUpperCase()} — ${levelNumber()}</span>` +
        `<span class="dt-id">${escapeHtml(doc.id) || '(ID なし)'}</span>` +
        `<span class="dt-desc">${escapeHtml(doc.description)}</span><span class="dt-caret">▾</span>`;
    $<HTMLButtonElement>('btn-undo').disabled = undoStack.length === 0;
    $<HTMLButtonElement>('btn-redo').disabled = redoStack.length === 0;
}

/**
 * LEVELS の印（tools §1）: ● = 問題に未書込の変更（EDITED）、◆ = 問題はファイルのまま・解答手順だけ未保存（SOLUTION）、
 * ↓ = 他の端末の下書きが Gist に届いている。端末内の下書きがファイル（と保存済みの手順）と同じになっていたら、ここで片付ける
 */
type LevelMarkKind = 'edited' | 'solution';
const MARK_CHAR: Record<LevelMarkKind, string> = { edited: '●', solution: '◆' };
const MARK_TITLE: Record<LevelMarkKind, string> = {
    edited: '未書込の変更あり（WRITE FILE で消えます）',
    solution: '問題はファイルのまま。解答手順だけ未保存（SAVE SOLUTION で消えます）',
};
function levelMarks(rule: Rule, id: string): { edit: LevelMarkKind | null; incoming: boolean } {
    const key = draftKey(rule, id, '');
    let local = localDrafts.get(key);
    let edit: LevelMarkKind | null = null;
    if (key === curDraftKey() && levelsLoaded) {
        // 開いている問題は自動保存（0.3 秒後）を待たずに今の内容で
        const kind = editStateOf(doc, sourceId).kind;
        edit = kind === 'solution' ? 'solution' : kind === 'edited' ? 'edited' : null;
    } else if (local && levelsLoaded) {
        const kind = editStateOf(local.doc, local.sourceId).kind;
        // 開いていない問題の下書きが、別の経路でファイルと同じになっていたら消す（保存済みの手順を読めていない間は判断しない）
        if (kind === 'file' && key !== curDraftKey() && (solutionsLoaded || rule !== 'tet')) { localDrafts.remove(key); local = undefined; }
        else edit = kind === 'solution' ? 'solution' : kind === 'file' ? null : 'edited';
    } else if (local) edit = 'edited';
    const r = remoteFor(rule, id, local?.draftId ?? '');
    let incoming = false;
    if (r) {
        const h = contentHash(r[1].doc, r[1].sourceId);
        incoming = !local || (contentHash(local.doc, local.sourceId) !== h && !(local.sent && r[0] === local.draftId && r[1].rev === local.sent.rev));
    }
    return { edit, incoming };
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
    $('info-next').textContent = `NEXT ${nextLen()}${doc.rule === 'tet' ? '個' : 'ペア'} — NEXT モード（N）で編集します（TEXT 欄も TOOLS に）`;
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
 * 盤面のマスの大きさ。テト基準で最大 28px、ぷよはテトの盤面の枠に収まる大きさ（render.ts fitCell）。
 * PC は盤面エリア（#col-center）の高さと幅に、モバイル配置は「画面幅」と「盤面以外を並べた残りの高さ」に収める
 * （FIELD タブはツールまで一画面に収める。STEPS タブは手順リストが長くなりうるので下に 200px ぶん見せる）
 */
function cellSize(rule: Rule): number {
    if (!mobileMq.matches) {
        // PC: 高さが固定されない（低い画面）ときは上限の大きさ
        const area = $('col-center');
        const cs = getComputedStyle(area);
        if (cs.overflowY !== 'auto') return fieldCellSize(rule);
        const otherH = $('center-inner').offsetHeight - fieldCanvas.offsetHeight;
        const availH = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - otherH - 2;
        const wrap = $('field-wrap');
        const otherW = $('hold-col').offsetWidth + $('next-col').offsetWidth + 16 + (wrap.offsetWidth - fieldCanvas.offsetWidth);
        const availW = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - otherW - 2;
        return fitCell(rule, availW, availH);
    }
    const w = document.documentElement.clientWidth - 16 - 32;   // #layout の左右余白＋パネル・枠の余白
    const viewH = window.visualViewport?.height ?? window.innerHeight;
    const board = fieldCanvas.offsetHeight;
    const others = body().dataset.mtab === 'steps'
        ? $('topbar').offsetHeight + $('mtabs').offsetHeight + 260
        : $('topbar').offsetHeight + $('mtabs').offsetHeight + ($('layout').offsetHeight - board) + 8;
    return fitCell(rule, w, viewH - others);
}
function body(): HTMLElement { return document.body; }

// ─── PC のサイドバー（layout §1。アクティビティバーで LEVELS / INFO / STEPS / OUTPUT を切替・選択中をもう一度押すと閉じる） ───
type PTab = 'levels' | 'info' | 'steps' | 'out';
const PTAB_KEY = 'tetlabo.quizEditor.ptab';
const SIDE_KEY = 'tetlabo.quizEditor.side';
const narrowMq = matchMedia('(min-width: 761px) and (max-width: 999px)');   // サイドバーを盤面に重ねて開く幅
function curPTab(): PTab { return (body().dataset.ptab as PTab) || 'info'; }
function sideOpen(): boolean { return body().dataset.side !== 'closed'; }
function setPTab(t: PTab, open = true) {
    body().dataset.ptab = t;
    body().dataset.side = open ? 'open' : 'closed';
    try { localStorage.setItem(PTAB_KEY, t); localStorage.setItem(SIDE_KEY, open ? 'open' : 'closed'); } catch { /* 保存不可 */ }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#activity [data-ptab]')) {
        const on = open && b.dataset.ptab === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
    }
    if (open && t === 'levels') renderLevels();
    renderField();   // サイドバーの開閉でマスの大きさが変わる
}
/** アクティビティバーのボタン: 別のビューなら開いて切替、選択中ならサイドバーを閉じる */
function clickPTab(t: PTab) {
    solvePrevTab = null;   // 自分で切り替えたら、SOLVE を出た時に戻さない
    if (t === 'levels') { lvState.sel = currentLvKey(); lvState.open[doc.rule] = true; }
    setPTab(t, !(sideOpen() && curPTab() === t));
}
function toggleSide() { solvePrevTab = null; setPTab(curPTab(), !sideOpen()); }
/** SOLVE に入ったら STEPS を出し、出たら元のビューへ戻す（閉じていたら開かない。layout §8 F1） */
let solvePrevTab: PTab | null = null;
function sideForSolve(prev: EditMode, mode: EditMode) {
    if (prev === mode || !sideOpen() || narrowMq.matches) return;
    if (mode === 'solve') {
        if (curPTab() !== 'steps') { solvePrevTab = curPTab(); setPTab('steps'); }
    } else if (prev === 'solve') {
        if (solvePrevTab && curPTab() === 'steps') setPTab(solvePrevTab);
        solvePrevTab = null;
    }
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
        cursor: ui.cursor, hover: ui.mode === 'paint' ? ui.hover : null, rowMode: ui.rowMode,
        showCursor: ui.mode === 'paint' && document.activeElement === fieldCanvas,
    });
    const size = `${cols(doc.rule)}×${rows(doc.rule)}${doc.rule === 'puyo' ? '（上5段は隠し段）' : ''}`;
    $('field-size').textContent = size;
    $('sb-size').textContent = size;
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
                : (v === 0 ? '0' : v === PUYO_OJAMA ? `${v}` : `${v} ${PUYO_COLOR_NAMES[v - 1]}`);
            b.append(k);
            b.title = `${colorName(v)} (${v === TET_GARBAGE && doc.rule === 'tet' ? '8・G' : v})`;
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

/**
 * NEXT の編集ボタン。PC は NEXT モードの TOOLS（ピース行・十字・アクション行＝他のモードと同じ形。tools §3）、
 * スマホは NEXT タブに 1 行で並べる（十字・アクション行は display: contents）。
 * PC の NEXT 列は縦並びなので ↑ ↓ が前後（← → も同じ）。スマホは横並びなので ← → だけ
 */
function nextToolsHtml(rule: Rule): string {
    const pieces = rule === 'tet'
        ? MINO_LETTERS.map((L, t) => `<button type="button" data-mino="${t}" title="${L} を挿入 (${L})"><span class="k">${L}</span><canvas></canvas></button>`).join('')
        : PUYO_COLOR_NAMES.map((name, i) => `<button type="button" data-puyo="${i + 1}" title="${name}（${i + 1}）。2 つ押して [軸, 子] のペア"><canvas></canvas><span class="k">${i + 1} ${name}</span></button>`).join('');
    const extra = rule === 'tet'
        ? '<button type="button" id="btn-bag" title="7種1巡をランダム順で追加 (B)">+BAG</button>'
        : '<button type="button" id="btn-swap" title="キャレット直前のペアの軸/子を入れ替え (X)">SWAP</button>';
    return `<div class="nx-pieces tool-pieces">${pieces}</div>` +
        '<div class="op-pad nx-pad"><div class="pad-cross">' +
        '<button type="button" class="up pc-only" data-nx="caret-left" title="キャレットを前へ (↑)">↑</button>' +
        '<button type="button" class="left" data-nx="caret-left" title="キャレットを前へ (←)">←</button>' +
        '<span class="pad-lbl">CARET</span>' +
        '<button type="button" class="right" data-nx="caret-right" title="キャレットを後ろへ (→)">→</button>' +
        '<button type="button" class="down pc-only" data-nx="caret-right" title="キャレットを後ろへ (↓)">↓</button>' +
        '</div><div class="pad-acts">' +
        '<button type="button" data-nx="del" title="キャレットの前を削除 (Backspace)">DEL</button>' +
        '<button type="button" data-nx="move-left" title="キャレットの前の項目を1つ前へ (Alt+↑)">MOVE <span class="pc-only">↑</span><span class="m-only">◀</span></button>' +
        '<button type="button" data-nx="move-right" title="キャレットの前の項目を1つ後ろへ (Alt+↓)">MOVE <span class="pc-only">↓</span><span class="m-only">▶</span></button>' +
        extra +
        '<button type="button" id="btn-next-clear" title="NEXT を全部消す (Shift+Delete)">CLEAR</button>' +
        '</div></div>';
}
/** NEXT の編集ボタンのミノ・ぷよを描く（画像の読み込み後にも描き直す） */
function drawNextToolPieces() {
    const dpr = window.devicePixelRatio || 1;
    for (const b of $('next-tools').querySelectorAll<HTMLButtonElement>('[data-mino], [data-puyo]')) {
        const cv = b.querySelector('canvas')!;
        const s = b.dataset.mino ? 30 : 22;
        if (cv.width !== s * dpr) { cv.width = s * dpr; cv.height = s * dpr; cv.style.width = `${s}px`; cv.style.height = `${s}px`; }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, s, s);
        if (b.dataset.mino) drawMinoCentered(ctx, Number(b.dataset.mino), s / 2, s / 2, 6);
        else drawCellSwatch(ctx, 'puyo', Number(b.dataset.puyo), s);
    }
}

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
            p.textContent = `${PUYO_COLOR_NAMES[ui.pendingPuyo - 1] ?? ui.pendingPuyo}…`;
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
        tools.innerHTML = nextToolsHtml(doc.rule);
    }
    drawNextToolPieces();
    for (const b of tools.querySelectorAll<HTMLButtonElement>('button')) {
        b.disabled = !!usage;
        if (b.dataset.puyo) b.classList.toggle('on', Number(b.dataset.puyo) === ui.pendingPuyo);
    }
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

/** PC: ステータスバー（モード・盤面サイズ・キーの出どころ・検証の件数。SYNC と LOG は applyLayout でここへ移す） */
function renderStatusbar() {
    const mode = curMode();
    const sbMode = $('sb-mode');
    sbMode.textContent = MODE_BAND[mode][0] + (mode === 'paint' && ui.rowMode ? ' · ROW' : '');
    sbMode.title = MODE_BAND[mode][1];
    $('sb-keys').textContent = `KEYS: ${sourceLabel(binds.source)}`;
    $('sb-keys').title = `操作キー: ${sourceLabel(binds.source)}・${tuningLabel(tuning)}（押すとキー一覧）`;
    const errs = lastIssues.filter(i => i.level === 'error').length;
    const warns = lastIssues.filter(i => i.level === 'warn').length;
    const sb = $('sb-issues');
    sb.textContent = errs || warns ? `⚠ ${errs + warns}` : '✓ OK';
    sb.className = errs ? 'err' : warns ? 'warn' : 'ok';
    sb.title = errs || warns ? `エラー ${errs}・警告 ${warns}（押すと OUTPUT を開く）` : '検証の問題はありません（押すと OUTPUT を開く）';
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
        ? 'ファイルへの直接書き込みは、PC の dev サーバー（localhost）で開いた時か Chrome / Edge だけです（COPY JSON を使ってください）'
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
    const c = Math.floor((e.clientX - rect.left) / s), r = rowAtY(doc.rule, e.clientY - rect.top, s);   // ぷよの隠し段は低い
    if (r < 0 || r >= rows(doc.rule) || c < 0 || c >= cols(doc.rule)) return null;
    return { r, c };
}

// マウスもタッチも Pointer Events で扱う（§14.5）。タッチは「ホバー」が無いので押している間だけ追従する
let touchDown = false;
fieldCanvas.addEventListener('pointerdown', e => {
    const p = cellAt(e);
    if (!p) return;
    e.preventDefault();
    // NEXT モードで盤面を押したら、直前の PAINT / STAMP に戻り、そのまま塗る（置く）（tools §9.1 Q3）
    if (ui.mode === 'next') setMode(boardMode());
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

/** NEXT モードのキー（tools §4。フォーカスの場所に関係なく、NEXT モードの間はこれが解釈する） */
function handleNextKey(e: KeyboardEvent): boolean {
    const n = nextLen();
    // Alt+矢印: キャレットの前の項目を前後へ（VS Code の行の移動と同じ）
    if (e.altKey) {
        const i = ui.nextCaret - 1;
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { if (i > 0) moveNext(i, i - 1); return true; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { if (i >= 0 && i < n - 1) moveNext(i, i + 1); return true; }
        return false;
    }
    if (e.key === 'Delete' && e.shiftKey) { clearNext(); return true; }
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

function clearNext() {
    if (!nextLen()) return;
    commit(() => { doc.next = []; doc.pairs = []; ui.nextCaret = 0; ui.pendingPuyo = 0; });
}

// NEXT 列はフォーカスを取らない（入力欄ではなく、押すと NEXT モードに入ってキャレットを置く。tools §4）
const nextBox = $('next-box');
nextBox.addEventListener('click', e => {
    if (curMode() === 'solve') { warnStatus('SOLVE 中は NEXT を編集できません（EDIT に戻すには P）'); return; }
    const item = (e.target as HTMLElement).closest<HTMLElement>('.next-item');
    ui.nextCaret = item ? Number(item.dataset.index) + 1 : nextLen();
    ui.pendingPuyo = 0;
    if (curMode() !== 'next' && !mobileMq.matches) setMode('next');
    else renderNext();
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
    else if (b.id === 'btn-next-clear') clearNext();
    else if (b.dataset.nx) {
        const i = ui.nextCaret - 1, n = nextLen();
        switch (b.dataset.nx) {
            case 'caret-left': ui.nextCaret = Math.max(0, ui.nextCaret - 1); ui.pendingPuyo = 0; renderNext(); break;
            case 'caret-right': ui.nextCaret = Math.min(n, ui.nextCaret + 1); ui.pendingPuyo = 0; renderNext(); break;
            case 'del': if (ui.pendingPuyo) { ui.pendingPuyo = 0; renderNext(); } else deleteNext(i); break;
            case 'move-left': if (i > 0) moveNext(i, i - 1); break;
            case 'move-right': if (i >= 0 && i < n - 1) moveNext(i, i + 1); break;
        }
    }
    focusField();   // ボタンにフォーカスを残さない（Space がボタンの押下にならないように）
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
            if (rule !== 'tet' && ui.mode === 'place') ui.mode = 'paint';
            place.resetActive();
            if (ui.selColor > maxColorId(rule)) ui.selColor = 1;
            ui.cursor = { r: Math.min(ui.cursor.r, rows(rule) - 1), c: Math.min(ui.cursor.c, cols(rule) - 1) };
        });
    });
}

/** 既存の問題を開く（この端末に編集中の下書きがあればその続き。他の端末の下書きが届いていれば、そちらを開くか聞く） */
function openLevel(rule: Rule, i: number) {
    const raw = levels[rule][i];
    if (!raw) return;
    const id = String(raw.id);
    const local = localDrafts.get(draftKey(rule, id, ''));
    const incoming = levelMarks(rule, id).incoming ? remoteFor(rule, id, local?.draftId ?? '') : undefined;
    if (incoming && confirm(`「${id}」には ${incoming[1].device} で保存された下書きが Gist にあります（${fmtTime(incoming[1].updatedAt)}）。そちらを開きますか？\n（キャンセルで${local ? 'この端末の編集中の内容' : 'ファイルの内容'}を開きます）`)) openDraft(incoming[0]);
    else if (local) {
        openDoc(cloneDoc(local.doc), local.sourceId, local.draftId);
        const st = editStateOf(doc, sourceId);
        showNotice(`「${id}」はこの端末で編集中の内容を開きました（変更: ${st.changes.join('・') || 'なし'}）`, true);
    } else openDoc(withSolution(docFromLevel(raw)), id);
}
$<HTMLSelectElement>('level-select').addEventListener('change', e => {
    const v = (e.target as HTMLSelectElement).value;
    if (!v) return;
    const [rule, i] = v.split(':') as [Rule, string];
    openLevel(rule, Number(i));
    focusField();
});
$('btn-new').addEventListener('click', () => {
    const d = newDoc(doc.rule);
    openDoc(d, null);
    focusField();
});


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
        // dev サーバーの口（Safari も可・ファイルを選ばない）→ File System Access（選んだファイル）
        let h: { name: string; write(text: string): Promise<void> };
        let text: string;
        if (devFilesAvailable() && !forcePick) {
            const cur = await devRead(fileName);
            text = cur.text;
            h = { name: fileName, write: t => devWrite(fileName, t, cur.hash) };
        } else {
            const fh = await getHandle(fileName, 'open', forcePick);
            if (fh.name !== fileName && !confirm(`選んだファイルは「${fh.name}」です。${fileName} ではありませんが書き込みますか？`)) return;
            text = await readText(fh);
            h = { name: fh.name, write: t => writeText(fh, t) };
        }
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

        await h.write(plan.text);
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
        const msg = `${h.name} に書き込みました（${what}）。反映には public/core/base.js の ASSET_VERSION を +1 してください`;
        // 手順は別のファイル（tsolutions.json）。未保存なら知らせて、その場で保存できるようにする（tools §1.3）
        if (editStateOf(doc, sourceId).kind === 'solution') {
            toast(`${msg}。解答手順は未保存です`, 'info', {
                actions: [{ label: 'SAVE SOLUTION', title: '解答手順を保存する', run: () => void saveSolutionFile(false) }],
            });
        } else setStatus(msg);
    } catch (err) {
        if ((err as Error).name === 'AbortError') return;   // ファイル選択をキャンセル
        console.error(err);
        errStatus(`書き込めませんでした: ${(err as Error).message}`);
    }
    renderAll();
}
$('btn-write').addEventListener('click', () => void writeLevelsFile(false));
$('btn-write-pick').addEventListener('click', () => void writeLevelsFile(true));

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
/** フォーカスした部品が自分で使うキーか（ボタン・チェックボックスの Space / Enter はブラウザのクリック） */
function ownedByFocused(target: Element | null, e: KeyboardEvent): boolean {
    if (!target || target === fieldCanvas || target === document.body) return false;
    const pressable = target instanceof HTMLButtonElement || (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio'));
    return pressable && (e.key === ' ' || e.key === 'Enter');
}
/**
 * キーの行き先（tools §4）: テキスト欄 → 文字入力。それ以外は、フォーカスした部品が使うキー（Space/Enter 等）を除き
 * 「今のモード」が解釈する（盤面以外にフォーカスがあっても P・N・H 等が効く）
 */
document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;   // ダイアログ内はブラウザ標準
    if (e.defaultPrevented) return;                       // LEVELS のタイル・絞り込み欄などが処理済み
    const target = e.target as Element | null;
    const text = isTextInput(target);
    const k = e.key.toLowerCase();
    // Ctrl/⌘+P: 問題の一覧（サイドバーの LEVELS）、Ctrl/⌘+B: サイドバーの開閉（VS Code と同じ。layout §8 K1）
    if (isMod(e) && !e.shiftKey && !e.altKey && k === 'p') { e.preventDefault(); showLevels(); return; }
    if (isMod(e) && !e.shiftKey && !e.altKey && k === 'b' && !mobileMq.matches) { e.preventDefault(); toggleSide(); return; }

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
    if (e.key === '?') { e.preventDefault(); renderHelp(); helpDlg.showModal(); return; }
    // /: LEVELS の絞り込み欄へ（LEVELS を表示中だけ）
    if (e.key === '/' && levelsVisible()) { e.preventDefault(); lvFilter.focus(); return; }
    if (e.key === 'Escape') { focusField(); return; }
    const diffKey = /^(Digit|Numpad)([0-5])$/.exec(e.code);
    if (e.altKey && diffKey) {
        e.preventDefault();
        const v = Number(diffKey[2]);
        commit(() => { doc.diff = v === 0 ? null : v; });
        return;
    }

    if (ownedByFocused(target, e)) return;

    let handled = false;
    if (ui.mode === 'next') handled = handleNextKey(e);
    else if (ui.mode === 'place') handled = place.handleKey(e, binds);
    else handled = handleFieldKey(e);
    // P: EDIT（最後に使った PAINT/STAMP/NEXT）⇔ SOLVE、Shift+P: PAINT → STAMP → NEXT、N: NEXT ⇔ 盤面のモード
    // （SOLVE で同期キーに割り当てられていれば上で処理済み）
    if (!handled && !e.altKey && e.code === 'KeyP') {
        const m = curMode();
        if (e.shiftKey) setMode(cycleEditMode(m === 'solve' ? ui.lastEdit : m));
        else setMode(m === 'solve' ? ui.lastEdit : 'solve');
        handled = true;
    }
    if (!handled && !e.altKey && !e.shiftKey && e.code === 'KeyN' && !mobileMq.matches) {
        setMode(curMode() === 'next' ? boardMode() : 'next');
        handled = true;
    }
    // H: HOLD 許可の切替（PAINT は handleFieldKey で処理済み。NEXT・STAMP でも効かせる）
    if (!handled && !e.altKey && !e.shiftKey && e.code === 'KeyH' && doc.rule === 'tet' && curMode() !== 'solve') {
        commit(() => { doc.allowHold = !doc.allowHold; });
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

// ─── PC 配置: 一部の部品を PC では盤面の横・サイドバー・ステータスバーへ移す（スマホでは元の場所＝下部タブの仕組みのまま） ───
const relocations: [HTMLElement, HTMLElement][] = [
    [$('next-h'), $('next-col')], [$('next-box'), $('next-col')],
    [$('steps-note'), $('col-steps')], [$('solve-box'), $('col-steps')],
    [$('mode-seg'), $('mode-seg-slot')],
    [$('next-tools'), $('nexttool-box')], [$('next-text-wrap'), $('nexttool-box')],
    [$('btn-sync'), $('sb-right')], [$('btn-log'), $('sb-right')],
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
for (const b of document.querySelectorAll<HTMLButtonElement>('#activity [data-ptab]')) {
    b.addEventListener('click', () => clickPTab(b.dataset.ptab as PTab));
}
$('sb-issues').addEventListener('click', () => { solvePrevTab = null; setPTab('out'); });
$('sb-keys').addEventListener('click', () => { renderHelp(); helpDlg.showModal(); });

// ─── サイドバーの幅（境界線のドラッグ。layout §1.7） ───
const SIDE_W_KEY = 'tetlabo.quizEditor.sideW';
const SIDE_W_DEFAULT = 300, SIDE_W_MIN = 240, SIDE_W_MAX = 560;
function setSideW(w: number, save = true) {
    const v = Math.round(Math.max(SIDE_W_MIN, Math.min(SIDE_W_MAX, w)));
    body().style.setProperty('--side-w', `${v}px`);
    if (save) try { localStorage.setItem(SIDE_W_KEY, String(v)); } catch { /* 保存不可 */ }
    renderField();
}
{
    let w = NaN;
    try { w = Number(localStorage.getItem(SIDE_W_KEY)); } catch { /* 読めない */ }
    if (w) setSideW(w, false);
    const sash = $('sash');
    let drag: { x: number; w: number } | null = null;
    sash.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        try { sash.setPointerCapture(e.pointerId); } catch { /* 既に離れたポインタ */ }
        drag = { x: e.clientX, w: $('sidebar').offsetWidth };
        body().classList.add('sash-drag');
    });
    sash.addEventListener('pointermove', e => {
        if (drag) setSideW(drag.w + e.clientX - drag.x, false);
    });
    const end = () => {
        if (drag) setSideW($('sidebar').offsetWidth);   // 離した時に保存
        drag = null;
        body().classList.remove('sash-drag');
    };
    sash.addEventListener('pointerup', end);
    sash.addEventListener('pointercancel', end);
    sash.addEventListener('dblclick', () => setSideW(SIDE_W_DEFAULT));
}

// ─── 問題の一覧（サイドバーの LEVELS ビュー。ゲームの選択画面と同じ番号タイル。tools §2） ───
const lvFilter = $<HTMLInputElement>('lv-filter');
const lvBody = $('lv-body');
const lvState = { open: { tet: true, puyo: false } as Record<Rule, boolean>, sel: '', hover: '', html: '' };
function starsHtml(diff: unknown): string {
    if (typeof diff !== 'number') return '';
    return Array.from({ length: 5 }, (_, k) => `<span class="${k < Math.round(diff) ? 'sf' : 'se'}">${k < Math.round(diff) ? '★' : '☆'}</span>`).join('');
}
/** 開いている問題のタイル（新規なら 'new'） */
function currentLvKey(): string {
    const i = sourceId === null ? -1 : levels[doc.rule].findIndex(l => l.id === sourceId);
    return i >= 0 ? `${doc.rule}:${i}` : 'new';
}
function lvMatches(rule: Rule, i: number, q: string): boolean {
    if (!q) return true;
    const l = levels[rule][i];
    return `${i + 1} ${rule} ${String(l.id ?? '')} ${String(l.description ?? '')}`.toLowerCase().includes(q);
}
function levelsVisible(): boolean { return !mobileMq.matches && sideOpen() && curPTab() === 'levels'; }
/** 一覧を描く（表示中は renderAll のたびに呼ぶ。中身が同じなら DOM を触らない＝タイルのフォーカスを保つ） */
function renderLevels() {
    if (!levelsVisible()) return;
    const q = lvFilter.value.trim().toLowerCase();
    const cur = currentLvKey();
    const parts: string[] = [];
    for (const rule of ['tet', 'puyo'] as Rule[]) {
        const list = levels[rule];
        const idx = list.map((_, i) => i).filter(i => lvMatches(rule, i, q));
        const open = q ? idx.length > 0 : lvState.open[rule];
        parts.push(`<div class="lv-head"><button type="button" class="lv-toggle" data-rule="${rule}" aria-expanded="${open}">${open ? '▼' : '▶'} ${rule.toUpperCase()} <small>(${q ? `${idx.length}/` : ''}${list.length})</small></button>` +
            `<button type="button" class="lv-new" data-new="${rule}" title="${rule.toUpperCase()} の新しい問題">+ NEW</button></div>`);
        if (!open) continue;
        const tiles = idx.map(i => {
            const l = list[i];
            const key = `${rule}:${i}`;
            const mk = levelMarks(rule, String(l.id));
            const marks = (mk.edit ? `<span class="lv-m ${mk.edit}" title="${MARK_TITLE[mk.edit]}">${MARK_CHAR[mk.edit]}</span>` : '') +
                (mk.incoming ? '<span class="lv-m incoming" title="他の端末から届いた下書きがあります">↓</span>' : '');
            return `<button type="button" class="lv-tile${key === cur ? ' me' : ''}" data-key="${key}" tabindex="-1">` +
                `<span class="lv-num">${i + 1}</span><span class="lv-diff">${starsHtml(l.diff)}</span>${marks ? `<span class="lv-mark">${marks}</span>` : ''}</button>`;
        });
        // 新規（未書込）の問題は、WRITE FILE で入る位置（末尾）に点線のタイルで出す
        if (!q && cur === 'new' && doc.rule === rule) {
            tiles.push(`<button type="button" class="lv-tile me new" data-key="new" tabindex="-1" title="編集中の新しい問題（WRITE FILE で入る位置）"><span class="lv-num">${list.length + 1}</span><span class="lv-diff">${starsHtml(doc.diff)}</span></button>`);
        }
        parts.push(`<div class="lv-grid">${tiles.join('') || '<span class="note">該当なし</span>'}</div>`);
    }
    const html = parts.join('');
    if (html !== lvState.html) {
        const focusKey = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('#lv-body .lv-tile')?.dataset.key;
        lvBody.innerHTML = html;
        lvState.html = html;
        if (focusKey) lvTile(focusKey)?.focus({ preventScroll: true });
    }
    if (!lvTile(lvState.sel)) lvState.sel = lvTile(cur) ? cur : lvBody.querySelector<HTMLElement>('.lv-tile')?.dataset.key ?? '';
    syncLevelSel();
}
function lvTile(key: string): HTMLElement | null {
    return key ? lvBody.querySelector<HTMLElement>(`.lv-tile[data-key="${key}"]`) : null;
}
/** 選択中のタイルだけ Tab で入れる（矢印で移動。ゲームの選択画面と同じ） */
function syncLevelSel() {
    for (const t of lvBody.querySelectorAll<HTMLElement>('.lv-tile')) {
        const on = t.dataset.key === lvState.sel;
        t.classList.toggle('sel', on);
        t.tabIndex = on ? 0 : -1;
    }
    renderLevelDetail();
}
function renderLevelDetail() {
    const key = lvState.hover || lvState.sel;
    const el = $('lv-detail');
    if (!key) { el.innerHTML = ''; return; }
    let num: number, rule: Rule, id: string, desc: string, goal: string, diff: unknown;
    if (key === 'new') {
        rule = doc.rule; num = levels[rule].length + 1; id = doc.id || '(ID なし)'; desc = doc.description; goal = doc.cond.description; diff = doc.diff;
    } else {
        const [r, i] = key.split(':');
        rule = r as Rule; num = Number(i) + 1;
        const l = levels[rule][Number(i)];
        if (!l) { el.innerHTML = ''; return; }
        id = String(l.id ?? ''); desc = String(l.description ?? '');
        goal = String((l.clearCondition as { description?: unknown } | undefined)?.description ?? ''); diff = l.diff;
    }
    el.innerHTML = `<div><span class="pv-rule">${rule.toUpperCase()} — ${num}</span> <span class="pv-stars">${starsHtml(diff)}</span> <span class="lv-id">${escapeHtml(id)}</span></div>` +
        `<div class="lv-desc">${escapeHtml(desc) || '<i>（問題名なし）</i>'}</div>` +
        `<div class="pv-goal">GOAL: ${escapeHtml(goal)}</div>`;
}
/** LEVELS を開き、開いている問題のタイルにフォーカスする（⌘P・問題のタブ）。絞り込み欄には自動でフォーカスしない */
function showLevels() {
    if (mobileMq.matches) { $('level-select').focus(); return; }
    $('topbar').classList.remove('menu-open');
    solvePrevTab = null;
    lvState.open[doc.rule] = true;
    lvState.sel = currentLvKey();
    lvState.hover = '';
    setPTab('levels', true);   // renderLevels を含む
    focusLevelSel();
}
function focusLevelSel() {
    const t = lvTile(lvState.sel);
    if (!t) return;
    t.focus({ preventScroll: true });
    t.scrollIntoView({ block: 'nearest' });
}
function activateLevel(key: string) {
    if (key && key !== 'new' && key !== currentLvKey()) {
        const [rule, i] = key.split(':');
        openLevel(rule as Rule, Number(i));
    }
    if (narrowMq.matches) setPTab('levels', false);   // 盤面に重ねて開いている幅では閉じる（盤面を隠したままにしない）
    focusField();
}
/** 矢印キー: 画面上の位置で上下左右のタイルへ（ゲームの選択画面と同じ動き） */
function moveLevelSel(dx: number, dy: number) {
    const tiles = [...lvBody.querySelectorAll<HTMLElement>('.lv-tile')];
    if (!tiles.length) return;
    const cur = tiles.find(t => t.dataset.key === lvState.sel) ?? tiles[0];
    const r0 = cur.getBoundingClientRect();
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const t of tiles) {
        if (t === cur) continue;
        const r = t.getBoundingClientRect();
        const ddx = r.left - r0.left, ddy = r.top - r0.top;
        let score: number;
        if (dx) { if (Math.abs(ddy) > 4 || Math.sign(ddx) !== dx) continue; score = Math.abs(ddx); }
        else { if (Math.abs(ddy) <= 4 || Math.sign(ddy) !== dy) continue; score = Math.abs(ddy) * 1000 + Math.abs(ddx); }
        if (score < bestScore) { bestScore = score; best = t; }
    }
    // 行の端では前後の行へ続ける
    if (!best && dx) best = tiles[tiles.indexOf(cur) + dx] ?? null;
    if (!best) return;
    lvState.sel = best.dataset.key!;
    lvState.hover = '';
    syncLevelSel();
    focusLevelSel();
}
lvFilter.addEventListener('input', () => { lvState.hover = ''; renderLevels(); });
lvFilter.addEventListener('keydown', e => {
    // Esc: 文字を消してタイルへ／↓: タイルへ／Enter: 選択中（先頭の該当）を開く
    if (e.key === 'Escape') { e.preventDefault(); lvFilter.value = ''; renderLevels(); focusLevelSel(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusLevelSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (lvState.sel) activateLevel(lvState.sel); }
});
// タイルにフォーカスがある時だけ矢印・Enter を使う。それ以外のキーは今のモードへ流れる（tools §2.3）
lvBody.addEventListener('keydown', e => {
    if (!(e.target as HTMLElement).closest('.lv-tile') || e.altKey || isMod(e)) return;
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (dir) { e.preventDefault(); moveLevelSel(dir[0], dir[1]); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (lvState.sel) activateLevel(lvState.sel); }
});
lvBody.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const tile = t.closest<HTMLElement>('.lv-tile');
    if (tile) { lvState.sel = tile.dataset.key!; activateLevel(tile.dataset.key!); return; }
    const tog = t.closest<HTMLElement>('.lv-toggle');
    if (tog) {
        const rule = tog.dataset.rule as Rule;
        lvFilter.value = '';
        lvState.open[rule] = !lvState.open[rule];
        renderLevels();
        lvBody.querySelector<HTMLElement>(`.lv-toggle[data-rule="${rule}"]`)?.focus();   // 絞り込み欄へは移さない
        return;
    }
    const nw = t.closest<HTMLElement>('[data-new]');
    if (nw) { openDoc(newDoc(nw.dataset.new as Rule), null); if (narrowMq.matches) setPTab('levels', false); focusField(); }
});
lvBody.addEventListener('mouseover', e => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('.lv-tile')?.dataset.key ?? '';
    if (key !== lvState.hover) { lvState.hover = key; renderLevelDetail(); }
});
lvBody.addEventListener('mouseleave', () => { lvState.hover = ''; renderLevelDetail(); });
$('doc-tab').addEventListener('click', showLevels);

// サイドバーの前回のビューと開閉（LEVELS の部品ができてから。setPTab が一覧を描くため）
{
    let saved: string | null = null, side: string | null = null;
    try { saved = localStorage.getItem(PTAB_KEY); side = localStorage.getItem(SIDE_KEY); } catch { /* 読めない */ }
    // 旧版の PREVIEW タブは廃止（layout §3）
    const t: PTab = saved === 'levels' || saved === 'steps' || saved === 'out' ? saved : 'info';
    setPTab(t, side !== 'closed' && !narrowMq.matches);   // 狭い画面は盤面に重なるので閉じて始める
}

// ─── PC: ≡ メニュー・盤面に重ねたサイドバーは、外側を押したら閉じるだけ（その押下は盤面に渡さない。layout §8 C5） ───
let swallowClick = false;
window.addEventListener('pointerdown', e => {
    swallowClick = false;   // 前の押下が click にならなかった（ドラッグ等）時に、次の click を飲み込まない
    if (mobileMq.matches) return;
    const t = e.target as Element;
    let consumed = false;
    if ($('topbar').classList.contains('menu-open') && !t.closest('#menu-pop, #btn-menu')) {
        closeMenu();
        consumed = true;
    }
    if (narrowMq.matches && sideOpen() && !t.closest('#sidebar, #activity, dialog')) {
        setPTab(curPTab(), false);
        consumed = true;
    }
    if (consumed) { e.preventDefault(); e.stopPropagation(); swallowClick = true; }
}, true);
window.addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
}, true);
window.addEventListener('keydown', () => { swallowClick = false; }, true);
narrowMq.addEventListener('change', () => { if (narrowMq.matches) setPTab(curPTab(), false); });

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

loadImages(() => { renderField(); renderPalette(); renderNext(); renderHold(); buildStampGrid($('stamp-grid')); });
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
// 未読の件数（PC はステータスバーの 🔔 に出す）
let logUnread = 0;
function renderLogUnread() {
    const b = $('log-unread');
    b.hidden = logUnread === 0;
    b.textContent = String(Math.min(logUnread, 99));
}
onToastLog(() => {
    if (logDlg.open) renderLog();
    else { logUnread++; renderLogUnread(); }
});
$('btn-log').addEventListener('click', () => { logUnread = 0; renderLogUnread(); renderLog(); logDlg.showModal(); });
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
function closeMenu() {
    $('topbar').classList.remove('menu-open');
    $('btn-menu').setAttribute('aria-expanded', 'false');
}
$('btn-menu').addEventListener('click', () => {
    const open = $('topbar').classList.toggle('menu-open');
    $('btn-menu').setAttribute('aria-expanded', String(open));
});
for (const id of ['btn-new', 'btn-paste', 'btn-drafts', 'btn-revert', 'btn-log']) $(id).addEventListener('click', closeMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('topbar').classList.contains('menu-open')) closeMenu(); });
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
mobileMq.addEventListener('change', () => {
    if (mobileMq.matches && ui.mode === 'next') ui.mode = 'paint';   // NEXT モードは PC だけ
    applyLayout();
    renderAll();
});
// 書けない環境では書き込みの部品を隠す（スマホ・プレビュー URL の Safari 等）。dev サーバーの口は起動後に確かめるので2回呼ぶ
function applyWriteCaps() {
    for (const id of ['btn-write', 'write-pos']) {
        const el = $(id);
        (el.closest('label') ?? el).hidden = !canWriteFiles();
    }
    // CHOOSE FILE（ファイルを選び直す）は File System Access の時だけ意味がある
    $<HTMLButtonElement>('btn-write-pick').hidden = !canPickFiles();
}
applyWriteCaps();
void probeDevFiles().then(ok => { if (ok) { applyWriteCaps(); renderAll(); } });
// テストプレイは本体がタッチ非対応
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
