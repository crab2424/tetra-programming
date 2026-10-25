// クイズエディタ SEARCH（段階 S1〜S5）の確認と計測。
//   node --experimental-strip-types --no-warnings scripts/quiz-search-check.ts [問題ID ...]
//   環境変数: LIMIT_MS（1 問の打ち切り。既定 20000）、HEAD_DIR（tet-sim/puyo-sim の変更前のコピー。あれば変更前後の simulate を突き合わせる）
// 1. 置き場所の列挙・固定・連鎖を、エディタのシミュレーター（tet-sim / puyo-sim）で同じことをした結果と突き合わせる（乱数盤面）
// 2. 既存の全問題を探索し、取り出した解をすべて simulate で検算する。試作（solver-proto）で数え終わった問題は数も比べる
// 3. 置き場所の列挙 1 回の速さ
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { docFromLevel, type EditorDoc, type Pair } from '../quiz-editor/model.ts';
import * as T from '../quiz-editor/tet-sim.ts';
import * as P from '../quiz-editor/puyo-sim.ts';
import * as ST from '../quiz-editor/search-tet.ts';
import * as SP from '../quiz-editor/search-puyo.ts';
import { modeOptions, searchDoc, SOLUTION_CAP, verifySolutions } from '../quiz-editor/search.ts';
import { exactOf } from '../quiz-editor/search-ui.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIMIT_MS = Number(process.env.LIMIT_MS ?? 20000);
const only = process.argv.slice(2);
let failures = 0;
const fail = (msg: string) => { failures++; console.log('  ✗ ' + msg); };

// ─── 乱数 ───
// mulberry32（下位ビットの偏りが無い）
let seed = 20261022;
const rnd = (n: number) => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
};

// ─── 参照実装: tet-sim / puyo-sim の関数だけで同じ BFS をする（遅いが素直） ───
function refTetPlacements(g: T.Grid, type: number): Set<string> {
    const out = new Set<string>();
    const s = T.spawn(g, type);
    if (!s) return out;
    const seen = new Set<string>();
    const q: { p: T.Piece; lastRot: boolean; kick5: boolean }[] = [{ p: s, lastRot: false, kick5: false }];
    const k = (n: typeof q[0]) => `${n.p.x},${n.p.y},${n.p.rot},${n.lastRot},${n.kick5}`;
    seen.add(k(q[0]));
    while (q.length) {
        const n = q.pop()!;
        const next: typeof q = [];
        for (const dx of [-1, 1]) { const m = T.moved(g, n.p, dx, 0); if (m) next.push({ p: m, lastRot: false, kick5: false }); }
        const d = T.moved(g, n.p, 0, 1); if (d) next.push({ p: d, lastRot: false, kick5: false });
        for (const dir of [1, -1] as const) { const r = T.rotated(g, n.p, dir); if (r) next.push({ p: r.piece, lastRot: true, kick5: r.kick5 }); }
        for (const m of next) { const kk = k(m); if (!seen.has(kk)) { seen.add(kk); q.push(m); } }
        if (T.isGrounded(g, n.p)) {
            const spin = T.checkTSpin(g, n.p, n.lastRot, n.kick5);
            out.add(T.cellsOf(n.p).map(([x, y]) => y * 16 + x).sort((a, b) => a - b).join(',') + '|' + spin);
        }
    }
    return out;
}

function refPuyoPlacements(g: P.Grid, pair: Pair): Map<string, P.PuyoStep> {
    const out = new Map<string, P.PuyoStep>();
    const seen = new Set<string>();
    const q = [P.spawnPos()];
    const k = (p: P.PairPos) => `${p.x},${p.y},${p.rot},${Math.min(p.qt, 2)}`;
    seen.add(k(q[0]));
    while (q.length) {
        const p = q.pop()!;
        const next: P.PairPos[] = [];
        for (const dx of [-1, 1]) { const m = P.movedPos(g, p, dx); if (m) next.push(m); }
        const d = P.softDropped(g, p); if (d) next.push(d);
        for (const dir of [1, -1] as const) next.push(P.rotatedPos(g, p, dir).pos);
        for (const m of next) { const kk = k(m); if (m.y >= -7 && !seen.has(kk)) { seen.add(kk); q.push(m); } }
        const l = P.landedPos(g, p);
        if (!P.validLanding(g, { x: l.x, y: l.y, rot: l.rot })) continue;   // エディタが手として受け付けない着地は除く
        const g2 = P.cloneGrid(g);
        P.fixPair(g2, { ...l, qt: 0 }, pair);
        const key = g2.map(r => r.join('')).join('/');
        if (!out.has(key)) out.set(key, { x: l.x, y: l.y, rot: l.rot });
    }
    return out;
}

