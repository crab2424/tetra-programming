// ─────────────────────────────────────────────
// cpu_worker5.js
// CPU5(上級) 用のWeb Worker.Wasm(5)を呼び出します。
// ★完全版：メモリサイズの拡張と保護を行いました（6手対応）
// ─────────────────────────────────────────────

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

importScripts('cpu_wasm5.js');

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    // メモリ確保 (24要素の重み、43要素の戻り値に対応)
    if (boardPtr === null) {
        boardPtr   = Module._my_malloc(200);       
        weightsPtr = Module._my_malloc(4 * 24); // 最大24要素まで確保
        resultPtr  = Module._my_malloc(4 * 43); // 6手対応で最大43要素まで確保
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
        resultPtr
    );

    const endTime = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm CPU4 Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 43); // 最大43要素まで読み取る

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};