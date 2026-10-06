// ─────────────────────────────────────────────
// sync.ts
// PC とスマホの受け渡し（非公開 Gist。旧設計 §14.3 → save-notify §3 で手動保存に変更）。
//
// Gist のファイル構成:
//   draft-<draftId>.json … 下書き 1 件（DraftEntry）。**SAVE を押した時だけ**書く。1 問につき 1 つ
//   tsolutions.json      … テトの解答手順（ローカルの source_assets/quizlevels/tsolutions.json と同じ形式）
//   psolutions.json      … ぷよの解答手順（同 psolutions.json。最初に保存した時に作られる。段階4）
//
// 編集の自動保存は端末内（local-drafts.ts）だけ。Gist は自動では書かない（回数制限に当たらないように）。
// 取得は起動時・画面に戻った時・DRAFTS を開いた時・SYNC NOW の時だけ（一定間隔の取得はしない）。
// 解答の保存と下書きの削除は、送れなかった時に備えてキュー（localStorage）に積み、次の通信で送り直す。
// ─────────────────────────────────────────────
import type { EditorDoc, Rule } from './model.ts';
import { type SolutionMap, type SolutionEntry, serializeSolutions, hasSolutionContent, SOLUTION_FILES, RULES } from './solutions.ts';
import { findOrCreateGist, getGist, patchGist, GistAuthError, GistNotFoundError, GistRateLimitError, type GistSnapshot } from './gist.ts';

export interface DraftEntry {
    doc: EditorDoc;
    sourceId: string | null;   // 既存問題から開いた場合の元 id（WRITE FILE の置換先）
    rev: number;               // Gist に保存するたびに +1
    updatedAt: string;         // ISO
    device: string;            // 保存した端末
    conflictOf?: string;       // 「別の下書きとして保存」した場合、元の下書きの id
    status?: string;           // 旧形式（editing/ready/written）。読むだけで、もう書かない
}

export interface SyncConfig { token: string; gistId: string; device: string; }
export type SyncState = 'off' | 'synced' | 'saving' | 'offline' | 'error' | 'auth' | 'limited';

export interface SyncEvent {
    remoteUpdated: string[];                      // 他の端末で更新・削除された下書き
    skippedSolutions: string[];                   // 他の端末の方が新しかったため保存しなかった解答
}

const CONFIG_KEY = 'tetlabo.quizEditor.sync';
const QUEUE_KEY = 'tetlabo.quizEditor.syncQueue';
const CACHE_KEY = 'tetlabo.quizEditor.syncCache';
const DRAFT_RE = /^draft-([A-Za-z0-9_-]+)\.json$/;
/** 画面に戻った時の取得は、前回からこれ以上たっている時だけ */
const REFRESH_MIN_INTERVAL = 30000;
/** Gist の下書きがこれを超えたら DRAFTS で整理を促す（自動では消さない） */
export const GIST_DRAFT_WARN = 20;

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
export interface Remote { drafts: Record<string, DraftEntry>; solutions: Record<Rule, SolutionMap>; solutionsText: Record<Rule, string>; }
/** rule が無い操作は段階4より前のキュー（テト） */
export type SolOp = ({ op: 'set'; id: string; entry: SolutionEntry } | { op: 'del'; id: string; at: string }) & { rule?: Rule };
/** deletes: 下書き id → 消すと決めた時の Gist 側 rev（その後に他の端末で保存されていたら消さない） */
export interface Queue { deletes: Record<string, number>; sol: SolOp[]; }
interface LegacyQueue extends Queue { drafts?: Record<string, { entry: DraftEntry }>; }

export function emptyQueue(): Queue { return { deletes: {}, sol: [] }; }
export function emptyRemote(): Remote { return { drafts: {}, solutions: { tet: {}, puyo: {} }, solutionsText: { tet: '', puyo: '' } }; }
function opsOf(ops: SolOp[], rule: Rule): SolOp[] { return ops.filter(o => (o.rule ?? 'tet') === rule); }

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
    const out = emptyRemote();
    out.drafts = drafts;
    for (const rule of RULES) {
        const text = files[SOLUTION_FILES[rule]] ?? '';
        out.solutionsText[rule] = text;
        try {
            const v = JSON.parse(text || '{}') as unknown;
            if (v && typeof v === 'object' && !Array.isArray(v)) out.solutions[rule] = v as SolutionMap;
        } catch { /* 壊れていたら空扱い。保存時に上書きされないよう solutionsText は保持 */ }
    }
    return out;
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