const boardKey = (b: Uint8Array) => Array.from({ length: 17 }, (_, r) => Array.from(b.subarray(r * 6, r * 6 + 6)).join('')).join('/');

// ─── 乱数盤面 ───
function randomTetField(): number[][] {
    const f = Array.from({ length: 20 }, () => new Array(10).fill(0));
    const h = rnd(14);
    for (let r = 20 - h; r < 20; r++) {
        for (let x = 0; x < 10; x++) if (rnd(4)) f[r][x] = 8;
        f[r][rnd(10)] = 0;
        if (rnd(3) === 0) f[r][rnd(10)] = 0;
    }
    // T-Spin の形が出やすいよう、ときどき上に庇を足す
    for (let i = rnd(4); i > 0; i--) { const r = 20 - h - 1 + rnd(3); if (r >= 0 && r < 20) f[r][rnd(10)] = 8; }
    return f;
}
function randomPuyoField(): number[][] {
    const f = Array.from({ length: 17 }, () => new Array(6).fill(0));
    for (let c = 0; c < 6; c++) {
        const h = rnd(c === 2 ? 11 : 15);
        for (let r = 16; r > 16 - h; r--) f[r][c] = rnd(9) === 0 ? 6 : 1 + rnd(4);
        if (rnd(6) === 0 && h < 12) f[16 - h - 1 - rnd(3)][c] = 1 + rnd(4);   // 浮いたぷよ（初期盤面にはあり得る）
    }
    return f;
}

// ─── 1. 突き合わせ ───
console.log('[1] 置き場所・固定・連鎖の突き合わせ（乱数盤面）');
{
    let n = 0, bad = 0;
    for (let i = 0; i < 1500; i++) {
        const field = randomTetField();
        const g = T.gridFromField(field), b = ST.boardFromField(field);
        for (let type = 0; type < 7; type++) {
            const ref = refTetPlacements(g, type);
            const mine = ST.tetPlacements(b, type);
            const got = new Set(mine.map(p => T.cellsOf(p).map(([x, y]) => y * 16 + x).sort((a, c) => a - c).join(',') + '|' + p.spin));
            n++;
            if (got.size !== mine.length || got.size !== ref.size || [...ref].some(k => !got.has(k))) {
                if (bad++ < 3) fail(`tet 置き場所が違う type=${type} ref=${ref.size} mine=${mine.length}`);
                continue;
            }
            // 固定・消去
            for (const p of mine) {
                const g2 = T.cloneGrid(g);
                const lines = T.lockPiece(g2, p);
                const r = ST.lockOn(b, p);
                const same = r.lines === lines && g2.every((row, ri) => row.every((v, x) => (v !== 0) === (((r.board[ri] >> x) & 1) === 1)));
                if (!same) { if (bad++ < 3) fail(`tet 固定の結果が違う type=${type}`); break; }
            }
        }
    }
    console.log(`  tet: ${n} 回（盤面×ミノ）${bad ? `・不一致 ${bad}` : '一致'}`);

    n = 0; bad = 0;
    // 後半 1000 枚は床から隙間なく積んだ低い盤面（着地の「宙の近道」を通る。段階 S5）。乱数は別の列（前半の盤面を変えないため）
    let s2 = 7, nHint = 0;
    const rnd2 = (k: number) => { s2 = (Math.imul(s2, 1103515245) + 12345) >>> 0; return ((s2 >>> 8) % k); };
    for (let i = 0; i < 4000; i++) {
        const field = i < 3000 ? randomPuyoField() : Array.from({ length: 17 }, () => new Array(6).fill(0));
        if (i >= 3000) for (let c = 0; c < 6; c++) { const h = rnd2(11); for (let r = 16; r > 16 - h; r--) field[r][c] = rnd2(9) === 0 ? 6 : 1 + rnd2(4); }
        const g = P.gridFromField(field), b = SP.boardFromField(field);
        const stable = SP.resolveChains(b.slice()).chain === 0;
        const pair: Pair = i < 3000 ? [1 + rnd(4), 1 + rnd(4)] : [1 + rnd2(4), 1 + rnd2(4)];
        const ref = refPuyoPlacements(g, pair);
        const mine = SP.puyoPlacements(b, pair);
        n++;
        const got = new Map(mine.map(p => [boardKey(p.board), p]));
        if (got.size !== mine.length || got.size !== ref.size || [...ref.keys()].some(k => !got.has(k))) {
            if (bad++ < 3) fail(`puyo 着地が違う ref=${ref.size} mine=${mine.length}`);
            continue;
        }
        for (const p of mine) {
            if (!P.validLanding(g, p.step)) { if (bad++ < 3) fail('puyo 記録する手が validLanding で通らない'); break; }
            // 連鎖
            const g2 = P.gridFromField(field);
            P.fixPair(g2, { ...p.step, qt: 0 }, pair);
            const rc = P.resolveChains(g2);
            const b2 = p.board.slice();
            const mc = SP.resolveChains(b2);
            // 置く前の盤面が安定していれば、置いた 2 個からの判定（段階 S5）でも同じ結果
            if (stable) {
                const b3 = p.board.slice();
                const hc = SP.resolveChains(b3, p.placed);
                nHint++;
                if (hc.chain !== mc.chain || hc.score !== mc.score || boardKey(b3) !== boardKey(b2)) { if (bad++ < 3) fail('puyo 置いた 2 個からの連鎖判定が全体の判定と違う'); break; }
            }
            const refScore = rc.links.reduce((a, l) => a + l.score, 0);
            if (mc.chain !== rc.links.length || mc.score !== refScore || boardKey(b2) !== g2.map(r => r.join('')).join('/')) {
                if (bad++ < 3) fail(`puyo 連鎖の結果が違う ref=${rc.links.length}連鎖 ${refScore} mine=${mc.chain}連鎖 ${mc.score}`);
                break;
            }
        }
    }
    console.log(`  puyo: ${n} 回（盤面×ペア）${bad ? `・不一致 ${bad}` : '一致'}（置いた 2 個からの連鎖判定 ${nHint} 回）`);
}

