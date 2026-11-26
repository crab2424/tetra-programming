// 高い盤面でテト CPU lv6 の「探索が選んだ置き場所」と「操作列で実際に置く場所」がずれるかを数える。
//   本番の public/core/base.js（Block/Mino/Field）・game/tet/board.js・rotation.js・cpu/tet/lv6/cpu6.js を
//   node:vm で読み、探索は本番 wasm（cpu/tet/lv6/wasm/cpu_wasm6.js）をそのまま呼ぶ。画面は起動しない。
//   1件 = 盤面を作る → ミノを出現位置へ（1段上げ込み）→ 探索 → 操作列を試しに動かして 4 マスを比べる。
//   比べるもの:
//     short … 簡略化した操作列（buildShortActionQueue）
//     final … 実際に使う操作列（buildActionQueue。short が着かなければ探索の path どおり）
//   short のずれ＝簡略化が 2 回転の途中のキックなどを見ていない。final のずれ＝探索と実機の動きの違い。
//
// 使い方: node training/tet/lv6_place_check.mjs [件数=1000] [seed=1] [--show=3] [--zone（ZONE の発動中の印を付ける）]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '../../public');
const args = process.argv.slice(2);
const positional = args.filter(s => !s.startsWith('--'));
const N = parseInt(positional[0] || '1000', 10);
let seed = parseInt(positional[1] || '1', 10) >>> 0 || 1;
const SHOW = parseInt((args.find(s => s.startsWith('--show=')) || '--show=3').slice(7), 10);
const ZONE = args.includes('--zone');

const ctx = {
    console, Math, JSON, Set, Map, Array, Uint8Array, Int32Array, Promise,
    performance: { now: () => 0 }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    document: { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null },
};
ctx.window = ctx;
vm.createContext(ctx);
const base = readFileSync(path.join(pub, 'core/base.js'), 'utf8');
const pick = (src, from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to, i);
    if (i < 0 || j < 0) throw new Error(`base.js に ${from} 〜 ${to} が見つかりません`);
    return src.slice(i, j + to.length);
};
vm.runInContext(`
const BLOCK_SIZE = 32, COLS_COUNT = 10, ROWS_COUNT = 20;
const LEVEL_SPEEDS = [0, 1000, 793, 618, 473, 355, 262, 190, 135, 94, 64, 43, 28, 18, 11, 7];
const Asset = { blockImages: [] };
${pick(base, 'class Block {', 'Field.TOP_PAD = 20')}
class Game {}
globalThis.Block = Block; globalThis.Mino = Mino; globalThis.Field = Field; globalThis.Game = Game;
globalThis.LEVEL_SPEEDS = LEVEL_SPEEDS;
`, ctx);
for (const f of ['game/tet/board.js', 'game/tet/rotation.js', 'cpu/tet/cpu_zone.js', 'cpu/tet/lv6/cpu6.js']) { // cpu_zone.js: findGamePath の本体（CpuZone.gamePath）
    vm.runInContext(readFileSync(path.join(pub, f), 'utf8'), ctx, { filename: f });
}
const { Game, Mino, Block, Field, CPU6 } = ctx;

const wasmJs = path.join(pub, 'cpu/tet/lv6/wasm/cpu_wasm6.js');
const M = await new Promise((resolve) => {
    const mod = { print() {}, printErr() {}, locateFile: (p) => path.join(path.dirname(wasmJs), p) };
    mod.onRuntimeInitialized = () => resolve(mod);
    const fn = new Function('require', '__dirname', '__filename', 'Module',
        readFileSync(wasmJs, 'utf8') + '\n;Module.HEAPU8 = HEAPU8; Module.HEAP32 = HEAP32;');
    fn(createRequire(wasmJs), path.dirname(wasmJs), wasmJs, mod);
});
const boardPtr = M._my_malloc(250), weightsPtr = M._my_malloc(4 * 39), outPtr = M._my_malloc(4 * 43);
const W = [100,-55,-560,-20,4,3,-2,-24,72,36,200,-800,-85,1000,120,-600,100,2000,750,150,256,2560,-60,-100,20,496,-200,-100,-300,100,-400,72,-36,100,6000,150,8000,10,6000];
M.HEAP32.set(W, weightsPtr >> 2);

