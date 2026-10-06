// ─────────────────────────────────────────────
// sync-ui.ts
// 同期まわりの画面（SYNC 設定・QR コード・DRAFTS 一覧・トップバーの状態表示）。設計書 §14.3〜14.4
// 状態とエディタ本体の操作は main.ts から deps で受け取る。
// ─────────────────────────────────────────────
import qrcode from 'qrcode-generator';
import {
    type SyncEngine, type DraftEntry, type SyncState, guessDevice, encodeSyncHash, GIST_DRAFT_WARN,
} from './sync.ts';
import { type LocalDrafts, type LocalDraft, type TrashEntry, LOCAL_DRAFT_WARN, contentHash } from './local-drafts.ts';
import type { EditorDoc } from './model.ts';
import { fmtDateTime, canWriteFiles, readLocalSolutions, exportSolutionsFile, RULES, SOLUTION_FILES } from './solutions.ts';
import { toast } from './toast.ts';
import { ask } from './ask.ts';

export interface SyncUiDeps {
    engine: SyncEngine;
    localDrafts: LocalDrafts;
    currentKey: () => string;
    /** ファイルの問題と比べた変更（「変更: 盤面」「手順のみ」など） */
    describe: (d: EditorDoc, sourceId: string | null) => string;
    /** ファイルの問題と比べた状態（問題一覧を読む前・新規は null） */
    editKind: (d: EditorDoc, sourceId: string | null) => 'file' | 'edited' | 'solution' | 'new' | null;
    /** 端末内の下書きと Gist の関係（SAVED / SAVED* / ↓ 端末 / 未保存） */
    sendLabel: (l: LocalDraft) => string;
    openDraft: (id: string) => void;
    openLocal: (key: string) => void;
    discardLocal: (key: string) => void;
    saveLocal: (key: string) => Promise<void>;
    afterSolutionsChanged: () => void;
    /** Gist の下書きをファイルと比べる時の問題 id（書き込んだ後は doc.id でファイルに入っている） */
    judgeSrc: (d: DraftEntry) => string | null;
    /** DRAFTS から問題を開いた後（盤面に重ねたサイドバーを閉じる・盤面へフォーカス） */
    afterOpen: () => void;
    /** ごみ箱から戻した等、このブラウザの下書きが変わった後 */
    afterLocalChanged: () => void;
    isMobile: () => boolean;
    /** PC: サイドバーの DRAFTS ビューを開く */
    showSidebar: () => void;
}

type GroupId = 'pending' | 'solution' | 'done' | 'trash';
type Ver = { kind: 'local'; key: string; l: LocalDraft; doc: EditorDoc; sourceId: string | null; updatedAt: string }
    | { kind: 'remote'; id: string; d: DraftEntry; doc: EditorDoc; sourceId: string | null; updatedAt: string };
/** 1 問ぶん（このブラウザの下書きと、同じ問題の Gist の下書きをまとめた物） */
interface Row { key: string; rule: EditorDoc['rule']; vers: Ver[]; }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PREVIEW_SUFFIX = '-citgame.pptlabo.workers.dev';
const QR_URL_KEY = 'tetlabo.quizEditor.qrUrl';
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

const STATE_LABEL: Record<SyncState, string> = {
    off: 'SYNC: OFF', synced: 'SYNCED', saving: 'SAVING…', offline: 'OFFLINE', error: 'SYNC ERROR', auth: 'SYNC: TOKEN?', limited: 'SYNC: WAIT',
};

