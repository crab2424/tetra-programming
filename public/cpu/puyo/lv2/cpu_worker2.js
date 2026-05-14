// ─────────────────────────────────────────────
// cpu_worker2.js
// ぷよCPU lv2 用 Web Worker
// Wasm (cpu_wasm2.js / cpu_wasm2.wasm) を呼び出します。
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    INITIAL_MEMORY: 8 * 1024 * 1024,
    onRuntimeInitialized: function () {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

importScripts('cpu_wasm2.js');

let boardPtr     = null;
let weightsPtr   = null;
let resultPtr    = null;
let stairsPtr    = null; 
let keyPtr       = null; 
let nextPairsPtr = null; 

self.onmessage = function (e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr     = Module._my_malloc(102);      
        weightsPtr   = Module._my_malloc(4 * 12);   // ★ 10要素から12要素(48 bytes)に拡張
        resultPtr    = Module._my_malloc(4 * 7);    
        stairsPtr    = Module._my_malloc(24);       
        keyPtr       = Module._my_malloc(24);       
        nextPairsPtr = Module._my_malloc(4 * 20); 
    }

    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.weightsArray, weightsPtr / 4);
    HEAP32.set(data.nextPairs, nextPairsPtr / 4);
    
    if (data.stairsBuffer && data.keyBuffer) {
        HEAPU8.set(data.stairsBuffer, stairsPtr);
        HEAPU8.set(data.keyBuffer, keyPtr);
    } else {
        HEAPU8.fill(0, stairsPtr, stairsPtr + 24);
        HEAPU8.fill(0, keyPtr, keyPtr + 24);
    }

    const startTime = performance.now();

    Module._searchBestMovePuyoWasm(
        boardPtr,
        nextPairsPtr, 
        weightsPtr,
        resultPtr,
        stairsPtr,
        keyPtr
    );

    const endTime   = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm Bitboard PuyoCPU2 (Depth:10) Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 7);

    self.postMessage({
        type:   'result',
        result: new Int32Array(resultArray) 
    });
};