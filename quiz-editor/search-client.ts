// ─────────────────────────────────────────────
// search-client.ts
// SEARCH（段階 S3）のページ側: Worker での実行・進捗・中止・結果の文言。
// 画面（段階 S4）はこれを使う。設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-solver.md
// ─────────────────────────────────────────────
import type { AnyStep, EditorDoc } from './model.ts';
import { modeOptions, SOLUTION_CAP, type AnySearchResult, type SearchMode, type SearchOptions, type SearchProgress } from './search.ts';

// ─── Worker とのメッセージ ───
export interface WorkerRequest { id: number; doc: EditorDoc; opts: Omit<SearchOptions, 'onProgress'>; }
export type WorkerResponse =
    | { type: 'progress'; id: number; progress: SearchProgress }
    | { type: 'done'; id: number; result: AnySearchResult; bad: number }
    | { type: 'error'; id: number; message: string };

/**
 * 結果の種類
 * - done: 全探索済み（count は正確）
 * - capped: COUNT で SOLUTION_CAP 個に達して止めた（count は下限）
 * - multiple: UNIQUE で 2 つ目の解が見つかって止めた
 * - timeout: 時間で打ち切り（count は下限）
 * - cancelled: CANCEL で中止（count は最後の進捗の時点の値）
 */
export type SearchStatus = 'done' | 'capped' | 'multiple' | 'timeout' | 'cancelled' | 'error';

export interface SearchOutcome {
    mode: SearchMode;
    status: SearchStatus;
    count: number;
    solutions: AnyStep[][];
    /** 検算（simulate）に通らなかった解の数。0 でなければ探索側の不具合 */
    bad: number;
    /** 取り出した解の最短手数。shortestExact = 全部の解を取り出した上での最短（＝問題全体の最短） */
    shortest: number | null;
    shortestExact: boolean;
    /** 取り出した解の手数ごとの件数 */
    byLength: [number, number][];
    nodes: number;
    elapsedMs: number;
    timeLimitMs: number;
    /** 分けて動かした Worker の数（1 = 分けていない） */
    parts: number;
    message?: string;
}

/**
 * 並列にする Worker の数（設計 §14）。テトだけ分ける（ぷよは同じ局面への合流が多く、分けるとメモが効かずに遅くなる）。
 * 論理コアから 2 つ残し、8 まで
 */
export function parallelParts(doc: EditorDoc): number {
    if (doc.rule !== 'tet') return 1;
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
    return Math.max(1, Math.min(8, cores - 2));
}

interface RunState {
    id: number; mode: SearchMode; timeLimitMs: number; started: number; parts: number;
    last: (SearchProgress | null)[];
    results: ({ result: AnySearchResult; bad: number } | null)[];
    resolve: (o: SearchOutcome) => void; onProgress?: (p: SearchProgress) => void;
}

export class SearchRunner {
    private workers: (Worker | null)[] = [];
    private seq = 0;
    private current: RunState | null = null;

    get running(): boolean { return this.current !== null; }

    /** 探索を始める。実行中なら前のものは中止する。テトは parallelParts 個の Worker で受け持ちを分ける（search.ts の split） */
    run(doc: EditorDoc, mode: SearchMode, timeLimitMs: number, onProgress?: (p: SearchProgress) => void): Promise<SearchOutcome> {
        if (this.current) this.cancel();
        const parts = parallelParts(doc);
        const id = ++this.seq;
        return new Promise(resolve => {
            this.current = {
                id, mode, timeLimitMs, started: performance.now(), parts,
                last: new Array(parts).fill(null), results: new Array(parts).fill(null),
                resolve: o => resolve({ ...o, parts }), onProgress,
            };
            const base = modeOptions(mode, timeLimitMs);
            const copy = structuredClone(doc);
            for (let part = 0; part < parts; part++) {
                const req: WorkerRequest = { id, doc: copy, opts: parts > 1 ? { ...base, split: { part, parts } } : base };
                (this.workers[part] ?? this.spawn(part)).postMessage(req);
            }
        });
    }