// 変更前の simulate との突き合わせ（scoreLock / advancePuyo へ切り出した分）
if (process.env.HEAD_DIR) {
    const HT = await import(process.env.HEAD_DIR + '/tet-sim.ts');
    const HP = await import(process.env.HEAD_DIR + '/puyo-sim.ts');
    const conds = [
        { type: 'clearLines', value: 3 }, { type: 'allClear', value: 0 }, { type: 'score', value: 900 }, { type: 'ren', value: 2 },
        { type: 'tspin', value: 1 }, { type: 'tspinDouble', value: 0 }, { type: 'count', value: 2, countCondition: 'clearLines', countValue: 1 },
        { type: 'count', value: 2, countCondition: 'tspin', countValue: 1 }, { type: 'count', value: 1, countCondition: 'score', countValue: 500 },
    ];
    let n = 0, bad = 0;
    for (let i = 0; i < 400; i++) {
        const field = randomTetField();
        const doc = { rule: 'tet', field, next: Array.from({ length: 8 }, () => rnd(7)), allowHold: rnd(2) === 1, cond: { countCondition: 'clearLines', countValue: 1, ...conds[rnd(conds.length)] } } as unknown as EditorDoc;
        // 適当な手順（置ける所からランダムに選ぶ。HOLD もときどき）
        const steps: T.Step[] = [];
        let b = ST.boardFromField(field), idx = 0, hold = -1;
        for (let k = 0; k < 8 && idx < doc.next.length; k++) {
            const useHold = doc.allowHold && rnd(3) === 0 && (hold >= 0 || idx + 1 < doc.next.length);
            const type = useHold ? (hold >= 0 ? hold : doc.next[idx + 1]) : doc.next[idx];
            const ps = ST.tetPlacements(b, type);
            if (!ps.length) break;
            const p = ps[rnd(ps.length)];
            steps.push({ piece: type, rot: p.rot, x: p.x, y: p.y, hold: useHold, ...(p.flag ? { lastRot: true } : {}), ...(p.flag === 2 ? { kick5: true } : {}) });
            b = ST.lockOn(b, p).board;
            if (useHold) { if (hold >= 0) { hold = doc.next[idx]; idx++; } else { hold = doc.next[idx]; idx += 2; } } else idx++;
        }
        n++;
        if (JSON.stringify(HT.simulate(doc, steps)) !== JSON.stringify(T.simulate(doc, steps))) { if (bad++ < 3) fail('tet simulate が変更前と違う'); }
    }
    const pconds = [{ type: 'chain', value: 2 }, { type: 'allClear', value: 0 }, { type: 'score', value: 400 },
        { type: 'count', value: 2, countCondition: 'chain', countValue: 1 }, { type: 'count', value: 1, countCondition: 'allClear', countValue: 1 }];
    for (let i = 0; i < 600; i++) {
        const field = randomPuyoField();
        const pairs: Pair[] = Array.from({ length: 6 }, () => [1 + rnd(4), 1 + rnd(4)] as Pair);
        const doc = { rule: 'puyo', field, pairs, cond: { countCondition: 'chain', countValue: 1, ...pconds[rnd(pconds.length)] } } as unknown as EditorDoc;
        const steps: P.PuyoStep[] = [];
        let b = SP.boardFromField(field);
        for (let k = 0; k < 6; k++) {
            const ps = SP.puyoPlacements(b, pairs[k]);
            const p = ps[rnd(ps.length)];
            steps.push(p.step);
            b = p.board.slice(); SP.resolveChains(b);
        }
        n++;
        if (JSON.stringify(HP.simulatePuyo(doc, steps)) !== JSON.stringify(P.simulatePuyo(doc, steps))) { if (bad++ < 3) fail('puyo simulatePuyo が変更前と違う'); }
    }
    console.log(`  simulate の変更前後: ${n} 手順 ${bad ? `・不一致 ${bad}` : '一致'}`);
}

