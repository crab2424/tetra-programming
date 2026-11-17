// テト CPU lv2〜lv6 に ZONE（VERSUS）の発動中を打たせて、段数・残ったマス・穴・通常火力の概算を数える（画面なし）。
//   本番の cpuN.js を node:vm で読み、onMinoSpawned が worker へ送る中身（盤面・重み・NEXT）をそのまま横取りして
//   本番 wasm を直接呼ぶ。ミノの形・出現は base.js / game/tet/board.js（_placeAtSpawn）。
//   盤面の進め方は ZONE の決まりの最小限: そろった段は底へ送って ZONE 段にする（消えない）。出現できなければ終わり。
//   ZONE 設計 §19.4・§20.2・§21。lv7 は training/tet/lv7_zone_sim.mjs。
//
// 使い方: node training/tet/zone_sim_lv.mjs <レベル 2〜6> [秒=40] [回数=12] [--wasm=別の cpu_wasmN.js] [--show]
//         node training/tet/zone_sim_lv.mjs <レベル> 0 <局面数> --compare=旧の cpu_wasmN.js（ZONE なしで結果が同じか）
//   秒 … 発動の長さ。手数は 秒×1000÷CpuZone.CONFIG.moveMs[レベル]（§19.4 と同じ数え方）
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
const LV = parseInt(positional[0] || '5', 10);
const SEC = parseFloat(positional[1] || '40');
const RUNS = parseInt(positional[2] || '12', 10);
const SHOW = args.includes('--show');
const FILES = {
    2: ['lv2/cpu2.js', 'lv2/cpu_wasm2.js', 'CPU2'],
    3: ['lv3/cpu3.js', 'lv3/cpu_wasm3.js', 'CPU3'],
    4: ['lv4/cpu4.js', 'lv4/cpu_wasm4.js', 'CPU4'],
    5: ['lv5/cpu5.js', 'lv5/cpu_wasm5.js', 'CPU5'],
    6: ['lv6/cpu6.js', 'lv6/wasm/cpu_wasm6.js', 'CPU6'],
};
const [cpuJs, wasmDefault, className] = FILES[LV];
const wasmJs = path.resolve(opt('wasm', path.join(pub, 'cpu/tet', wasmDefault)));

