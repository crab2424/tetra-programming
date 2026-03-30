// ─────────────────────────────────────────────
// cpu_worker3.js
// CPU3(中級) 用のWeb Worker。Wasm(3)を呼び出します。
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' }); 
    }
};

// ★今後作成するWasmファイル名を指定します
importScripts('cpu_wasm3.js');

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr = Module._my_malloc(200);      
        weightsPtr = Module._my_malloc(4 * 16); 
        resultPtr = Module._my_malloc(4 * 12);  
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
        data.canHold,
        weightsPtr, 
        resultPtr
    );

    const endTime = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm CPU3 Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 12);

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};