// テト CPU lv1・lv2 の手の速さ（1 手の時間・PPS・LPM・APM）を画面なしで数える。
//   旧（898947b: cpuAction('teleport') で向きと列へ飛ばしてから待つ）と新（1 操作ずつ入れる）を同じツモで比べる。
//   設計 source_assets/memory/mode/cpu/tet/lv1-2/lv1-2-input-design.md・結果 lv1-2-pace-sim.md。
//
//   本番の cpu.js / cpu2.js を node:vm で読み、盤面の操作は本番の game/tet/board.js（cpuAction・valid・hardDrop・
//   重力・固定猶予）と rotation.js（tryRotate・_placeAtSpawn・checkTSpin）、待ち時間は core/cpu_port.js の
//   cpuSchedule / cpuFrame をそのまま使う。時計はにせもの（1 フレーム = 1000/hz ms ずつ進める）。
//   フレームの順は render.js と同じ: 時計（固定猶予の予約）→ CPU（_runCpu）→ 重力。
//   lv2 の worker は「投げたフレームの後・次のフレームの前」に返事が届く（cpuSchedule(0) で次のフレームに受け取る）。
//   置いた後は本番どおり ARE・消去の待ちなしで次のミノが出る。おじゃまは来ない（相手なし）。
//   火力は VERSUS のマージン前の表（scoring.js）: 2 段 1・3 段 2・4 段 4・T-Spin 段×2・B2B +1・REN 表・PC 10。
//
// 使い方: node training/tet/lv12_pace_sim.mjs [--lv=1,2] [--seeds=10] [--pieces=500] [--hz=60]
//           [--ver=old=<dir>,head=<dir>,work=public/cpu/tet] [--json=出力先]
//   <dir> は lv1/cpu.js・lv2/cpu2.js・lv2/cpu_wasm2.js(+.wasm) を持つフォルダ。
//   旧・HEAD の取り出し例: git show 898947b:public/cpu/tet/lv1/cpu.js > <dir>/lv1/cpu.js（lv2 は 3 ファイル）
//   --ver を省くと public/cpu/tet（いまの作業ツリー）だけ。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const pub = path.join(root, 'public');
const args = process.argv.slice(2);
const opt = (name, def) => {
    const a = args.find(s => s.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : def;
};
const LVS = opt('lv', '1,2').split(',').map(Number);
const SEEDS = parseInt(opt('seeds', '10'), 10);
const PIECES = parseInt(opt('pieces', '500'), 10);
const HZ = parseFloat(opt('hz', '60'));
const DT = 1000 / HZ;
const VERS = opt('ver', 'work=public/cpu/tet').split(',').map(s => {
    const [name, dir] = s.split('=');
    return { name, dir: path.resolve(root, dir) };
});

// ── 本番 JS を vm で読む（版ごとに別の文脈）──────────────
function makeEnv(cpuDir, lv) {
    const env = { pendingMsgs: [], worker: null };
    const ctx = {
        console: { log() {}, warn: console.warn, error: console.error }, Math, JSON, Set, Map, Array, Uint8Array, Int32Array, Promise, Object, Number, String, Infinity,
        performance: { now: () => 0 }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
        requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
        document: { createElement: () => ({ getContext: () => ({}), style: {}, appendChild() {} }), getElementById: () => null, querySelector: () => null },
        CpuWorkerPool: {
            acquire: () => (env.worker = { postMessage(m) { env.pendingMsgs.push(m); }, terminate() {}, onmessage: null, onerror: null }),
        },
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
    const load = (f) => vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    for (const f of ['core/cpu_port.js', 'game/tet/board.js', 'game/tet/rotation.js']) load(path.join(pub, f));
    vm.runInContext('Object.assign(Game.prototype, CpuPort);', ctx);
    load(path.join(cpuDir, lv === 1 ? 'lv1/cpu.js' : 'lv2/cpu2.js'));
    env.ctx = ctx;
    env.CPU = lv === 1 ? ctx.CPU : ctx.CPU2;
    return env;
}

// ── wasm（lv2）──────────────────────────────────
const loadWasm = (js) => new Promise((resolve) => {
    const mod = { print() {}, printErr() {}, locateFile: (p) => path.join(path.dirname(js), p) };
    mod.onRuntimeInitialized = () => {
        mod.ptrs = [mod._my_malloc(250), mod._my_malloc(4 * 16), mod._my_malloc(4 * 12)];
        resolve(mod);
    };
    const fn = new Function('require', '__dirname', '__filename', 'Module',
        readFileSync(js, 'utf8') + '\n;Module.HEAPU8 = HEAPU8; Module.HEAP32 = HEAP32;');
    fn(createRequire(js), path.dirname(js), js, mod);
});
// cpu_worker2.js と同じ呼び方。新しい版（curX/curY/curRot あり）は canHold の後に 3 つ足す
function callWasm(M, d) {
    const [B, W, O] = M.ptrs;
    M.HEAPU8.set(d.boardBuffer, B);
    M.HEAP32.set(d.weightsArray, W >> 2);
    if ('curX' in d) M._searchBestMoveWasm(B, d.currentType, d.holdType, d.next1, d.next2, d.canHold, d.curX, d.curY, d.curRot, W, O);
    else M._searchBestMoveWasm(B, d.currentType, d.holdType, d.next1, d.next2, d.canHold, W, O);
    return new Int32Array(M.HEAP32.subarray(O >> 2, (O >> 2) + 12));
}

// ── 乱数（7 種 1 巡）──────────────────────────────
function makeRng(seed) {
    let s = (seed * 2654435761) >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ── 1 局 ───────────────────────────────────────
function runGame(env, M, lv, seed) {
    const { ctx } = env;
    const { Game, Mino, Field } = ctx;
    const rnd = makeRng(seed);
    let bag = [];
    const nextType = () => {
        if (!bag.length) { bag = [0, 1, 2, 3, 4, 5, 6]; for (let i = 6; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; } }
        return bag.pop();
    };

    // 時計（game_clock.js の代わり。予約はフレームの頭で実行）
    const clock = {
        t: 0, list: [], seq: 0,
        now() { return this.t; },
        schedule(ms, cb) { const h = { due: this.t + ms, seq: ++this.seq, cb }; this.list.push(h); this.list.sort((a, b) => a.due - b.due || a.seq - b.seq); return h; },
        cancel(h) { const i = this.list.indexOf(h); if (i >= 0) this.list.splice(i, 1); },
        advance(t) { this.t = t; while (this.list.length && this.list[0].due <= t) { const h = this.list.shift(); h.cb(); } },
    };

    const st = {
        pieces: [], lines: 0, attack: 0, over: false, lockByTimer: 0, holds: 0, lastLock: 0,
        cur: null, // 今の手（ホールドをまたいで 1 手）
    };
    const g = Object.create(Game.prototype);
    Object.assign(g, {
        field: new Field(), mino: null, nextQueue: [], holdMino: null, canHold: true,
        level: 2, lockDelay: 600, topLimit: -5, isVersusMode: true, clock,
        ren: 0, backToBack: false, gravityDisabled: false, timer: null, isGrounded: false, lowestY: 0, moveCount: 0,
        lockTimer: null, isPaused: false, state: 'playing', score: 0, currentMode: 'versus', canvasPrefix: 'cpu',
        lastActionWasRotation: false, lastRotUsedPoint5: false,
        playSe() {}, requestRedraw() {}, drawAll() {}, updateStatsDisplay() {},
    });
    for (let i = 0; i < 6; i++) g.nextQueue.push(new Mino(nextType()));

    // 操作を数える（新: 実際の rotate/shift、旧: teleport の向き・列の差を 1 操作ずつに直した数）
    const origAction = g.cpuAction;
    g.cpuAction = function (type, a, b, c) {
        const m = this.mino;
        if (m && st.cur) {
            if (type === 'rotate') st.cur.rot++;
            else if (type === 'shift') st.cur.shift++;
            else if (type === 'teleport') {
                const d = (a - m.rotation + 4) % 4;
                st.cur.rot += m.type === 1 ? 0 : (d === 3 ? 1 : d);
                st.cur.shift += Math.abs(b - m.x);
            }
            else if (type === 'hold') st.cur.hold++;
        }
        return origAction.call(this, type, a, b, c);
    };

    const startGravity = () => { g.timer = true; g._gravityLastTime = clock.now(); };
    g.startGravity = startGravity;
    const gravityTick = () => { // lifecycle.js _applyGravityTick（ZONE・PRACTICE を除く）
        if (!g.timer) return;
        if (!g.mino || g.gravityDisabled) { g._gravityLastTime = clock.now(); return; }
        const speed = ctx.LEVEL_SPEEDS[g.level];
        const elapsed = clock.now() - g._gravityLastTime;
        if (elapsed < speed) return;
        const n = Math.floor(elapsed / speed);
        g._gravityLastTime = clock.now() - (elapsed % speed);
        for (let i = 0; i < n; i++) { g.dropMino(); if (!g.timer) break; }
    };
    const resetPieceState = () => {
        g.isGrounded = false; g.lowestY = g.mino.y; g.moveCount = 0;
        g.lastActionWasRotation = false; g.lastRotUsedPoint5 = false;
        g._cancelLockTimer(); startGravity();
    };
    g.popMino = function () {
        const m = this.nextQueue.shift();
        this.nextQueue.push(new Mino(nextType()));
        if (!this._placeAtSpawn(m, 0)) { this.mino = m; st.over = true; return; }
        this.mino = m;
        this.canHold = true;
        resetPieceState();
        if (!st.cur) st.cur = { t0: clock.now(), rot: 0, shift: 0, hold: 0 };
    };
    g.holdCurrentMino = function () { // rotation.js holdCurrentMino（IRS/IHS なし）
        if (!this.canHold) return;
        this.canHold = false;
        st.holds++;
        if (this.holdMino === null) {
            this.holdMino = new Mino(this.mino.type);
            this.popMino();
            this.canHold = false;
        } else {
            const prev = this.holdMino.type;
            this.holdMino = new Mino(this.mino.type);
            const m = new Mino(prev);
            if (!this._placeAtSpawn(m, 0)) { this.mino = m; st.over = true; return; }
            this.mino = m;
            resetPieceState();
        }
    };
    const origStartLock = g.startLockTimer;
    g.startLockTimer = function (delay) {
        origStartLock.call(this, delay);
        const h = this.lockTimer, cb = h.cb;
        h.cb = () => { st.lockByTimer++; cb(); };
    };
    g.secureMino = function () { // board.js secureMino の盤面・火力の部分（おじゃまなし）
        const allOutside = this.mino.blocks.every(b => b.y + this.mino.y < 0);
        const tspin = this.checkTSpin();
        for (const b of this.mino.blocks) { b.x += this.mino.x; b.y += this.mino.y; }
        this.field.blocks = this.field.blocks.concat(this.mino.blocks);
        this.field.markDirty();
        const n = this.field.checkLine();
        const pc = this.field.blocks.length === 0;
        // scoring.js（マージン前の表）
        const btbAct = n > 0 && (n === 4 || tspin !== null);
        let b2bTrig = false;
        if (btbAct) { b2bTrig = this.backToBack; this.backToBack = true; } else if (n > 0) this.backToBack = false;
        const r = this.ren;
        if (n > 0) this.ren++; else this.ren = 0;
        let atk = 0;
        if (pc) atk = 10;
        else if (n > 0) {
            if (tspin === 'tspin') atk = n * 2;
            else atk = n === 2 ? 1 : n === 3 ? 2 : n === 4 ? 4 : 0;
            if (b2bTrig) atk += 1;
            if (r === 2 || r === 3) atk += 1; else if (r === 4 || r === 5) atk += 2; else if (r === 6 || r === 7) atk += 3;
            else if (r >= 8 && r <= 12) atk += 4; else if (r >= 13) atk += 5;
        }
        const now = clock.now();
        const c = st.cur || { t0: st.lastLock, rot: 0, shift: 0, hold: 0 };
        st.pieces.push({ dt: now - c.t0, ops: c.rot + c.shift, rot: c.rot, shift: c.shift, hold: c.hold, lines: n, atk, type: this.mino.type });
        st.lines += n; st.attack += atk; st.lastLock = now;
        st.cur = null;
        this.mino = null;
        if (allOutside) { st.over = true; return; }
        this.popMino();
    };

    const cpu = new env.CPU(g);
    cpu.workerReady = true;
    env.pendingMsgs.length = 0;
    g.popMino();
    st.cur.t0 = 0;
    cpu.start();

    const maxFrames = Math.ceil(PIECES * 5000 / DT);
    for (let f = 1; f <= maxFrames && !st.over && st.pieces.length < PIECES; f++) {
        const t = f * DT;
        clock.advance(t);            // 固定猶予など
        if (st.over) break;
        g._runCpu();                 // CPU の手
        if (st.over) break;
        gravityTick();               // 重力
        // worker の返事（投げたフレームの後に届く。onmessage は cpuSchedule(0) で次のフレームに受け取る）
        while (env.pendingMsgs.length) {
            const m = env.pendingMsgs.shift();
            const res = callWasm(M, m);
            env.worker.onmessage({ data: { type: 'result', result: res } });
        }
    }
    cpu.stop();
    return { pieces: st.pieces, lines: st.lines, attack: st.attack, time: st.lastLock, over: st.over, lockByTimer: st.lockByTimer, holds: st.holds };
}

// ── 集計 ───────────────────────────────────────
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function summarize(games) {
    const ps = games.flatMap(g => g.pieces);
    const dts = ps.map(p => p.dt);
    const time = games.reduce((a, g) => a + g.time, 0);
    const lines = games.reduce((a, g) => a + g.lines, 0);
    const atk = games.reduce((a, g) => a + g.attack, 0);
    const hist = {};
    for (const d of dts) { const b = Math.floor(d / 100) * 100; hist[b] = (hist[b] || 0) + 1; }
    const ops = {};
    for (const p of ps) { const k = Math.min(p.ops, 8); ops[k] = (ops[k] || 0) + 1; }
    const noHold = ps.filter(p => !p.hold).map(p => p.dt);
    return {
        games: games.length, topOuts: games.filter(g => g.over).length, pieces: ps.length,
        mean: mean(dts), median: q(dts, 0.5), p10: q(dts, 0.1), p90: q(dts, 0.9), min: Math.min(...dts), max: Math.max(...dts),
        meanNoHold: noHold.length ? mean(noHold) : 0, holdRate: ps.filter(p => p.hold).length / ps.length,
        pps: ps.length / (time / 1000), lpm: lines / (time / 60000), apm: atk / (time / 60000),
        lines, attack: atk, timeSec: time / 1000,
        opsMean: mean(ps.map(p => p.ops)), rotMean: mean(ps.map(p => p.rot)), shiftMean: mean(ps.map(p => p.shift)),
        lockByTimer: games.reduce((a, g) => a + g.lockByTimer, 0),
        hist, ops,
        perGame: games.map(g => ({ pieces: g.pieces.length, over: g.over, lpm: +(g.lines / (g.time / 60000)).toFixed(2), apm: +(g.attack / (g.time / 60000)).toFixed(2) })),
    };
}

const results = {};
for (const lv of LVS) {
    for (const v of VERS) {
        const env = makeEnv(v.dir, lv);
        const M = lv === 2 ? await loadWasm(path.join(v.dir, 'lv2/cpu_wasm2.js')) : null;
        const games = [];
        for (let s = 1; s <= SEEDS; s++) games.push(runGame(env, M, lv, s));
        const r = summarize(games);
        results[`lv${lv}/${v.name}`] = r;
        const f = (x) => x.toFixed(1);
        console.log(`lv${lv} ${v.name.padEnd(5)} 手数 ${r.pieces}（${r.games} 局・窒息 ${r.topOuts}） 1手 平均 ${f(r.mean)} 中央 ${f(r.median)} p10 ${f(r.p10)} p90 ${f(r.p90)} ms` +
            `  PPS ${r.pps.toFixed(3)}  LPM ${r.lpm.toFixed(2)}  APM ${r.apm.toFixed(2)}  操作 ${r.opsMean.toFixed(2)}（回転 ${r.rotMean.toFixed(2)}・横 ${r.shiftMean.toFixed(2)}）` +
            `  ホールド率 ${(r.holdRate * 100).toFixed(1)}%  固定猶予で固定 ${r.lockByTimer}`);
        console.log('   1手の時間(100ms刻み) ' + Object.keys(r.hist).map(Number).sort((a, b) => a - b).map(k => `${k}:${r.hist[k]}`).join(' '));
        console.log('   操作数(8=8以上)      ' + Object.keys(r.ops).map(Number).sort((a, b) => a - b).map(k => `${k}:${r.ops[k]}`).join(' '));
    }
}
const jsonOut = opt('json', '');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ seeds: SEEDS, pieces: PIECES, hz: HZ, results }, null, 1));
