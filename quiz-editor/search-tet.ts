// ─────────────────────────────────────────────
// search-tet.ts
// テトの解の探索（SEARCH 段階 S1）: ビットボード盤面・STRICT 相当の配置列挙（BFS）・メモ化 DFS で解の数を数える
// ルール（形状・キック・T-Spin の判定表・得点・クリア条件）は tet-sim.ts から借りる。盤面の扱いだけここで持つ。
// 見つけた解は search.ts の verifySolutions で simulate() に通して検算する。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-solver.md
// ─────────────────────────────────────────────
import type { EditorDoc } from './model.ts';
import { classifyTSpin, kickTable, scoreLock, shapeOf, SIM_TOP, type Step, type TetProgress } from './tet-sim.ts';
import type { SearchOptions, SearchResult } from './search.ts';

const COLS = 10;
const VISIBLE = 20;
const ROWS = VISIBLE + SIM_TOP;   // 25。行 r = y + SIM_TOP（tet-sim の Grid と同じ並び）
const FULL = (1 << COLS) - 1;

/** 盤面: 1 行 10 bit（bit x = 列 x） */
export type Board = Uint16Array;

// ─── 形状（(type, rot) ごとに行マスクを前計算） ───
interface Shape { dy: number[]; mask: number[]; minX: number; maxX: number; }
const SHAPES: Shape[][] = Array.from({ length: 7 }, (_, type) => Array.from({ length: 4 }, (_, rot) => {
    const rows = new Map<number, number>();
    let minX = 9, maxX = 0;
    for (const [bx, by] of shapeOf(type, rot)) {
        rows.set(by, (rows.get(by) ?? 0) | (1 << bx));
        minX = Math.min(minX, bx); maxX = Math.max(maxX, bx);
    }
    const dy = [...rows.keys()].sort((a, b) => a - b);
    return { dy, mask: dy.map(y => rows.get(y)!), minX, maxX };
}));

// ─── キック（(type, rot, 回転方向) ごとに [dx, 位置の dy] を平たく前計算。tet-sim の表は「上が正」なので符号を返す） ───
const KICKS: Int8Array[][][] = Array.from({ length: 7 }, (_, type) => Array.from({ length: 4 }, (_, rot) =>
    ([1, -1] as const).map(dir => Int8Array.from((kickTable(type, rot, dir) ?? []).flatMap(([dx, dy]) => [dx, -dy])))));

export function boardFromField(field: number[][]): Board {
    const b = new Uint16Array(ROWS);
    field.forEach((row, i) => { let m = 0; row.forEach((v, x) => { if (v) m |= 1 << x; }); b[i + SIM_TOP] = m; });
    return b;
}

function fits(b: Board, sh: Shape, x: number, y: number): boolean {
    if (x + sh.minX < 0 || x + sh.maxX >= COLS) return false;
    for (let i = 0; i < sh.dy.length; i++) {
        const r = y + sh.dy[i] + SIM_TOP;
        if (r < 0 || r >= ROWS) return false;
        const m = x >= 0 ? sh.mask[i] << x : sh.mask[i] >> -x;
        if (b[r] & m) return false;
    }
    return true;
}

/** tet-sim checkTSpin と同じ角（範囲外・床は埋まっている扱い、上の見えない段より上は空） */
function corner(b: Board, x: number, y: number): boolean {
    if (x < 0 || x >= COLS || y >= VISIBLE) return true;
    if (y < -SIM_TOP) return false;
    return ((b[y + SIM_TOP] >> x) & 1) === 1;
}

// ─── 配置の列挙（BFS） ───

/** 1 つの置き場所。flag: 0=最後が回転でない 1=回転 2=回転（5 番目のキック） */
export interface TetPlacement { type: number; rot: number; x: number; y: number; flag: number; spin: 'tspin' | 'mini' | null; }

// 状態 index = ((rot*28 + y+8)*16 + x+3)*3 + flag。世代スタンプで訪問済みを判定（毎回の初期化をしない）
const Y_OFF = 8, X_OFF = 3, NY = 28, NX = 16;
const visited = new Int32Array(4 * NY * NX * 3);
let generation = 0;
const qx = new Int8Array(visited.length), qy = new Int8Array(visited.length), qr = new Int8Array(visited.length), qf = new Int8Array(visited.length);
const seenKeys = new Set<number>();