// ── 本番 JS を vm で読む ──────────────────────────
let posted = null;
const ctx = {
    console, Math, JSON, Set, Map, Array, Uint8Array, Int32Array, Promise, Object, Number, String,
    performance: { now: () => 0 }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    document: { createElement: () => ({ getContext: () => ({}), style: {}, appendChild() {} }), getElementById: () => null, querySelector: () => null },
    CpuWorkerPool: { acquire: () => ({ postMessage(m) { posted = m; }, terminate() {}, onmessage: null, onerror: null }) },
    localStorage: { getItem: () => null, setItem() {} },
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
const load = (f) => vm.runInContext(readFileSync(path.join(pub, f), 'utf8'), ctx, { filename: f });
for (const f of ['game/tet/board.js', 'game/tet/rotation.js', 'cpu/tet/cpu_zone.js']) load(f);
if (LV >= 5) load('cpu/tet/lv4/cpu4.js'); // 操作系を借りるレベルがある
load('cpu/tet/' + cpuJs);
const { Game, Mino, Block, Field, CpuZone } = ctx;
const CPU = ctx[className] || vm.runInContext(className, ctx);
const MOVES = Math.round(SEC * 1000 / CpuZone.CONFIG.moveMs[LV]);

// ── wasm ─────────────────────────────────────────
const loadWasm = (js) => new Promise((resolve) => {
    const mod = { print() {}, printErr() {}, locateFile: (p) => path.join(path.dirname(js), p) };
    mod.onRuntimeInitialized = () => {
        mod.ptrs = [mod._my_malloc(250), mod._my_malloc(4 * 64), mod._my_malloc(4 * 64)];
        resolve(mod);
    };
    const fn = new Function('require', '__dirname', '__filename', 'Module',
        readFileSync(js, 'utf8') + '\n;Module.HEAPU8 = HEAPU8; Module.HEAP32 = HEAP32;');
    fn(createRequire(js), path.dirname(js), js, mod);
});
const M0 = await loadWasm(wasmJs);

function callWasm(d, M = M0) {
    const [B, W, O] = M.ptrs;
    M.HEAPU8.set(d.boardBuffer, B);
    M.HEAP32.set(d.weightsArray, W >> 2);
    if (LV === 2) M._searchBestMoveWasm(B, d.currentType, d.holdType, d.next1, d.next2, d.canHold, W, O);
    else if (LV === 3) M._searchBestMoveWasm(B, d.currentType, d.holdType, d.next1, d.next2, d.next3, d.canHold, W, O);
    // lv4・lv5 の後ろ 2 つ（予告・残り手数）は §21 で足した引数。古い wasm は余分な引数を読まない
    else if (LV === 4) M._searchBestMoveWasm(B, d.currentType, d.holdType, d.next1, d.next2, d.next3, d.next4, d.next5, d.canHold, W, O, d.incoming || 0, d.zoneMovesLeft || 0);
    else if (LV === 5) M._searchBestMoveWasm(B, d.currentType, d.holdType, d.next1, d.next2, d.next3, d.next4, d.next5, d.canHold, W, O, d.ren, d.backToBack, d.incoming || 0, d.zoneMovesLeft || 0);
    else M._searchBestMoveWasm(B, d.currentType, d.holdType, d.next1, d.next2, d.next3, d.next4, d.next5, d.next6, d.next7, d.next8,
        d.canHold, W, O, d.ren, d.backToBack, d.incoming || 0, d.zoneMovesLeft || 0);
    return Int32Array.from(M.HEAP32.subarray(O >> 2, (O >> 2) + 43));
}

// ── 乱数・開始盤面（§19.3 と同じ 4 つ）───────────────
let seed = 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
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
    let cells = startBoard(kind), zone = 0, holdType = -1, attack = 0, ren = 0, b2b = false, pcs = 0;
    let queue = [], bagLeft = [], moves = 0, ended = 'time', canHold = true;
    const refill = () => { while (queue.length < 12) { if (!bagLeft.length) bagLeft = bag(); queue.push(bagLeft.shift()); } };
    const g = Object.create(Game.prototype);
    Object.assign(g, {
        field: new Field(), level: 2, score: 0, isVersusMode: true, backToBack: false, ren: 0,
        zoneActive: true, zoneLines: 0, topLimit: -20, playSe() {}, requestRedraw() {},
        zoneRemainingMs: () => Math.max(0, (MOVES - moves) * CpuZone.CONFIG.moveMs[LV]),
        cpuFrame() {}, cpuSchedule() {}, garbageQueue: [],
    });
    const cpu = new CPU(g);
    cpu.workerReady = true;
    for (; moves < MOVES; moves++) {
        refill();
        g.field.blocks = [...cells].map(s => { const [x, y] = s.split(',').map(Number); return new Block(x, y, 7); });
        g.field.markDirty && g.field.markDirty();
        g.zoneLines = zone;
        g.ren = ren; g.backToBack = b2b;
        g.holdMino = holdType >= 0 ? new Mino(holdType) : null;
        g.canHold = canHold;
        const mino = new Mino(queue[0]);
        g.mino = mino;
        if (!g._placeAtSpawn(mino, 0)) { ended = 'block'; break; }
        g.nextQueue = queue.slice(1).map(t => new Mino(t));
        posted = null;
        cpu.isCalculating = false;
        cpu.onMinoSpawned();
        if (!posted) throw new Error('探索の依頼が出ませんでした');
        const out = callWasm(posted);
        if (out[0] === -1 || !(out[3] >= 0 && out[3] <= 6)) { ended = 'nomove'; break; }
        const id = out[3];
        if (out[0] === 1) { // HOLD してから置く
            if (holdType < 0) { holdType = queue.shift(); queue.shift(); } else { holdType = queue.shift(); }
        } else queue.shift();
        const t = new Mino(id);
        for (let i = 0; i < out[4]; i++) t.rotate();
        const py = out[6] - 5;
        const placed = t.blocks.map(b => ({ x: b.x + out[5], y: b.y + py }));
        if (placed.some(b => cells.has(b.x + ',' + b.y) || b.x < 0 || b.x > 9 || b.y > 19)) { ended = 'bad'; break; }
        for (const b of placed) cells.add(b.x + ',' + b.y);
        const full = [];
        for (let y = -20; y < 20 - zone; y++) { let f = true; for (let x = 0; x < 10; x++) if (!cells.has(x + ',' + y)) { f = false; break; } if (f) full.push(y); }
        const n = full.length;
        if (n) {
            const tspin = out[12] === 1;
            const b2bAct = tspin || n === 4;
            attack += tspin ? [2, 4, 6][n - 1] : [0, 1, 2, 4][n - 1];
            if (b2bAct && b2b) attack += 1;
            b2b = b2bAct ? true : (n > 0 ? false : b2b);
            ren++; if (ren > 2) attack += Math.min(5, Math.floor((ren - 1) / 2));
            const shifted = new Set();
            for (const s of cells) {
                const [x, y] = s.split(',').map(Number);
                if (y >= 20 - zone) { shifted.add(s); continue; }
                if (full.includes(y)) continue;
                shifted.add(x + ',' + (y + full.filter(f => f > y).length - n));
            }
            zone += n;
            for (let k = 0; k < zone; k++) for (let x = 0; x < 10; x++) shifted.add(x + ',' + (19 - k));
            cells = shifted;
            if (cells.size === zone * 10) { pcs++; attack += 10; }
        } else ren = 0;
    }
    let rest = 0, holes = 0;
    for (let x = 0; x < 10; x++) {
        let top = null;
        for (let y = -20; y < 20 - zone; y++) {
            if (cells.has(x + ',' + y)) { rest++; if (top === null) top = y; }
            else if (top !== null) holes++;
        }
    }
    if (SHOW) {
        const rows = [];
        for (let y = -3; y < 20; y++) { let r = ''; for (let x = 0; x < 10; x++) r += cells.has(x + ',' + y) ? (y >= 20 - zone ? '=' : '#') : '.'; rows.push(r); }
        console.log(`[${kind}] ${ended} 手数 ${moves}\n` + rows.join('\n'));
    }
    return { zone, rest, holes, attack, moves, ended, pcs };
}

