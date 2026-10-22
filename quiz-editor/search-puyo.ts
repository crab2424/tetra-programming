// ─────────────────────────────────────────────
// search-puyo.ts
// ぷよの解の探索（SEARCH 段階 S1）: 型付き配列の盤面・STRICT 相当の着地の列挙（BFS）・メモ化 DFS で解の数を数える
// 移動/回転/着地/ちぎれ/消去は puyo-sim.ts を型付き配列向けに書き直したもの（scripts/quiz-search-check.ts で puyo-sim と突き合わせる）。
// 得点・クリア条件は puyo-sim.ts の chainScoreOf / advancePuyo をそのまま使う。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-solver.md
// ─────────────────────────────────────────────
import type { EditorDoc, Pair } from './model.ts';
import { advancePuyo, chainScoreOf, HIDDEN, type PuyoProgress, type PuyoStep } from './puyo-sim.ts';
import type { SearchOptions, SearchResult } from './search.ts';

const COLS = 6;
const ROWS = 12;             // 可視段
const TOTAL = ROWS + HIDDEN; // 17
const OJAMA = 6;
const DC = [0, 1, 0, -1];
const DR = [-1, 0, 1, 0];

/** 盤面: index = (論理行 + HIDDEN) * 6 + 列（puyo-sim の Grid を平たくしたもの） */
export type Board = Uint8Array;

export function boardFromField(field: number[][]): Board {
    const b = new Uint8Array(TOTAL * COLS);
    field.forEach((row, r) => row.forEach((v, c) => { b[r * COLS + c] = v; }));
    return b;
}

// ─── 盤面の参照（puyo-sim getCell / isEmpty と同じ。一番上の隠し段は常に空として読む） ───
/** 空いているか（isEmpty。canPlaceGrid の 1 マス分も同じ）。範囲外の上は空、床・左右の壁は不可 */
function free(b: Board, c: number, row: number): boolean {
    if (c < 0 || c >= COLS || row >= ROWS) return false;
    if (row <= -HIDDEN) return true;
    return b[(row + HIDDEN) * COLS + c] === 0;
}
function canPlaceRow(b: Board, pc: number, pr: number, rot: number): boolean {
    return free(b, pc, pr) && free(b, pc + DC[rot], pr + DR[rot]);
}
function canPlace(b: Board, pc: number, py: number, rot: number): boolean {
    const r1 = Math.floor(py), r2 = Math.ceil(py);
    if (!canPlaceRow(b, pc, r1, rot)) return false;
    return r1 === r2 || canPlaceRow(b, pc, r2, rot);
}
function limitY(b: Board, pc: number, py: number, rot: number): number {
    const cc = pc + DC[rot];
    let pr = Math.floor(py);
    while (pr < ROWS && free(b, pc, pr + 1)) pr++;
    let cr = Math.floor(py) + DR[rot];
    while (cr < ROWS && free(b, cc, cr + 1)) cr++;
    return Math.min(pr, cr - DR[rot]);
}
function limitYSingle(b: Board, c: number, y: number): number {
    let r = Math.floor(y);
    while (r < ROWS && free(b, c, r + 1)) r++;
    return r;
}
function setCell(b: Board, c: number, row: number, v: number) {
    const r = row + HIDDEN;
    if (r < 0 || r >= TOTAL || c < 0 || c >= COLS) return;
    b[r * COLS + c] = v;
}

// ─── 着地の列挙（BFS） ───

// 状態 index = ((x*37 + (y+7)*2)*4 + rot)*3 + min(qt,2)。y < -7 は省く（それより上は全部空いていて、着地は y=-7 からと同じ）
const Y_MIN = -7, NY2 = (ROWS - 1 - Y_MIN) * 2 + 1;
const visited = new Int32Array(COLS * NY2 * 4 * 3);
let generation = 0;
const qx = new Int8Array(visited.length), qy2 = new Int8Array(visited.length), qr = new Int8Array(visited.length), qq = new Int8Array(visited.length);
const seenKeys = new Set<number>();
// 同じ着地（x, 着地行, rot）を 2 回計算しない
const landed = new Int32Array(COLS * (ROWS - Y_MIN + 1) * 4);

