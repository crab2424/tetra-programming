// ─────────────────────────────────────────────
// cpu_worker.js
// ─────────────────────────────────────────────

let wasmReady = false;

// Wasmの準備が完了したタイミングをフックする
self.Module = {
    onRuntimeInitialized: function() {
        wasmReady = true;
        self.postMessage({ type: 'ready' }); // メインスレッドに準備完了を通知
    }
};

importScripts('cpu_wasm.js');

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    // 準備ができていなければ弾く
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    // 初回のみメモリを確保 (board用、重み用、結果用)
    if (boardPtr === null) {
        boardPtr = Module._malloc(200);      
        weightsPtr = Module._malloc(4 * 10); // Int32(4バイト) * 10要素
        resultPtr = Module._malloc(4 * 12);  
    }

    // 1. 盤面と重みデータをWasmのメモリに書き込む
    Module.HEAPU8.set(data.boardBuffer, boardPtr);
    // 注意: HEAP32は4バイト単位のインデックスを要求するため、ポインタを4で割る必要があります
    Module.HEAP32.set(data.weightsArray, weightsPtr / 4);

    // 2. C++の関数を呼び出す（weightsPtr を忘れずに追加！）
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

    // 3. 計算結果を読み取る
    const resultArray = new Int32Array(Module.HEAP32.buffer, resultPtr, 12);

    // 4. メインスレッドに返す
    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};