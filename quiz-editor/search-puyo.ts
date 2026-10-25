// ─────────────────────────────────────────────
// search-puyo.ts
// ぷよの解の探索（SEARCH 段階 S1）: 型付き配列の盤面・STRICT 相当の着地の列挙（BFS）・メモ化 DFS で解の数を数える
// 移動/回転/着地/ちぎれ/消去は puyo-sim.ts を型付き配列向けに書き直したもの（scripts/quiz-search-check.ts で puyo-sim と突き合わせる）。
// 得点・クリア条件は puyo-sim.ts の chainScoreOf / advancePuyo をそのまま使う。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-solver.md
// ─────────────────────────────────────────────
import type { Cond, EditorDoc, Pair } from './model.ts';
import { advancePuyo, chainScoreOf, GROUP_BONUS, HIDDEN, ZENKESHI_BONUS, type PuyoProgress, type PuyoStep } from './puyo-sim.ts';
import { SPLIT_DEPTH, type SearchOptions, type SearchResult } from './search.ts';

/** 進捗を送る間隔 */
const PROGRESS_MS = 200;

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
const colTop = new Int8Array(COLS);
// 同じ着地（x, 着地行, rot）を 2 回計算しない
const landed = new Int32Array(COLS * (ROWS - Y_MIN + 1) * 4);

// BFS 1 回の中で、整数行ごとの「置けるか」「着地行」を覚える（半段の y・qt 違いの状態で同じ計算を繰り返さないため）
const R_MIN = -9, NR = ROWS - R_MIN;   // 行 -9〜11。それより上は全部空いている
const rowStamp = new Int32Array(COLS * NR * 4), rowVal = new Uint8Array(rowStamp.length);
const limStamp = new Int32Array(COLS * NR * 4), limVal = new Int8Array(limStamp.length);
function rowOkCached(b: Board, x: number, r: number, rot: number, gen: number): boolean {
    if (x < 0 || x >= COLS) return false;
    if (r < R_MIN) return canPlaceRow(b, x, r, rot);
    const id = (x * NR + r - R_MIN) * 4 + rot;
    if (rowStamp[id] !== gen) { rowStamp[id] = gen; rowVal[id] = canPlaceRow(b, x, r, rot) ? 1 : 0; }
    return rowVal[id] === 1;
}
function canPlaceCached(b: Board, x: number, py: number, rot: number, gen: number): boolean {
    const r1 = Math.floor(py), r2 = Math.ceil(py);
    if (!rowOkCached(b, x, r1, rot, gen)) return false;
    return r1 === r2 || rowOkCached(b, x, r2, rot, gen);
}
/** limitY は y の整数部だけで決まる */
function limitYCached(b: Board, x: number, py: number, rot: number, gen: number): number {
    const r = Math.floor(py);
    if (r < R_MIN) return limitY(b, x, py, rot);
    const id = (x * NR + r - R_MIN) * 4 + rot;
    if (limStamp[id] !== gen) { limStamp[id] = gen; limVal[id] = limitY(b, x, r, rot); }
    return limVal[id];
}

/**
 * 1 つの着地。step = 記録する手（y はちぎれる前の着地行）、board = 置いてちぎれた後（連鎖前）の盤面、
 * placed = 置いた 2 個の盤面の index（resolveChains の最初の判定をここからに絞るため）
 */
export interface PuyoPlacement { step: PuyoStep; board: Board; placed: [number, number]; }

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

/**
 * 出現位置から 左右・回転（蹴り・押し上げ・クイックターン）・ソフトドロップ（0.5 段）で届く着地をすべて返す。
 * chainOnly: 置いたぷよが消えるつながりを作る着地だけ（b が安定している時の最後の手用。連鎖の無い手ではクリアしない）
 */
