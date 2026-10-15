// ─────────────────────────────────────────────
// tests/gen_js_cases.mjs — 本番 JS エンジンの関数を Node で直接動かし、一致テストの正解データを作る。
//   ・乱数: public/app/versus.js createSeededRandom
//   ・ツモ: lifecycle.js _initActiveColors → engine.js _initNextQueue / _dequeueNext
//   ・連鎖: engine.js _findErasableInField / _calcChainScore（おじゃま巻き込み込み）
//   使い方: node tests/gen_js_cases.mjs > build/js_cases.json
// ─────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '../../../public');
const read = (p) => fs.readFileSync(path.join(pub, p), 'utf8');

const ctx = { console, Math, window: {} };
vm.createContext(ctx);
const base = read('core/base.js');
const pc = base.match(/const PConfig = \{[\s\S]*?\n\};/);
if (!pc) throw new Error('PConfig が base.js に見つからない');
vm.runInContext(pc[0].replace('const PConfig', 'globalThis.PConfig') , ctx);
const rngSrc = read('app/versus.js').match(/function createSeededRandom\(seed\) \{[\s\S]*?\n\}/);
if (!rngSrc) throw new Error('createSeededRandom が versus.js に見つからない');
vm.runInContext(rngSrc[0] + '\nglobalThis.createSeededRandom = createSeededRandom;', ctx);
vm.runInContext('globalThis.PuyoGame = class { _random() { return this.rng ? this.rng() : Math.random(); } };', ctx);
for (const f of ['game/puyo/engine.js', 'game/puyo/lifecycle.js']) vm.runInContext(read(f), ctx, { filename: f });

const { PuyoGame, createSeededRandom, PConfig } = ctx;
const out = { rng: [], pairs: [], chains: [] };

// ── 乱数 ──
for (const seed of [1, 7, 12345, 999999, 1000000]) {
    const r = createSeededRandom(seed);
    out.rng.push({ seed, values: Array.from({ length: 50 }, () => r()) });
}

// ── ツモ列 ──
for (const colorCount of [3, 4, 5]) {
    for (let seed = 1; seed <= 40; seed++) {
        const g = new PuyoGame();
        g.rng = createSeededRandom(seed * 7919);
        g.vsColorCount = colorCount;
        g._initActiveColors();
        g._initNextQueue();
        const seq = [];
        for (let i = 0; i < 60; i++) seq.push(...g._dequeueNext());
        out.pairs.push({ seed: seed * 7919, colorCount, seq });
    }
}

// ── 連鎖スコア（ランダム盤面。消えるまで回す）──
const totalRows = PConfig.rows + PConfig.hiddenRows;
let s = 20261015;
const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
for (let n = 0; n < 3000; n++) {
    const field = Array.from({ length: totalRows }, () => new Array(PConfig.cols).fill(0));
    const nColors = 3 + Math.floor(rand() * 3);
    for (let c = 0; c < PConfig.cols; c++) {
        const h = Math.floor(rand() * (PConfig.rows + 2));   // 隠し段にもはみ出す
        for (let k = 0; k < h; k++) {
            const r = totalRows - 1 - k;
            field[r][c] = rand() < 0.08 ? 6 : 1 + Math.floor(rand() * nColors);
        }
    }
    const board = field.flat();
    const g = new PuyoGame();
    Object.assign(g, { chainCount: 0, clearedPuyos: 0, attackScore: 0, generatedOjamaTotal: 0, pendingFire: 0,
                       scoreEl: null, _updateChainDisplay() {} });
    let total = 0;
    while (true) {
        const { groups, ojamaToErase } = g._findErasableInField(field);
        if (groups.length === 0) break;
        g.chainCount++;
        g._calcChainScore(groups);
        total += g.chainScoreAdd;
        for (const grp of groups) for (const cell of grp) field[cell.r][cell.c] = 0;
        for (const cell of ojamaToErase) field[cell.r][cell.c] = 0;
        for (let c = 0; c < PConfig.cols; c++) {        // 重力（全段）
            const stack = [];
            for (let r = totalRows - 1; r >= 0; r--) if (field[r][c] !== 0) stack.push(field[r][c]);
            for (let r = totalRows - 1; r >= 0; r--) {
                const k = totalRows - 1 - r;
                field[r][c] = k < stack.length ? stack[k] : 0;
            }
        }
    }
    out.chains.push({ board, score: total, chains: g.chainCount, pendingFire: g.pendingFire });
}
process.stdout.write(JSON.stringify(out) + '\n');
