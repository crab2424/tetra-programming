// ─────────────────────────────────────────────
// cpu_worker2.js
// ぷよCPU lv2 用 Web Worker
// Wasm (cpu_wasm2.js / cpu_wasm2.wasm) を呼び出します。
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    // Wasm ヒープサイズ（8MB: ぷよは 6×14 フィールドのため小さめで十分）
    INITIAL_MEMORY: 8 * 1024 * 1024,
    onRuntimeInitialized: function () {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

// Wasm JS グルーコードの読み込み（同じディレクトリに配置すること）
importScripts('cpu_wasm2.js');

// メモリポインタ（一度だけ確保して使い回す）
let boardPtr     = null;
let weightsPtr   = null;
let resultPtr    = null;
let stairsPtr    = null; 
let keyPtr       = null; 
let nextPairsPtr = null; // ★ 10手分の色情報用

self.onmessage = function (e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    // ── メモリ確保（初回のみ） ──
    if (boardPtr === null) {
        boardPtr     = Module._my_malloc(102);      
        weightsPtr   = Module._my_malloc(4 * 10);   
        resultPtr    = Module._my_malloc(4 * 7);    
        stairsPtr    = Module._my_malloc(24);       
        keyPtr       = Module._my_malloc(24);       
        nextPairsPtr = Module._my_malloc(4 * 20); // int32 20要素 = 80 bytes
    }

    // ── JS → Wasm メモリへコピー ──
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

    // ── Wasm 関数呼び出し ──
    Module._searchBestMovePuyoWasm(
        boardPtr,
        nextPairsPtr, // ★ 10手分の配列を渡す
        weightsPtr,
        resultPtr,
        stairsPtr,
        keyPtr
    );

    const endTime   = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm Bitboard PuyoCPU2 (Depth:10) Calculated in: ${timeTaken} ms`);

    // ── 結果を読み出してメインスレッドへ送信 ──
    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 7);

    self.postMessage({
        type:   'result',
        result: new Int32Array(resultArray) 
    });
};