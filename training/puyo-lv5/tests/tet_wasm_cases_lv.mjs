// 本番 wasm（public/cpu/tet/lv{4,5,6}）で探索を回し、出力を返す（tests/test_tet_parity.py から呼ぶ）。
//   入力: 第1引数の JSON（{level, weights:[...], cases:[[307 int], ...]}）
//         1件 = 盤面250 + cur,hold,next×8,canHold,ren,b2b,incoming + 出力43（sim/tet_api.cpp tet_trace_cases_lv）
//   出力: 標準出力に JSON（各ケースの outResult[43]）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const WASM_JS = {
    4: '../../../public/cpu/tet/lv4/cpu_wasm4.js',
    5: '../../../public/cpu/tet/lv5/cpu_wasm5.js',
    6: '../../../public/cpu/tet/lv6/wasm/cpu_wasm6.js',
};
const wasmJs = path.resolve(here, WASM_JS[input.level]);

// 本番の cpu_wasm*.js は classic script（リポジトリの package.json が type:module なので require できない）。
// CommonJS の引数を渡した関数として評価する。
const M = await new Promise((resolve) => {
    const mod = {};
    mod.onRuntimeInitialized = () => resolve(mod);
    const fn = new Function('require', '__dirname', '__filename', 'module', 'Module', readFileSync(wasmJs, 'utf8'));
    fn(createRequire(wasmJs), path.dirname(wasmJs), wasmJs, { exports: {} }, mod);
});

const boardPtr = M._my_malloc(250);
const wPtr = M._my_malloc(input.weights.length * 4);
const outPtr = M._my_malloc(43 * 4);
M.HEAP32.set(Int32Array.from(input.weights), wPtr >> 2);

const results = [];
for (const c of input.cases) {
    M.HEAPU8.set(Uint8Array.from(c.slice(0, 250)), boardPtr);
    const [cur, hold, n1, n2, n3, n4, n5, n6, n7, n8, canHold, ren, b2b, incoming] = c.slice(250, 264);
    if (input.level === 4) {
        M._searchBestMoveWasm(boardPtr, cur, hold, n1, n2, n3, n4, n5, canHold, wPtr, outPtr);
    } else if (input.level === 5) {
        M._searchBestMoveWasm(boardPtr, cur, hold, n1, n2, n3, n4, n5, canHold, wPtr, outPtr, ren, b2b);
    } else {
        M._searchBestMoveWasm(boardPtr, cur, hold, n1, n2, n3, n4, n5, n6, n7, n8, canHold, wPtr, outPtr, ren, b2b, incoming);
    }
    results.push(Array.from(M.HEAP32.subarray(outPtr >> 2, (outPtr >> 2) + 43)));
}
process.stdout.write(JSON.stringify(results));
