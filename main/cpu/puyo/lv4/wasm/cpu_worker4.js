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

importScripts('cpu_wasm4.js?v=7');

let boardPtr     = null;
let weightsPtr   = null;
let resultPtr    = null;
let gtrPtr       = null; // stairsPtrから変更
let keyPtr       = null; 
let nextPairsPtr = null; 

self.onmessage = function (e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr     = Module._my_malloc(102);
        // ★ weightsArray の要素数が 30 に増えたためサイズを拡張
        //   （…+ 期待連鎖の速度調整3項目 + 通常ビームの速度調整 mainMaxDepth/mainBeamWidth 2項目）
        weightsPtr   = Module._my_malloc(4 * 30);   // 30要素(120 bytes)
        resultPtr    = Module._my_malloc(4 * 7);    
        gtrPtr       = Module._my_malloc(24);       
        keyPtr       = Module._my_malloc(24);       
        nextPairsPtr = Module._my_malloc(4 * 20); 
    }

    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.weightsArray, weightsPtr / 4);
    HEAP32.set(data.nextPairs, nextPairsPtr / 4);
    
    if (data.gtrBuffer && data.keyBuffer) {
        HEAPU8.set(data.gtrBuffer, gtrPtr);
        HEAPU8.set(data.keyBuffer, keyPtr);
    } else {
        HEAPU8.fill(0, gtrPtr, gtrPtr + 24);
        HEAPU8.fill(0, keyPtr, keyPtr + 24);
    }

    const startTime = performance.now();

    Module._searchBestMovePuyoWasm(
        boardPtr,
        nextPairsPtr, 
        weightsPtr,
        resultPtr,
        gtrPtr,
        keyPtr
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