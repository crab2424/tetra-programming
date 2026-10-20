// 本番 public/game/puyo/ojama.js の _resolveTetAttack を node で動かす（tests/test_tet_attack.py から呼ぶ）。
//   入力: 第1引数の JSON（ケースの配列。各ケースは sim_tet_resolve_case と同じ並び）
//   出力: 標準出力に JSON（[lines, carry, zen, キュー残り合計, ready の残り, 未 ready の残り]）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(here, '../../../public/game/puyo/ojama.js'), 'utf8');
const ctx = { console, window: {} };
vm.createContext(ctx);
vm.runInContext(`
const PConfig = { zenkeshiBonus: 2100, ojamaRate: 70 };
class PuyoGame { get pendingOjama() { return this.garbageQueue.reduce((s, g) => s + g.amount, 0); } }
globalThis.PuyoGame = PuyoGame;
` + src, ctx);

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const c of cases) {
    const [rate, chainCount, carry, zen, add, n, nq] = c;
    const g = Object.create(ctx.PuyoGame.prototype);
    Object.assign(g, {
        isVersusMode: true, opponentRule: 'tet', vsOjamaRate: rate, vsAttackMultiplier: 1.0, vsMarginMultiplier: 1.0,
        chainCount, tetAttackCarry: carry, hasTetZenkeshi: !!zen, tetDropScore: 0, _tetCalcAdd: add, _tetCalcN: n,
        tetPendingFire: 0, tetAttackLines: 0, pendingFire: 0, updateGarbageGauge() {},
        garbageQueue: [],
    });
    for (let i = 0; i < nq; i++) g.garbageQueue.push({ amount: c[7 + i * 2], ready: !!c[8 + i * 2], holes: [] });
    g._resolveTetAttack();
    let sum = 0, r = 0, u = 0;
    for (const q of g.garbageQueue) { sum += q.amount; if (q.ready) r += q.amount; else u += q.amount; }
    out.push([g.tetPendingFire, g.tetAttackCarry, g.hasTetZenkeshi ? 1 : 0, sum, r, u]);
}
process.stdout.write(JSON.stringify(out));