    /** 中止（Worker ごと止める。次の run で作り直す） */
    cancel() {
        const cur = this.current;
        if (!cur) return;
        this.stopAll();
        cur.resolve(outcomeOf(cur.mode, cur.timeLimitMs, 'cancelled', null, 0, sumProgress(cur.last), performance.now() - cur.started));
    }

    dispose() {
        this.cancel();
        this.stopAll();
    }

    private stopAll() {
        for (const w of this.workers) w?.terminate();
        this.workers = [];
        this.current = null;
    }

    private spawn(part: number): Worker {
        const w = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<WorkerResponse>) => {
            const cur = this.current;
            const msg = e.data;
            if (!cur || msg.id !== cur.id) return;   // 中止した前の探索の残り
            if (msg.type === 'progress') {
                cur.last[part] = msg.progress;
                cur.onProgress?.(sumProgress(cur.last)!);
                return;
            }
            const elapsed = performance.now() - cur.started;
            if (msg.type === 'error') {
                this.stopAll();
                const o = outcomeOf(cur.mode, cur.timeLimitMs, 'error', null, 0, sumProgress(cur.last), elapsed);
                o.message = msg.message;
                cur.resolve(o);
                return;
            }
            cur.results[part] = { result: msg.result, bad: msg.bad };
            // 1 つの受け持ちだけで上限（UNIQUE は 2 つ）に届いたら、残りの受け持ちを待たずに止める
            const stopped = msg.result.stopped;
            if (!stopped && cur.results.some(r => r === null)) return;
            if (stopped && cur.results.some(r => r === null)) this.stopAll(); else this.current = null;
            const merged = mergeResults(cur, part);
            let status: SearchStatus = merged.result.complete ? 'done' : merged.result.stopped ? (cur.mode === 'unique' ? 'multiple' : 'capped') : 'timeout';
            // 受け持ちの和で上限を超えた時も、1 つで止めた時と同じ表示にする（UNIQUE の 2 つ目・COUNT の打ち切り後）
            if (cur.mode === 'unique' && merged.result.count >= 2) status = 'multiple';
            else if (status === 'timeout' && merged.result.count >= SOLUTION_CAP) status = 'capped';
            cur.resolve(outcomeOf(cur.mode, cur.timeLimitMs, status, merged.result, merged.bad, sumProgress(cur.last), elapsed));
        };
        w.onerror = (e) => {
            const cur = this.current;
            if (!cur) return;
            this.stopAll();
            const o = outcomeOf(cur.mode, cur.timeLimitMs, 'error', null, 0, sumProgress(cur.last), performance.now() - cur.started);
            o.message = e.message || 'Worker を起動できませんでした';
            cur.resolve(o);
        };
        this.workers[part] = w;
        return w;
    }
}

/** 受け持ちごとの進捗の和（経過は一番長いもの） */
function sumProgress(ps: (SearchProgress | null)[]): SearchProgress | null {
    const got = ps.filter((p): p is SearchProgress => p !== null);
    if (!got.length) return null;
    return { nodes: got.reduce((a, p) => a + p.nodes, 0), found: got.reduce((a, p) => a + p.found, 0), elapsedMs: Math.max(...got.map(p => p.elapsedMs)) };
}

/**
 * 受け持ちの結果をまとめる。終わっていない受け持ち（上限で途中で止めた時）は最後の進捗の解の数を足す（＝下限）。
 * 解は終わった受け持ちのものを、止めた受け持ち（last）を先にして上限まで
 */