// ─── 1b. 枝刈りの健全性: 小さな乱数問題を枝刈りあり/なしで数え、同じ数になること ───
console.log('\n[1b] 枝刈りあり/なしの数の一致（乱数の小問題）');
{
    const tetConds = [
        { type: 'clearLines', value: 2 }, { type: 'clearLines', value: 3 }, { type: 'allClear', value: 0 }, { type: 'score', value: 300 },
        { type: 'score', value: 900 }, { type: 'ren', value: 1 }, { type: 'ren', value: 2 }, { type: 'tspin', value: 1 },
        { type: 'tspinSingle', value: 0 }, { type: 'tspinDouble', value: 0 },
        { type: 'count', value: 2, countCondition: 'clearLines', countValue: 1 }, { type: 'count', value: 1, countCondition: 'clearLines', countValue: 2 },
        { type: 'count', value: 1, countCondition: 'allClear', countValue: 1 }, { type: 'count', value: 2, countCondition: 'score', countValue: 200 },
        { type: 'count', value: 1, countCondition: 'ren', countValue: 1 }, { type: 'count', value: 1, countCondition: 'tspin', countValue: 1 },
    ];
    const puyoConds = [
        { type: 'chain', value: 1 }, { type: 'chain', value: 2 }, { type: 'chain', value: 3 }, { type: 'allClear', value: 0 },
        { type: 'score', value: 300 }, { type: 'score', value: 1500 },
        { type: 'count', value: 2, countCondition: 'chain', countValue: 1 }, { type: 'count', value: 1, countCondition: 'chain', countValue: 2 },
        { type: 'count', value: 1, countCondition: 'allClear', countValue: 1 }, { type: 'count', value: 2, countCondition: 'score', countValue: 100 },
    ];
    const stat = new Map<string, { n: number; pos: number }>();
    let bad = 0, n = 0;
    const cmp = (doc: EditorDoc, label: string) => {
        const a = searchDoc(doc, { timeLimitMs: 60000, maxSolutions: 0, prune: false });
        const b = searchDoc(doc, { timeLimitMs: 60000, maxSolutions: 0 });
        n++;
        const st = stat.get(label) ?? { n: 0, pos: 0 };
        st.n++; if (a.count > 0) st.pos++;
        stat.set(label, st);
        if (!a.complete || !b.complete || a.count !== b.count) { if (bad++ < 5) fail(`${label}: 枝刈りなし ${a.complete ? '' : '≥'}${a.count} / あり ${b.complete ? '' : '≥'}${b.count}`); }
    };
    for (let i = 0; i < 600; i++) {
        const f = Array.from({ length: 20 }, () => new Array(10).fill(0));
        let next: number[];
        if (rnd(2)) {
            // PC を作れる盤面: 下 L 段を埋め、そこからミノ k 個の形をくり抜く（NEXT はくり抜いたミノ＋ときどき余分に 1 個）
            const L = 2 + rnd(3), cut: number[] = [];
            for (let r = 20 - L; r < 20; r++) f[r].fill(8);
            for (let tries = 0; tries < 200 && cut.length < 2 + rnd(2); tries++) {
                const p = { type: rnd(7), rot: rnd(4), x: rnd(10) - 1, y: 20 - L - 1 + rnd(L + 1) };
                const cells = T.cellsOf(p);
                if (cells.every(([x, y]) => x >= 0 && x < 10 && y >= 20 - L && y < 20 && f[y][x] === 8)) { cells.forEach(([x, y]) => { f[y][x] = 0; }); cut.push(p.type); }
            }
            next = cut.sort(() => rnd(2) - 0.5);
            if (rnd(2)) next.push(rnd(7));
        } else {
            // 下 1〜4 段がほぼ埋まった盤面（消去・T-Spin が起きやすい）
            const h = 1 + rnd(4);
            for (let r = 20 - h; r < 20; r++) { f[r].fill(8); for (let k = 1 + rnd(4); k > 0; k--) f[r][rnd(10)] = 0; }
            if (rnd(2)) { const r = 20 - h - 1; f[r][rnd(10)] = 8; f[r][rnd(10)] = 8; }
            next = Array.from({ length: 3 }, () => rnd(4) === 0 ? 2 : rnd(7));
        }
        const cond = { countCondition: 'clearLines', countValue: 1, ...tetConds[rnd(tetConds.length)] };
        const allowHold = rnd(3) === 0;
        const doc = { rule: 'tet', field: f, next, allowHold, cond } as unknown as EditorDoc;
        cmp(doc, `tet ${cond.type === 'count' ? 'count:' + cond.countCondition : cond.type}`);
    }
    for (let i = 0; i < 300; i++) {
        const f = Array.from({ length: 17 }, () => new Array(6).fill(0));
        // 色を 2〜3 色に絞って低めに積む（連鎖・全消しが起きやすい）
        const nc = 2 + rnd(2);
        for (let c = 0; c < 6; c++) { const h = rnd(7); for (let r = 16; r > 16 - h; r--) f[r][c] = rnd(14) === 0 ? 6 : 1 + rnd(nc); }
        const cond = { countCondition: 'chain', countValue: 1, ...puyoConds[rnd(puyoConds.length)] };
        const doc = { rule: 'puyo', field: f, pairs: Array.from({ length: 3 }, () => [1 + rnd(nc), 1 + rnd(nc)] as Pair), cond } as unknown as EditorDoc;
        cmp(doc, `puyo ${cond.type === 'count' ? 'count:' + cond.countCondition : cond.type}`);
    }
    // T-Spin の段の予算（段階 S5・設計 §14）が効く問題: 下 H 段を埋めて T 字の穴（屋根つき）と他のミノの形をくり抜く。
    // NEXT はくり抜いたミノ＋T（順番はばらばら・ときどき余分）。T-Spin で消す段数のある条件だけ
    const spinConds = [
        { type: 'tspinDouble', value: 0 }, { type: 'tspinSingle', value: 0 }, { type: 'tspinTriple', value: 0 }, { type: 'tspin', value: 1 },
        { type: 'tspin', value: 2 }, { type: 'count', value: 1, countCondition: 'tspinDouble', countValue: 1 },
        { type: 'count', value: 2, countCondition: 'tspinDouble', countValue: 1 }, { type: 'count', value: 2, countCondition: 'tspinSingle', countValue: 1 },
        { type: 'count', value: 2, countCondition: 'tspin', countValue: 1 },
    ];
    for (let i = 0; i < 300; i++) {
        const f = Array.from({ length: 20 }, () => new Array(10).fill(0));
        const H = 2 + rnd(3);
        for (let r = 20 - H; r < 20; r++) f[r].fill(8);
        const next: number[] = [];
        const cut = (p: T.Piece) => {
            const cells = T.cellsOf(p);
            if (!cells.every(([x, y]) => x >= 0 && x < 10 && y >= 20 - H && y < 20 && f[y][x] === 8)) return false;
            cells.forEach(([x, y]) => { f[y][x] = 0; });
            next.push(p.type);
            return true;
        };
        // T 字の穴（下向き＝rot 2 か 横向き）1〜2 個。上の段に屋根（ときどき無し）
        for (let k = 1 + rnd(2), tries = 0; k > 0 && tries < 50; tries++) {
            const p = { type: 2, rot: [2, 2, 1, 3][rnd(4)], x: rnd(9) - 1, y: 20 - H - 1 + rnd(H) };
            // 半分は一番上の段に揃える（上が開いていて回して入れられる＝解のある問題が増える）
            if (rnd(2)) p.y += 20 - H - Math.min(...T.cellsOf(p).map(([, y]) => y));
            if (!cut(p)) continue;
            k--;
            const [cx, cy] = T.cellsOf(p).reduce(([ax, ay], [x, y]) => [Math.min(ax, x), Math.min(ay, y)]);
            if (rnd(4) && cy > 0) f[cy - 1][Math.min(9, cx + (rnd(2) ? 0 : 2))] = 8;
        }
        for (let k = rnd(3), tries = 0; k > 0 && tries < 100; tries++) if (cut({ type: rnd(7), rot: rnd(4), x: rnd(10) - 1, y: 20 - H - 1 + rnd(H + 1) })) k--;
        // 消せない段を少し混ぜる（予算が足りなくなる盤面）
        if (rnd(3) === 0) f[20 - H + rnd(H)][rnd(10)] = 0;
        if (rnd(2)) next.push(rnd(7));
        if (rnd(3) === 0) next.push(2);
        next.sort(() => rnd(2) - 0.5);
        if (next.length > (rnd(6) ? 3 : 4)) next.length = 3;
        const cond = { countCondition: 'clearLines', countValue: 1, ...spinConds[rnd(spinConds.length)] };
        const doc = { rule: 'tet', field: f, next, allowHold: rnd(4) === 0, cond } as unknown as EditorDoc;
        cmp(doc, `tet(T) ${cond.type === 'count' ? 'count:' + cond.countCondition : cond.type}`);
    }
    // ぷよの得点の上限（段階 S5・設計 §14）が効く問題: 2〜3 色の低い盤面に 3〜4 ペア、目標は届くか届かないかの境目あたり
    const scoreTargets = [40, 200, 360, 700, 1000, 1500, 2500, 3500];
    for (let i = 0; i < 150; i++) {
        const f = Array.from({ length: 17 }, () => new Array(6).fill(0));
        const nc = 2 + rnd(2);
        for (let c = 0; c < 6; c++) { const h = rnd(6); for (let r = 16; r > 16 - h; r--) f[r][c] = rnd(16) === 0 ? 6 : 1 + rnd(nc); }
        const t = scoreTargets[rnd(scoreTargets.length)];
        const cond = rnd(3) ? { type: 'score', value: t, countCondition: 'chain', countValue: 1 } : { type: 'count', value: 1 + rnd(2), countCondition: 'score', countValue: t };
        const pairs = Array.from({ length: rnd(3) ? 3 : 4 }, () => [1 + rnd(nc), 1 + rnd(nc)] as Pair);
        cmp({ rule: 'puyo', field: f, pairs, cond } as unknown as EditorDoc, `puyo(得点) ${cond.type === 'count' ? 'count:score' : 'score'}`);
    }
    console.log(`  ${n} 問 ${bad ? `・不一致 ${bad}` : '一致'}（条件ごとの 問数/解あり: ${[...stat].map(([k, v]) => `${k} ${v.n}/${v.pos}`).join('・')}）`);
}

