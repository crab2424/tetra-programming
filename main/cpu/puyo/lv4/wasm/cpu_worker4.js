// ─────────────────────────────────────────────
// cpu_worker4.js
// ぷよCPU lv4 用 Web Worker
// Wasm (cpu_wasm4.js / cpu_wasm4.wasm) を呼び出します。
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    INITIAL_MEMORY: 8 * 1024 * 1024,
    onRuntimeInitialized: function () {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

importScripts('cpu_wasm4.js?v=8');

let boardPtr     = null;
let weightsPtr   = null;
let resultPtr    = null;
let nextPairsPtr = null;

self.onmessage = function (e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr     = Module._my_malloc(102);
        // ★ weightsArray の要素数は 27（flatBonus/colorConnBonus/templateBonus を削除）
        weightsPtr   = Module._my_malloc(4 * 27);   // 27要素(108 bytes)
        resultPtr    = Module._my_malloc(4 * 7);
        nextPairsPtr = Module._my_malloc(4 * 20);
    }

    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.weightsArray, weightsPtr / 4);
    HEAP32.set(data.nextPairs, nextPairsPtr / 4);

    const startTime = performance.now();

    Module._searchBestMovePuyoWasm(
        boardPtr,
        nextPairsPtr,
        weightsPtr,
        resultPtr
    );

    const endTime   = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm Bitboard PuyoCPU4 (Depth:10) Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 7);

    self.postMessage({
        type:   'result',
        result: new Int32Array(resultArray) 
    });
};