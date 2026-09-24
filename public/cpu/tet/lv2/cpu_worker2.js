// ─────────────────────────────────────────────
// cpu_worker2.js
// Web Worker上で動き、Wasmを呼び出す作業員（時間計測付き）
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

importScripts('cpu_wasm2.js?v=2'); // ★ v2.2.3 I: 25行化で再ビルド

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr = Module._my_malloc(250); // ★ v2.2.3 I: 隠し5行込みの 25 行
        weightsPtr = Module._my_malloc(4 * 16); // パラメータを16個に拡張済み
        resultPtr = Module._my_malloc(4 * 12);  
    }

    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.weightsArray, weightsPtr / 4);

    // ★ ここから時間計測スタート！
    const startTime = performance.now();

    // C++の関数を呼び出して爆速計算
    Module._searchBestMoveWasm(
        boardPtr,
        data.currentType,
        data.holdType,
        data.next1,
        data.next2,
        data.canHold,
        weightsPtr, 
        resultPtr
    );

    // ★ ここで時間計測ストップ！
    const endTime = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2); // 小数点2桁まで

    // C++の処理にかかった時間をコンソールに出力
    console.log(`⚡ Wasm CPU2 Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 12);

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};