export function puyoPlacements(b: Board, pair: Pair, chainOnly = false): PuyoPlacement[] {
    const out: PuyoPlacement[] = [];
    const gen = ++generation;
    seenKeys.clear();
    // 宙の近道（設計 §14）: どの列も論理行 1 より上（隠し段を含む）が空なら、出現位置の高さで左右・回転が全部でき、
    // 壁の内側の (x, rot) 22 通りすべてに届く。どの列も床から隙間なく積まれていれば（浮いたぷよ＝庇が無い）着地は (x, rot) だけで決まる＝BFS と同じ着地になる
    let low = true;
    for (let i = 0; i < (HIDDEN + 2) * COLS; i++) if (b[i]) { low = false; break; }
    for (let c = 0; low && c < COLS; c++) {
        let top = TOTAL;
        while (top > 0 && b[(top - 1) * COLS + c]) top--;
        for (let r = top - 1; r >= 0; r--) if (b[r * COLS + c]) { low = false; break; }
    }
    if (low) {
        // 列の高さだけで着地とちぎれが決まる（fixed と同じ結果）。top[c] = 一番上のぷよの論理行（空の列は ROWS）
        for (let c = 0; c < COLS; c++) {
            let r = 2;
            while (r < ROWS && !b[(r + HIDDEN) * COLS + c]) r++;
            colTop[c] = r;
        }
        for (let x = 0; x < COLS; x++) {
            for (let rot = 0; rot < 4; rot++) {
                const cc = x + DC[rot];
                if (cc < 0 || cc >= COLS) continue;
                let py: number, cy: number;
                if (rot === 0) { py = colTop[x] - 1; cy = py - 1; }
                else if (rot === 2) { cy = colTop[x] - 1; py = cy - 1; }
                else { py = colTop[x] - 1; cy = colTop[cc] - 1; }
                const pi = (py + HIDDEN) * COLS + x, ci = (cy + HIDDEN) * COLS + cc;
                const a = pi * 8 + pair[0], c2 = ci * 8 + pair[1];
                const key = a < c2 ? a * 1024 + c2 : c2 * 1024 + a;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                if (chainOnly) {
                    // 盤面を複製せずに一時的に置いて調べる
                    b[pi] = pair[0]; b[ci] = pair[1];
                    const hit = touchesGroup(b, [pi, ci]);
                    b[pi] = 0; b[ci] = 0;
                    if (!hit) continue;
                }
                const nb = b.slice();
                nb[pi] = pair[0]; nb[ci] = pair[1];
                out.push({ step: { x, y: rot === 1 || rot === 3 ? Math.min(py, cy) : py, rot }, board: nb, placed: [pi, ci] });
            }
        }
        return out;
    }
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
        if (canPlaceCached(b, x - 1, y, rot, gen)) push(x - 1, y, rot, 0);
        if (canPlaceCached(b, x + 1, y, rot, gen)) push(x + 1, y, rot, 0);
        // ソフトドロップ（softDropped: 0.5 段・着地位置で止まる。qt はそのまま）
        const lim = limitYCached(b, x, y + 0.5, rot, gen);
        const sy = y + 0.5 >= lim ? lim : y + 0.5;
        if (sy !== y) push(x, sy, rot, qt);
        // 回転（rotatedPos）
        for (let dir = 1; dir >= -1; dir -= 2) {
            const vertical = rot === 0 || rot === 2;
            const nr = ((rot + dir) % 4 + 4) % 4;
            let nx = x, ny = y, ok = false;
            if (nr === 2 && !vertical) {
                if (canPlaceCached(b, nx, ny, nr, gen)) ok = true;
                else if (canPlaceCached(b, nx, ny - 1, nr, gen)) { ny -= 1; ok = true; }
            } else if (canPlaceCached(b, nx, ny, nr, gen)) ok = true;
            else {
                if (canPlaceCached(b, nx - 1, ny, nr, gen)) { nx -= 1; ok = true; }
                else if (canPlaceCached(b, nx + 1, ny, nr, gen)) { nx += 1; ok = true; }
            }
            if (ok) { push(nx, ny, nr, 0); continue; }
            if (!vertical) continue;
            const q2 = qt + 1;
            if (q2 >= 2) {
                const qtRot = (rot + 2) % 4;
                if (rot === 0 && canPlaceCached(b, x, y - 1, qtRot, gen)) { push(x, y - 1, qtRot, 0); continue; }
                if (rot === 2 && canPlaceCached(b, x, y, qtRot, gen)) { push(x, y, qtRot, 0); continue; }
            }
            push(x, y, rot, q2);
        }
        // この位置からのドロップ（landedPos）
        const ly = limitYCached(b, x, y, rot, gen);
        const lid = (x * (ROWS - Y_MIN + 1) + ly - Y_MIN) * 4 + rot;
        if (landed[lid] === gen) continue;
        landed[lid] = gen;
        // 手として記録できる着地だけ（puyo-sim validLanding: その位置に置けて、そこが着地位置）。
        // 出現位置に浮いたぷよが重なる盤面では、出現位置から落とすと重なった位置に「着地」してしまうため
        if (!canPlaceCached(b, x, ly, rot, gen) || limitYCached(b, x, ly, rot, gen) !== ly) continue;
        const f = fixed(b, x, ly, rot, pair);
        if (seenKeys.has(f.key)) continue;
        seenKeys.add(f.key);
        if (chainOnly && !touchesGroup(f.board, [Math.floor(f.key / 1024) >> 3, (f.key % 1024) >> 3])) continue;
        out.push({ step: { x, y: ly, rot }, board: f.board, placed: [Math.floor(f.key / 1024) >> 3, (f.key % 1024) >> 3] });
    }
    return out;
}

