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
    message?: string;
}

export class SearchRunner {
    private worker: Worker | null = null;
    private seq = 0;
    private current: {
        id: number; mode: SearchMode; timeLimitMs: number; last: SearchProgress | null; started: number;
        resolve: (o: SearchOutcome) => void; onProgress?: (p: SearchProgress) => void;
    } | null = null;

    get running(): boolean { return this.current !== null; }

    /** 探索を始める。実行中なら前のものは中止する */
    run(doc: EditorDoc, mode: SearchMode, timeLimitMs: number, onProgress?: (p: SearchProgress) => void): Promise<SearchOutcome> {
        if (this.current) this.cancel();
        const worker = this.worker ?? this.spawn();
        const id = ++this.seq;
        return new Promise(resolve => {
            this.current = { id, mode, timeLimitMs, last: null, started: performance.now(), resolve, onProgress };
            const req: WorkerRequest = { id, doc: structuredClone(doc), opts: modeOptions(mode, timeLimitMs) };
            worker.postMessage(req);
        });
    }

    /** 中止（Worker ごと止める。次の run で作り直す） */
    cancel() {
        const cur = this.current;
        if (!cur) return;
        this.worker?.terminate();
        this.worker = null;
        this.current = null;
        cur.resolve(outcomeOf(cur.mode, cur.timeLimitMs, 'cancelled', null, 0, cur.last, performance.now() - cur.started));
    }

    dispose() {
        this.cancel();
        this.worker?.terminate();
        this.worker = null;
    }

    private spawn(): Worker {
        const w = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<WorkerResponse>) => {
            const cur = this.current;
            const msg = e.data;
            if (!cur || msg.id !== cur.id) return;   // 中止した前の探索の残り
            if (msg.type === 'progress') { cur.last = msg.progress; cur.onProgress?.(msg.progress); return; }
            this.current = null;
            const elapsed = performance.now() - cur.started;
            if (msg.type === 'error') {
                const o = outcomeOf(cur.mode, cur.timeLimitMs, 'error', null, 0, cur.last, elapsed);
                o.message = msg.message;
                cur.resolve(o);
                return;
            }
            const r = msg.result;
            const status: SearchStatus = r.complete ? 'done' : r.stopped ? (cur.mode === 'unique' ? 'multiple' : 'capped') : 'timeout';
            cur.resolve(outcomeOf(cur.mode, cur.timeLimitMs, status, r, msg.bad, cur.last, elapsed));
        };
        w.onerror = (e) => {
            const cur = this.current;
            if (!cur) return;
            this.current = null;
            this.worker?.terminate();
            this.worker = null;
            const o = outcomeOf(cur.mode, cur.timeLimitMs, 'error', null, 0, cur.last, performance.now() - cur.started);
            o.message = e.message || 'Worker を起動できませんでした';
            cur.resolve(o);
        };
        this.worker = w;
        return w;
    }
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
