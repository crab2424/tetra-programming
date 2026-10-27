// 本番 wasm（public/cpu/tet/lv7/wasm/cpu_wasm7.js、本番 lv7）で lv7Search を回し、出力を返す
//   （tests/test_lv6n_parity.py から呼ぶ）。
//   入力: 第1引数の JSON（{weights:[...], width, depth, thinkMs, outLen, cases:[{board:[250], queue:[...], hold, bagAfter, b2b, ren, incoming}]}）
//   出力: 標準出力に JSON（各ケースの out[outLen]）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const wasmJs = path.resolve(here, '../../../public/cpu/tet/lv7/wasm/cpu_wasm7.js');

const M = await new Promise((resolve) => {
    const mod = {};
    mod.onRuntimeInitialized = () => resolve(mod);
    const fn = new Function('require', '__dirname', '__filename', 'module', 'Module', readFileSync(wasmJs, 'utf8'));
    fn(createRequire(wasmJs), path.dirname(wasmJs), wasmJs, { exports: {} }, mod);
});

const L = input.outLen;
const boardPtr = M._lv7_malloc(250);
const qPtr = M._lv7_malloc(64 * 4);
const wPtr = M._lv7_malloc(input.weights.length * 4);
const outPtr = M._lv7_malloc(L * 4);
M.HEAP32.set(Int32Array.from(input.weights), wPtr >> 2);

const results = [];
for (const c of input.cases) {
    M.HEAPU8.set(Uint8Array.from(c.board), boardPtr);
    M.HEAP32.set(Int32Array.from(c.queue), qPtr >> 2);
    M._lv7Search(boardPtr, qPtr, c.queue.length, c.hold, c.bagAfter, c.b2b, c.ren, c.incoming, wPtr,
                 input.weights.length, input.width, input.depth, input.thinkMs, outPtr, L);
    results.push(Array.from(M.HEAP32.subarray(outPtr >> 2, (outPtr >> 2) + L)));
}
process.stdout.write(JSON.stringify(results));
