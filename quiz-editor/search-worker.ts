// ─────────────────────────────────────────────
// search-worker.ts
// SEARCH（段階 S3）の Web Worker。探索は同期的に走るので、画面を止めないようにここで動かす。
// 中止はページ側が Worker ごと terminate する（探索中はメッセージを受け取れないため）。
// 呼び出しは search-client.ts の SearchRunner から。
// ─────────────────────────────────────────────
import type { EditorDoc } from './model.ts';
import { searchDoc, verifySolutions, type SearchOptions } from './search.ts';
import type { WorkerRequest, WorkerResponse } from './search-client.ts';

const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(msg: WorkerResponse): void;
};

ctx.onmessage = (e) => {
    const { id, doc, opts } = e.data;
    try {
        const result = searchDoc(doc as EditorDoc, {
            ...(opts as SearchOptions),
            onProgress: p => ctx.postMessage({ type: 'progress', id, progress: p }),
        });
        // 見つけた解はすべてシミュレーターで検算する（設計 §1.1）
        const bad = verifySolutions(doc, result.solutions).length;
        ctx.postMessage({ type: 'done', id, result, bad });
    } catch (err) {
        ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
};
