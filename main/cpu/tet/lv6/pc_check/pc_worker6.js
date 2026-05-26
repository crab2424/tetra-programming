// ─────────────────────────────────────────────
// pc_worker6.js
// CPU6 用 パーフェクトクリア(全消し)探索 Worker。
// pc_wasm6.js (pc6.cpp のコンパイル結果) をロードして searchPerfectClearWasm を呼ぶ。
// cpu_worker6.js（評価関数ビームサーチ）とは完全に独立して並列動作する。
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    // SearchState ほどの大量確保は無いが、cpu_worker6.js と揃えて 16MB 確保
    INITIAL_MEMORY: 16 * 1024 * 1024,
    onRuntimeInitialized: function () {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

importScripts('pc_wasm6.js');

let boardPtr = null;   // 250 byte
let piecesPtr = null;  // 11 * int32
let resultPtr = null;  // 16 * int32

self.onmessage = function (e) {
    if (!wasmReady) return;
    const data = e.data;
    if (data.type !== 'pc_search') return;

    if (boardPtr === null) {
        boardPtr   = Module._my_malloc(250);
        piecesPtr  = Module._my_malloc(4 * 11);
        resultPtr  = Module._my_malloc(4 * 16);
    }

    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.pieces, piecesPtr / 4); // [current, next0..next9]

    const startTime = performance.now();

    Module._searchPerfectClearWasm(
        boardPtr,
        piecesPtr,
        data.holdType,
        data.canHold,
        data.maxDepth,
        resultPtr
    );

    const timeTaken = (performance.now() - startTime).toFixed(2);

    const out = new Int32Array(HEAP32.buffer, resultPtr, 16);
    const count = out[0];
    const names = ['I', 'O', 'T', 'J', 'L', 'S', 'Z'];

    let sequence = null;
    if (count > 0) {
        sequence = [];
        for (let i = 0; i < count; i++) {
            const p = out[1 + i];
            sequence.push({
                minoType: p & 0x7,
                rot:      (p >> 3) & 0x3,
                x:        (p >> 5) & 0xF,
                y:        (p >> 9) & 0x1F, // 内部 0〜24（JS側では -5 する）
                useHold:  (p >> 14) & 0x1
            });
        }
    }

    console.log(`💎 PC search in ${timeTaken} ms → ${count > 0 ? 'FOUND ' + count + ' moves' : 'none'}`);

    self.postMessage({
        type: 'pc_result',
        found: count > 0,
        sequence: sequence,
        searchId: data.searchId
    });
};
