// ─────────────────────────────────────────────
// sync.ts
// PC とスマホの同期（非公開 Gist。設計書 §14.3）。
//
// Gist のファイル構成:
//   draft-<draftId>.json … 編集中の問題 1 件（DraftEntry）。下書きごとに別ファイルなので、
//                          別の下書きを同時に保存しても互いに上書きしない
//   tsolutions.json      … 解答手順（ローカルの source_assets/quizlevels/tsolutions.json と同じ形式）
//
// 端末内の変更はまずキュー（localStorage）に積み、少し待ってから Gist へ送る。
// 送る直前に Gist を読み直し、同じ下書きを他の端末が先に更新していたら上書きせず「競合コピー」として別に保存する。
// ─────────────────────────────────────────────
import type { EditorDoc } from './model.ts';
import { type SolutionMap, type SolutionEntry, serializeSolutions } from './solutions.ts';
import { findOrCreateGist, getGist, patchGist, GistAuthError, GistNotFoundError, type GistSnapshot } from './gist.ts';

export type DraftStatus = 'editing' | 'ready' | 'written';
export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = { editing: 'EDITING', ready: 'READY', written: 'WRITTEN' };

export interface DraftEntry {
    doc: EditorDoc;
    sourceId: string | null;   // 既存問題から開いた場合の元 id（WRITE FILE の置換先）
    status: DraftStatus;       // editing=編集中 / ready=PC で書き込み待ち / written=書込済み
    rev: number;               // Gist に保存するたびに +1
    updatedAt: string;         // ISO
    device: string;            // 最後に保存した端末
    conflictOf?: string;       // 競合コピーの場合、元の下書きの id
}

export interface SyncConfig { token: string; gistId: string; device: string; }
export type SyncState = 'off' | 'synced' | 'saving' | 'offline' | 'error' | 'auth';

export interface SyncEvent {
    remoteUpdated: string[];                      // 他の端末で更新・削除された下書き
    conflicts: { from: string; to: string }[];    // 競合コピーを作った（from の変更を to として保存）
    skippedSolutions: string[];                   // 他の端末の方が新しかったため保存しなかった解答
}

const CONFIG_KEY = 'tetlabo.quizEditor.sync';
const QUEUE_KEY = 'tetlabo.quizEditor.syncQueue';
const CACHE_KEY = 'tetlabo.quizEditor.syncCache';
export const SOLUTIONS_FILE = 'tsolutions.json';
const DRAFT_RE = /^draft-([A-Za-z0-9_-]+)\.json$/;
const PUSH_DELAY = 5000;
const POLL_INTERVAL = 30000;
const KEEPALIVE_LIMIT = 60000;   // fetch keepalive の本文上限（64KB）より少し小さく

export function draftFileName(id: string): string { return `draft-${id}.json`; }
export function newDraftId(): string {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
export function guessDevice(): string {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows';
    return 'PC';
}

// ─────────────────────────────────────────────
// 純粋な処理（テストしやすいよう Engine から分けてある）
// ─────────────────────────────────────────────
export interface Remote { drafts: Record<string, DraftEntry>; solutions: SolutionMap; solutionsText: string; }
interface PendingDraft { entry: DraftEntry; base: number; seq: number; }   // base = 編集を始めた時の Gist 側 rev
export type SolOp = { op: 'set'; id: string; entry: SolutionEntry } | { op: 'del'; id: string; at: string };
export interface Queue { drafts: Record<string, PendingDraft>; deletes: Record<string, number>; sol: SolOp[]; }

export function emptyQueue(): Queue { return { drafts: {}, deletes: {}, sol: [] }; }

export function parseRemote(files: Record<string, string>): Remote {
    const drafts: Record<string, DraftEntry> = {};
    for (const [name, text] of Object.entries(files)) {
        const m = DRAFT_RE.exec(name);
        if (!m) continue;
        try {
            const e = JSON.parse(text) as DraftEntry;
            if (e && e.doc && Array.isArray(e.doc.field)) drafts[m[1]] = e;
        } catch { /* 壊れたファイルは無視（Gist 上には残る） */ }
    }
    let solutions: SolutionMap = {};
    const solutionsText = files[SOLUTIONS_FILE] ?? '';
    try {
        const v = JSON.parse(solutionsText || '{}') as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) solutions = v as SolutionMap;
    } catch { /* 壊れていたら空扱い。保存時に上書きされないよう solutionsText は保持 */ }
    return { drafts, solutions, solutionsText };
}