function mergeResults(cur: RunState, last: number): { result: AnySearchResult; bad: number } {
    const done = cur.results.map((r, i) => ({ r, i })).filter((x): x is { r: { result: AnySearchResult; bad: number }; i: number } => x.r !== null);
    done.sort((a, b) => (a.i === last ? -1 : b.i === last ? 1 : a.i - b.i));
    const all = done.length === cur.parts;
    const cap = modeOptions(cur.mode, cur.timeLimitMs).maxSolutions;
    const solutions: unknown[][] = [];
    for (const { r } of done) for (const sol of r.result.solutions) if (solutions.length < cap) solutions.push(sol);
    const sum = (f: (r: AnySearchResult) => number) => done.reduce((a, { r }) => a + f(r.result), 0);
    const pending = cur.last.reduce((a, p, i) => a + (cur.results[i] ? 0 : p?.found ?? 0), 0);
    const result = {
        count: sum(r => r.count) + pending,
        complete: all && done.every(({ r }) => r.result.complete),
        timedOut: done.some(({ r }) => r.result.timedOut),
        stopped: done.some(({ r }) => r.result.stopped),
        nodes: sum(r => r.nodes) + cur.last.reduce((a, p, i) => a + (cur.results[i] ? 0 : p?.nodes ?? 0), 0),
        memoSize: sum(r => r.memoSize), placementCalls: sum(r => r.placementCalls), placements: sum(r => r.placements),
        searchMs: Math.max(...done.map(({ r }) => r.result.searchMs)), totalMs: Math.max(...done.map(({ r }) => r.result.totalMs)),
        solutions,
    } as AnySearchResult;
    return { result, bad: done.reduce((a, { r }) => a + r.bad, 0) };
}

function outcomeOf(mode: SearchMode, timeLimitMs: number, status: SearchStatus, r: AnySearchResult | null, bad: number,
    last: SearchProgress | null, elapsedMs: number): SearchOutcome {
    const solutions = (r?.solutions ?? []) as AnyStep[][];
    const lengths = new Map<number, number>();
    for (const s of solutions) lengths.set(s.length, (lengths.get(s.length) ?? 0) + 1);
    const byLength = [...lengths].sort((a, b) => a[0] - b[0]);
    return {
        mode, status, bad, solutions, byLength, timeLimitMs,
        count: r ? r.count : last?.found ?? 0,
        shortest: byLength.length ? byLength[0][0] : null,
        shortestExact: status === 'done' && !!r && solutions.length === r.count,
        nodes: r ? r.nodes : last?.nodes ?? 0,
        elapsedMs,
        parts: 1,
    };
}

// ─── 表示の文言（見出しは英語・説明は日本語。UI 文言の規約） ───

const fmtN = (n: number) => n.toLocaleString('ja-JP');
const fmtSec = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;

/** 進捗の 1 行（例「3.2 秒・12,345 局面・26 通り」） */
export function describeProgress(p: SearchProgress): string {
    return `${fmtSec(p.elapsedMs)}・${fmtN(p.nodes)} 局面・${fmtN(p.found)} 通り`;
}

/** 結果の見出し（label）と説明（text） */
export function describeOutcome(o: SearchOutcome): { label: string; text: string } {
    const shortest = o.shortest === null ? '' : o.shortestExact ? `最短 ${o.shortest} 手` : `見つけた解の最短 ${o.shortest} 手`;
    let label: string, text: string;
    switch (o.status) {
        case 'done':
            if (o.count === 0) { label = 'NO SOLUTION'; text = '解なし（全探索済み）'; }
            else if (o.mode === 'unique') { label = 'UNIQUE'; text = `解は 1 つだけ（全探索済み・${o.shortest} 手）`; }
            else { label = 'SOLVED'; text = `解あり ${fmtN(o.count)} 通り（全探索済み・${shortest}）`; }
            break;
        case 'multiple':
            label = 'MULTIPLE'; text = '別解あり（解が 2 つ以上）';
            break;
        case 'capped':
            label = 'CAPPED'; text = `${fmtN(SOLUTION_CAP)} 通り以上（上限で止めました・${shortest}）`;
            break;
        case 'timeout':
            label = 'TIMEOUT';
            text = o.count > 0
                ? `${fmtN(o.count)} 通り以上（${fmtSec(o.timeLimitMs)}で打ち切り・${shortest}）`
                : `${fmtSec(o.timeLimitMs)}で打ち切り（解はまだ見つかっていません）`;
            break;
        case 'cancelled':
            label = 'CANCELLED'; text = `中止しました（${fmtSec(o.elapsedMs)}・それまでに ${fmtN(o.count)} 通り）`;
            break;
        default:
            label = 'ERROR'; text = `探索でエラーが起きました: ${o.message ?? ''}`;
    }
    if (o.bad > 0) text += `／⚠ 検算に通らない解が ${fmtN(o.bad)} 件（探索の不具合）`;
    return { label, text };
}
