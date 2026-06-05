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
        resultPtr  = Module._my_malloc(4 * 256); // 可変長 path 込みの結果
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
        (data.maxTimeMs > 0 ? data.maxTimeMs : 500), // 探索のウォールクロック上限(ms)
        resultPtr
    );

    const timeTaken = (performance.now() - startTime).toFixed(2);

    const out = new Int32Array(HEAP32.buffer, resultPtr, 256);
    const count = out[0];

    // 可変長レイアウトをデコード:
    //   各手 = header 1個 + path ceil(pathLen/10)個
    //   header: bit0-2 minoType / bit3-4 rot / bit5-8 (x+2) / bit9-13 y / bit14 useHold / bit15-20 pathLen
    //   path: 3bit×ID(1=左2=右3=SD4=CW5=CCW6=HD) を 1 int に 10 個ずつ
    let sequence = null;
    if (count > 0) {
        sequence = [];
        let idx = 1;
        for (let i = 0; i < count; i++) {
            const h = out[idx++];
            const pathLen = (h >> 15) & 0x3F;
            const path = [];
            for (let k = 0; k < pathLen; k++) {
                path.push((out[idx + ((k / 10) | 0)] >> ((k % 10) * 3)) & 0x7);
            }
            idx += Math.ceil(pathLen / 10);
            sequence.push({
                minoType: h & 0x7,
                rot:      (h >> 3) & 0x3,
                x:        ((h >> 5) & 0xF) - 2, // C 側で +2 オフセット格納（負値対応）
                y:        (h >> 9) & 0x1F,      // 内部 0〜24（JS側では -5 する）
                useHold:  (h >> 14) & 0x1,
                path
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
