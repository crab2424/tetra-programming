// ─────────────────────────────────────────────
// cpu_worker7.js
// テト CPU lv7（engine/。clys がもと、MIT）の Web Worker。Wasm(lv7Search / ctx があれば lv7Search2) を呼び出す。
// 設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md §3
// ─────────────────────────────────────────────

// ★ CpuWorkerPool（app/cpu_worker_pool.js）用: 返信へ要求元のリースID(__lease)をエコーする（cpu_worker6.js と同じ）。
let __leaseId;
self.addEventListener('message', (e) => { __leaseId = e.data ? e.data.__lease : undefined; });
const __postMessage = self.postMessage.bind(self);
self.postMessage = (msg, transfer) => {
    if (msg && typeof msg === 'object' && msg.type !== 'ready') msg.__lease = __leaseId;
    return transfer ? __postMessage(msg, transfer) : __postMessage(msg);
};

let wasmReady = false;

self.Module = {
    // ★再ビルドしたら ?v= を上げる（グルーjs・wasm・cpu7.js の WORKER_URLS を揃える）
    locateFile: function(path) { return path + '?v=2'; },
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

importScripts('cpu_wasm7.js?v=2');

const OUT_LEN = 160;       // [96..] は lv7Search2 の相手の見積もり（lv7Search は 96 まで）
const CTX_MAX = 19 + 4 * 16 + 250;   // lv7_wasm.cpp parse_ctx の並び
const QUEUE_MAX = 40;     // current＋確定 NEXT（深さ 32＋HOLD 空の1本＋余裕）
const WEIGHTS_MAX = 96;
let boardPtr = null;
let queuePtr = null;
let weightsPtr = null;
let outPtr = null;
let ctxPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;
    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr   = Module._lv7_malloc(250);
        queuePtr   = Module._lv7_malloc(4 * QUEUE_MAX);
        weightsPtr = Module._lv7_malloc(4 * WEIGHTS_MAX);
        outPtr     = Module._lv7_malloc(4 * OUT_LEN);
        ctxPtr     = Module._lv7_malloc(4 * CTX_MAX);
    }

    // ALLOW_MEMORY_GROWTH でヒープが付け替わることがあるので、毎回 Module から取り直す
    Module.HEAPU8.set(data.boardBuffer, boardPtr);
    const nQueue = Math.min(data.queue.length, QUEUE_MAX);
    Module.HEAP32.set(data.queue.slice(0, nQueue), queuePtr / 4);
    const nWeights = Math.min(data.weights.length, WEIGHTS_MAX);
    Module.HEAP32.set(data.weights.slice(0, nWeights), weightsPtr / 4);

    if (data.ctx) {
        const nCtx = Math.min(data.ctx.length, CTX_MAX);
        Module.HEAP32.set(data.ctx.slice(0, nCtx), ctxPtr / 4);
        Module._lv7Search2(
            boardPtr, queuePtr, nQueue, data.holdType, data.bagAfter,
            data.backToBack, data.ren, data.incoming || 0,
            weightsPtr, nWeights,
            data.width, data.depth, data.thinkMs,
            ctxPtr, nCtx, outPtr, OUT_LEN
        );
    } else {
        Module._lv7Search(
            boardPtr, queuePtr, nQueue, data.holdType, data.bagAfter,
            data.backToBack, data.ren, data.incoming || 0,
            weightsPtr, nWeights,
            data.width, data.depth, data.thinkMs,
            outPtr, 96
        );
        new Int32Array(Module.HEAP32.buffer, outPtr + 4 * 96, OUT_LEN - 96).fill(0);
    }

    const out = new Int32Array(Module.HEAP32.buffer, outPtr, OUT_LEN).slice();
    self.postMessage({ type: 'result', result: out });
};