/** 1 つの着地。step = 記録する手（y はちぎれる前の着地行）、board = 置いてちぎれた後（連鎖前）の盤面 */
export interface PuyoPlacement { step: PuyoStep; board: Board; }

/** 置いてちぎれた後の盤面（puyo-sim fixPair と同じ） */
function fixed(b: Board, x: number, y: number, rot: number, pair: Pair): { board: Board; key: number } {
    const nb = b.slice();
    const pc = x, pr = y, cc = x + DC[rot], cr = y + DR[rot];
    const pf = free(b, pc, pr + 1), cf = free(b, cc, cr + 1);
    let py = pr, cy = cr;
    if (pf && !cf) { setCell(nb, cc, cr, pair[1]); py = limitYSingle(nb, pc, pr); setCell(nb, pc, py, pair[0]); }
    else if (!pf && cf) { setCell(nb, pc, pr, pair[0]); cy = limitYSingle(nb, cc, cr); setCell(nb, cc, cy, pair[1]); }
    else { setCell(nb, pc, pr, pair[0]); setCell(nb, cc, cr, pair[1]); }
    // 置いた 2 個（位置と色）で盤面が決まる → 同じ盤面になる着地を 1 つにまとめる鍵
    const a = ((py + HIDDEN) * COLS + pc) * 8 + pair[0], c = ((cy + HIDDEN) * COLS + cc) * 8 + pair[1];
    return { board: nb, key: a < c ? a * 1024 + c : c * 1024 + a };
}

/** 出現位置から 左右・回転（蹴り・押し上げ・クイックターン）・ソフトドロップ（0.5 段）で届く着地をすべて返す */
export function puyoPlacements(b: Board, pair: Pair): PuyoPlacement[] {
    const out: PuyoPlacement[] = [];
    const gen = ++generation;
    seenKeys.clear();
    let head = 0, tail = 0;
    const push = (x: number, y: number, rot: number, qt: number) => {
        if (y < Y_MIN) return;
        const q = Math.min(qt, 2);
        const id = ((x * NY2 + (y - Y_MIN) * 2) * 4 + rot) * 3 + q;
        if (visited[id] === gen) return;
        visited[id] = gen;
        qx[tail] = x; qy2[tail] = (y - Y_MIN) * 2; qr[tail] = rot; qq[tail] = q; tail++;
    };
    push(2, -0.5, 0, 0);
    while (head < tail) {
        const x = qx[head], y = qy2[head] / 2 + Y_MIN, rot = qr[head], qt = qq[head]; head++;
        // 左右（movedPos）
        if (canPlace(b, x - 1, y, rot)) push(x - 1, y, rot, 0);
        if (canPlace(b, x + 1, y, rot)) push(x + 1, y, rot, 0);
        // ソフトドロップ（softDropped: 0.5 段・着地位置で止まる。qt はそのまま）
        const lim = limitY(b, x, y + 0.5, rot);
        const sy = y + 0.5 >= lim ? lim : y + 0.5;
        if (sy !== y) push(x, sy, rot, qt);
        // 回転（rotatedPos）
        for (let dir = 1; dir >= -1; dir -= 2) {
            const vertical = rot === 0 || rot === 2;
            const nr = ((rot + dir) % 4 + 4) % 4;
            let nx = x, ny = y, ok = false;
            if (nr === 2 && !vertical) {
                if (canPlace(b, nx, ny, nr)) ok = true;
                else if (canPlace(b, nx, ny - 1, nr)) { ny -= 1; ok = true; }
            } else if (canPlace(b, nx, ny, nr)) ok = true;
            else {
                for (const kick of [-1, 1]) if (canPlace(b, nx + kick, ny, nr)) { nx += kick; ok = true; break; }
            }
            if (ok) { push(nx, ny, nr, 0); continue; }
            if (!vertical) continue;
            const q2 = qt + 1;
            if (q2 >= 2) {
                const qtRot = (rot + 2) % 4;
                if (rot === 0 && canPlace(b, x, y - 1, qtRot)) { push(x, y - 1, qtRot, 0); continue; }
                if (rot === 2 && canPlace(b, x, y, qtRot)) { push(x, y, qtRot, 0); continue; }
            }
            push(x, y, rot, q2);
        }
        // この位置からのドロップ（landedPos）
        const ly = limitY(b, x, y, rot);
        const lid = (x * (ROWS - Y_MIN + 1) + ly - Y_MIN) * 4 + rot;
        if (landed[lid] === gen) continue;
        landed[lid] = gen;
        const f = fixed(b, x, ly, rot, pair);
        if (seenKeys.has(f.key)) continue;
        seenKeys.add(f.key);
        out.push({ step: { x, y: ly, rot }, board: f.board });
    }
    return out;
}

