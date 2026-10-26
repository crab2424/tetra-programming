// ─────────────────────────────────────────────
// cpu_worker_clys.js
// 参考AI clys（https://github.com/citrus610/clys, MIT）の Web Worker。Wasm(clysSearch) を呼び出す。
// 設計: source_assets/memory/cpu/tet/clys-port-design.md
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
    // ★再ビルドしたら ?v= を上げる（グルーjs・wasm・cpu_clys.js の WORKER_URLS を揃える）
    locateFile: function(path) { return path + '?v=1'; },
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

importScripts('cpu_wasm_clys.js?v=1');

const OUT_LEN = 96;
const QUEUE_MAX = 16;
let boardPtr = null;
let queuePtr = null;
let outPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;
    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr = Module._my_malloc(250);
        queuePtr = Module._my_malloc(4 * QUEUE_MAX);
        outPtr   = Module._my_malloc(4 * OUT_LEN);
    }

    // ALLOW_MEMORY_GROWTH でヒープが付け替わることがあるので、毎回 Module から取り直す
    Module.HEAPU8.set(data.boardBuffer, boardPtr);
    const nAll = Math.min(data.queue.length, QUEUE_MAX);
    Module.HEAP32.set(data.queue.slice(0, nAll), queuePtr / 4);

    Module._clysSearch(
        boardPtr, queuePtr, nAll, data.nSearch, data.holdType, data.bagAfter,
        data.backToBack, data.ren, data.incoming || 0,
        data.thinkMs, data.width, data.branch,
        outPtr, OUT_LEN
    );

    const out = new Int32Array(Module.HEAP32.buffer, outPtr, OUT_LEN).slice();
    console.log(`⚡ clys: ${out[14]} ms, nodes ${out[12]}, depth ${out[13]}, visit ${out[11]}`);
    self.postMessage({ type: 'result', result: out });
};