// ─── 2. 既存の全問題 ───
// 試作（solver-proto/solve.ts・2026-10-22）と段階 S1 で数え終わった問題の解の数（枝刈りを入れても同じになるはず）
const EXPECTED: Record<string, number> = {
    'tet-1': 1, 'tet-2': 1, 'tet-5': 1, 'tet-6': 1, 'tet-9': 1, 'tet-12': 6, 'tet-1.2': 1, 'tet-1.3': 13,
    'tet-1.5': 26, 'tet-1.6': 1, 'tet-1.7': 2, 'tet-2.4': 1,
    'puyo-1': 6, 'puyo-2': 3, 'puyo-3': 8, 'puyo-4': 2, 'puyo-10': 1, 'puyo-9': 1, 'puyo-6': 2, 'puyo-1.1': 1,
    'puyo-1.2': 1, 'puyo-1.3': 1, 'puyo-1.4': 1, 'puyo-1.5': 1, 'puyo-1.6': 1, 'puyo-1.7': 1, 'puyo-21': 6,
    // 段階 S1（枝刈りなし）で数え終わった問題
    'tet-7': 4230, 'tet-1.1': 3, 'puyo-7': 4, 'puyo-8': 3, 'puyo-1.8': 4, 'puyo-1.9': 1, 'puyo-2.0': 4,
    // 段階 S2 で数え終わった問題
    'tet-1.8': 7, 'tet-10': 2, 'tet-11': 268976, 'puyo-22': 14,
    // 段階 S5（設計 §14）で数え終わった問題。tet-1.4・puyo-5 は S2 のコード（新しい枝刈りなし・打ち切り 120 秒）でも同じ数
    'tet-1.4': 18, 'puyo-5': 1920, 'tet-8': 18, 'tet-2.0': 2, 'tet-1.9': 1, 'tet-2.1': 1, 'tet-23': 4,
};
console.log(`\n[2] 既存の問題（打ち切り ${LIMIT_MS / 1000} s）`);
console.log('  ID        N  H 条件         解の数        展開      メモ    b     探索ms  配置/s   検算');
let done = 0, total = 0, totalPlacements = 0, totalMs = 0;
const unconfirmed: string[] = [];
const docs: EditorDoc[] = [];
for (const f of ['tdata', 'pdata']) {
    const levels = JSON.parse(readFileSync(`${ROOT}public/assets/quizlevels/${f}.json`, 'utf8')) as Record<string, unknown>[];
    for (const lv of levels) {
        const doc = docFromLevel(lv);
        if (only.length && !only.includes(doc.id)) continue;
        total++;
        docs.push(doc);
        const r = searchDoc(doc, { timeLimitMs: LIMIT_MS, maxSolutions: 20000 });
        const bad = verifySolutions(doc, r.solutions);
        const uniq = new Set(r.solutions.map(s => JSON.stringify(s))).size;
        if (bad.length) fail(`${doc.id}: 検算で ${bad.length} 件が正しくない`);
        if (uniq !== r.solutions.length) fail(`${doc.id}: 同じ解が重複している`);
        if (r.complete && r.count <= 20000 && r.solutions.length !== r.count) fail(`${doc.id}: 取り出した解 ${r.solutions.length} ≠ 数 ${r.count}`);
        const exp = EXPECTED[doc.id];
        // 打ち切りは矛盾ではない（試作は枝刈りありで数え終わった。枝刈りは段階 S2）。数え終わったのに違う・下限が超えた時だけ不一致
        if (exp !== undefined && (r.complete ? r.count !== exp : r.count > exp)) fail(`${doc.id}: 既知の数は ${exp} 通り、今回 ${r.complete ? '' : '≥'}${r.count}`);
        if (exp !== undefined && !r.complete) unconfirmed.push(doc.id);
        if (r.complete) done++;
        totalPlacements += r.placements; totalMs += r.searchMs;
        const n = doc.rule === 'tet' ? doc.next.length : doc.pairs.length;
        const cond = doc.cond.type === 'count' ? `count:${doc.cond.countCondition}` : doc.cond.type;
        console.log(`  ${doc.id.padEnd(9)} ${String(n).padStart(2)} ${doc.allowHold ? '○' : '-'} ${cond.padEnd(12)} ${((r.complete ? '' : '≥') + r.count.toLocaleString()).padStart(12)} ${r.nodes.toLocaleString().padStart(10)} ${r.memoSize.toLocaleString().padStart(9)} ${(r.placementCalls ? r.placements / r.placementCalls : 0).toFixed(1).padStart(5)} ${Math.round(r.searchMs).toString().padStart(8)} ${(r.searchMs > 0 ? r.placements / r.searchMs / 1000 : 0).toFixed(2).padStart(6)}M ${r.solutions.length - bad.length}/${r.solutions.length}${r.timedOut ? ' 打ち切り' : ''}`);
    }
}
console.log(`  数え終わった問題 ${done}/${total}・平均 ${(totalPlacements / totalMs / 1000).toFixed(2)}M 配置/s`);
if (unconfirmed.length) console.log(`  既知の数と未照合（打ち切り）: ${unconfirmed.join(' ')}`);