// ─── 連鎖（puyo-sim findErasable / resolveChains と同じ。消去は可視段だけ、落下は全段） ───
const seen = new Int32Array(TOTAL * COLS);
let seenGen = 0;
const stack = new Int16Array(TOTAL * COLS);
const erase = new Int16Array(TOTAL * COLS);

/** b を連鎖後の盤面に書き換える。連鎖数と得点（全消しボーナス抜き） */
export function resolveChains(b: Board): { chain: number; score: number } {
    let chain = 0, score = 0;
    for (;;) {
        const gen = ++seenGen;
        const sizes: number[] = [];
        let colorMask = 0, nErase = 0;
        for (let i = HIDDEN * COLS; i < TOTAL * COLS; i++) {
            const color = b[i];
            if (seen[i] === gen || color === 0 || color === OJAMA) continue;
            let sp = 0, n = 0;
            const start = nErase;
            stack[sp++] = i; seen[i] = gen;
            while (sp) {
                const j = stack[--sp];
                erase[nErase + n++] = j;
                const r = (j / COLS) | 0, c = j - r * COLS;
                if (r > HIDDEN && b[j - COLS] === color && seen[j - COLS] !== gen) { seen[j - COLS] = gen; stack[sp++] = j - COLS; }
                if (r < TOTAL - 1 && b[j + COLS] === color && seen[j + COLS] !== gen) { seen[j + COLS] = gen; stack[sp++] = j + COLS; }
                if (c > 0 && b[j - 1] === color && seen[j - 1] !== gen) { seen[j - 1] = gen; stack[sp++] = j - 1; }
                if (c < COLS - 1 && b[j + 1] === color && seen[j + 1] !== gen) { seen[j + 1] = gen; stack[sp++] = j + 1; }
            }
            if (n >= 4) { sizes.push(n); colorMask |= 1 << color; nErase = start + n; }
        }
        if (!sizes.length) break;
        chain++;
        let colors = 0;
        for (let m = colorMask; m; m &= m - 1) colors++;
        score += chainScoreOf(sizes, colors, chain);
        // 巻き込まれるおじゃま（可視段で隣接）
        const end = nErase;
        for (let k = 0; k < end; k++) {
            const j = erase[k], r = (j / COLS) | 0, c = j - r * COLS;
            if (r > HIDDEN && b[j - COLS] === OJAMA) b[j - COLS] = 0;
            if (r < TOTAL - 1 && b[j + COLS] === OJAMA) b[j + COLS] = 0;
            if (c > 0 && b[j - 1] === OJAMA) b[j - 1] = 0;
            if (c < COLS - 1 && b[j + 1] === OJAMA) b[j + 1] = 0;
        }
        for (let k = 0; k < end; k++) b[erase[k]] = 0;
        // 落下（隠し段も含む全段）
        for (let c = 0; c < COLS; c++) {
            let w = TOTAL - 1;
            for (let r = TOTAL - 1; r >= 0; r--) {
                const v = b[r * COLS + c];
                if (!v) continue;
                b[r * COLS + c] = 0;
                b[w-- * COLS + c] = v;
            }
        }
    }
    return { chain, score };
}