/** tet-sim spawn と同じ出現位置（塞がっていたら 1 段上）。置けなければ null */
function spawnY(b: Board, type: number): number | null {
    const y = type === 0 ? -1 : -2;
    const sh = SHAPES[type][0];
    if (fits(b, sh, 3, y)) return y;
    return fits(b, sh, 3, y - 1) ? y - 1 : null;
}

/**
 * 出現位置から 左右・ソフトドロップ（1 段）・左右回転（SRS）で届く、接地した置き場所をすべて返す。
 * 置いたマスと T-Spin の判定が同じものは 1 つにまとめる（設計 §1.3・Q2: 判定が違えば別）
 */
export function tetPlacements(b: Board, type: number): TetPlacement[] {
    const out: TetPlacement[] = [];
    const sy = spawnY(b, type);
    if (sy === null) return out;
    const gen = ++generation;
    const isT = type === 2;
    seenKeys.clear();
    let head = 0, tail = 0;
    const push = (x: number, y: number, rot: number, flag: number) => {
        const id = ((rot * NY + y + Y_OFF) * NX + x + X_OFF) * 3 + flag;
        if (visited[id] === gen) return;
        visited[id] = gen;
        qx[tail] = x; qy[tail] = y; qr[tail] = rot; qf[tail] = flag; tail++;
    };
    push(3, sy, 0, 0);
    while (head < tail) {
        const x = qx[head], y = qy[head], rot = qr[head], flag = qf[head]; head++;
        const sh = SHAPES[type][rot];
        if (fits(b, sh, x - 1, y)) push(x - 1, y, rot, 0);
        if (fits(b, sh, x + 1, y)) push(x + 1, y, rot, 0);
        const grounded = !fits(b, sh, x, y + 1);
        if (!grounded) push(x, y + 1, rot, 0);
        for (let d = 0; d < 2; d++) {
            const k = KICKS[type][rot][d];
            const to = (rot + (d === 0 ? 1 : 3)) & 3;
            const sh2 = SHAPES[type][to];
            for (let i = 0; i < k.length; i += 2) {
                const nx = x + k[i], ny = y + k[i + 1];
                if (fits(b, sh2, nx, ny)) { push(nx, ny, to, isT ? (i === 8 ? 2 : 1) : 0); break; }
            }
        }
        if (!grounded) continue;
        let spin: 'tspin' | 'mini' | null = null;
        if (isT && flag > 0) {
            const px = x + 1, py = y + 2;
            spin = classifyTSpin(rot, [corner(b, px - 1, py - 1), corner(b, px + 1, py - 1), corner(b, px - 1, py + 1), corner(b, px + 1, py + 1)], flag === 2);
        }
        // 置いたマスの正規形: 一番上の行 + 行マスク（向きの番号が違っても同じマスなら同じ値）
        const top = y + sh.dy[0] + SIM_TOP;
        let key = top;
        for (let i = 0; i < sh.dy.length; i++) key = key * 1024 + (x >= 0 ? sh.mask[i] << x : sh.mask[i] >> -x);
        for (let i = sh.dy.length; i < 4; i++) key *= 1024;
        key = key * 3 + (spin === null ? 0 : spin === 'mini' ? 1 : 2);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        out.push({ type, rot, x, y, flag, spin });
    }
    return out;
}

/** 置いて消去した盤面と消えた段数 */
export function lockOn(b: Board, p: TetPlacement): { board: Board; lines: number } {
    const nb = b.slice();
    const sh = SHAPES[p.type][p.rot];
    for (let i = 0; i < sh.dy.length; i++) {
        nb[p.y + sh.dy[i] + SIM_TOP] |= p.x >= 0 ? sh.mask[i] << p.x : sh.mask[i] >> -p.x;
    }
    let lines = 0, w = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
        if (nb[r] === FULL) { lines++; continue; }
        nb[w--] = nb[r];
    }
    while (w >= 0) nb[w--] = 0;
    return { board: nb, lines };
}

function isEmptyBoard(b: Board): boolean {
    for (let r = 0; r < ROWS; r++) if (b[r]) return false;
    return true;
}

// ─── 探索 ───

interface State extends TetProgress { b: Board; idx: number; hold: number; }  // hold: -1 = 空

const keyBuf = new Uint16Array(ROWS + 9);
function stateKey(s: State): string {
    keyBuf.set(s.b, 0);
    keyBuf[ROWS] = s.idx;
    keyBuf[ROWS + 1] = s.hold + 1;
    keyBuf[ROWS + 2] = s.ren;
    keyBuf[ROWS + 3] = s.b2b ? 1 : 0;
    keyBuf[ROWS + 4] = s.score & 0xffff;
    keyBuf[ROWS + 5] = Math.floor(s.score / 65536);
    keyBuf[ROWS + 6] = s.totalLines;
    keyBuf[ROWS + 7] = s.clearTimes;
    return String.fromCharCode.apply(null, keyBuf as unknown as number[]);
}

