// ─────────────────────────────────────────────
// cpu_worker1.js
// ぷよCPU lv1 用 Web Worker
// Wasm (cpu_wasm1.js / cpu_wasm1.wasm) を呼び出します。
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
importScripts('cpu_wasm1.js');

// メモリポインタ（一度だけ確保して使い回す）
let boardPtr   = null;
let weightsPtr = null;
let resultPtr  = null;

self.onmessage = function (e) {
    if (!wasmReady) return;

    const data = e.data;
    if (data.type !== 'calculate') return;

    // ── メモリ確保（初回のみ） ──
    // boardData   : uint8_t[14 * 6] = 84 bytes
    // weightsArray: int32[9]  = 36 bytes
    // outResult   : int32[7]  = 28 bytes
    if (boardPtr === null) {
        boardPtr   = Module._my_malloc(84);      // TOTAL_ROWS(14) × COLS(6)
        weightsPtr = Module._my_malloc(4 * 9);   // 9 要素の int32
        resultPtr  = Module._my_malloc(4 * 7);   // 7 要素の int32
    }

    // ── JS → Wasm メモリへコピー ──
    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.weightsArray, weightsPtr / 4);

    const startTime = performance.now();

    // ── Wasm 関数呼び出し ──
    Module._searchBestMovePuyoWasm(
        boardPtr,
        data.pivotColor,
        data.childColor,
        data.next1Pivot,
        data.next1Child,
        data.next2Pivot,
        data.next2Child,
        weightsPtr,
        resultPtr
    );

    const endTime   = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm PuyoCPU1 Calculated in: ${timeTaken} ms`);

    // ── 結果を読み出してメインスレッドへ送信 ──
    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 7);

    self.postMessage({
        type:   'result',
        result: new Int32Array(resultArray) // transferable にしないでコピー
    });
};