// ─── 連鎖（puyo-sim findErasable / resolveChains と同じ。消去は可視段だけ、落下は全段） ───
const seen = new Int32Array(TOTAL * COLS);
let seenGen = 0;
const stack = new Int16Array(TOTAL * COLS);
const erase = new Int16Array(TOTAL * COLS);
const starts = new Int16Array(TOTAL * COLS);

/** placed のどれかを含む、可視段の同じ色 4 個以上のつながりがあるか */
function touchesGroup(b: Board, placed: readonly number[]): boolean {
    const gen = ++seenGen;
    for (const i of placed) {
        const color = b[i];
        if (i < HIDDEN * COLS || seen[i] === gen || color === 0 || color === OJAMA) continue;
        let sp = 0, n = 0;
        stack[sp++] = i; seen[i] = gen;
        while (sp) {
            const j = stack[--sp];
            n++;
            const r = (j / COLS) | 0, c = j - r * COLS;
            if (r > HIDDEN && b[j - COLS] === color && seen[j - COLS] !== gen) { seen[j - COLS] = gen; stack[sp++] = j - COLS; }
            if (r < TOTAL - 1 && b[j + COLS] === color && seen[j + COLS] !== gen) { seen[j + COLS] = gen; stack[sp++] = j + COLS; }
            if (c > 0 && b[j - 1] === color && seen[j - 1] !== gen) { seen[j - 1] = gen; stack[sp++] = j - 1; }
            if (c < COLS - 1 && b[j + 1] === color && seen[j + 1] !== gen) { seen[j + 1] = gen; stack[sp++] = j + 1; }
        }
        if (n >= 4) return true;
    }
    return false;
}

/**
 * b を連鎖後の盤面に書き換える。連鎖数と得点（全消しボーナス抜き）。
 * placed: 置く前の盤面に消えるグループが無かった（安定していた）なら、新しくできるグループは置いたぷよを必ず含むので、
 * 1 連鎖目が起きるかはそこからの塗りつぶしだけで分かる（起きない時は盤面全体を見ない）
 */
