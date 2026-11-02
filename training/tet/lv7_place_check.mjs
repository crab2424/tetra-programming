// 高い盤面でテト CPU lv7 の「探索が選んだ置き場所」と「実際に置いた場所」がずれるかを数える。
//   本番の public/core/base.js（Block/Mino/Field）・game/tet/board.js・rotation.js・cpu/tet/lv7/cpu7.js を
//   node:vm で読み、探索は本番 wasm（cpu/tet/lv7/wasm/cpu_wasm7.js）をそのまま呼ぶ。画面は起動しない。
//   1件 = 盤面を作る → popMino（出現位置の1段上げ込み）→ lv7Search → handleWorkerResult →
//         executeAction（buildActionQueue → processActionQueue）を偽タイマーで最後まで回し、ハードドロップの4マスを比べる。
//   比べるもの:
//     queue … 実際の操作列（cpu7.js の簡略化込み）で置いた4マス
//     raw   … 探索の path をそのまま TETLABO の操作で再生した4マス（HOLD は本番の holdCurrentMino で出す）
//   raw がずれる＝探索と TETLABO の動き（出現位置・キック）の違い。raw が合って queue がずれる＝操作の簡略化の問題。
//
// 使い方: node training/tet/lv7_place_check.mjs [件数=1000] [seed=1] [--show=3] [--profile=all|touch|high|well]
//         [--depth=8] [--think=20] [--only-nohold（例の表示を HOLD 以外に絞る）]
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
const N = parseInt(positional[0] || '1000', 10);
let seed = parseInt(positional[1] || '1', 10) >>> 0 || 1;
const SHOW = parseInt(opt('show', '3'), 10);
const PROFILE = opt('profile', 'all');
const THINK_MS = parseInt(opt('think', '20'), 10);
const DEPTH = parseInt(opt('depth', '8'), 10);

