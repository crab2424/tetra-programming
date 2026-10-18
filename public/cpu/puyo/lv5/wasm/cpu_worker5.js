// ─────────────────────────────────────────────
// cpu_worker5.js
// ぷよCPU lv5 用 Web Worker
// Wasm (cpu_wasm5.js / cpu_wasm5.wasm) を呼び出します。
// ─────────────────────────────────────────────

// ★ CpuWorkerPool（app/cpu_worker_pool.js）用: 返信へ要求元のリースID(__lease)をエコーする。
//   プールは worker を使い回すので、前の持ち主が投げた計算の結果を次の持ち主へ届けないために使う。
//   計算は onmessage 内で同期的に終わって返信されるので「直近に受けた要求のID」を付ければ対応が取れる。
//   （addEventListener は下の self.onmessage より先に登録されるので、ハンドラ実行前にIDが入る）
let __leaseId;
self.addEventListener('message', (e) => { __leaseId = e.data ? e.data.__lease : undefined; });
const __postMessage = self.postMessage.bind(self);
self.postMessage = (msg, transfer) => {
    if (msg && typeof msg === 'object' && msg.type !== 'ready') msg.__lease = __leaseId;
    return transfer ? __postMessage(msg, transfer) : __postMessage(msg);
};

let wasmReady = false;

self.Module = {
    INITIAL_MEMORY: 8 * 1024 * 1024,
    // ★ .wasm もファイル名でキャッシュされるため ?v= を付けてキャッシュバストする
    //   （グルーjs/worker と同じバージョンに揃えること）。
    locateFile: function (path) {
        return path === 'cpu_wasm5.wasm' ? 'cpu_wasm5.wasm?v=45' : path;
    },
    onRuntimeInitialized: function () {
        wasmReady = true;
        self.postMessage({ type: 'ready' });
    }
};

importScripts('cpu_wasm5.js?v=45');

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
        // ★ weightsArray の要素数は 57（…[45]qSubWeight [46..48]催促 H1 [49]対応 H2 [50]催促 H1 残す本線の絶対量 [51..53]副砲・催促の本線条件 G1/G2 [54..56]発火点の保全 K）
        weightsPtr   = Module._my_malloc(4 * 57);   // 57要素(228 bytes)
        resultPtr    = Module._my_malloc(4 * 36);   // [0..6]=着手 / [7..26]=デバッグ統計 / [27..29]=path(操作列) / [30]=致命セル枝刈り数 / [31][32]=撃った後の本線潜在・今の本線潜在 / [33..35]=判断の内訳
        nextPairsPtr = Module._my_malloc(4 * 20);
    }

    HEAPU8.set(data.boardBuffer, boardPtr);
    HEAP32.set(data.weightsArray, weightsPtr / 4);
    HEAP32.set(data.nextPairs, nextPairsPtr / 4);

    Module._searchBestMovePuyoWasm(
        boardPtr,
        nextPairsPtr,
        weightsPtr,
        resultPtr
    );

    // ★ 思考ログ（[7..26][30..35] のデバッグ統計）は本体側 cpu5_worker_io.js _logThink が出す。
    //   worker はどちらの盤面の計算かを知らないため、ここでは出さない（CPU 同士で2台分が混ざるのを防ぐ）。

    // [0..6]=着手結果 / [27..29]=選択初手への到達操作列(path packing)。JS 側で復号して再生する。
    const resultArray = new Int32Array(HEAP32.buffer, resultPtr, 36);

    self.postMessage({
        type:   'result',
        result: new Int32Array(resultArray)
    });
};