// ─────────────────────────────────────────────
// cpu_worker4.js
// CPU4(中級) 用のWeb Worker.Wasm(4)を呼び出します。
// ★完全版：メモリサイズの拡張と保護を行いました
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' }); 
    }
};

importScripts('cpu_wasm4.js');

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    // メモリ確保 (24要素の重み、26要素の戻り値に対応)
    if (boardPtr === null) {
        boardPtr   = Module._my_malloc(200);       
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

    console.log(`⚡ Wasm CPU4 Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 26);

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};