export interface PushPlan { files: Record<string, string | null>; skippedSolutions: string[]; }

/** Gist の現状（remote）にキュー（削除・解答）を重ねて、書き換えるファイルを決める */
export function planPush(remote: Remote, queue: Queue): PushPlan {
    const plan: PushPlan = { files: {}, skippedSolutions: [] };
    for (const [id, base] of Object.entries(queue.deletes)) {
        const r = remote.drafts[id];
        if (r && r.rev === base) plan.files[draftFileName(id)] = null;   // 消すと決めた後に他の端末で保存されていたら消さない
    }
    for (const rule of RULES) {
        const ops = opsOf(queue.sol, rule);
        if (!ops.length) continue;
        const merged = applySolOps(remote.solutions[rule], ops, true, plan.skippedSolutions);
        const text = serializeSolutions(merged);
        if (text !== remote.solutionsText[rule]) plan.files[SOLUTION_FILES[rule]] = text;
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class SyncEngine {
    config: SyncConfig | null = loadJson<SyncConfig>(CONFIG_KEY);
    state: SyncState = 'off';
    message = '';
    lastSyncAt: Date | null = null;
    htmlUrl = '';
    /** レート制限で止めている間の再開時刻（ms）。0 = 制限なし */
    limitedUntil = 0;

    private remote: Remote = emptyRemote();
    private etag: string | null = null;
    private queue: Queue = emptyQueue();
    /** 旧版（自動送信）のキューに残っていた未送信の下書き。main.ts が端末内の下書きへ移す */
    private legacyDrafts: [string, DraftEntry][] = [];
    private busy = false;
    private again = false;
    private started = false;
    private limitTimer = 0;

    constructor(private readonly onEvent: (ev: SyncEvent) => void, private readonly onState: () => void) {
        const cache = loadJson<{ files: Record<string, string>; htmlUrl: string }>(CACHE_KEY);
        if (cache) { this.remote = parseRemote(cache.files); this.htmlUrl = cache.htmlUrl; }
        const q = loadJson<LegacyQueue>(QUEUE_KEY);
        if (q) {
            this.queue = { deletes: q.deletes ?? {}, sol: q.sol ?? [] };
            this.legacyDrafts = Object.entries(q.drafts ?? {}).map(([id, p]) => [id, p.entry] as [string, DraftEntry]).filter(([, e]) => e && e.doc);
            if (q.drafts) this.persistQueue();
        }
        if (this.config) this.state = 'saving';
    }

    get enabled(): boolean { return this.config !== null; }
    /** この画面を開いてから Gist を読めていて、今も同期できている（キャッシュだけで判断しない。drafts §5.2） */
    get fresh(): boolean { return this.lastSyncAt !== null && this.state === 'synced'; }

    /** 旧版のキューに残っていた未送信の下書きを取り出す（1回だけ） */
    takeLegacyDrafts(): [string, DraftEntry][] {
        const l = this.legacyDrafts;
        this.legacyDrafts = [];
        return l;
    }

    // ─── 表示用（Gist の内容から、消す予定の下書きを除いたもの） ───
    drafts(): Record<string, DraftEntry> {
        const out: Record<string, DraftEntry> = { ...this.remote.drafts };
        for (const id of Object.keys(this.queue.deletes)) delete out[id];
        return out;
    }
    draft(id: string): DraftEntry | undefined { return this.drafts()[id]; }
    solutions(rule: Rule): SolutionMap { return applySolOps(this.remote.solutions[rule], opsOf(this.queue.sol, rule), false); }
    pendingCount(): number { return Object.keys(this.queue.deletes).length + this.queue.sol.length; }

    // ─── 変更 ───
    /**
     * 下書きを Gist に保存する（SAVE）。baseRev = 上書きする下書きの今の rev（新しく作るなら 0）。
     * 競合の確認は呼び出し側（直前に refreshNow で読み直して判断する）。失敗したら例外
     */
    async writeDraft(id: string, doc: EditorDoc, sourceId: string | null, baseRev: number, conflictOf?: string): Promise<DraftEntry> {
        const cfg = this.config;
        if (!cfg) throw new Error('SYNC が設定されていません');
        if (this.isLimited()) throw new Error(this.message || 'GitHub の回数制限で待っています');
        await this.idle();
        this.busy = true;
        this.state = 'saving';
        this.onState();
        try {
            const e: DraftEntry = {
                doc: JSON.parse(JSON.stringify(doc)) as EditorDoc, sourceId,
                rev: baseRev + 1, updatedAt: new Date().toISOString(), device: cfg.device,
            };
            if (conflictOf) e.conflictOf = conflictOf;
            const snap = await patchGist(cfg.token, cfg.gistId, { [draftFileName(id)]: JSON.stringify(e) });
            if (snap) this.setRemote(snap);
            this.ok();
            return e;
        } catch (err) {
            this.fail(err);
            throw err;
        } finally {
            this.busy = false;
            this.afterBusy();
        }
    }

    /** 下書きを Gist から消す（送れなければキューに残して次の通信で送る） */
    async deleteDrafts(ids: string[]) {
        if (!this.config || !ids.length) return;
        for (const id of ids) {
            const r = this.remote.drafts[id];
            if (r) this.queue.deletes[id] = r.rev;
        }
        this.persistQueue();
        this.onState();
        await this.push();
    }

    /** 1問ぶんの解答を保存してすぐ送る。oldId は問題 id を変えた時の旧キー（消す）。手順も MEMO も無ければキーごと削除 */
    async setSolution(rule: Rule, id: string, oldId: string | null, entry: SolutionEntry): Promise<string[]> {
        const at = new Date().toISOString();
        if (oldId && oldId !== id) this.queue.sol.push({ op: 'del', id: oldId, at, rule });
        if (hasSolutionContent(entry)) this.queue.sol.push({ op: 'set', id, entry: { ...entry, updatedAt: at }, rule });
        else this.queue.sol.push({ op: 'del', id, at, rule });
        this.persistQueue();
        return (await this.push()).skippedSolutions;
    }

    /** ローカルの解答ファイルを取り込む（Gist に無い・Gist より新しいエントリだけ）。戻り値は取り込んだ件数 */
    async importSolutions(rule: Rule, map: SolutionMap): Promise<number> {
        const cur = this.solutions(rule);
        let n = 0;
        for (const [id, e] of Object.entries(map)) {
            const c = cur[id];
            const newer = !c || (e.updatedAt ?? e.updated ?? '') > (c.updatedAt ?? c.updated ?? '');
            if (!newer || !(e.steps?.length || e.memo)) continue;
            this.queue.sol.push({ op: 'set', id, entry: { ...e, updatedAt: e.updatedAt ?? new Date().toISOString() }, rule });
            n++;
        }
        this.persistQueue();
        if (n) await this.push();
        return n;
    }

    // ─── 接続 ───
    async connect(token: string, device: string, gistId?: string): Promise<void> {
        const id = gistId || await findOrCreateGist(token, { [SOLUTION_FILES.tet]: '{\n}\n' });
        this.config = { token, gistId: id, device: device || guessDevice() };
        saveJson(CONFIG_KEY, this.config);
        // 別の Gist に繋ぎ直した時に前の Gist の内容を混ぜない
        this.remote = emptyRemote();
        this.etag = null;
        this.limitedUntil = 0;
        saveJson(CACHE_KEY, null);
        this.state = 'saving';
        this.start(true);
        await this.syncNow();
    }

    /** この端末から同期設定を消す（Gist と端末内の下書きは消さない） */
    disconnect() {
        this.config = null;
        saveJson(CONFIG_KEY, null);
        saveJson(CACHE_KEY, null);
        this.remote = emptyRemote();
        this.etag = null;
        this.state = 'off';
        this.message = '';
        this.onState();
    }

    setDevice(name: string) {
        if (!this.config) return;
        this.config = { ...this.config, device: name.trim() || guessDevice() };
        saveJson(CONFIG_KEY, this.config);
    }

    /** 画面に戻った時・通信が戻った時の取得を始める（1回だけ）。skipInitial=true なら最初の同期は呼び出し側が行う */
    start(skipInitial = false) {
        if (this.started) return;
        this.started = true;
        document.addEventListener('visibilitychange', () => {
            if (!this.config || document.visibilityState !== 'visible') return;
            if (this.lastSyncAt && Date.now() - this.lastSyncAt.getTime() < REFRESH_MIN_INTERVAL) return;
            void this.syncNow();
        });
        window.addEventListener('online', () => void this.syncNow());
        if (this.config && !skipInitial) void this.syncNow();
    }

    /** 取得して、送り残し（解答・削除）があれば送る */
    async syncNow(): Promise<void> {
        if (this.pendingCount()) await this.push();
        else await this.pull();
    }

    /** 最新の Gist を読み終えるまで待つ（SAVE の前の競合確認用）。読めなければ例外 */
    async refreshNow(): Promise<void> {
        if (!this.config) throw new Error('SYNC が設定されていません');
        if (this.isLimited()) throw new Error(this.message || 'GitHub の回数制限で待っています');
        await this.idle();
        await this.pull();
        if (this.state !== 'synced' && this.state !== 'saving') throw new Error(this.message || 'Gist を読めませんでした');
    }

    // ─── 通信 ───
    async pull(): Promise<void> {
        if (!this.config || this.isLimited()) return;
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
        const empty: PushPlan = { files: {}, skippedSolutions: [] };
        if (!this.config || this.isLimited()) return empty;
        if (this.busy) { this.again = true; return empty; }
        this.busy = true;
        this.state = 'saving';
        this.onState();
        try {
            await this.refresh();
            const cfg = this.config;
            const delIds = Object.keys(this.queue.deletes);
            const solN = this.queue.sol.length;
            const plan = planPush(this.remote, this.queue);
            if (Object.keys(plan.files).length) {
                const snap = await patchGist(cfg.token, cfg.gistId, plan.files);
                if (snap) this.setRemote(snap);
            }
            for (const id of delIds) delete this.queue.deletes[id];
            this.queue.sol.splice(0, solN);
            this.persistQueue();
            this.ok();
            if (plan.skippedSolutions.length) this.onEvent({ remoteUpdated: [], skippedSolutions: plan.skippedSolutions });
            return plan;
        } catch (err) {
            this.fail(err);
            return empty;
        } finally {
            this.busy = false;
            this.afterBusy();
        }
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
        if (changed.length) this.onEvent({ remoteUpdated: changed, skippedSolutions: [] });
    }

    private setRemote(snap: GistSnapshot) {
        this.remote = parseRemote(snap.files);
        this.etag = snap.etag;
        this.htmlUrl = snap.htmlUrl;
        saveJson(CACHE_KEY, { files: snap.files, htmlUrl: snap.htmlUrl });
    }

    private async idle() { while (this.busy) await sleep(50); }

    private persistQueue() { saveJson(QUEUE_KEY, this.queue); }

    private afterBusy() {
        if (!this.again) return;
        this.again = false;
        void this.syncNow();
    }

    /** レート制限中か（中は送信も取得もしない。制限中に叩き続けると延びることがあるため） */
    isLimited(): boolean { return this.limitedUntil > Date.now(); }

    private ok() {
        this.lastSyncAt = new Date();
        this.state = this.pendingCount() ? 'saving' : 'synced';
        this.message = '';
        this.onState();
    }

    private fail(err: unknown) {
        console.error('[sync]', err);
        if (err instanceof GistRateLimitError) {
            // トークンは有効。再開時刻まで待って自動で1回やり直す（編集は端末内に残っている）
            this.limitedUntil = err.until;
            this.state = 'limited';
            const t = new Date(err.until);
            this.message = `GitHub の回数制限に当たりました。${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} ごろに自動で再開します（トークンはそのまま使えます）。${err.message}`;
            clearTimeout(this.limitTimer);
            this.limitTimer = window.setTimeout(() => { this.limitedUntil = 0; void this.syncNow(); }, Math.max(1000, err.until - Date.now() + 500));
        } else if (err instanceof GistAuthError) {
            this.state = 'auth';
            this.message = `トークンが無効・期限切れ・権限不足のいずれかです。SYNC で登録し直してください（${err.message}）`;
        } else if (err instanceof GistNotFoundError) {
            this.state = 'error';
            this.message = 'Gist が見つかりません。SYNC で接続し直してください';
        } else if (err instanceof TypeError) {
            this.state = 'offline';
            this.message = '通信できません（オフライン）。編集は端末内に残っています';
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