function contentKey(e: Pick<DraftEntry, 'doc' | 'sourceId' | 'status'>): string {
    return JSON.stringify([e.doc, e.sourceId, e.status]);
}

/** 解答のキュー操作を適用する。honorNewer=true なら相手の方が新しいものは適用せず skipped に入れる */
export function applySolOps(base: SolutionMap, ops: SolOp[], honorNewer: boolean, skipped: string[] = []): SolutionMap {
    const m: SolutionMap = { ...base };
    for (const op of ops) {
        const cur = m[op.id];
        if (op.op === 'set') {
            if (honorNewer && cur && (cur.updatedAt ?? '') > (op.entry.updatedAt ?? '')) { skipped.push(op.id); continue; }
            m[op.id] = op.entry;
        } else if (cur) {
            if (honorNewer && (cur.updatedAt ?? '') > op.at) { skipped.push(op.id); continue; }
            delete m[op.id];
        }
    }
    return m;
}

export interface PushPlan {
    files: Record<string, string | null>;
    written: Record<string, DraftEntry>;          // 書いた（または既に同じ内容だった）下書き
    conflicts: { from: string; to: string }[];
    skippedSolutions: string[];
}

/**
 * Gist の現状（remote）にキューを重ねて、書き換えるファイルを決める。
 * allowConflicts=false（ページを閉じる途中の送信）では競合する下書きは送らない（次回の通常送信で扱う）
 */
export function planPush(remote: Remote, queue: Queue, device: string, now: string, allowConflicts = true): PushPlan {
    const plan: PushPlan = { files: {}, written: {}, conflicts: [], skippedSolutions: [] };
    for (const [id, p] of Object.entries(queue.drafts)) {
        const r = remote.drafts[id];
        if (r && contentKey(r) === contentKey(p.entry)) { plan.written[id] = r; continue; }   // 送信済み（閉じる途中の送信が届いていた等）
        const cur = r?.rev ?? 0;
        if (r && cur !== p.base) {
            if (!allowConflicts) continue;
            const to = newDraftId();
            const e: DraftEntry = { ...p.entry, rev: 1, updatedAt: now, device, conflictOf: id };
            plan.files[draftFileName(to)] = JSON.stringify(e);
            plan.written[to] = e;
            plan.conflicts.push({ from: id, to });
            continue;
        }
        const e: DraftEntry = { ...p.entry, rev: Math.max(cur, p.base) + 1, updatedAt: now, device };
        plan.files[draftFileName(id)] = JSON.stringify(e);
        plan.written[id] = e;
    }
    for (const [id, base] of Object.entries(queue.deletes)) {
        const r = remote.drafts[id];
        if (r && r.rev === base) plan.files[draftFileName(id)] = null;   // 削除後に他の端末で編集されていたら消さない
    }
    if (queue.sol.length) {
        const merged = applySolOps(remote.solutions, queue.sol, true, plan.skippedSolutions);
        const text = serializeSolutions(merged);
        if (text !== remote.solutionsText) plan.files[SOLUTIONS_FILE] = text;
    }
    return plan;
}

// ─────────────────────────────────────────────
// 同期エンジン
// ─────────────────────────────────────────────
function loadJson<T>(key: string): T | null {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
function saveJson(key: string, v: unknown) {
    try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* 保存不可 */ }
}

export class SyncEngine {
    config: SyncConfig | null = loadJson<SyncConfig>(CONFIG_KEY);
    state: SyncState = 'off';
    message = '';
    lastSyncAt: Date | null = null;
    htmlUrl = '';

    private remote: Remote = { drafts: {}, solutions: {}, solutionsText: '' };
    private etag: string | null = null;
    private queue: Queue = { ...emptyQueue(), ...loadJson<Queue>(QUEUE_KEY) };
    private seq = 0;
    private busy = false;
    private again = false;
    private pushTimer = 0;
    private started = false;