/** その状態で置けるピース（tet-sim candidates と同じ）と、置いた後のキュー */
function options(doc: EditorDoc, s: State): { type: number; hold: boolean; idx: number; holdAfter: number }[] {
    const n = doc.next.length;
    if (s.idx >= n) return [];
    const opts = [{ type: doc.next[s.idx], hold: false, idx: s.idx + 1, holdAfter: s.hold }];
    if (doc.allowHold) {
        if (s.hold >= 0) opts.push({ type: s.hold, hold: true, idx: s.idx + 1, holdAfter: doc.next[s.idx] });
        else if (s.idx + 1 < n) opts.push({ type: doc.next[s.idx + 1], hold: true, idx: s.idx + 2, holdAfter: doc.next[s.idx] });
    }
    return opts;
}

interface Child { state: State; cleared: boolean; step: Step; }

function children(doc: EditorDoc, s: State, stats: { calls: number; placements: number }): Child[] {
    const out: Child[] = [];
    let cacheType = -1, cache: TetPlacement[] = [];
    for (const o of options(doc, s)) {
        // 通常と HOLD が同じ種類なら列挙は 1 回で済む（盤面が同じ）
        if (o.type !== cacheType) { cache = tetPlacements(s.b, o.type); cacheType = o.type; stats.calls++; stats.placements += cache.length; }
        for (const p of cache) {
            const { board, lines } = lockOn(s.b, p);
            const sc = scoreLock(s, lines, p.spin, isEmptyBoard(board), doc.cond);
            const step: Step = { piece: p.type, rot: p.rot, x: p.x, y: p.y, hold: o.hold };
            if (p.flag > 0) step.lastRot = true;
            if (p.flag === 2) step.kick5 = true;
            out.push({ state: { b: board, idx: o.idx, hold: o.holdAfter, ...sc.next }, cleared: sc.cleared, step });
        }
    }
    return out;
}

export function searchTet(doc: EditorDoc, opts: SearchOptions): SearchResult<Step> {
    const t0 = performance.now();
    const memo = new Map<string, number>();
    const stats = { calls: 0, placements: 0 };
    let nodes = 0, found = 0, timedOut = false, stopped = false;
    const stopAt = opts.stopAt ?? Infinity;

    // 戻り値はその状態から先の解の数。打ち切り時は「それまでに数えた分」（下限）を返し、メモには残さない
    const rec = (s: State): number => {
        if ((++nodes & 255) === 0 && performance.now() - t0 > opts.timeLimitMs) timedOut = true;
        const key = stateKey(s);
        const m = memo.get(key);
        if (m !== undefined) { found += m; if (found >= stopAt) stopped = true; return m; }
        let total = 0;
        for (const c of children(doc, s, stats)) {
            if (timedOut || stopped) return total;
            if (c.cleared) { total++; if (++found >= stopAt) stopped = true; continue; }
            if (c.state.idx >= doc.next.length) continue;   // NEXT 切れ（HOLD 中のピースだけでは置けない）
            total += rec(c.state);
        }
        if (timedOut || stopped) return total;
        memo.set(key, total);
        return total;
    };
    const root: State = { b: boardFromField(doc.field), idx: 0, hold: -1, ren: 0, b2b: false, score: 0, totalLines: 0, clearTimes: 0 };
    const count = rec(root);
    const searchMs = performance.now() - t0;

    // 解の取り出し: メモで「解が 1 つ以上」と分かっている子だけをたどる
    const solutions: Step[][] = [];
    const path: Step[] = [];
    const walk = (s: State) => {
        for (const c of children(doc, s, { calls: 0, placements: 0 })) {
            if (solutions.length >= opts.maxSolutions) return;
            path.push(c.step);
            if (c.cleared) solutions.push(path.slice());
            else if (c.state.idx < doc.next.length && (memo.get(stateKey(c.state)) ?? 0) > 0) walk(c.state);
            path.pop();
        }
    };
    if (opts.maxSolutions > 0 && count > 0) walk(root);

    return {
        count, complete: !timedOut && !stopped, timedOut, stopped,
        nodes, memoSize: memo.size, placementCalls: stats.calls, placements: stats.placements,
        searchMs, totalMs: performance.now() - t0, solutions,
    };
}