// UNIQUE（2 つ目の解で止める）の速さ
if (!process.env.SKIP_UNIQUE) {
    console.log(`\n[2b] UNIQUE（解が 2 つ見つかったら止める・打ち切り ${LIMIT_MS / 1000} s）`);
    const line: string[] = [];
    for (const doc of docs) {
        const r = searchDoc(doc, { timeLimitMs: LIMIT_MS, maxSolutions: 2, stopAt: 2 });
        if (verifySolutions(doc, r.solutions).length) fail(`${doc.id}: UNIQUE の解が検算で通らない`);
        const verdict = r.stopped ? '別解あり' : r.complete ? (r.count === 1 ? '1つだけ' : '解なし') : '打ち切り';
        line.push(`${doc.id} ${verdict} ${Math.round(r.searchMs)}ms`);
    }
    for (let i = 0; i < line.length; i += 4) console.log('  ' + line.slice(i, i + 4).map(t => t.padEnd(26)).join(''));
}

// ─── 2c. COUNT の上限と、止めた後の解の取り出し（段階 S3） ───
console.log(`\n[2c] COUNT の上限 ${SOLUTION_CAP}・打ち切り後の解の取り出し`);
for (const [id, limit] of [['tet-11', LIMIT_MS], ['tet-7', LIMIT_MS], ['puyo-5', 3000], ['tet-1.4', 3000]] as [string, number][]) {
    const doc = docs.find(d => d.id === id);
    if (!doc) continue;
    const r = searchDoc(doc, modeOptions('count', limit));
    const bad = verifySolutions(doc, r.solutions).length;
    const uniq = new Set(r.solutions.map(x => JSON.stringify(x))).size;
    if (bad) fail(`${id}: 検算に通らない解 ${bad}`);
    if (uniq !== r.solutions.length) fail(`${id}: 同じ解が重複`);
    // 止めた時も、数えた解はほぼ全部取り出せる（途中で止めた状態にも入るため）
    if (!r.complete && r.solutions.length < Math.min(r.count, SOLUTION_CAP)) fail(`${id}: 数えた ${r.count} 件のうち ${r.solutions.length} 件しか取り出せない`);
    console.log(`  ${id.padEnd(8)} ${r.complete ? '全探索' : r.stopped ? '上限で停止' : '打ち切り'} 数 ${r.count.toLocaleString()}・取り出し ${r.solutions.length}・検算 OK ${r.solutions.length - bad}・${Math.round(r.totalMs)} ms`);
}

