// ─────────────────────────────────────────────
// cpu_worker7.js
// テト CPU lv7（engine/。clys がもと、MIT）の Web Worker。Wasm(lv7Search) を呼び出す。
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

const OUT_LEN = 96;
const QUEUE_MAX = 40;     // current＋確定 NEXT（深さ 32＋HOLD 空の1本＋余裕）
const WEIGHTS_MAX = 96;
let boardPtr = null;
let queuePtr = null;
let weightsPtr = null;
let outPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;
    const data = e.data;
    // calculate = 初手だけ（lv7Search）／plan = 初手から続く読み筋（lv7Plan。アシスト用）
    if (data.type !== 'calculate' && data.type !== 'plan') return;

    if (boardPtr === null) {
        boardPtr   = Module._lv7_malloc(250);
        queuePtr   = Module._lv7_malloc(4 * QUEUE_MAX);
        weightsPtr = Module._lv7_malloc(4 * WEIGHTS_MAX);
        outPtr     = Module._lv7_malloc(4 * OUT_LEN);
    }

    // ALLOW_MEMORY_GROWTH でヒープが付け替わることがあるので、毎回 Module から取り直す
    Module.HEAPU8.set(data.boardBuffer, boardPtr);
    const nQueue = Math.min(data.queue.length, QUEUE_MAX);
    Module.HEAP32.set(data.queue.slice(0, nQueue), queuePtr / 4);
    const nWeights = Math.min(data.weights.length, WEIGHTS_MAX);
    Module.HEAP32.set(data.weights.slice(0, nWeights), weightsPtr / 4);

    (data.type === 'plan' ? Module._lv7Plan : Module._lv7Search)(
        boardPtr, queuePtr, nQueue, data.holdType, data.bagAfter,
        data.backToBack, data.ren, data.incoming || 0,
        weightsPtr, nWeights,
        data.width, data.depth, data.thinkMs,
        outPtr, OUT_LEN
    );

    const out = new Int32Array(Module.HEAP32.buffer, outPtr, OUT_LEN).slice();
    self.postMessage({ type: 'result', result: out });
};
