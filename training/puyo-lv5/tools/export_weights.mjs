// ─────────────────────────────────────────────
// tools/export_weights.mjs — 本番 JS（cpu5_weights.js / cpu5_modes.js / cpu5_worker_io.js）から
//   現行 lv5 の weightsArray（build / fast）とカウンター定数を取り出して JSON で出力する。
//   puyo lv6（cpu6.js：学習済み重み＋対戦判断 VS_DECISION）も "lv6" に出す。
//   重みを手で写すと本番とずれるため、学習の基準値は必ずここから取る。
//   使い方: node tools/export_weights.mjs > build/baseline.json
// ─────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lv5 = path.resolve(here, '../../../public/cpu/puyo/lv5/js');

const ctx = { window: {}, console };
ctx.window.PuyoCPU5 = class {};
vm.createContext(ctx);
for (const f of ['weights/cpu5_weights.js', 'weights/cpu5_modes.js']) {
    vm.runInContext(fs.readFileSync(path.join(lv5, f), 'utf8'), ctx, { filename: f });
}
const cpu = new ctx.window.PuyoCPU5();
cpu._initWeights();

// [46][49][50]（催促 H1・対応 H2）は本番では思考ごとに入れる値（_harassMinScore など）なので、
//   _buildWeightsArray の外では 0 になる。学習用シミュは「保存している値」（個数・1/0）を受け取り、
//   思考ごとの換算（個数×レート・局面での有効/無効）は sim/player.cpp decide が行う。
const stored = (c, a) => {
    const cw = c.controlWeights;
    a[46] = cw.harassMinOjama || 0;
    a[49] = cw.counterKeepReach || 0;
    a[50] = cw.harassMinReach || 0;
    return a;
};
const arr = (mode) => {
    cpu.setMode(mode);
    return stored(cpu, Array.from(cpu._buildWeightsArray(9)));
};
const out = { build: arr('build'), fast: arr('fast'), buildNamed: {} };
cpu.setMode('build');
Object.assign(out.buildNamed, cpu.rewardWeights, cpu.evalWeights, cpu.controlWeights);

const io = fs.readFileSync(path.join(lv5, 'core/cpu5_worker_io.js'), 'utf8');
const num = (name) => {
    const m = io.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`));
    if (!m) throw new Error(`${name} が cpu5_worker_io.js に見つからない`);
    return Number(m[1]);
};
out.counterTrigger = num('COUNTER_TRIGGER_OJAMA_VSPUYO');
out.counterMargin  = num('COUNTER_MARGIN_VSPUYO');
if (out.build.length !== 51) throw new Error(`weightsArray 長が ${out.build.length}（51 を想定）`);

// ── puyo lv6（lv5 を継承した学習済み重み＋対戦判断）。public/cpu/puyo/lv6/js/cpu6.js から取り出す ──
{
    const lv6src = fs.readFileSync(path.resolve(lv5, '../../lv6/js/cpu6.js'), 'utf8');
    vm.runInContext(lv6src, ctx, { filename: 'cpu6.js' });
    const c6 = new ctx.window.PuyoCPU6();
    c6._initWeights();
    const arr6 = (mode) => { c6.setMode(mode); return stored(c6, Array.from(c6._buildWeightsArray(9))); };
    const C = ctx.window.PuyoCPU6;
    out.lv6 = {
        build: arr6('build'), fast: arr6('fast'),
        counterTrigger: C.TRAINED_COUNTER.triggerVsPuyo,
        counterMargin:  C.TRAINED_COUNTER.marginVsPuyo,
        vsDecision: C.VS_DECISION || {},
    };
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