    constructor(private readonly onEvent: (ev: SyncEvent) => void, private readonly onState: () => void) {
        const cache = loadJson<{ files: Record<string, string>; htmlUrl: string }>(CACHE_KEY);
        if (cache) { this.remote = parseRemote(cache.files); this.htmlUrl = cache.htmlUrl; }
        for (const p of Object.values(this.queue.drafts)) this.seq = Math.max(this.seq, p.seq);
        if (this.config) this.state = 'saving';
    }

    get enabled(): boolean { return this.config !== null; }

    // ─── 表示用（Gist の内容に未送信の変更を重ねたもの） ───
    drafts(): Record<string, DraftEntry> {
        const out: Record<string, DraftEntry> = { ...this.remote.drafts };
        for (const id of Object.keys(this.queue.deletes)) delete out[id];
        for (const [id, p] of Object.entries(this.queue.drafts)) out[id] = { ...p.entry, rev: p.base };
        return out;
    }
    draft(id: string): DraftEntry | undefined { return this.drafts()[id]; }
    solutions(): SolutionMap { return applySolOps(this.remote.solutions, this.queue.sol, false); }
    hasPending(id: string): boolean { return id in this.queue.drafts; }
    pendingCount(): number {
        return Object.keys(this.queue.drafts).length + Object.keys(this.queue.deletes).length + this.queue.sol.length;
    }

    // ─── 変更 ───
    /** 下書きの内容を更新する（内容が同じなら何もしない） */
    putDraft(id: string, doc: EditorDoc, sourceId: string | null, status?: DraftStatus) {
        if (!this.config) return;
        const cur = this.draft(id);
        const contentChanged = !cur || JSON.stringify([cur.doc, cur.sourceId]) !== JSON.stringify([doc, sourceId]);
        // 書込済みの下書きを編集し直したら「編集中」に戻す
        let st: DraftStatus;
        if (status) st = status;
        else if (!cur || (cur.status === 'written' && contentChanged)) st = 'editing';
        else st = cur.status;
        if (cur && !contentChanged && cur.status === st) return;
        const prev = this.queue.drafts[id];
        const entry: DraftEntry = {
            doc: JSON.parse(JSON.stringify(doc)) as EditorDoc, sourceId, status: st,
            rev: 0, updatedAt: new Date().toISOString(), device: this.config.device,
        };
        if (cur?.conflictOf) entry.conflictOf = cur.conflictOf;
        this.queue.drafts[id] = { entry, base: prev ? prev.base : this.remote.drafts[id]?.rev ?? 0, seq: ++this.seq };
        delete this.queue.deletes[id];
        this.queueChanged(status !== undefined && !contentChanged ? 800 : PUSH_DELAY);
    }

    setDraftStatus(id: string, status: DraftStatus) {
        const cur = this.draft(id);
        if (cur) this.putDraft(id, cur.doc, cur.sourceId, status);
    }

    deleteDraft(id: string) {
        if (!this.config) return;
        delete this.queue.drafts[id];
        const r = this.remote.drafts[id];
        if (r) this.queue.deletes[id] = r.rev;
        this.queueChanged(800);
    }

    /** 1問ぶんの解答を保存してすぐ送る。oldId は問題 id を変えた時の旧キー（消す）。steps が空ならキーごと削除 */
    async setSolution(id: string, oldId: string | null, entry: SolutionEntry): Promise<string[]> {
        const at = new Date().toISOString();
        if (oldId && oldId !== id) this.queue.sol.push({ op: 'del', id: oldId, at });
        if (entry.steps.length) this.queue.sol.push({ op: 'set', id, entry: { ...entry, updatedAt: at } });
        else this.queue.sol.push({ op: 'del', id, at });
        this.persistQueue();
        return (await this.push()).skippedSolutions;
    }

    /** ローカルの解答ファイルを取り込む（Gist に無い・Gist より新しいエントリだけ）。戻り値は取り込んだ件数 */
    async importSolutions(map: SolutionMap): Promise<number> {
        const cur = this.solutions();
        let n = 0;
        for (const [id, e] of Object.entries(map)) {
            const c = cur[id];
            const newer = !c || (e.updatedAt ?? e.updated ?? '') > (c.updatedAt ?? c.updated ?? '');
            if (!newer || !e.steps?.length) continue;
            this.queue.sol.push({ op: 'set', id, entry: { ...e, updatedAt: e.updatedAt ?? new Date().toISOString() } });
            n++;
        }
        this.persistQueue();
        if (n) await this.push();
        return n;
    }

