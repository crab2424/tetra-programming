// ─────────────────────────────────────────────
// sync-ui.ts
// 同期まわりの画面（SYNC 設定・QR コード・DRAFTS 一覧・トップバーの状態表示）。設計書 §14.3〜14.4
// 状態とエディタ本体の操作は main.ts から deps で受け取る。
// ─────────────────────────────────────────────
import qrcode from 'qrcode-generator';
import {
    type SyncEngine, type DraftStatus, type SyncState, DRAFT_STATUS_LABEL, guessDevice, encodeSyncHash,
} from './sync.ts';
import { canWriteFiles, readLocalSolutions, exportSolutionsFile } from './solutions.ts';

export interface SyncUiDeps {
    engine: SyncEngine;
    currentDraftId: () => string | null;
    openDraft: (id: string) => void;
    status: (msg: string) => void;
    afterSolutionsChanged: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PREVIEW_SUFFIX = '-citgame.pptlabo.workers.dev';
const QR_URL_KEY = 'tetlabo.quizEditor.qrUrl';
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

const STATE_LABEL: Record<SyncState, string> = {
    off: 'SYNC: OFF', synced: 'SYNCED', saving: 'SAVING…', offline: 'OFFLINE', error: 'SYNC ERROR', auth: 'SYNC: TOKEN?',
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
        chip.textContent = STATE_LABEL[engine.state];
        chip.dataset.state = engine.state;
        chip.title = engine.message || 'PC とスマホの同期（GitHub Gist）';
        const ready = Object.values(engine.drafts()).filter(d => d.status === 'ready').length;
        const badge = $('drafts-badge');
        badge.hidden = ready === 0;
        badge.textContent = String(ready);
        badge.title = `PC で書き込み待ち: ${ready}件`;
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
            ${engine.message ? `<p class="${engine.state === 'offline' ? 'note' : 'err'}">${esc(engine.message)}</p>` : ''}
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
        deps.status('GitHub に接続しています…');
        try {
            await engine.connect(token, device, gistId);
            deps.afterSolutionsChanged();
            deps.status(engine.state === 'synced' || engine.state === 'saving' ? '同期を開始しました' : engine.message);
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
                        if (!map) { deps.status('ローカルの解答ファイルを読めませんでした'); return; }
                        const n = await engine.importSolutions(map);
                        deps.afterSolutionsChanged();
                        deps.status(n ? `${n}件の解答を Gist に取り込みました` : '取り込む解答はありませんでした（Gist の方が新しいか同じ）');
                    } catch (err) {
                        if ((err as Error).name !== 'AbortError') deps.status(`取り込めませんでした: ${(err as Error).message}`);
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
                        deps.status(r.via === 'file' ? `${r.fileName} に書き出しました` : 'ダウンロードしました');
                    } catch (err) {
                        if ((err as Error).name !== 'AbortError') deps.status(`書き出せませんでした: ${(err as Error).message}`);
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

    // ─── DRAFTS 画面 ───
    function renderDrafts() {
        const body = $('drafts-body');
        if (!engine.enabled) {
            body.innerHTML = '<p class="note">SYNC を設定すると、編集中の問題が PC とスマホで共有され、ここに一覧で出ます。</p>';
            return;
        }
        const cur = deps.currentDraftId();
        const list = Object.entries(engine.drafts()).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
        if (!list.length) { body.innerHTML = '<p class="note">下書きはまだありません。問題を編集すると自動で作られます。</p>'; return; }
        const opts = (st: DraftStatus) => (Object.keys(DRAFT_STATUS_LABEL) as DraftStatus[])
            .map(s => `<option value="${s}" ${s === st ? 'selected' : ''}>${DRAFT_STATUS_LABEL[s]}</option>`).join('');
        body.innerHTML = `<ul class="draft-list">${list.map(([id, d]) => `
            <li class="draft ${d.status}${id === cur ? ' current' : ''}" data-id="${esc(id)}">
              <div class="draft-main">
                <span class="draft-rule">${d.doc.rule.toUpperCase()}</span>
                <b>${esc(d.doc.id || '(ID なし)')}</b> ${esc(d.doc.description || '')}
                ${d.conflictOf ? '<span class="warn">競合コピー</span>' : ''}
                ${id === cur ? '<span class="note">← 開いている</span>' : ''}
              </div>
              <div class="draft-meta note">${esc(d.device)} ・ ${esc(relTime(d.updatedAt))}${d.sourceId ? ` ・ 元: ${esc(d.sourceId)}` : ' ・ 新規'}${engine.hasPending(id) ? ' ・ 未送信' : ''}</div>
              <div class="row">
                <select data-act="status" aria-label="状態">${opts(d.status)}</select>
                <button type="button" data-act="open" ${id === cur ? 'disabled' : ''}>OPEN</button>
                <button type="button" data-act="delete">DELETE</button>
              </div>
            </li>`).join('')}</ul>
            <p class="note">READY = スマホで作り終えて PC での書き込み待ち。WRITTEN = tdata/pdata.json に書き込み済み（WRITE FILE で自動的に付きます）。</p>`;
    }
    $('drafts-body').addEventListener('click', e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
        const id = btn?.closest<HTMLElement>('li.draft')?.dataset.id;
        if (!btn || !id) return;
        if (btn.dataset.act === 'open') { draftsDlg.close(); deps.openDraft(id); }
        if (btn.dataset.act === 'delete') {
            const d = engine.draft(id);
            if (d && confirm(`下書き「${d.doc.id} ${d.doc.description}」を削除します（Gist の履歴からは戻せます）。よろしいですか？`)) {
                engine.deleteDraft(id);
                renderDrafts();
            }
        }
    });
    $('drafts-body').addEventListener('change', e => {
        const sel = e.target as HTMLSelectElement;
        const id = sel.closest<HTMLElement>('li.draft')?.dataset.id;
        if (sel.dataset.act === 'status' && id) { engine.setDraftStatus(id, sel.value as DraftStatus); renderDrafts(); }
    });
    $('btn-drafts').addEventListener('click', () => { renderDrafts(); draftsDlg.showModal(); });

    return {
        /** 同期の状態が変わった時に呼ぶ */
        refresh() {
            renderChip();
            if (draftsDlg.open) renderDrafts();
            if (syncDlg.open && !(document.activeElement instanceof HTMLInputElement)) renderSync();
        },
    };
}