export function resolveChains(b: Board, placed?: readonly number[]): { chain: number; score: number } {
    if (placed && !touchesGroup(b, placed)) return { chain: 0, score: 0 };
    let chain = 0, score = 0;
    // 調べる起点（placed がある時だけ）: 1 連鎖目は置いた 2 個、2 連鎖目からは落ちたぷよ。
    // 消えたグループは全部消えるので、動かなかったぷよだけのつながりは前の段で 4 個未満だったもの＝新しいグループは動いたぷよを含む
    let nStart = -1;
    if (placed) { nStart = 0; for (const i of placed) starts[nStart++] = i; }
    for (;;) {
        const gen = ++seenGen;
        const sizes: number[] = [];
        let colorMask = 0, nErase = 0;
        const nScan = nStart < 0 ? ROWS * COLS : nStart;
        for (let k = 0; k < nScan; k++) {
            const i = nStart < 0 ? HIDDEN * COLS + k : starts[k];
            const color = b[i];
            if (i < HIDDEN * COLS || seen[i] === gen || color === 0 || color === OJAMA) continue;
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
        // 落下（隠し段も含む全段）。落ちて可視段に来たぷよが次の起点
        let nMoved = 0;
        for (let c = 0; c < COLS; c++) {
            let w = TOTAL - 1;
            for (let r = TOTAL - 1; r >= 0; r--) {
                const v = b[r * COLS + c];
                if (!v) continue;
                if (w !== r) {
                    b[r * COLS + c] = 0;
                    b[w * COLS + c] = v;
                    if (w >= HIDDEN) starts[nMoved++] = w * COLS + c;
                }
                w--;
            }
        }
        if (nStart >= 0) nStart = nMoved;
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

/**
 * メモのキーに入れる値（設計 §2.4）。chain / allClear は「その手」でクリアが決まるので盤面と手番だけ
 * （最大連鎖は目標未満のまま・全消し状態は全消しの手で即クリア。count の allClear も連鎖のあった手で全消しを付け直すので前の値は効かない）
 */
interface KeyMode { score: number; chainMax: boolean; times: boolean; allClear: boolean; }

function keyModeOf(c: Cond, prune: boolean): KeyMode {
    if (!prune) return { score: Infinity, chainMax: true, times: true, allClear: true };
    const inner = c.type === 'count' ? c.countCondition : c.type;
    const times = c.type === 'count';
    if (inner === 'score') return { score: c.type === 'count' ? c.countValue : Infinity, chainMax: false, times, allClear: false };
    return { score: -1, chainMax: false, times, allClear: false };
}

const keyBuf = new Uint16Array(Math.ceil(TOTAL * COLS / 5) + 6);
function stateKeyOf(s: State, km: KeyMode): string {
    let k = 0;
    for (let i = 0; i < TOTAL * COLS; i += 5) {
        keyBuf[k++] = s.b[i] | s.b[i + 1] << 3 | s.b[i + 2] << 6 | s.b[i + 3] << 9 | (s.b[i + 4] ?? 0) << 12;
    }
    const score = km.score < 0 ? 0 : Math.min(s.score, km.score);
    keyBuf[k++] = s.idx;
    keyBuf[k++] = score & 0xffff;
    keyBuf[k++] = Math.floor(score / 65536);
    keyBuf[k++] = km.chainMax ? s.chainMax : 0;
    keyBuf[k++] = km.times ? s.clearTimes : 0;
    keyBuf[k++] = km.allClear && s.isAllClear ? 1 : 0;
    return String.fromCharCode.apply(null, keyBuf as unknown as number[]);
}

// ─── 枝刈り（設計 §2.5。解を落とさないものだけ） ───

/**
 * これから取れる得点の上限（設計 §14）。消せるぷよ = 4 個以上ある色のぷよの合計 E（盤面の全段＋残りのペア）、その色の数 C。
 * 消える 1 回（連鎖の 1 段）ごとの得点は chainScoreOf(グループの大きさ, 色数, 連鎖数)。手ごとに連鎖数は 1 から数え直すが、
 * 全部の段を 1 つの連鎖の 1, 2, 3, … 段目として並べた方が連鎖ボーナスは大きいか同じなので、
 * 「E 個を何回かに分けて消す・k 回目は k 連鎖目」の最大＋全消しボーナス×（全消しできる手の数の上限）で上から抑える。
 * グループは色ごとに分かれる・大きさの上限（その色の個数）は無視する（＝緩い方へ倒す）
 */
function makeScoreBound(maxE: number) {
    // part[a][h] = a 個を h グループ（各 4 個以上）に分けた時のグループボーナスの合計が最大になる分け方
    const gb = (n: number) => GROUP_BONUS[Math.min(n, GROUP_BONUS.length - 1)];
    const part: (number[] | null)[][] = Array.from({ length: maxE + 1 }, () => []);
    const partB: number[][] = Array.from({ length: maxE + 1 }, () => []);
    for (let a = 4; a <= maxE; a++) {
        part[a][1] = [a]; partB[a][1] = gb(a);
        for (let h = 2; 4 * h <= a; h++) {
            let best = -1, bestP: number[] | null = null;
            for (let s = 4; a - s >= 4 * (h - 1); s++) {
                const rest = part[a - s][h - 1];
                if (!rest) continue;
                const v = gb(s) + partB[a - s][h - 1];
                if (v > best) { best = v; bestP = [s, ...rest]; }
            }
            part[a][h] = bestP; partB[a][h] = best;
        }
    }
    const tables = new Map<number, Float64Array>();   // 色数 C → future[j * (maxE+1) + n] = j 連鎖目から n 個で取れる最大
    const J = Math.floor(maxE / 4) + 2;
    const tableOf = (C: number): Float64Array => {
        let t = tables.get(C);
        if (t) return t;
        t = new Float64Array((J + 1) * (maxE + 1));
        for (let j = J - 1; j >= 1; j--) {
            for (let n = 0; n <= maxE; n++) {
                let best = 0;
                for (let a = 4; a <= n; a++) {
                    let step = 0;
                    for (let h = 1; 4 * h <= a; h++) {
                        const p = part[a][h];
                        if (p) step = Math.max(step, chainScoreOf(p, Math.min(C, h), j));
                    }
                    best = Math.max(best, step + t[(j + 1) * (maxE + 1) + n - a]);
                }
                t[j * (maxE + 1) + n] = best;
            }
        }
        tables.set(C, t);
        return t;
    };
    /** E 個・C 色・残り left 手で取れる得点の上限 */
    return (E: number, C: number, left: number): number => {
        if (E < 4 || C === 0) return 0;
        return tableOf(C)[1 * (maxE + 1) + Math.min(E, maxE)] + ZENKESHI_BONUS * Math.min(left, Math.floor(E / 4));
    };
}

/**
 * true なら、この状態からは条件を満たせない。
 * 色ごとの個数（盤面の全段＋残りのペア）から、1 連鎖ごとに同じ色が 4 個以上要ることを使う
 */
function makePrune(doc: EditorDoc): (s: State) => boolean {
    const c = doc.cond, n = doc.pairs.length;
    const inner = c.type === 'count' ? c.countCondition : c.type;
    // addSuffix[i][color] = pairs[i..] のその色の個数
    const addSuffix = Array.from({ length: n + 1 }, () => new Array(8).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let col = 0; col < 8; col++) addSuffix[i][col] = addSuffix[i + 1][col];
        addSuffix[i][doc.pairs[i][0]]++;
        addSuffix[i][doc.pairs[i][1]]++;
    }
    const cnt = new Array(8);
    // 得点: 初めの盤面＋全部のペアの色ぷよの数が、どの状態でも E の上限
    let scoreBound: ((E: number, C: number, left: number) => number) | null = null;
    if (inner === 'score') {
        let total = 0;
        for (const v of doc.field.flat()) if (v >= 1 && v <= 5) total++;
        for (let col = 1; col <= 5; col++) total += addSuffix[0][col];
        scoreBound = makeScoreBound(total);
    }
    return (s: State): boolean => {
        const left = n - s.idx;
        const timesLeft = c.type === 'count' ? c.value - s.clearTimes : 1;
        if (timesLeft > left) return true;   // 1 手で数えられるのは 1 回まで
        if (inner !== 'chain' && inner !== 'allClear' && inner !== 'score') return false;
        const add = addSuffix[s.idx];
        for (let col = 1; col <= 5; col++) cnt[col] = add[col];
        for (let i = 0; i < TOTAL * COLS; i++) { const v = s.b[i]; if (v >= 1 && v <= 5) cnt[v]++; }
        if (scoreBound) {
            // 累計がこの先の上限を足しても目標に届かない（count は「連鎖のあった手で累計 ≥ countValue」なので同じ判定）
            let E = 0, C = 0;
            for (let col = 1; col <= 5; col++) if (cnt[col] >= 4) { E += cnt[col]; C++; }
            const target = c.type === 'count' ? c.countValue : c.value;
            return s.score + scoreBound(E, C, left) < target;
        }
        let groups = 0;   // これから消せるグループの数の上限
        for (let col = 1; col <= 5; col++) groups += Math.floor(cnt[col] / 4);
        if (inner === 'chain') {
            // 連鎖 k 段には k グループ以上。count はそれを timesLeft 回
            const need = c.type === 'count' ? c.countValue * timesLeft : c.value;
            return groups < need;
        }
        // 全消し: 可視段にある色は 4 個以上にならないと消えない（ぷよは上へは動かない）。可視段のおじゃまは隣で何かが消える必要がある
        if (!groups) {
            for (let i = HIDDEN * COLS; i < TOTAL * COLS; i++) if (s.b[i]) return true;
            return false;
        }
        for (let i = HIDDEN * COLS; i < TOTAL * COLS; i++) { const v = s.b[i]; if (v >= 1 && v <= 5 && cnt[v] < 4) return true; }
        return false;
    };
}

interface Child { state: State; cleared: boolean; dead: boolean; step: PuyoStep; }

/** stable: s.b に消えるグループが無い（1 手目以降は必ず。初めの盤面だけ調べる） */
function children(doc: EditorDoc, s: State, stats: { calls: number; placements: number }, stable: boolean): Child[] {
    // 最後の手は連鎖が無いとクリアしない（クリアしていない状態から、連鎖の無い手で得点・最大連鎖・全消し・回数は増えない）
    const ps = puyoPlacements(s.b, doc.pairs[s.idx], stable && s.idx === doc.pairs.length - 1);
    stats.calls++; stats.placements += ps.length;
    return ps.map(p => {
        const { chain, score } = resolveChains(p.board, stable ? p.placed : undefined);
        // 全消しは連鎖のあった手だけ見る（advancePuyo も chain > 0 の時だけ使う）
        const pr = advancePuyo(s, chain, score, chain > 0 && visibleEmpty(p.board), doc.cond);
        return { state: { b: p.board, idx: s.idx + 1, ...pr.next }, cleared: pr.cleared, dead: isDead(p.board), step: p.step };
    });
}

export function searchPuyo(doc: EditorDoc, opts: SearchOptions): SearchResult<PuyoStep> {
    const t0 = performance.now();
    const memo = new Map<string, number>();
    const partial = new Set<string>();   // 打ち切り・上限で途中までしか数えなかった状態（解の取り出しではここにも入る）
    const stats = { calls: 0, placements: 0 };
    let nodes = 0, found = 0, timedOut = false, stopped = false;
    let lastReport = t0;
    const stopAt = opts.stopAt ?? Infinity;
    const n = doc.pairs.length;
    const rootB = boardFromField(doc.field);
    const rootStable = resolveChains(rootB.slice()).chain === 0;
    const km = keyModeOf(doc.cond, opts.prune !== false);
    const pruned = opts.prune !== false ? makePrune(doc) : () => false;
    const stateKey = (s: State) => stateKeyOf(s, km);

    const rec = (s: State): number => {
        if ((++nodes & 255) === 0) {
            const now = performance.now();
            if (now - t0 > opts.timeLimitMs) timedOut = true;
            if (opts.onProgress && now - lastReport >= PROGRESS_MS) { lastReport = now; opts.onProgress({ nodes, found, elapsedMs: now - t0 }); }
        }
        const key = stateKey(s);
        const m = memo.get(key);
        if (m !== undefined) { found += m; if (found >= stopAt) stopped = true; return m; }
        let total = 0;
        for (const c of children(doc, s, stats, s.idx > 0 || rootStable)) {
            if (timedOut || stopped) { partial.add(key); return total; }
            if (c.cleared) { total++; if (++found >= stopAt) stopped = true; continue; }
            if (c.dead || c.state.idx >= n) continue;   // 窒息・NEXT 切れ
            if (pruned(c.state)) continue;
            total += rec(c.state);
        }
        if (timedOut || stopped) { partial.add(key); return total; }
        memo.set(key, total);
        return total;
    };
    // 並列の受け持ち（split）: search-tet.ts と同じ（SPLIT_DEPTH 手目の子に番号を付けて自分の分だけ rec。浅い所はメモに入れない）
    const split = opts.split && opts.split.parts > 1 ? opts.split : null;
    let item = 0;
    const top = (s: State, depth: number): number => {
        let total = 0;
        for (const c of children(doc, s, stats, s.idx > 0 || rootStable)) {
            if (timedOut || stopped) return total;
            if (depth + 1 === SPLIT_DEPTH && item++ % split!.parts !== split!.part) continue;
            if (c.cleared) {
                if (depth + 1 < SPLIT_DEPTH && split!.part !== 0) continue;
                total++; if (++found >= stopAt) stopped = true;
                continue;
            }
            if (c.dead || c.state.idx >= n || pruned(c.state)) continue;
            total += depth + 1 < SPLIT_DEPTH ? top(c.state, depth + 1) : rec(c.state);
        }
        return total;
    };
    const root: State = { b: rootB, idx: 0, score: 0, chainMax: 0, clearTimes: 0, isAllClear: false };
    const count = n === 0 || isDead(root.b) ? 0 : split ? top(root, 0) : rec(root);
    const searchMs = performance.now() - t0;

    const solutions: PuyoStep[][] = [];
    const path: PuyoStep[] = [];
    const walk = (s: State) => {
        for (const c of children(doc, s, { calls: 0, placements: 0 }, s.idx > 0 || rootStable)) {
            if (solutions.length >= opts.maxSolutions) return;
            path.push(c.step);
            if (c.cleared) solutions.push(path.slice());
            else if (!c.dead && c.state.idx < n) { const k = stateKey(c.state); if ((memo.get(k) ?? 0) > 0 || partial.has(k)) walk(c.state); }
            path.pop();
        }
    };
    let walkItem = 0;
    const walkTop = (s: State, depth: number) => {
        for (const c of children(doc, s, { calls: 0, placements: 0 }, s.idx > 0 || rootStable)) {
            if (solutions.length >= opts.maxSolutions) return;
            if (depth + 1 === SPLIT_DEPTH && walkItem++ % split!.parts !== split!.part) continue;
            path.push(c.step);
            if (c.cleared) { if (depth + 1 === SPLIT_DEPTH || split!.part === 0) solutions.push(path.slice()); }
            else if (!c.dead && c.state.idx < n && !pruned(c.state)) {
                if (depth + 1 < SPLIT_DEPTH) walkTop(c.state, depth + 1);
                else { const k = stateKey(c.state); if ((memo.get(k) ?? 0) > 0 || partial.has(k)) walk(c.state); }
            }
            path.pop();
        }
    };
    if (opts.maxSolutions > 0 && count > 0) { if (split) walkTop(root, 0); else walk(root); }

    return {
        count, complete: !timedOut && !stopped, timedOut, stopped,
        nodes, memoSize: memo.size, placementCalls: stats.calls, placements: stats.placements,
        searchMs, totalMs: performance.now() - t0, solutions,
    };
}
