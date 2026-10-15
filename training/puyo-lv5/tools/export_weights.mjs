// ─────────────────────────────────────────────
// tools/export_weights.mjs — 本番 JS（cpu5_weights.js / cpu5_modes.js / cpu5_worker_io.js）から
//   現行 lv5 の weightsArray（build / fast）とカウンター定数を取り出して JSON で出力する。
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

const arr = (mode) => {
    cpu.setMode(mode);
    return Array.from(cpu._buildWeightsArray(9));
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
if (out.build.length !== 43) throw new Error(`weightsArray 長が ${out.build.length}（43 を想定）`);
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
