// ─────────────────────────────────────────────
// cpu_worker4.js
// ぷよCPU lv4 用 Web Worker
// Wasm (cpu_wasm4.js / cpu_wasm4.wasm) を呼び出します。
// ─────────────────────────────────────────────

let wasmReady = false;

self.Module = {
    INITIAL_MEMORY: 8 * 1024 * 1024,
    // ★ .wasm もファイル名でキャッシュされるため ?v= を付けてキャッシュバストする
    //   （グルーjs/worker と同じバージョンに揃えること）。
    locateFile: function (path) {
        return path === 'cpu_wasm4.wasm' ? 'cpu_wasm4.wasm?v=25' : path;
    },
    onRuntimeInitialized: function () {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

importScripts('cpu_wasm4.js?v=25');

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
        // ★ weightsArray の要素数は 38（…[35]growthFireForbidChains [36]emergencyFireMinRatio [37]emergencyHardCol2）
        weightsPtr   = Module._my_malloc(4 * 38);   // 38要素(152 bytes)
        resultPtr    = Module._my_malloc(4 * 26);   // [0..6]=着手 / [7..25]=デバッグ統計
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

    // ── ★ ama探索デバッグ（outResult[7..19]）──
    //   ①scale: 到達連鎖(selChain) と base(構築品質) / base幅(spread)
    //   ②PRUNE/dedup: 実発動数（0なら効いていない）
    //   ③差別化: nWithChain(連鎖を組める初手数) と bestChain(到達連鎖スコア最大)
    const dbg = new Int32Array(HEAP32.buffer, resultPtr, 26);
    if (dbg[9] >= 0) { // nCand>=0 なら探索成立
        // 到達連鎖の達成深さ[25]：何手後に組み上がるか。0=今そのまま発火／-1=連鎖未到達。
        const selDepth = dbg[25];
        const selDepthStr = selDepth < 0 ? '連鎖未到達'
            : selDepth === 0 ? '0手後(今すぐ)'
            : `${selDepth}手後`;
        console.log(
            `[ama dbg] nCand=${dbg[9]} maxDepth=${dbg[10]} band(同点崩し)=${dbg[11]}\n` +
            `  PRUNE発動=${dbg[7]} dedup除去=${dbg[8]}\n` +
            `  選択初手: 到達連鎖selChain=${dbg[14]} (期待${dbg[20]}連鎖／${selDepthStr})  base=${dbg[13]}\n` +
            `  理論上いま撃てる最大: ${dbg[21]}連鎖 (${dbg[22]}点) \n` +
            `  差別化: 連鎖を組める初手数 nWithChain=${dbg[16]}/${dbg[9]}  bestChain=${dbg[12]}  base幅(spread)=${dbg[18]}\n` +
            `  発火: ${dbg[15] > 0
                ? `★${dbg[15]}連鎖を発火（${dbg[23] === 1 ? '目標到達' : dbg[23] === 2 ? '緊急＝本線ほぼ完成' : dbg[23] === 3 ? '緊急延命＝最終手段(致死列満杯)' : '理由不明'}）`
                : `育成（撃たず）${dbg[24] > 0 ? `／※選択手が小発火${dbg[24]}連鎖こぼし` : ''}`}`
        );
    }

    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 7);

    self.postMessage({
        type:   'result',
        result: new Int32Array(resultArray) 
    });
};