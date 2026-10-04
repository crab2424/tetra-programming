// ─────────────────────────────────────────────
// sync-ui.ts
// 同期まわりの画面（SYNC 設定・QR コード・DRAFTS 一覧・トップバーの状態表示）。設計書 §14.3〜14.4
// 状態とエディタ本体の操作は main.ts から deps で受け取る。
// ─────────────────────────────────────────────
import qrcode from 'qrcode-generator';
import {
    type SyncEngine, type DraftEntry, type SyncState, guessDevice, encodeSyncHash, GIST_DRAFT_WARN,
} from './sync.ts';
import { type LocalDrafts, type LocalDraft, LOCAL_DRAFT_WARN, contentHash } from './local-drafts.ts';
import type { EditorDoc } from './model.ts';
import { canWriteFiles, readLocalSolutions, exportSolutionsFile } from './solutions.ts';
import { toast } from './toast.ts';

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
}

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
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
        // バッジ = Gist の下書きの件数（PC で書き込み待ち）。多すぎる時は「!」で整理を促す
        const remote = engine.enabled ? Object.keys(engine.drafts()).length : 0;
        const local = deps.localDrafts.count();
        const tooMany = remote > GIST_DRAFT_WARN || local > LOCAL_DRAFT_WARN;
        const badge = $('drafts-badge');
        badge.hidden = remote === 0 && !tooMany;
        badge.textContent = tooMany ? `${remote}!` : String(remote);
        badge.classList.toggle('err', tooMany);
        badge.title = `Gist の下書き（PC で書き込み待ち）: ${remote}件・この端末の下書き: ${local}件${tooMany ? '\n多くなっています。DRAFTS で整理してください' : ''}`;
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
            <p class="note">解答手順は Gist の tsolutions.json が正本です。</p>
            <div class="row">
              <button type="button" id="sync-import" title="ローカルの source_assets/quizlevels/tsolutions.json を Gist に取り込む（Gist に無い・Gist より新しいものだけ）">IMPORT LOCAL FILE</button>
              <button type="button" id="sync-export" title="Gist の解答をローカルの tsolutions.json に書き出す（バックアップ）">EXPORT TO FILE</button>
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
                        const map = await readLocalSolutions();
                        if (!map) { toast('ローカルの解答ファイルを読めませんでした', 'error'); return; }
                        const n = await engine.importSolutions(map);
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
                    const map = engine.solutions();
                    if (!confirm(`Gist の解答 ${Object.keys(map).length}件で、ローカルの tsolutions.json を上書きします。よろしいですか？`)) return;
                    try {
                        const r = await exportSolutionsFile(map);
                        toast(r.via === 'file' ? `${r.fileName} に書き出しました` : 'ダウンロードしました');
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

    // ─── DRAFTS 画面（上: この端末で編集中の下書き / 下: Gist の下書き＝PC で書き込み待ち。save-notify §5.3） ───
    function renderDrafts() {
        const body = $('drafts-body');
        const cur = deps.currentKey();
        const locals = deps.localDrafts.all();
        const remotes = engine.enabled ? Object.entries(engine.drafts()).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)) : [];
        const localHashes = new Set(locals.map(([, l]) => contentHash(l.doc, l.sourceId)));
        const warn = [
            locals.length > LOCAL_DRAFT_WARN ? `この端末の下書きが ${locals.length}件あります。不要な物は DISCARD してください。` : '',
            remotes.length > GIST_DRAFT_WARN ? `Gist の下書きが ${remotes.length}件あります。CLEAN UP で書き込み済みの物を整理してください。` : '',
        ].filter(Boolean).join('<br>');
        const head = (d: EditorDoc) => `<span class="draft-rule">${d.rule.toUpperCase()}</span><b>${esc(d.id || '(ID なし)')}</b> ${esc(d.description || '')}`;
        const localHtml = locals.length ? `<ul class="draft-list">${locals.map(([key, l]) => {
            const send = deps.sendLabel(l);
            const sendCls = send === 'SAVED' ? 'saved' : send === 'SAVED*' ? 'changed' : send.startsWith('↓') ? 'incoming' : 'none';
            return `
            <li class="draft${key === cur ? ' current' : ''}" data-key="${esc(key)}">
              <div class="draft-main">${head(l.doc)}
                ${send ? `<span class="send ${sendCls}">${esc(send)}</span>` : ''}
                ${key === cur ? '<span class="note">← 開いている</span>' : ''}</div>
              <div class="draft-meta note">${esc(deps.describe(l.doc, l.sourceId))} ・ ${esc(relTime(l.updatedAt))}</div>
              <div class="row">
                <button type="button" data-act="open-local" ${key === cur ? 'disabled' : ''}>OPEN</button>
                ${engine.enabled ? `<button type="button" data-act="save-local" ${send === 'SAVED' ? 'disabled' : ''} title="Gist に保存する">SAVE</button>` : ''}
                <button type="button" data-act="discard" title="この端末の下書きを捨てる（Gist は消えない）">DISCARD</button>
              </div>
            </li>`;
        }).join('')}</ul>` : '<p class="note">この端末で編集中の下書きはありません（問題を編集すると自動で作られます）。</p>';
        const remoteHtml = !engine.enabled
            ? '<p class="note">SYNC を設定すると、SAVE した下書きが Gist に保存され、他の端末のここに出ます。</p>'
            : remotes.length ? `<ul class="draft-list">${remotes.map(([id, d]) => `
            <li class="draft remote" data-id="${esc(id)}">
              <div class="draft-main">${head(d.doc)}
                ${d.conflictOf ? '<span class="warn">別の下書き</span>' : ''}
                ${d.status === 'written' ? '<span class="warn">WRITTEN（旧）</span>' : ''}
                ${localHashes.has(contentHash(d.doc, d.sourceId)) ? '<span class="note">この端末と同じ</span>' : ''}</div>
              <div class="draft-meta note">${esc(d.device)} ・ ${esc(relTime(d.updatedAt))} ・ ${esc(deps.describe(d.doc, d.sourceId))}</div>
              <div class="row">
                <button type="button" data-act="open">OPEN</button>
                <button type="button" data-act="delete" title="Gist から消す（Gist の履歴には残る）">DELETE</button>
              </div>
            </li>`).join('')}</ul>` : '<p class="note">Gist に下書きはありません。</p>';
        body.innerHTML = `
            ${warn ? `<p class="warn-box">${warn}</p>` : ''}
            <h3>THIS DEVICE <small>${locals.length}</small></h3>
            ${localHtml}
            <div class="row"><h3>GIST <small>${remotes.length}</small></h3><span class="spacer"></span>
              ${engine.enabled ? `<button type="button" data-act="sync" title="Gist を読み直す">SYNC NOW</button>
              <button type="button" data-act="cleanup" title="書き込み済み・ファイルと同じ・古い下書きをまとめて消す">CLEAN UP</button>` : ''}</div>
            ${remoteHtml}
            <p class="note">自動保存はこの端末の中だけです。Gist には SAVE（OUTPUT・Ctrl/⌘+Shift+S）を押した時だけ保存され、他の端末のここに出ます。
              PC で WRITE FILE が成功すると、その問題の Gist の下書きは自動で消えます。</p>`;
    }

    /** CLEAN UP の対象: ファイルと同じ（書き込み済み）・旧 WRITTEN・元の問題がファイルに無く 30 日以上前の物 */
    function cleanupTargets(): [string, DraftEntry][] {
        const old = Date.now() - 30 * 86400_000;
        return Object.entries(engine.drafts()).filter(([, d]) => {
            const k = deps.editKind(d.doc, d.sourceId);
            return k === 'file' || d.status === 'written' || (k === 'new' && Date.parse(d.updatedAt) < old);
        });
    }

    $('drafts-body').addEventListener('click', e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
        if (!btn) return;
        const li = btn.closest<HTMLElement>('li.draft');
        const key = li?.dataset.key;
        const id = li?.dataset.id;
        switch (btn.dataset.act) {
            case 'open-local': if (key) { draftsDlg.close(); deps.openLocal(key); } break;
            case 'save-local': if (key) void deps.saveLocal(key).then(renderDrafts); break;
            case 'discard': if (key) { deps.discardLocal(key); renderDrafts(); } break;
            case 'open': if (id) { draftsDlg.close(); deps.openDraft(id); } break;
            case 'delete': {
                const d = id ? engine.draft(id) : undefined;
                if (id && d && confirm(`Gist の下書き「${d.doc.id || '(ID なし)'} ${d.doc.description}」を消します（Gist の履歴からは戻せます）。よろしいですか？`)) {
                    void engine.deleteDrafts([id]).then(renderDrafts);
                }
                break;
            }
            case 'sync': void engine.syncNow().then(renderDrafts); break;
            case 'cleanup': {
                const list = cleanupTargets();
                if (!list.length) { toast('整理する下書きはありません'); break; }
                const lines = list.map(([, d]) => `・${d.doc.id || '(ID なし)'} ${d.doc.description}（${d.device}・${deps.describe(d.doc, d.sourceId)}）`).join('\n');
                if (confirm(`次の ${list.length}件の下書きを Gist から消します（Gist の履歴には残ります）。\n${lines}`)) {
                    void engine.deleteDrafts(list.map(([i]) => i)).then(() => { toast(`${list.length}件の下書きを整理しました`); renderDrafts(); });
                }
                break;
            }
        }
    });
    $('btn-drafts').addEventListener('click', () => {
        renderDrafts();
        draftsDlg.showModal();
        if (engine.enabled) void engine.syncNow();   // 開いた時に読み直す（結果は refresh で描き直される）
    });

    return {
        /** 同期の状態が変わった時に呼ぶ */
        refresh() {
            renderChip();
            if (draftsDlg.open) renderDrafts();
            if (syncDlg.open && !(document.activeElement instanceof HTMLInputElement)) renderSync();
        },
    };
}