    // ─── 接続 ───
    async connect(token: string, device: string, gistId?: string): Promise<void> {
        const id = gistId || await findOrCreateGist(token, { [SOLUTIONS_FILE]: '{\n}\n' });
        this.config = { token, gistId: id, device: device || guessDevice() };
        saveJson(CONFIG_KEY, this.config);
        // 別の Gist に繋ぎ直した時に前の Gist の内容を混ぜない
        this.remote = { drafts: {}, solutions: {}, solutionsText: '' };
        this.etag = null;
        saveJson(CACHE_KEY, null);
        this.state = 'saving';
        this.start(true);
        await this.pull();
        if (this.pendingCount()) await this.push();
    }

    /** この端末から同期設定を消す（Gist と未送信の変更は消さない） */
    disconnect() {
        this.config = null;
        saveJson(CONFIG_KEY, null);
        saveJson(CACHE_KEY, null);
        this.remote = { drafts: {}, solutions: {}, solutionsText: '' };
        this.etag = null;
        this.state = 'off';
        this.message = '';
        clearTimeout(this.pushTimer);
        this.onState();
    }

    setDevice(name: string) {
        if (!this.config) return;
        this.config = { ...this.config, device: name.trim() || guessDevice() };
        saveJson(CONFIG_KEY, this.config);
    }

    /** ポーリングとページの表示/非表示の監視を始める（1回だけ）。skipInitial=true なら最初の同期は呼び出し側が行う */
    start(skipInitial = false) {
        if (this.started) return;
        this.started = true;
        document.addEventListener('visibilitychange', () => {
            if (!this.config) return;
            if (document.visibilityState === 'hidden') this.flushKeepalive();
            else void this.syncNow();
        });
        window.addEventListener('pagehide', () => this.flushKeepalive());
        window.addEventListener('online', () => void this.syncNow());
        window.setInterval(() => {
            if (this.config && document.visibilityState === 'visible' && this.state !== 'auth') void this.syncNow();
        }, POLL_INTERVAL);
        if (this.config && !skipInitial) void this.syncNow();
    }

    /** 取得して、未送信があれば送る */
    async syncNow(): Promise<void> {
        if (this.pendingCount()) await this.push();
        else await this.pull();
    }

    // ─── 通信 ───
    async pull(): Promise<void> {
        if (!this.config) return;
        if (this.busy) { this.again = true; return; }
        this.busy = true;
        try {
            await this.refresh();
            this.ok();
        } catch (err) {
            this.fail(err);
        } finally {
            this.busy = false;
            this.afterBusy();
        }
    }

    async push(): Promise<PushPlan> {
        const empty: PushPlan = { files: {}, written: {}, conflicts: [], skippedSolutions: [] };
        if (!this.config) return empty;
        if (this.busy) { this.again = true; return empty; }
        clearTimeout(this.pushTimer);
        this.busy = true;
        this.state = 'saving';
        this.onState();
        try {
            await this.refresh();
            const cfg = this.config;
            const seqs = Object.fromEntries(Object.entries(this.queue.drafts).map(([id, p]) => [id, p.seq]));
            const delIds = Object.keys(this.queue.deletes);
            const solN = this.queue.sol.length;
            const plan = planPush(this.remote, this.queue, cfg.device, new Date().toISOString());
            if (Object.keys(plan.files).length) {
                const snap = await patchGist(cfg.token, cfg.gistId, plan.files);
                if (snap) this.setRemote(snap);
            }
            // 送った分をキューから外す（送信中に更に編集された下書きは残し、基準 rev を更新）
            for (const [id, seq] of Object.entries(seqs)) {
                const p = this.queue.drafts[id];
                if (!p) continue;
                const conflict = plan.conflicts.find(c => c.from === id);
                const target = conflict ? conflict.to : id;
                const w = plan.written[target];
                if (p.seq === seq) delete this.queue.drafts[id];
                else if (w) {
                    delete this.queue.drafts[id];
                    this.queue.drafts[target] = { ...p, base: w.rev };
                }
            }
            for (const id of delIds) delete this.queue.deletes[id];
            this.queue.sol.splice(0, solN);
            this.persistQueue();
            this.ok();
            if (plan.conflicts.length || plan.skippedSolutions.length) {
                this.onEvent({ remoteUpdated: [], conflicts: plan.conflicts, skippedSolutions: plan.skippedSolutions });
            }
            return plan;
        } catch (err) {
            this.fail(err);
            return empty;
        } finally {
            this.busy = false;
            this.afterBusy();
        }
    }