function visibleEmpty(b: Board): boolean {
    for (let i = HIDDEN * COLS; i < TOTAL * COLS; i++) if (b[i]) return false;
    return true;
}
/** 窒息（3列目の可視最上段が埋まっている） */
function isDead(b: Board): boolean { return b[HIDDEN * COLS + 2] !== 0; }

// ─── 探索 ───

interface State extends PuyoProgress { b: Board; idx: number; }

const keyBuf = new Uint16Array(Math.ceil(TOTAL * COLS / 5) + 6);
function stateKey(s: State): string {
    let k = 0;
    for (let i = 0; i < TOTAL * COLS; i += 5) {
        keyBuf[k++] = s.b[i] | s.b[i + 1] << 3 | s.b[i + 2] << 6 | s.b[i + 3] << 9 | (s.b[i + 4] ?? 0) << 12;
    }
    keyBuf[k++] = s.idx;
    keyBuf[k++] = s.score & 0xffff;
    keyBuf[k++] = Math.floor(s.score / 65536);
    keyBuf[k++] = s.chainMax;
    keyBuf[k++] = s.clearTimes;
    keyBuf[k++] = s.isAllClear ? 1 : 0;
    return String.fromCharCode.apply(null, keyBuf as unknown as number[]);
}

interface Child { state: State; cleared: boolean; dead: boolean; step: PuyoStep; }

function children(doc: EditorDoc, s: State, stats: { calls: number; placements: number }): Child[] {
    const ps = puyoPlacements(s.b, doc.pairs[s.idx]);
    stats.calls++; stats.placements += ps.length;
    return ps.map(p => {
        const { chain, score } = resolveChains(p.board);
        const pr = advancePuyo(s, chain, score, visibleEmpty(p.board), doc.cond);
        return { state: { b: p.board, idx: s.idx + 1, ...pr.next }, cleared: pr.cleared, dead: isDead(p.board), step: p.step };
    });
}

export function searchPuyo(doc: EditorDoc, opts: SearchOptions): SearchResult<PuyoStep> {
    const t0 = performance.now();
    const memo = new Map<string, number>();
    const stats = { calls: 0, placements: 0 };
    let nodes = 0, found = 0, timedOut = false, stopped = false;
    const stopAt = opts.stopAt ?? Infinity;
    const n = doc.pairs.length;

    const rec = (s: State): number => {
        if ((++nodes & 255) === 0 && performance.now() - t0 > opts.timeLimitMs) timedOut = true;
        const key = stateKey(s);
        const m = memo.get(key);
        if (m !== undefined) { found += m; if (found >= stopAt) stopped = true; return m; }
        let total = 0;
        for (const c of children(doc, s, stats)) {
            if (timedOut || stopped) return total;
            if (c.cleared) { total++; if (++found >= stopAt) stopped = true; continue; }
            if (c.dead || c.state.idx >= n) continue;   // 窒息・NEXT 切れ
            total += rec(c.state);
        }
        if (timedOut || stopped) return total;
        memo.set(key, total);
        return total;
    };
    const root: State = { b: boardFromField(doc.field), idx: 0, score: 0, chainMax: 0, clearTimes: 0, isAllClear: false };
    const count = n === 0 || isDead(root.b) ? 0 : rec(root);
    const searchMs = performance.now() - t0;

    const solutions: PuyoStep[][] = [];
    const path: PuyoStep[] = [];
    const walk = (s: State) => {
        for (const c of children(doc, s, { calls: 0, placements: 0 })) {
            if (solutions.length >= opts.maxSolutions) return;
            path.push(c.step);
            if (c.cleared) solutions.push(path.slice());
            else if (!c.dead && c.state.idx < n && (memo.get(stateKey(c.state)) ?? 0) > 0) walk(c.state);
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
