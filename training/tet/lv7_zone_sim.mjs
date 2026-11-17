// テト CPU lv7 に ZONE（VERSUS）の発動中を打たせて、段数・残ったマス・穴・通常火力の概算を数える（画面なし）。
//   探索は本番 wasm（cpu/tet/lv7/wasm/cpu_wasm7.js）を直接呼ぶ。重みは本番 cpu7.js の既定＋ZONE_WEIGHTS。
//   盤面の進め方は ZONE の決まりの最小限: そろった段は底へ送って ZONE 段にする（消えない）。
//   出現位置（列 3〜6 の y=0〜1）がふさがったら出現不能で終わり。ZONE 設計 §19.3・§21。
//
// 使い方: node training/tet/lv7_zone_sim.mjs [手数=55] [回数=6] [--wasm=別の cpu_wasm7.js] [--think=80]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '../../public');
const args = process.argv.slice(2);
const opt = (name, def) => {
    const a = args.find(s => s.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : def;
};
const positional = args.filter(s => !s.startsWith('--'));
const MOVES = parseInt(positional[0] || '55', 10);
const RUNS = parseInt(positional[1] || '6', 10);
const THINK = parseInt(opt('think', '80'), 10);
const wasmJs = path.resolve(opt('wasm', path.join(pub, 'cpu/tet/lv7/wasm/cpu_wasm7.js')));

// 重み（cpu7.js をそのまま読む）
const ctx = { console, Math, JSON, Int32Array, Uint8Array, CpuWorkerPool: { acquire: () => ({}) } };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(pub, 'cpu/tet/lv7/cpu7.js'), 'utf8') + '\nglobalThis.CPU7 = CPU7;', ctx);
const cpu = new ctx.CPU7({ zoneActive: true, isVersusMode: true });
const W = cpu.weightsArray();

const M = await new Promise((resolve) => {
    const mod = {};
    mod.onRuntimeInitialized = () => resolve(mod);
    mod.locateFile = (p) => path.join(path.dirname(wasmJs), p);
    const fn = new Function('require', '__dirname', '__filename', 'module', 'Module', readFileSync(wasmJs, 'utf8'));
    fn(createRequire(wasmJs), path.dirname(wasmJs), wasmJs, { exports: {} }, mod);
});
const OUT_LEN = 96;
const boardPtr = M._lv7_malloc(400), queuePtr = M._lv7_malloc(4 * 40), weightsPtr = M._lv7_malloc(4 * 96), outPtr = M._lv7_malloc(4 * OUT_LEN);

let seed = 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

// 開始盤面（§19.3 と同じ 4 つ）。cells: y=-20〜19 の Set("x,y")
function startBoard(kind) {
    const c = new Set();
    const fill = (x, y) => c.add(x + ',' + y);
    if (kind === 'right') { for (let y = 14; y < 20; y++) for (let x = 0; x < 9; x++) fill(x, y); }
    if (kind === 'hole') { for (let y = 14; y < 20; y++) for (let x = 0; x < 10; x++) if (!(y === 17 && x === 4) && !(x === 9)) fill(x, y); }
    if (kind === 'rough') {
        for (let x = 0; x < 10; x++) { const h = 4 + Math.floor(rnd() * 5); for (let k = 0; k < h; k++) if (k === h - 1 || rnd() < 0.8) fill(x, 19 - k); }
        for (let y = 0; y < 20; y++) { let f = true; for (let x = 0; x < 10; x++) if (!c.has(x + ',' + y)) f = false; if (f) c.delete(Math.floor(rnd() * 10) + ',' + y); }
    }
    return c;
}

