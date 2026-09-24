// ─────────────────────────────────────────────
// cpu_worker3.js
// CPU3(中級) 用のWeb Worker。Wasm(3)を呼び出します。
// ★完全版：メモリサイズの拡張と保護を行いました
// ─────────────────────────────────────────────

// ★ CpuWorkerPool（app/cpu_worker_pool.js）用: 返信へ要求元のリースID(__lease)をエコーする。
//   プールは worker を使い回すので、前の持ち主が投げた計算の結果を次の持ち主へ届けないために使う。
//   計算は onmessage 内で同期的に終わって返信されるので「直近に受けた要求のID」を付ければ対応が取れる。
//   （addEventListener は下の self.onmessage より先に登録されるので、ハンドラ実行前にIDが入る）
let __leaseId;
self.addEventListener('message', (e) => { __leaseId = e.data ? e.data.__lease : undefined; });
const __postMessage = self.postMessage.bind(self);
self.postMessage = (msg, transfer) => {
    if (msg && typeof msg === 'object' && msg.type !== 'ready') msg.__lease = __leaseId;
    return transfer ? __postMessage(msg, transfer) : __postMessage(msg);
};

let wasmReady = false;

self.Module = {
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' }); 
    }
};

importScripts('cpu_wasm3.js?v=2'); // ★ v2.2.3 I: 25行化で再ビルド

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    // メモリ確保 (24要素の重み、26要素の戻り値に対応)
    if (boardPtr === null) {
        boardPtr   = Module._my_malloc(250); // ★ v2.2.3 I: 隠し5行込みの 25 行
        weightsPtr = Module._my_malloc(4 * 24); // 最大24要素まで確保
        resultPtr  = Module._my_malloc(4 * 26); // 最大26要素まで確保
    }

    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.weightsArray, weightsPtr / 4);

    const startTime = performance.now();

    Module._searchBestMoveWasm(
        boardPtr,
        data.currentType,
        data.holdType,
        data.next1,
        data.next2,
        data.next3,
        data.canHold,
        weightsPtr, 
        resultPtr
    );

    const endTime = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm CPU3 Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 26);

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};