// --compare=旧 wasm: ZONE でない盤面（ランダム）で、旧 wasm と結果の配列が全部同じかを数えて終わる
const cmp = opt('compare', '');
if (cmp) {
    const M1 = await loadWasm(path.resolve(cmp));
    const g = Object.create(Game.prototype);
    Object.assign(g, { field: new Field(), level: 2, score: 0, isVersusMode: true, zoneActive: false, zoneLines: 0, topLimit: -5,
        playSe() {}, requestRedraw() {}, zoneRemainingMs: () => 0, cpuFrame() {}, cpuSchedule() {}, garbageQueue: [] });
    const cpu = new CPU(g);
    cpu.workerReady = true;
    let same = 0, diff = 0;
    for (let i = 0; i < RUNS; i++) {
        const c = new Set();
        for (let x = 0; x < 10; x++) { const h = Math.floor(rnd() * 16); for (let k = 0; k < h; k++) if (k === h - 1 || rnd() < 0.85) c.add(x + ',' + (19 - k)); }
        for (let y = -5; y < 20; y++) { let f = true; for (let x = 0; x < 10; x++) if (!c.has(x + ',' + y)) f = false; if (f) c.delete(Math.floor(rnd() * 10) + ',' + y); }
        g.field.blocks = [...c].map(s => { const [x, y] = s.split(',').map(Number); return new Block(x, y, 7); });
        const q = Array.from({ length: 10 }, () => Math.floor(rnd() * 7));
        g.mino = new Mino(q[0]); g.nextQueue = q.slice(1).map(t => new Mino(t));
        g.holdMino = rnd() < 0.5 ? new Mino(Math.floor(rnd() * 7)) : null; g.canHold = true;
        g.ren = Math.floor(rnd() * 3); g.backToBack = rnd() < 0.3;
        g.garbageQueue = rnd() < 0.3 ? [{ amount: 1 + Math.floor(rnd() * 6) }] : [];
        posted = null; cpu.isCalculating = false; cpu.onMinoSpawned();
        const a = callWasm(posted, M0).join(','), b = callWasm(posted, M1).join(',');
        if (a === b) same++; else diff++;
    }
    console.log(`lv${LV} ZONE なし ${RUNS} 局面: 同じ ${same}／違う ${diff}`);
    process.exit(0);
}

console.log(`lv${LV} ${SEC} 秒（${MOVES} 手）× ${RUNS} 回  wasm=${path.relative(process.cwd(), wasmJs)}`);
for (const kind of ['empty', 'right', 'hole', 'rough']) {
    seed = 12345;
    const rs = [];
    for (let i = 0; i < RUNS; i++) rs.push(run(kind));
    const avg = (k) => (rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(1);
    const ends = rs.map(r => r.ended[0]).join('');
    console.log(`${kind.padEnd(6)} 段数 ${avg('zone')}  残ったマス ${avg('rest')}  穴 ${avg('holes')}  通常火力 ${avg('attack')}  手数 ${avg('moves')}  終わり方 ${ends}`);
}