function esc(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Workers Builds のブランチ別名（小文字・英数字以外は「-」） */
function branchAlias(branch: string): string {
    return branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** QR に入れる「スマホで開くエディタの URL」の既定値 */
function defaultQrUrl(): string {
    if (location.hostname.endsWith(PREVIEW_SUFFIX)) return location.origin + location.pathname;
    const b = QUIZ_EDITOR_BRANCH;
    if (b && b !== 'main' && b !== 'HEAD') return `https://${branchAlias(b)}${PREVIEW_SUFFIX}/quiz-editor/`;
    return '';
}
function qrUrl(): string {
    try { return localStorage.getItem(QR_URL_KEY) || defaultQrUrl(); } catch { return defaultQrUrl(); }
}

function hhmm(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relTime(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    return fmtDateTime(iso);
}

export function initSyncUi(deps: SyncUiDeps) {
    const { engine } = deps;
    const syncDlg = $<HTMLDialogElement>('sync-dlg');
    const draftsDlg = $<HTMLDialogElement>('drafts-dlg');
    let qrShown = false;
    let connectError = '';

    // ─── トップバー ───
    function renderChip() {
        const chip = $<HTMLButtonElement>('btn-sync');
        chip.textContent = engine.state === 'limited' && engine.limitedUntil
            ? `${STATE_LABEL.limited} ${hhmm(engine.limitedUntil)}` : STATE_LABEL[engine.state];
        chip.dataset.state = engine.state;
        chip.title = engine.message || 'PC とスマホの同期（GitHub Gist）';
        // バッジ = やり残しの件数（書き込み待ち＋手順だけ。1 問 1 件。drafts §1.3 D）。多すぎる時は「!」で整理を促す
        const n = pendingCount();
        const remote = engine.enabled ? Object.keys(engine.drafts()).length : 0;
        const local = deps.localDrafts.count();
        const tooMany = n > GIST_DRAFT_WARN || remote > GIST_DRAFT_WARN || local > LOCAL_DRAFT_WARN;
        const title = `やり残しの下書き: ${n}件（このブラウザ ${local}件・Gist ${remote}件）${tooMany ? '\n多くなっています。DRAFTS で整理してください' : ''}`;
        // ≡ メニューの DRAFTS（スマホ）と、PC のアクティビティバーの DRAFTS に同じ件数を出す
        for (const id of ['drafts-badge', 'menu-badge', 'act-drafts-badge']) {
            const badge = document.getElementById(id);
            if (!badge) continue;
            badge.hidden = (n === 0 && !tooMany) || (id === 'menu-badge' && !deps.isMobile());
            badge.textContent = tooMany ? `${n}!` : String(n);
            badge.classList.toggle('err', tooMany);
            badge.title = title;
        }
    }

    // ─── SYNC 画面 ───
    function renderSync() {
        const body = $('sync-body');
        if (!engine.enabled) {
            body.innerHTML = `
                <p class="note">PC とスマホで「編集中の問題」と「解答手順」を共有します。保存先はあなたの GitHub アカウントの<b>非公開 Gist</b> です（サーバーは使いません）。</p>
                <ol class="sync-steps">
                  <li><a href="${TOKEN_URL}" target="_blank" rel="noopener">GitHub でトークンを作る</a>：
                    Repository access は <b>Public repositories</b> のまま、<b>Account permissions → Gists</b> を <b>Read and write</b> に。
                    Expiration（有効期限）も設定してください（それ以外の権限は不要）</li>
                  <li>作ったトークンを下に貼って CONNECT（Gist が無ければ自動で作ります）</li>
                  <li>スマホは、接続後に表示する QR コードを読むだけで設定できます</li>
                </ol>
                <label>TOKEN <input id="sync-token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" /></label>
                <label>DEVICE <input id="sync-device" type="text" value="${esc(guessDevice())}" /></label>
                <p class="err" id="sync-err">${esc(connectError)}</p>
                <div class="row"><button type="button" id="sync-connect">CONNECT</button></div>`;
            return;
        }
        const cfg = engine.config!;
        const last = engine.lastSyncAt ? relTime(engine.lastSyncAt.toISOString()) : '—';
        const pending = engine.pendingCount();
        body.innerHTML = `
            <p><b class="sync-state" data-state="${engine.state}">${STATE_LABEL[engine.state]}</b>
               <span class="note">最終同期: ${esc(last)}${pending ? ` ・未送信 ${pending}件` : ''}</span></p>
            ${engine.message ? `<p class="${engine.state === 'offline' || engine.state === 'limited' ? 'note' : 'err'}">${esc(engine.message)}</p>` : ''}
            <p class="note">GIST: ${engine.htmlUrl ? `<a href="${esc(engine.htmlUrl)}" target="_blank" rel="noopener">${esc(cfg.gistId)}</a>` : esc(cfg.gistId)}</p>
            <label>DEVICE <input id="sync-device" type="text" value="${esc(cfg.device)}" /></label>
            <div class="row">
              <button type="button" id="sync-now">SYNC NOW</button>
              <button type="button" id="sync-qr">${qrShown ? 'HIDE QR' : 'SHOW QR'}</button>
            </div>
            <div id="sync-qr-box" ${qrShown ? '' : 'hidden'}>
              <label>スマホで開く URL <input id="sync-qr-url" type="url" spellcheck="false" value="${esc(qrUrl())}" placeholder="https://<branch>${PREVIEW_SUFFIX}/quiz-editor/" /></label>
              <div id="sync-qr-img"></div>
              <p class="note">スマホのカメラで読むと、トークン入りの URL でエディタが開き、同期の設定が済みます（トークンは URL の # 以降に入り、サーバーには送られません）。<br>読み取ったら HIDE QR で消してください。</p>
            </div>
            <h3>SOLUTIONS</h3>
            <p class="note">解答手順は Gist の tsolutions.json（テト）・psolutions.json（ぷよ）が正本です。</p>
            <div class="row">
              <button type="button" id="sync-import" title="ローカルの source_assets/quizlevels/tsolutions.json・psolutions.json を Gist に取り込む（Gist に無い・Gist より新しいものだけ）">IMPORT LOCAL FILE</button>
              <button type="button" id="sync-export" title="Gist の解答をローカルの tsolutions.json・psolutions.json に書き出す（バックアップ）">EXPORT TO FILE</button>
            </div>
            <h3>TOKEN</h3>
            <div class="row">
              <input id="sync-token" type="password" autocomplete="off" spellcheck="false" placeholder="新しいトークン（期限切れの時）" />
              <button type="button" id="sync-retoken">UPDATE</button>
              <span class="spacer"></span>
              <button type="button" id="sync-disconnect" title="この端末の同期設定を消す（Gist の内容は消えません）">DISCONNECT</button>
            </div>`;
        if (!canWriteFiles() && !location.hostname.match(/^(localhost|127\.0\.0\.1)$/)) $<HTMLButtonElement>('sync-import').hidden = true;
        if (qrShown) renderQr();
    }

    function renderQr() {
        const box = document.getElementById('sync-qr-img');
        const cfg = engine.config;
        if (!box || !cfg) return;
        const base = $<HTMLInputElement>('sync-qr-url').value.trim();
        if (!/^https:\/\//.test(base)) { box.innerHTML = '<p class="err">https:// で始まる URL を入れてください</p>'; return; }
        const url = base.replace(/#.*$/, '') + '#' + encodeSyncHash(cfg);
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    }

    async function connect(token: string, device: string, gistId?: string) {
        if (!token) { connectError = 'トークンを入れてください'; renderSync(); return; }
        connectError = '';
        toast('GitHub に接続しています…');
        try {
            await engine.connect(token, device, gistId);
            deps.afterSolutionsChanged();
            toast(engine.state === 'synced' || engine.state === 'saving' ? '同期を開始しました' : engine.message);
        } catch (err) {
            console.error(err);
            connectError = `接続できませんでした: ${(err as Error).message}`;
            engine.disconnect();
        }
        renderSync();
    }

    $('sync-body').addEventListener('click', e => {
        const id = (e.target as HTMLElement).closest('button')?.id;
        switch (id) {
            case 'sync-connect':
                void connect($<HTMLInputElement>('sync-token').value.trim(), $<HTMLInputElement>('sync-device').value.trim());
                break;
            case 'sync-retoken': {
                const t = $<HTMLInputElement>('sync-token').value.trim();
                if (t && engine.config) void connect(t, engine.config.device, engine.config.gistId);
                break;
            }
            case 'sync-now': void engine.syncNow().then(renderSync); break;
            case 'sync-qr': qrShown = !qrShown; renderSync(); break;
            case 'sync-disconnect':
                if (confirm('この端末の同期設定を消します（Gist の内容と、この端末の編集中の画面は消えません）。よろしいですか？')) {
                    engine.disconnect();
                    qrShown = false;
                    renderSync();
                }
                break;
            case 'sync-import':
                void (async () => {
                    try {
                        let n = 0, read = 0;
                        for (const rule of RULES) {
                            const map = await readLocalSolutions(rule);
                            if (!map) continue;
                            read++;
                            n += await engine.importSolutions(rule, map);
                        }
                        if (!read) { toast('ローカルの解答ファイルを読めませんでした', 'error'); return; }
                        deps.afterSolutionsChanged();
                        toast(n ? `${n}件の解答を Gist に取り込みました` : '取り込む解答はありませんでした（Gist の方が新しいか同じ）');
                    } catch (err) {
                        if ((err as Error).name !== 'AbortError') toast(`取り込めませんでした: ${(err as Error).message}`, 'error');
                    }
                    renderSync();
                })();
                break;
            case 'sync-export':
                void (async () => {
                    const counts = RULES.map(rule => `${SOLUTION_FILES[rule]} ${Object.keys(engine.solutions(rule)).length}件`).join('・');
                    if (!confirm(`Gist の解答（${counts}）で、ローカルの解答ファイルを上書きします。よろしいですか？`)) return;
                    try {
                        const done: string[] = [];
                        for (const rule of RULES) {
                            const r = await exportSolutionsFile(rule, engine.solutions(rule));
                            done.push(r.via === 'file' ? r.fileName : `${r.fileName}（ダウンロード）`);
                        }
                        toast(`${done.join('・')} に書き出しました`);
                    } catch (err) {
                        if ((err as Error).name !== 'AbortError') toast(`書き出せませんでした: ${(err as Error).message}`, 'error');
                    }
                })();
                break;
        }
    });
    $('sync-body').addEventListener('change', e => {
        const t = e.target as HTMLInputElement;
        if (t.id === 'sync-device' && engine.enabled) engine.setDevice(t.value);
        if (t.id === 'sync-qr-url') {
            try { localStorage.setItem(QR_URL_KEY, t.value.trim()); } catch { /* 保存不可 */ }
            renderQr();
        }
    });
    $('btn-sync').addEventListener('click', () => { renderSync(); syncDlg.showModal(); });
    // 閉じたら QR（トークン入り）を消す
    syncDlg.addEventListener('close', () => { qrShown = false; $('sync-body').innerHTML = ''; });

    // ─── DRAFTS（エクスプローラー。1 問 1 行・状態でグループ。PC はサイドバー、スマホはダイアログ。drafts §4） ───
    const view = $('drafts-view');
    const dvBody = $('dv-body');
    const dvFilter = $<HTMLInputElement>('dv-filter');
    const GROUP_KEY = 'tetlabo.quizEditor.dvOpen';
    const dv = {
        rule: 'all' as 'all' | 'tet' | 'puyo',
        sel: '', hover: '', html: '',
        expanded: new Set<string>(),
        open: { pending: true, solution: true, done: false, trash: false } as Record<GroupId, boolean>,
    };
    try { Object.assign(dv.open, JSON.parse(localStorage.getItem(GROUP_KEY) || '{}')); } catch { /* 既定のまま */ }

    function rows(): Row[] {
        const byKey = new Map<string, Row>();
        const add = (key: string, v: Ver) => {
            let r = byKey.get(key);
            if (!r) { r = { key, rule: v.doc.rule, vers: [] }; byKey.set(key, r); }
            r.vers.push(v);
        };
        for (const [key, l] of deps.localDrafts.all()) add(key, { kind: 'local', key, l, doc: l.doc, sourceId: l.sourceId, updatedAt: l.updatedAt });
        if (engine.enabled) {
            for (const [id, d] of Object.entries(engine.drafts())) {
                const local = deps.localDrafts.findByDraftId(id);
                const key = local ? local[0] : d.sourceId !== null ? `${d.doc.rule}:${d.sourceId}` : `new:${id}`;
                add(key, { kind: 'remote', id, d, doc: d.doc, sourceId: d.sourceId, updatedAt: d.updatedAt });
            }
        }
        return [...byKey.values()];
    }
    /** 版の状態（ファイルと比べて）。分からない（一覧を読む前・新規）は edited 扱い */
    function verKind(v: Ver): 'file' | 'edited' | 'solution' {
        const src = v.kind === 'remote' ? deps.judgeSrc(v.d) : v.sourceId;
        const k = deps.editKind(v.doc, src);
        return k === 'file' ? 'file' : k === 'solution' ? 'solution' : 'edited';
    }
    function groupOf(r: Row): GroupId {
        const kinds = r.vers.map(verKind);
        return kinds.includes('edited') ? 'pending' : kinds.includes('solution') ? 'solution' : 'done';
    }
    function mainVer(r: Row): Ver { return r.vers.find(v => v.kind === 'local') ?? r.vers.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; }
    function latest(r: Row): string { return r.vers.reduce((m, v) => v.updatedAt > m ? v.updatedAt : m, ''); }
    /** 中身の違う版（同じ中身の Gist の版はまとめる） */
    function distinct(r: Row): Ver[] {
        const seen = new Set<string>();
        return r.vers.filter(v => { const h = contentHash(v.doc, v.sourceId); if (seen.has(h)) return false; seen.add(h); return true; });
    }
    function sendOf(v: Ver): string { return v.kind === 'local' ? deps.sendLabel(v.l) : `↓ ${v.d.device}`; }
    function sendCls(send: string): string {
        return send === 'SAVED' ? 'saved' : send === 'SAVED*' ? 'changed' : send.startsWith('↓') ? 'incoming' : 'none';
    }
    /** やり残し（書き込み待ち＋手順だけ）の件数。バッジに出す */
    function pendingCount(): number { return rows().filter(r => groupOf(r) !== 'done').length; }

    function matches(doc: EditorDoc): boolean {
        if (dv.rule !== 'all' && doc.rule !== dv.rule) return false;
        const q = dvFilter.value.trim().toLowerCase();
        return !q || `${doc.rule} ${doc.id} ${doc.description}`.toLowerCase().includes(q);
    }
    const MARK: Record<GroupId, string> = { pending: '●', solution: '◆', done: '', trash: '' };
    const GROUP_LABEL: Record<GroupId, [string, string]> = {
        pending: ['書き込み待ち', '問題に変更あり（EDITED）・新しい問題。WRITE FILE で片付く'],
        solution: ['手順だけ', '問題はファイルのまま、解答手順だけ未保存。SAVE SOLUTION で片付く'],
        done: ['書き込み済み', 'ファイルと同じ内容の Gist の下書き（CLEAN UP で消せる。dev サーバーでは自動で片付く）'],
        trash: ['最近消した', 'このブラウザで消した下書き（7 日・30 件まで）。RESTORE で戻せる'],
    };

    function renderDraftsView() {
        if (!view.isConnected || view.offsetParent === null) return;
        const cur = deps.currentKey();
        const all = rows();
        const groups: Record<GroupId, Row[]> = { pending: [], solution: [], done: [], trash: [] };
        for (const r of all) groups[groupOf(r)].push(r);
        const trash = deps.localDrafts.trashList();
        const parts: string[] = [];
        for (const g of ['pending', 'solution', 'done', 'trash'] as GroupId[]) {
            const items = g === 'trash'
                ? trash.map((t, i) => ({ t, i })).filter(({ t }) => matches(t.draft.doc))
                : groups[g].filter(r => matches(mainVer(r).doc)).sort((a, b) => latest(b).localeCompare(latest(a)));
            if ((g === 'done' || g === 'solution') && !groups[g].length) continue;
            if (g === 'trash' && !trash.length) continue;
            const open = dv.open[g];
            parts.push(`<button type="button" class="dv-item dv-group" data-item="g:${g}" title="${esc(GROUP_LABEL[g][1])}" aria-expanded="${open}" tabindex="-1">` +
                `${open ? '▼' : '▶'} ${GROUP_LABEL[g][0]} <small>${items.length}</small></button>`);
            if (!open) continue;
            if (g === 'trash') {
                for (const { t, i } of items as { t: TrashEntry; i: number }[]) {
                    parts.push(`<button type="button" class="dv-item dv-row trash" data-item="t:${i}" tabindex="-1">` +
                        `<span class="draft-rule">${t.draft.doc.rule.toUpperCase()}</span><span class="dv-id">${esc(t.draft.doc.id || '(ID なし)')}</span>` +
                        `<span class="dv-desc">${esc(t.draft.doc.description)}</span>` +
                        `<span class="dv-tag">${t.reason === 'written' ? '書き込み済み' : 'DISCARD'}</span><time>${esc(relTime(t.deletedAt))}</time></button>`);
                }
                continue;
            }
            for (const r of items as Row[]) {
                const m = mainVer(r);
                const send = sendOf(m);
                const vers = distinct(r);
                const exp = vers.length > 1;
                const expanded = exp && dv.expanded.has(r.key);
                parts.push(`<button type="button" class="dv-item dv-row${r.key === cur ? ' me' : ''}" data-item="r:${esc(r.key)}" tabindex="-1"` +
                    `${exp ? ` aria-expanded="${expanded}"` : ''}>` +
                    `<span class="dv-twisty">${exp ? (expanded ? '▾' : '▸') : ''}</span>` +
                    `<span class="draft-rule">${r.rule.toUpperCase()}</span><span class="dv-id">${esc(m.doc.id || (m.sourceId === null ? '新規' : '(ID なし)'))}</span>` +
                    `<span class="dv-desc">${esc(m.doc.description)}</span>` +
                    `<span class="lv-m ${g === 'solution' ? 'solution' : 'edited'}">${MARK[g]}</span>` +
                    `${send ? `<span class="send ${sendCls(send)}">${esc(send)}</span>` : ''}<time>${esc(relTime(latest(r)))}</time></button>`);
                if (!expanded) continue;
                vers.forEach((v, i) => {
                    const label = v.kind === 'local' ? 'このブラウザ' : `Gist・${v.d.device}${v.d.conflictOf ? '（別の下書き）' : ''}`;
                    const vs = sendOf(v);
                    parts.push(`<button type="button" class="dv-item dv-row dv-child" data-item="v:${esc(r.key)}|${i}" tabindex="-1">` +
                        `<span class="dv-twisty">${i === vers.length - 1 ? '└' : '├'}</span><span class="dv-desc">${esc(label)}</span>` +
                        `<span class="dv-tag">${esc(deps.describe(v.doc, v.kind === 'remote' ? deps.judgeSrc(v.d) : v.sourceId))}</span>` +
                        `${v.kind === 'local' && vs ? `<span class="send ${sendCls(vs)}">${esc(vs)}</span>` : ''}<time>${esc(relTime(v.updatedAt))}</time></button>`);
                });
            }
        }
        if (!parts.length) parts.push(`<p class="note">下書きはありません（問題を編集すると自動で作られます${engine.enabled ? '。SAVE すると Gist に保存され、他の端末のここに出ます' : ''}）。</p>`);
        const html = parts.join('');
        if (html !== dv.html) {
            const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('#dv-body .dv-item')?.dataset.item;
            dvBody.innerHTML = html;
            dv.html = html;
            if (focused) itemEl(focused)?.focus({ preventScroll: true });
        }
        if (!itemEl(dv.sel)) dv.sel = itemEl(`r:${cur}`) ? `r:${cur}` : dvBody.querySelector<HTMLElement>('.dv-row')?.dataset.item ?? '';
        for (const el of dvBody.querySelectorAll<HTMLElement>('.dv-item')) {
            el.classList.toggle('sel', el.dataset.item === dv.sel);
            el.tabIndex = el.dataset.item === dv.sel ? 0 : -1;
        }
        for (const b of view.querySelectorAll<HTMLButtonElement>('#dv-rule button')) b.classList.toggle('on', b.dataset.rule === dv.rule);
        const locals = deps.localDrafts.count();
        const remotes = engine.enabled ? Object.keys(engine.drafts()).length : 0;
        const warn = [
            locals > LOCAL_DRAFT_WARN ? `このブラウザの下書きが ${locals}件あります。不要な物は DISCARD してください。` : '',
            remotes > GIST_DRAFT_WARN ? `Gist の下書きが ${remotes}件あります。CLEAN UP で書き込み済みの物を整理してください。` : '',
        ].filter(Boolean).join('<br>');
        $('dv-warn').innerHTML = warn;
        $('dv-warn').hidden = !warn;
        // プレビュー URL の「ファイル」はデプロイした時点の物（PC で書き込んだ内容は push・デプロイまで見えない。drafts §5.4）
        const stale = $('dv-stale');
        stale.hidden = import.meta.env.DEV;
        if (!import.meta.env.DEV) stale.textContent = `問題一覧はデプロイした時点（${new Date(QUIZ_EDITOR_BUILT_AT).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）の内容です。PC で書き込んだ物は push 後に反映されます`;
        $<HTMLButtonElement>('dv-sync').hidden = !engine.enabled;
        $<HTMLButtonElement>('dv-cleanup').hidden = !engine.enabled;
        renderDetail();
    }
    function itemEl(item: string): HTMLElement | null {
        return item ? dvBody.querySelector<HTMLElement>(`.dv-item[data-item="${CSS.escape(item)}"]`) : null;
    }

    /** data-item から対象を引く */
    type Target = { kind: 'row'; row: Row } | { kind: 'ver'; row: Row; ver: Ver } | { kind: 'trash'; index: number; entry: TrashEntry } | { kind: 'group'; g: GroupId } | null;
    function target(item: string): Target {
        const [t, rest] = [item.slice(0, 1), item.slice(2)];
        if (t === 'g') return { kind: 'group', g: rest as GroupId };
        if (t === 't') { const e = deps.localDrafts.trashList()[Number(rest)]; return e ? { kind: 'trash', index: Number(rest), entry: e } : null; }
        if (t === 'r') { const row = rows().find(r => r.key === rest); return row ? { kind: 'row', row } : null; }
        if (t === 'v') {
            const i = rest.lastIndexOf('|');
            const row = rows().find(r => r.key === rest.slice(0, i));
            const ver = row ? distinct(row)[Number(rest.slice(i + 1))] : undefined;
            return row && ver ? { kind: 'ver', row, ver } : null;
        }
        return null;
    }
    const localOf = (r: Row) => r.vers.find(v => v.kind === 'local') as Extract<Ver, { kind: 'local' }> | undefined;
    const remotesOf = (r: Row) => r.vers.filter(v => v.kind === 'remote') as Extract<Ver, { kind: 'remote' }>[];

    function renderDetail() {
        const el = $('dv-detail');
        const t = target(dv.hover || dv.sel);
        if (!t || t.kind === 'group') { el.innerHTML = '<p class="note">行を選ぶと詳しく出ます。クリック（Enter）で開く・Delete で捨てる</p>'; return; }
        if (t.kind === 'trash') {
            const d = t.entry.draft;
            el.innerHTML = `<div><span class="draft-rule">${d.doc.rule.toUpperCase()}</span><b>${esc(d.doc.id || '(ID なし)')}</b> ${esc(d.doc.description)}</div>` +
                `<div class="note">${t.entry.reason === 'written' ? '書き込まれたため片付けた' : 'DISCARD した'} ・ ${esc(relTime(t.entry.deletedAt))} ・ ${esc(deps.describe(d.doc, d.sourceId))}</div>` +
                `<div class="row"><button type="button" data-act="restore">RESTORE</button><button type="button" data-act="purge" title="ごみ箱から消す">DELETE</button></div>`;
            return;
        }
        const row = t.row;
        const m = t.kind === 'ver' ? t.ver : mainVer(row);
        const local = t.kind === 'ver' ? (t.ver.kind === 'local' ? t.ver : undefined) : localOf(row);
        const remotes = t.kind === 'ver' ? (t.ver.kind === 'remote' ? [t.ver] : []) : remotesOf(row);
        const lines: string[] = [];
        if (local) {
            const send = deps.sendLabel(local.l);
            lines.push(`このブラウザ: ${relTime(local.updatedAt)}${send ? ` ・ ${send}` : ''}`);
        }
        for (const r of remotes) lines.push(`Gist: ${r.d.device} ・ ${fmt(r.d.updatedAt)}${r.d.conflictOf ? '（別の下書き）' : ''}${r.d.status === 'written' ? '（旧 WRITTEN）' : ''}`);
        const sendL = local ? deps.sendLabel(local.l) : '';
        el.innerHTML = `<div><span class="draft-rule">${m.doc.rule.toUpperCase()}</span><b>${esc(m.doc.id || '(ID なし)')}</b> ${esc(m.doc.description)}</div>` +
            `<div class="note">${esc(deps.describe(m.doc, m.kind === 'remote' ? deps.judgeSrc(m.d) : m.sourceId))}</div>` +
            lines.map(l => `<div class="note">${esc(l)}</div>`).join('') +
            `<div class="row"><button type="button" data-act="open" ${local && local.key === deps.currentKey() ? 'disabled' : ''}>OPEN</button>` +
            (local && engine.enabled ? `<button type="button" data-act="save" ${sendL === 'SAVED' ? 'disabled' : ''} title="Gist に保存する">SAVE</button>` : '') +
            (local ? '<button type="button" data-act="discard" title="このブラウザの下書きを捨てる（Gist は消えない・最近消したから戻せる）">DISCARD</button>' : '') +
            (remotes.length ? `<button type="button" data-act="delete" title="Gist から消す（Gist の履歴には残る）">DELETE GIST${remotes.length > 1 ? ` (${remotes.length})` : ''}</button>` : '') +
            '</div>';
    }
    const fmt = fmtDateTime;

    /** 開く（行＝このブラウザの版を優先、子の行＝その版） */
    function openTarget(t: Target) {
        if (!t) return;
        if (t.kind === 'group') { toggleGroup(t.g); return; }
        if (t.kind === 'trash') return;
        const v = t.kind === 'ver' ? t.ver : (localOf(t.row) ?? mainVer(t.row));
        if (v.kind === 'local') { if (v.key !== deps.currentKey()) deps.openLocal(v.key); }
        else deps.openDraft(v.id);
        if (draftsDlg.open) draftsDlg.close();
        deps.afterOpen();
    }
    function toggleGroup(g: GroupId) {
        dv.open[g] = !dv.open[g];
        try { localStorage.setItem(GROUP_KEY, JSON.stringify(dv.open)); } catch { /* 保存不可 */ }
        renderDraftsView();
        itemEl(`g:${g}`)?.focus({ preventScroll: true });
    }
    function act(name: string, t: Target) {
        if (!t) return;
        if (t.kind === 'trash') {
            if (name === 'restore') {
                if (!deps.localDrafts.restore(t.index)) toast('同じ問題の下書きがこのブラウザにあるため戻せません（先にその下書きを開くか DISCARD してください）', 'warn');
                else toast(`「${t.entry.draft.doc.id || '(ID なし)'}」の下書きを戻しました`);
            } else if (name === 'purge') deps.localDrafts.removeTrash(t.index);
            deps.afterLocalChanged();
            return;
        }
        if (t.kind === 'group') return;
        if (name === 'open') { openTarget(t); return; }
        const local = t.kind === 'ver' ? (t.ver.kind === 'local' ? t.ver : undefined) : localOf(t.row);
        const remotes = t.kind === 'ver' ? (t.ver.kind === 'remote' ? [t.ver] : []) : remotesOf(t.row);
        if (name === 'save' && local) void deps.saveLocal(local.key).then(renderDraftsView);
        if (name === 'discard' && local) { deps.discardLocal(local.key); renderDraftsView(); }
        if (name === 'delete' && remotes.length) {
            const d = remotes[0].d;
            void ask(`Gist の下書き「${d.doc.id || '(ID なし)'} ${d.doc.description}」${remotes.length > 1 ? `ほか ${remotes.length - 1}件` : ''}を消します（Gist の履歴からは戻せます）。よろしいですか？`,
                { skipId: 'delete-gist' }).then(ok => { if (ok) void engine.deleteDrafts(remotes.map(r => r.id)).then(renderDraftsView); });
        }
    }

    /** CLEAN UP の対象: ファイルと同じ（書き込み済み）・旧 WRITTEN・元の問題がファイルに無く 30 日以上前の物 */
    function cleanupTargets(): [string, DraftEntry][] {
        const old = Date.now() - 30 * 86400_000;
        return Object.entries(engine.drafts()).filter(([, d]) => {
            const k = deps.editKind(d.doc, deps.judgeSrc(d));
            return k === 'file' || d.status === 'written' || (k === 'new' && Date.parse(d.updatedAt) < old);
        });
    }

    view.addEventListener('click', e => {
        const el = e.target as HTMLElement;
        const btn = el.closest<HTMLButtonElement>('button');
        if (!btn) return;
        if (btn.closest('#dv-rule')) { dv.rule = btn.dataset.rule as typeof dv.rule; renderDraftsView(); return; }
        if (btn.id === 'dv-sync') { void engine.syncNow().then(renderDraftsView); return; }
        if (btn.id === 'dv-cleanup') {
            const list = cleanupTargets();
            if (!list.length) { toast('整理する下書きはありません'); return; }
            const lines = list.map(([, d]) => `・${d.doc.id || '(ID なし)'} ${d.doc.description}（${d.device}・${deps.describe(d.doc, deps.judgeSrc(d))}）`).join('\n');
            if (confirm(`次の ${list.length}件の下書きを Gist から消します（Gist の履歴には残ります）。\n${lines}`)) {
                void engine.deleteDrafts(list.map(([i]) => i)).then(() => { toast(`${list.length}件の下書きを整理しました`); renderDraftsView(); });
            }
            return;
        }
        if (btn.dataset.act) { act(btn.dataset.act, target(dv.sel)); return; }
        const item = btn.closest<HTMLElement>('.dv-item')?.dataset.item;
        if (!item) return;
        dv.sel = item;
        const t = target(item);
        if (t?.kind === 'row' && (e.target as HTMLElement).closest('.dv-twisty') && distinct(t.row).length > 1) {
            if (dv.expanded.has(t.row.key)) dv.expanded.delete(t.row.key); else dv.expanded.add(t.row.key);
            renderDraftsView();
            return;
        }
        if (t?.kind === 'trash') { renderDraftsView(); return; }
        openTarget(t);
    });
    // 行にフォーカスがある時だけ矢印・Enter・Delete を使う。それ以外のキーは今のモードへ流れる（LEVELS と同じ。tools §2.3）
    dvBody.addEventListener('keydown', e => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('.dv-item');
        if (!el || e.altKey || e.metaKey || e.ctrlKey) return;
        const items = [...dvBody.querySelectorAll<HTMLElement>('.dv-item')];
        const i = items.indexOf(el);
        const t = target(el.dataset.item!);
        const go = (n: HTMLElement | undefined) => {
            if (!n) return;
            dv.sel = n.dataset.item!;
            dv.hover = '';
            renderDraftsView();   // 時刻の表示が変わると描き直すので、要素は item で引き直す
            const m = itemEl(dv.sel);
            m?.focus({ preventScroll: true });
            m?.scrollIntoView({ block: 'nearest' });
        };
        if (e.key === 'ArrowDown') { e.preventDefault(); go(items[i + 1]); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) go(items[i - 1]); else dvFilter.focus(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const want = e.key === 'ArrowRight';
            if (t?.kind === 'group' && dv.open[t.g] !== want) toggleGroup(t.g);
            else if (t?.kind === 'row' && distinct(t.row).length > 1 && dv.expanded.has(t.row.key) !== want) {
                if (want) dv.expanded.add(t.row.key); else dv.expanded.delete(t.row.key);
                renderDraftsView();
                itemEl(el.dataset.item!)?.focus({ preventScroll: true });
            }
        } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dv.sel = el.dataset.item!; openTarget(t); }
        else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (t?.kind === 'trash') act('purge', t);
            else if (t && t.kind !== 'group') act((t.kind === 'ver' ? t.ver.kind === 'local' : !!localOf(t.row)) ? 'discard' : 'delete', t);
        }
    });
    dvBody.addEventListener('focusin', e => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.dv-item')?.dataset.item;
        if (item && item !== dv.sel) { dv.sel = item; renderDraftsView(); }
    });
    dvBody.addEventListener('mouseover', e => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.dv-item')?.dataset.item ?? '';
        if (item !== dv.hover) { dv.hover = item; renderDetail(); }
    });
    dvBody.addEventListener('mouseleave', () => { dv.hover = ''; renderDetail(); });
    dvFilter.addEventListener('input', () => { dv.hover = ''; renderDraftsView(); });
    dvFilter.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); dvFilter.value = ''; renderDraftsView(); itemEl(dv.sel)?.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); itemEl(dv.sel)?.focus(); }
    });
    function showDrafts() {
        if (deps.isMobile()) { renderDraftsView(); draftsDlg.showModal(); renderDraftsView(); }
        else deps.showSidebar();
        if (engine.enabled) void engine.syncNow();   // 開いた時に読み直す（結果は refresh で描き直される）
    }
    $('btn-drafts').addEventListener('click', showDrafts);

    return {
        /** DRAFTS を開く（PC はサイドバー、スマホはダイアログ） */
        showDrafts,
        /** DRAFTS ビューを描く（PC のサイドバーで表示された時） */
        renderDrafts() { renderDraftsView(); },
        /** 開いた時に Gist を読み直す */
        shown() { if (engine.enabled) void engine.syncNow(); },
        /** 同期の状態が変わった時に呼ぶ */
        refresh() {
            renderChip();
            renderDraftsView();
            if (syncDlg.open && !(document.activeElement instanceof HTMLInputElement)) renderSync();
        },
    };
}