const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// 出現位置のまわりが出現ミノに触れる高さの盤面（ZONE のときは下の zoneLines 段がそろった段）
function makeBoard() {
    const cells = new Set();
    const zoneLines = ZONE ? ri(10, 17) : 0;
    for (let x = 0; x < 10; x++) {
        const h = ri(17, 21);
        for (let k = 0; k < h; k++) {
            const y = 19 - k;
            if (k < zoneLines || k === h - 1 || rnd() < 0.85) cells.add(x + ',' + y);
        }
    }
    for (let y = -5; y < 20 - zoneLines; y++) {
        let full = true;
        for (let x = 0; x < 10; x++) if (!cells.has(x + ',' + y)) { full = false; break; }
        if (full) cells.delete(ri(0, 9) + ',' + y);
    }
    return { zoneLines, blocks: [...cells].map(s => { const [x, y] = s.split(',').map(Number); return { x, y }; }) };
}

let done = 0, shortBad = 0, finalBad = 0, shown = 0, tries = 0;
while (done < N && tries < N * 20) {
    tries++;
    const { zoneLines, blocks } = makeBoard();
    const g = Object.create(Game.prototype);
    Object.assign(g, {
        field: new Field(), level: 2, score: 0, isVersusMode: true, backToBack: false, ren: 0,
        zoneActive: ZONE, zoneLines, topLimit: -5, playSe() {}, requestRedraw() {},
    });
    g.field.blocks = blocks.map(b => new Block(b.x, b.y, 7));
    g.field.markDirty();
    const types = Array.from({ length: 9 }, () => ri(0, 6));
    const mino = new Mino(types[0]);
    g.mino = mino;
    if (!g._placeAtSpawn(mino, 0)) continue;

    const buf = new Uint8Array(250);
    for (const b of blocks) { const by = Math.max(0, b.y + 5); if (by < 25) buf[by * 10 + b.x] = 1; }
    if (ZONE) buf[0] = 100 + zoneLines;
    M.HEAPU8.set(buf, boardPtr);
    M._searchBestMoveWasm(boardPtr, types[0], -1, types[1], types[2], types[3], types[4], types[5], types[6], types[7], types[8],
        0, weightsPtr, outPtr, 0, 0, 0, 0);
    const res = Int32Array.from(M.HEAP32.subarray(outPtr >> 2, (outPtr >> 2) + 43));
    if (res[0] !== 0 || !(res[3] >= 0 && res[3] <= 6)) continue;
    const best = { action: 'play', id: res[3], rot: res[4], x: res[5], y: res[6] - 5, tSpinType: res[12], clearedLines: [], path: [] };
    for (let i = 0; i < 64; i++) {
        const act = (res[36 + Math.floor(i / 10)] >> ((i % 10) * 3)) & 7;
        if (act === 0) break;
        best.path.push(act);
        if (act === 6) break;
    }
    const cpu = Object.create(CPU6.prototype);
    Object.assign(cpu, { game: g, actionDelay: 0, harddropDelay: 0 });
    const okShort = cpu.queueLandsAt(cpu.buildShortActionQueue(best), best);
    const okFinal = cpu.queueLandsAt(cpu.buildActionQueue(best), best);
    done++;
    if (!okShort) shortBad++;
    if (!okFinal) finalBad++;
    if (!okShort && shown < SHOW) {
        shown++;
        console.log(`例 ${shown}: ミノ ${best.id} 向き ${best.rot} x=${best.x} y=${best.y} path=${best.path.join('')} short=${cpu.buildShortActionQueue(best).map(a => a.type).join(',')}`);
    }
}
console.log(`${done} 件${ZONE ? '（ZONE）' : ''}: 簡略化した操作列のずれ ${shortBad}（${(100 * shortBad / Math.max(1, done)).toFixed(2)}%）／実際に使う操作列のずれ ${finalBad}`);