function bag() { const a = [0, 1, 2, 3, 4, 5, 6]; for (let i = 6; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function run(kind) {
    let cells = startBoard(kind), zone = 0, hold = -1, attack = 0, ren = 0, b2b = 0, moves = 0, pcs = 0;
    let queue = [], bagLeft = [];
    const refill = () => { while (queue.length < 40) { if (!bagLeft.length) bagLeft = bag(); queue.push(bagLeft.shift()); } };
    let ended = 'time';
    for (; moves < MOVES; moves++) {
        refill();
        // 出現位置（列 3〜6・y=0〜1）がふさがっていたら出現不能
        let blocked = false;
        for (let x = 3; x <= 6; x++) if (cells.has(x + ',0')) blocked = true;
        if (blocked) { ended = 'block'; break; }
        const buf = new Uint8Array(400);
        for (const s of cells) { const [x, y] = s.split(',').map(Number); if (y >= -20) buf[(y + 20) * 10 + x] = 1; }
        buf[0] |= 0x80;
        let bagAfter = 0; for (const t of bagLeft) bagAfter |= 1 << t;
        M.HEAPU8.set(buf, boardPtr);
        M.HEAP32.set(Int32Array.from(queue.slice(0, 40)), queuePtr >> 2);
        M.HEAP32.set(W.slice(0, 96), weightsPtr >> 2);
        M._lv7Search(boardPtr, queuePtr, 40, hold, bagAfter, b2b, ren, 0, weightsPtr, Math.min(W.length, 96), 256, 32, THINK, outPtr, OUT_LEN);
        const out = Int32Array.from(M.HEAP32.subarray(outPtr >> 2, (outPtr >> 2) + OUT_LEN));
        if (out[0] !== 1) { ended = 'nomove'; break; }
        const id = out[1];
        if (out[10]) { if (hold < 0) { hold = queue.shift(); queue.shift(); } else { hold = queue.shift(); } }
        else queue.shift();
        void id;
        for (let i = 0; i < 4; i++) cells.add(out[2 + i * 2] + ',' + out[3 + i * 2]);
        // そろった段（ZONE 段より上）を底へ送る
        const full = [];
        for (let y = -20; y < 20 - zone; y++) { let f = true; for (let x = 0; x < 10; x++) if (!cells.has(x + ',' + y)) { f = false; break; } if (f) full.push(y); }
        const n = full.length;
        if (n) {
            const tspin = out[16] === 1;
            attack += tspin ? [2, 4, 6][n - 1] : [0, 1, 2, 4][n - 1];
            if (tspin || n === 4) { if (b2b) attack += 1; b2b = 1; } else b2b = 0;
            ren++; if (ren > 2) attack += Math.min(5, Math.floor((ren - 1) / 2));
            // 消した段より下の積みはそのまま、上の積みは下へ詰め、全体を n 段持ち上げて底に ZONE 段を n 段足す
            const shifted = new Set();
            for (const s of cells) {
                const [x, y] = s.split(',').map(Number);
                if (y >= 20 - zone) { shifted.add(x + ',' + (y)); continue; }
                if (full.includes(y)) continue;
                const below = full.filter(f => f > y).length;
                shifted.add(x + ',' + (y + below - n));
            }
            zone += n;
            for (let k = 0; k < zone; k++) for (let x = 0; x < 10; x++) shifted.add(x + ',' + (19 - k));
            cells = shifted;
            // ZONE 段だけ残ったら PC
            if (cells.size === zone * 10) { pcs++; attack += 10; }
        } else ren = 0;
    }
    // 残ったマス・穴（ZONE 段より上）
    let rest = 0, holes = 0;
    for (let x = 0; x < 10; x++) {
        let top = null;
        for (let y = -20; y < 20 - zone; y++) {
            if (cells.has(x + ',' + y)) { rest++; if (top === null) top = y; }
            else if (top !== null) holes++;
        }
    }
    if (args.includes('--show')) {
        const rows = [];
        for (let y = -2; y < 20; y++) { let r = ''; for (let x = 0; x < 10; x++) r += cells.has(x + ',' + y) ? (y >= 20 - zone ? '=' : '#') : '.'; rows.push(r); }
        console.log(`[${kind}] ${ended} 手数 ${moves}\n` + rows.join('\n'));
    }
    return { zone, rest, holes, attack, moves, ended, pcs };
}

for (const kind of ['empty', 'right', 'hole', 'rough']) {
    seed = 12345;
    const rs = [];
    for (let i = 0; i < RUNS; i++) rs.push(run(kind));
    const avg = (k) => (rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(1);
    const ends = rs.map(r => r.ended[0]).join('');
    console.log(`${kind.padEnd(6)} 段数 ${avg('zone')}  残ったマス ${avg('rest')}  穴 ${avg('holes')}  通常火力 ${avg('attack')}  手数 ${avg('moves')}  PC ${avg('pcs')}  終わり方 ${ends}`);
}