// ─── 2d. 保存済みの解との比較（段階 S4）: 見つけた解ごとに鍵が違い、同じマスに置く別の書き方（向きの番号違い）でも同じ鍵になる ───
console.log('\n[2d] 保存済みの解との比較の鍵');
{
    let n = 0, re = 0;
    for (const doc of docs) {
        const r = searchDoc(doc, modeOptions('count', 3000));
        const keys = r.solutions.map(s => exactOf(doc, s));
        if (keys.some(k => k === null)) fail(`${doc.id}: 鍵を作れない解がある`);
        if (new Set(keys).size !== keys.length) fail(`${doc.id}: 違う解が同じ鍵になる`);
        n += keys.length;
        if (doc.rule !== 'tet') continue;
        // 同じマスになる別の (rot, x, y) に書き換えた手順（SOLVE で記録した手と同じ形になり得る）
        for (const sol of r.solutions.slice(0, 50)) {
            const alt = (sol as T.Step[]).map(st => {
                const want = T.cellsOf({ type: st.piece, rot: st.rot, x: st.x, y: st.y }).map(([x, y]) => y * 16 + x).sort((a, b) => a - b).join();
                for (let rot = 0; rot < 4; rot++) {
                    if (rot === st.rot) continue;
                    for (let x = -3; x < 10; x++) for (let y = -8; y < 20; y++) {
                        const c = T.cellsOf({ type: st.piece, rot, x, y }).map(([cx, cy]) => cy * 16 + cx).sort((a, b) => a - b).join();
                        if (c === want) return { ...st, rot, x, y };
                    }
                }
                return st;
            });
            if (JSON.stringify(alt) === JSON.stringify(sol)) continue;
            re++;
            if (exactOf(doc, alt) !== exactOf(doc, sol)) fail(`${doc.id}: 向きの番号だけ違う同じ解が別の鍵になる`);
        }
    }
    console.log(`  解 ${n} 件の鍵が全部別・書き換えた同じ解 ${re} 件が同じ鍵`);
}

