// ─────────────────────────────────────────────
// cpu_worker5.js
// CPU5(上級) 用のWeb Worker.Wasm(5)を呼び出します。
// ★完全版：メモリサイズの拡張と保護を行いました（6手対応）
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
    // ★ WasmのHEAPサイズを明示的に設定（デフォルト256KBでは SearchState の大量確保で枯渇するため）
    // SearchState(~616bytes) × 320 + Placement(~92bytes) × 80 × 各ステップ = ~200KB 超のため
    // 16MB(= 256 * 64KB pages)を確保して余裕を持たせる
    INITIAL_MEMORY: 16 * 1024 * 1024, // 16MB
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' }); 
    }
};

importScripts('cpu_wasm5.js?v=2'); // ★ v2.2.3 I: 致死判定修正で再ビルド

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;

    if (data.type === 'evaluate_single') {
        if (boardPtr === null) {
            boardPtr   = Module._my_malloc(250); // ★修正: Y=-5〜19に対応するため 200 -> 250 に拡張
            // ★修正: JS側から渡される要素数が33に増えたため、確保サイズを 4 * 33 に変更
            weightsPtr = Module._my_malloc(4 * 33); 
            resultPtr  = Module._my_malloc(4 * 43); 
        }

        HEAPU8.set(data.boardBuffer, boardPtr);
        HEAP32.set(data.weightsArray, weightsPtr / 4);

        Module._evaluateSinglePlacementWasm(
            boardPtr,
            data.minoType,
            data.rot,
            data.x,
            data.y, // JS側で y+5 された座標が渡される
            weightsPtr,
            resultPtr,
            data.ren,
            data.backToBack,
            data.tSpinType
        );

        const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 2);
        self.postMessage({
            type: 'evaluate_single_result',
            score: resultArray[0],
            diff: resultArray[1]
        });
        return;
    }

    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr   = Module._my_malloc(250); // ★修正: Y=-5〜19に対応するため 200 -> 250 に拡張
        // ★修正: JS側から渡される要素数が33に増えたため、確保サイズを 4 * 33 に変更
        weightsPtr = Module._my_malloc(4 * 33); 
        resultPtr  = Module._my_malloc(4 * 43); 
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
        data.next4,
        data.next5,
        data.canHold,
        weightsPtr, 
        resultPtr,
        data.ren,        
        data.backToBack  
    );

    const endTime = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm CPU5 Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 43); 

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};