    /** ページを閉じる/隠す途中の送信。読み直しはせず、手元の Gist の内容を基準に競合しない分だけ送る */
    flushKeepalive() {
        const cfg = this.config;
        if (!cfg || !this.pendingCount() || this.busy) return;
        clearTimeout(this.pushTimer);
        const plan = planPush(this.remote, this.queue, cfg.device, new Date().toISOString(), false);
        if (!Object.keys(plan.files).length) return;
        if (JSON.stringify(plan.files).length > KEEPALIVE_LIMIT) return;
        // 結果は待てない。キューは残し、次回の送信で「同じ内容が既にある」ことを確かめて外す
        void patchGist(cfg.token, cfg.gistId, plan.files, true).catch(() => { /* 次回の送信で再送 */ });
    }

    // ─── 内部 ───
    /** Gist を読み直し、他の端末による変更を通知する */
    private async refresh() {
        const cfg = this.config!;
        const snap = await getGist(cfg.token, cfg.gistId, this.etag);
        if (!snap) return;   // 変化なし
        const before = this.remote.drafts;
        this.setRemote(snap);
        const after = this.remote.drafts;
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .filter(id => before[id]?.rev !== after[id]?.rev);
        if (changed.length) this.onEvent({ remoteUpdated: changed, conflicts: [], skippedSolutions: [] });
    }

    private setRemote(snap: GistSnapshot) {
        this.remote = parseRemote(snap.files);
        this.etag = snap.etag;
        this.htmlUrl = snap.htmlUrl;
        saveJson(CACHE_KEY, { files: snap.files, htmlUrl: snap.htmlUrl });
    }

    private queueChanged(delay: number) {
        this.persistQueue();
        if (!this.config) return;
        clearTimeout(this.pushTimer);
        this.pushTimer = window.setTimeout(() => void this.push(), delay);
        if (this.state === 'synced') this.state = 'saving';
        this.onState();
    }

    private persistQueue() { saveJson(QUEUE_KEY, this.queue); }

    private afterBusy() {
        if (!this.again) return;
        this.again = false;
        void this.syncNow();
    }

    private ok() {
        this.lastSyncAt = new Date();
        this.state = this.pendingCount() ? 'saving' : 'synced';
        this.message = '';
        this.onState();
    }

    private fail(err: unknown) {
        console.error('[sync]', err);
        if (err instanceof GistAuthError) {
            this.state = 'auth';
            this.message = 'トークンが無効か期限切れです。SYNC で登録し直してください';
        } else if (err instanceof GistNotFoundError) {
            this.state = 'error';
            this.message = 'Gist が見つかりません。SYNC で接続し直してください';
        } else if (err instanceof TypeError) {
            this.state = 'offline';
            this.message = '通信できません（オフライン）。編集は端末内に保存され、つながった時に送ります';
        } else {
            this.state = 'error';
            this.message = (err as Error).message;
        }
        this.onState();
    }
}

// ─── QR コードで端末に設定を渡す（URL のフラグメントに入れる。フラグメントはサーバーへ送られない） ───
export function encodeSyncHash(cfg: SyncConfig): string {
    const json = JSON.stringify({ t: cfg.token, g: cfg.gistId });
    return 'sync=' + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeSyncHash(hash: string): { token: string; gistId: string } | null {
    const m = /(?:^#?|&)sync=([A-Za-z0-9_-]+)/.exec(hash);
    if (!m) return null;
    try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const o = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4))) as { t?: unknown; g?: unknown };
        return typeof o.t === 'string' && typeof o.g === 'string' ? { token: o.t, gistId: o.g } : null;
    } catch {
        return null;
    }
}