// ─── 2e. 並列の受け持ち（split・段階 S5）: 受け持ちごとの数の和と解の和集合が、分けない時と同じ ───
console.log('\n[2e] 並列の受け持ち（split）の和');
{
    let n = 0;
    for (const doc of docs) {
        const whole = searchDoc(doc, { timeLimitMs: 3000, maxSolutions: 20000 });
        if (!whole.complete || whole.count > 20000) continue;
        for (const parts of [2, 3, 5]) {
            let sum = 0;
            const sols: string[] = [];
            for (let part = 0; part < parts; part++) {
                const r = searchDoc(doc, { timeLimitMs: 20000, maxSolutions: 20000, split: { part, parts } });
                if (!r.complete) fail(`${doc.id}: split ${part}/${parts} が打ち切り`);
                if (verifySolutions(doc, r.solutions).length) fail(`${doc.id}: split ${part}/${parts} の解が検算で通らない`);
                sum += r.count;
                sols.push(...r.solutions.map(x => JSON.stringify(x)));
            }
            const want = new Set(whole.solutions.map(x => JSON.stringify(x)));
            if (sum !== whole.count) fail(`${doc.id}: split ${parts} の和 ${sum} ≠ ${whole.count}`);
            else if (sols.length !== want.size || sols.some(x => !want.has(x))) fail(`${doc.id}: split ${parts} の解が分けない時と違う`);
        }
        n++;
    }
    console.log(`  ${n} 問 × 受け持ち 2・3・5 で和が一致`);
}

// ─── 3. 置き場所の列挙の速さ（solver-proto/bench-ts.ts と同じ盤面） ───
console.log('\n[3] 置き場所の列挙 1 回');
{
    const field = Array.from({ length: 20 }, () => new Array(10).fill(0));
    let s = 12345;
    for (let r = 14; r < 20; r++) { for (let x = 0; x < 10; x++) { s = (s * 1103515245 + 12345) >>> 0; if (((s >>> 16) % 3) !== 0) field[r][x] = 8; } field[r][(r * 3) % 10] = 0; }
    const b = ST.boardFromField(field);
    const N = 200000;
    let tot = 0, t0 = performance.now();
    for (let i = 0; i < N; i++) tot += ST.tetPlacements(b, i % 7).length;
    let ms = performance.now() - t0;
    console.log(`  tet : ${(ms * 1000 / N).toFixed(1)} µs/回（平均 ${(tot / N).toFixed(1)} 配置）`);
    const pf = Array.from({ length: 17 }, (_, r) => r >= 11 ? [1, 2, 3, 4, 1, 2].map((v, i) => (r + i) % 3 ? v : 0) : new Array(6).fill(0));
    const pb = SP.boardFromField(pf);
    tot = 0; t0 = performance.now();
    for (let i = 0; i < N; i++) tot += SP.puyoPlacements(pb, [1, 2]).length;
    ms = performance.now() - t0;
    console.log(`  puyo: ${(ms * 1000 / N).toFixed(1)} µs/回（平均 ${(tot / N).toFixed(1)} 着地）`);
    t0 = performance.now();
    for (let i = 0; i < N; i++) SP.resolveChains(pb.slice());
    ms = performance.now() - t0;
    console.log(`  puyo 連鎖の判定: ${(ms * 1000 / N).toFixed(2)} µs/回`);
}

console.log(failures ? `\n✗ ${failures} 件の不一致` : '\n✓ すべて一致');
process.exit(failures ? 1 : 0);
