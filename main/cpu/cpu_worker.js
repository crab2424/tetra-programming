// ─────────────────────────────────────────────
// cpu_worker.js
// Web Worker上で動き、Wasmを呼び出す作業員（時間計測付き）
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' }); 
    }
};

importScripts('cpu_wasm2.js');

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr = Module._my_malloc(200);      
        weightsPtr = Module._my_malloc(4 * 10); 
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
    console.log(`⚡ Wasm CPU Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 12);

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};