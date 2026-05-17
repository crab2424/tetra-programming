// ─────────────────────────────────────────────
// cpu_worker6.js
// CPU6 用のWeb Worker.Wasm(6)を呼び出します。
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

importScripts('cpu_wasm6.js');

let boardPtr = null;
let resultPtr = null;
let weightsPtr = null;

self.onmessage = function(e) {
    if (!wasmReady) return;

    const data = e.data;

    if (data.type === 'evaluate_single') {
        if (boardPtr === null) {
            boardPtr   = Module._my_malloc(250); // ★修正: Y=-5〜19に対応するため 200 -> 250 に拡張
            // ★修正: JS側から渡される要素数が34に増えたため（centerDip追加）、確保サイズを 4 * 34 に変更
            weightsPtr = Module._my_malloc(4 * 34); 
            resultPtr  = Module._my_malloc(4 * 43); 
        }

        HEAPU8.set(data.boardBuffer, boardPtr);
        HEAP32.set(data.weightsArray, weightsPtr / 4);

        Module._evaluateSinglePlacementWasm(
            boardPtr,
            data.minoType,
            data.rot,
            data.x,
            data.y, // JS側で y+5 された座標が渡される
            weightsPtr,
            resultPtr,
            data.ren,
            data.backToBack,
            data.tSpinType
        );

        const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 2);
        self.postMessage({
            type: 'evaluate_single_result',
            score: resultArray[0],
            diff: resultArray[1]
        });
        return;
    }

    if (data.type !== 'calculate') return;

    if (boardPtr === null) {
        boardPtr   = Module._my_malloc(250); // ★修正: Y=-5〜19に対応するため 200 -> 250 に拡張
        // ★修正: JS側から渡される要素数が34に増えたため（centerDip追加）、確保サイズを 4 * 34 に変更
        weightsPtr = Module._my_malloc(4 * 34); 
        resultPtr  = Module._my_malloc(4 * 43); 
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
        resultPtr,
        data.ren,        
        data.backToBack  
    );

    const endTime = performance.now();
    const timeTaken = (endTime - startTime).toFixed(2);

    console.log(`⚡ Wasm CPU6 Calculated in: ${timeTaken} ms`);

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 43); 

    self.postMessage({
        type: 'result',
        result: new Int32Array(resultArray)
    });
};