// ── 本番 JS を vm で読む ──────────────────────────
let timers = [];
const ctx = {
    console, Math, JSON, Set, Map, Array, Uint8Array, Int32Array, Promise,
    performance: { now: () => 0 },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    document: {
        createElement: () => ({ getContext: () => ({}) }),
        getElementById: () => null,
    },
    CpuWorkerPool: { acquire: () => ({ postMessage() {}, terminate() {}, onmessage: null, onerror: null }) },
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
${pick(base, 'class Block {', 'Field.TOP_PAD = 5')}
class Game {}
globalThis.Block = Block; globalThis.Mino = Mino; globalThis.Field = Field; globalThis.Game = Game;
globalThis.LEVEL_SPEEDS = LEVEL_SPEEDS;
`, ctx);
for (const f of ['game/tet/board.js', 'game/tet/rotation.js', 'cpu/tet/lv7/cpu7.js']) {
    vm.runInContext(readFileSync(path.join(pub, f), 'utf8'), ctx, { filename: f });
}
const { Game, Mino, Block, Field, CPU7 } = ctx;
// 簡略化した操作列が置き場所に着かず path どおりに戻した回数（cpu7.js buildActionQueue → queueLandsAt）
const origLands = CPU7.prototype.queueLandsAt;
CPU7.prototype.queueLandsAt = function (queue, best) {
    const ok = origLands.call(this, queue, best);
    if (!ok) globalThis.__verifyFallbacks = (globalThis.__verifyFallbacks || 0) + 1;
    return ok;
};
const drain = () => { for (let k = 0; timers.length && k < 100000; k++) timers.shift()(); timers = []; };

// ── wasm ─────────────────────────────────────────
const wasmJs = path.join(pub, 'cpu/tet/lv7/wasm/cpu_wasm7.js');
const M = await new Promise((resolve) => {
    const mod = {};
    mod.onRuntimeInitialized = () => resolve(mod);
    const fn = new Function('require', '__dirname', '__filename', 'module', 'Module', readFileSync(wasmJs, 'utf8'));
    fn(createRequire(wasmJs), path.dirname(wasmJs), wasmJs, { exports: {} }, mod);
});
const OUT_LEN = 96, QUEUE_MAX = 40, WEIGHTS_MAX = 96;
const boardPtr = M._lv7_malloc(250), queuePtr = M._lv7_malloc(4 * QUEUE_MAX);
const weightsPtr = M._lv7_malloc(4 * WEIGHTS_MAX), outPtr = M._lv7_malloc(4 * OUT_LEN);

// cpu7.js onMinoSpawned と同じ入力で探索する
function search(game, cpu) {
    const boardBuffer = new Uint8Array(250);
    for (const b of game.field.blocks) {
        const by = b.y + 5;
        if (by >= 0 && by < 25 && b.x >= 0 && b.x < 10) boardBuffer[by * 10 + b.x] = 1;
    }
    const depth = Math.max(1, Math.min(32, Math.round(cpu.weights.searchDepth)));
    game.ensureNextQueue(depth + 1);
    const queue = [game.mino.type, ...game.nextQueue.map(m => m.type)].slice(0, QUEUE_MAX);
    let bagAfter = 0;
    for (const t of game.bag) bagAfter |= 1 << t;
    const w = cpu.weightsArray();
    M.HEAPU8.set(boardBuffer, boardPtr);
    M.HEAP32.set(Int32Array.from(queue), queuePtr >> 2);
    M.HEAP32.set(w.slice(0, WEIGHTS_MAX), weightsPtr >> 2);
    M._lv7Search(boardPtr, queuePtr, queue.length, game.holdMino ? game.holdMino.type : -1, bagAfter,
        0, 0, 0, weightsPtr, Math.min(w.length, WEIGHTS_MAX),
        Math.round(cpu.weights.searchWidth), depth, Math.round(cpu.weights.thinkMs), outPtr, OUT_LEN);
    return Int32Array.from(M.HEAP32.subarray(outPtr >> 2, (outPtr >> 2) + OUT_LEN));
}

// ── 乱数・盤面 ───────────────────────────────────
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// 列の高さ（段数。20 で y=0 まで、21 以上は隠し段へ）を決めて、上端は必ず埋め・中は少し穴を開ける
function makeHeights(profile) {
    const h = new Array(10);
    if (profile === 'touch') {
        // 出現位置（列3〜6）の真下が出現ミノに触れる高さ（19＝接する／20＝1段上げ）、他の列は低めで上が空いている
        for (let x = 0; x < 10; x++) h[x] = (x >= 3 && x <= 6) ? ri(18, 20) : ri(4, 19);
    } else if (profile === 'well') {
        for (let x = 0; x < 10; x++) h[x] = ri(16, 20);
        h[ri(0, 9)] = ri(0, 8);
    } else {
        for (let x = 0; x < 10; x++) h[x] = ri(12, 21);
    }
    return h;
}

function makeBoard(profile) {
    const h = makeHeights(profile);
    const cells = new Set();
    for (let x = 0; x < 10; x++) {
        for (let k = 0; k < h[x]; k++) {
            const y = 19 - k;
            if (k === h[x] - 1 || rnd() < 0.85) cells.add(x + ',' + y);
        }
    }
    // 揃った行は1マス空ける（置く前に消える行を作らない）
    for (let y = -5; y < 20; y++) {
        let full = true;
        for (let x = 0; x < 10; x++) if (!cells.has(x + ',' + y)) { full = false; break; }
        if (full) cells.delete(ri(0, 9) + ',' + y);
    }
    return [...cells].map(s => { const [x, y] = s.split(',').map(Number); return { x, y }; });
}

function newGame(blocks, queueTypes, holdType) {
    const g = Object.create(Game.prototype);
    Object.assign(g, {
        field: new Field(), bag: [], nextQueue: queueTypes.map(t => new Mino(t)),
        holdMino: null, canHold: true, level: 2, score: 0, isVersusMode: true, vsHoldEnabled: true,
        currentMode: 'versus', garbageQueue: [], backToBack: false, ren: 0, gravityDisabled: false,
        lockTimer: null, timer: null, isPaused: false, state: 'playing',
        tumoRng: rnd,
        playSe() {}, requestRedraw() {}, drawAll() {}, updateStatsDisplay() {}, startGravity() {},
        // CPU の待ち時間（本番は core/cpu_port.js のゲーム時計の予約）は偽タイマーへ
        cpuSchedule(ms, fn) { return ctx.setTimeout(fn, ms); }, cpuCancel() {}, cpuFrame() {}, cpuThink() {},
        gameOver() { this._over = true; },
    });
    g.field.blocks = blocks.map(b => new Block(b.x, b.y, 7));
    g.field.markDirty();
    if (holdType >= 0) { g.holdMino = new Mino(holdType); }
    return g;
}

const cellsOf = (mino) => mino.blocks.map(b => ({ x: b.x + mino.x, y: b.y + mino.y }));
const keyOf = (cells) => cells.map(c => c.x + ',' + c.y).sort().join(' ');

// ハードドロップを「落として4マスを記録し、ミノを消す」に差し替える（secureMino 以降は動かさない）
function captureHardDrop(g, sink) {
    g.hardDrop = function () {
        while (this.valid(0, 1)) this.mino.y++;
        sink.cells = cellsOf(this.mino);
        sink.overlap = !this.valid(0, 0);
        this.mino = null;
    };
}

// 探索の path をそのまま TETLABO の操作で再生する（HOLD は本番の holdCurrentMino）
function replayRaw(blocks, queueTypes, holdType, move) {
    const g = newGame(blocks, queueTypes, holdType);
    g.popMino();
    if (g._over) return null;
    const sink = {};
    captureHardDrop(g, sink);
    if (move.useHold) g.holdCurrentMino();
    if (g._over || !g.mino) return null;
    const spawnY = g.mino.y;
    for (const a of move.path) {
        if (a === 1) { if (g.valid(-1, 0)) g.mino.x--; }
        else if (a === 2) { if (g.valid(1, 0)) g.mino.x++; }
        else if (a === 3) { if (g.valid(0, 1)) g.mino.y++; }
        else if (a === 4) g.tryRotate(1, true);
        else if (a === 5) g.tryRotate(-1, true);
        else if (a === 6) { g.hardDrop(); break; }
    }
    if (g.mino) g.hardDrop();
    return { cells: sink.cells, spawnY };
}

const ASCII = (blocks, want, got) => {
    const has = new Set(blocks.map(b => b.x + ',' + b.y));
    const w = new Set(want.map(c => c.x + ',' + c.y)), q = new Set((got || []).map(c => c.x + ',' + c.y));
    const lines = [];
    for (let y = -5; y < 20; y++) {
        let s = (y < 0 ? 'h' : ' ') + String(y).padStart(3) + ' ';
        for (let x = 0; x < 10; x++) {
            const k = x + ',' + y;
            s += has.has(k) ? '#' : w.has(k) && q.has(k) ? '@' : w.has(k) ? 'E' : q.has(k) ? 'Q' : '.';
        }
        lines.push(s);
    }
    return lines.join('\n') + '\n     E=探索の置き場所 Q=実際に置いた場所 @=両方 #=盤面 h=隠し段';
};

// ── 本体 ─────────────────────────────────────────
const profiles = PROFILE === 'all' ? ['touch', 'high', 'well'] : [PROFILE];
const tally = {};
const bump = (k) => { tally[k] = (tally[k] || 0) + 1; };
let shown = 0, done = 0;

for (let i = 0; i < N; i++) {
    const profile = profiles[i % profiles.length];
    const blocks = makeBoard(profile);
    // 7種袋からツモ（深さぶん＋余り）
    const queueTypes = [];
    while (queueTypes.length < DEPTH + 3) {
        const bag = [0, 1, 2, 3, 4, 5, 6];
        for (let k = 6; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [bag[k], bag[j]] = [bag[j], bag[k]]; }
        queueTypes.push(...bag);
    }
    const holdType = rnd() < 0.5 ? ri(0, 6) : -1;

    const g = newGame(blocks, queueTypes, holdType);
    g.popMino();
    if (g._over) { bump('skip: 出現できない'); continue; }
    const sink = {};
    captureHardDrop(g, sink);

    const cpu = new CPU7(g);
    cpu.weights.searchDepth = DEPTH;
    cpu.weights.thinkMs = THINK_MS;
    cpu.isActive = true;
    cpu.isAutoPlay = false;           // handleWorkerResult では動かさず、下で executeAction を呼ぶ
    cpu.currentMino = g.mino;
    cpu._calcMino = g.mino;
    const res = search(g, cpu);
    if (res[0] !== 1) { bump('skip: 置ける手が無い'); continue; }
    cpu.handleWorkerResult(res);
    const move = cpu.bestMoveData;
    if (!move) { bump('skip: 形に直せない'); continue; }

    const want = [];
    for (let k = 0; k < 4; k++) want.push({ x: res[2 + k * 2], y: res[3 + k * 2] });

    // 実行の記録：作った操作列・回転でキックが起きたか・すり抜け（重なり）が起きたか
    const flags = new Set();
    if (move.useHold) flags.add('HOLD');
    if (move.path.length === 0) flags.add('経路なし');
    const origBuild = cpu.buildHoldActionQueue.bind(cpu);
    let builtQueue = null;
    cpu.buildHoldActionQueue = (m) => { const q = origBuild(m); builtQueue = q.slice(); return q; };
    const origRotate = g.tryRotate;
    g.tryRotate = function (dir, silent) {
        const x0 = this.mino.x, y0 = this.mino.y, r0 = this.mino.rotation;
        const ok = origRotate.call(this, dir, silent);
        if (!silent && ok) {
            // キック0なら位置は変わらない（ミノの x/y は回転では動かず、ブロックだけ回る）
            if (this.mino.x !== x0 || this.mino.y !== y0) flags.add(`キック(rot${r0}→${this.mino.rotation})`);
        }
        return ok;
    };
    const origStep = cpu.processActionQueue;
    cpu.processActionQueue = function () {
        const a = this.actionQueue[0];
        origStep.call(this);
        if (a && a.type === 'moveToTargetX' && this.game.mino && !this.game.valid(0, 0)) flags.add('瞬間移動');
    };

    cpu.isAutoPlay = true;
    cpu.executeAction(move);
    drain();
    done++;

    const types = (builtQueue || []).map(a => a.type);
    for (let k = 1; k < types.length; k++) if (types[k] === 'rotateCW' && types[k - 1] === 'rotateCW') flags.add('180°(右2回)');
    if (!types.some(t => t === 'multiSoftDrop' || t === 'softDrop')) flags.add('即時落下');

    const raw = replayRaw(blocks, queueTypes, holdType, move);
    if (move.useHold) {
        const t = new Mino(move.id); t.spawn();
        if (raw && raw.spawnY !== t.y) flags.add('HOLD出現の1段上げ');
    }
    const rawOk = raw && raw.cells && keyOf(raw.cells) === keyOf(want);
    const qOk = sink.cells && keyOf(sink.cells) === keyOf(want);
    if (sink.overlap) flags.add('重なったまま固定');

    bump(`${profile}: 件数`);
    if (qOk) { bump(`${profile}: 一致`); continue; }
    bump(`${profile}: ずれ`);
    bump(rawOk ? 'ずれ: 操作の簡略化（raw は一致）' : 'ずれ: 探索と TETLABO の動きの違い（raw もずれ）');
    for (const f of flags) bump(`ずれの内訳: ${f}`);
    if (shown < SHOW && !(args.includes("--only-nohold") && move.useHold)) {
        shown++;
        console.log(`\n── ずれ #${shown}（${profile}・ミノ ${move.id}・rot ${move.rot}・raw ${rawOk ? '一致' : 'ずれ'}・${[...flags].join(' / ') || '印なし'}）`);
        console.log('path:', move.path.join(','));
        console.log('queue:', types.join(','));
        console.log(ASCII(blocks, want, sink.cells));
    }
}

console.log(`\n=== lv7 置き場所チェック（${done} 件・seed ${positional[1] || 1}・depth ${DEPTH}・think ${THINK_MS}ms）===`);
for (const k of Object.keys(tally).sort()) console.log(`${k.padEnd(44)} ${tally[k]}`);
if (globalThis.__verifyFallbacks) console.log(`path どおりに戻した回数（queueLandsAt が不一致）       ${globalThis.__verifyFallbacks}`);
