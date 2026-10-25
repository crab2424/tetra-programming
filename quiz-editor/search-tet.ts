// ─────────────────────────────────────────────
// search-tet.ts
// テトの解の探索（SEARCH 段階 S1）: ビットボード盤面・STRICT 相当の配置列挙（BFS）・メモ化 DFS で解の数を数える
// ルール（形状・キック・T-Spin の判定表・得点・クリア条件）は tet-sim.ts から借りる。盤面の扱いだけここで持つ。
// 見つけた解は search.ts の verifySolutions で simulate() に通して検算する。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-solver.md
// ─────────────────────────────────────────────
import type { Cond, EditorDoc } from './model.ts';
import { classifyTSpin, kickTable, scoreLock, shapeOf, SIM_TOP, type Step, type TetProgress } from './tet-sim.ts';
import { SPLIT_DEPTH, type SearchOptions, type SearchResult } from './search.ts';

/** 進捗を送る間隔 */
const PROGRESS_MS = 200;

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

// 状態 index = (rot*28 + y+8)*16 + x+3。世代スタンプで訪問済みを判定（毎回の初期化をしない）。
// 最後の操作（flag）は次の操作に影響しないので状態に入れず、その位置に届いた最後の操作の種類を bit で覚える（接地した所の T-Spin 判定だけに使う）
const Y_OFF = 8, X_OFF = 3, NY = 28, NX = 16;
const visited = new Int32Array(4 * NY * NX);
const flagsAt = new Uint8Array(visited.length);
let generation = 0;
const qx = new Int8Array(visited.length), qy = new Int8Array(visited.length), qr = new Int8Array(visited.length);
const seenKeys = new Set<number>();

// BFS 1 回ぶんの「置けるか」の表: fitTab[rot * NX + x+X_OFF] の bit (y+Y_OFF) = その位置に置ける（fits と同じ）。
// 盤面の段ごとの当たり（行マスク → 当たる段の bit）は同じ行マスクを使い回す
const fitTab = new Int32Array(4 * NX);
const hitStamp = new Int32Array(1 << COLS), hitVal = new Int32Array(1 << COLS);
const Y_BITS = (1 << NY) - 1;
let hitGen = 0;
function buildFitTab(b: Board, type: number) {
    const gen = ++hitGen;
    for (let rot = 0; rot < 4; rot++) {
        const sh = SHAPES[type][rot];
        for (let xi = 0; xi < NX; xi++) {
            const x = xi - X_OFF;
            if (x + sh.minX < 0 || x + sh.maxX >= COLS) { fitTab[rot * NX + xi] = 0; continue; }
            let blocked = 0;
            for (let i = 0; i < sh.dy.length; i++) {
                const m = x >= 0 ? sh.mask[i] << x : sh.mask[i] >> -x;
                if (hitStamp[m] !== gen) {
                    let h = ~((1 << ROWS) - 1);   // 段 25 以上（床）は当たり
                    for (let r = 0; r < ROWS; r++) if (b[r] & m) h |= 1 << r;
                    hitStamp[m] = gen; hitVal[m] = h;
                }
                // 段 r = (y+Y_OFF) + sh.dy[i] + SIM_TOP - Y_OFF。dy ≤ 3 なので右へずらす量は 0〜3（段 < 0 は当たり）
                const sft = Y_OFF - SIM_TOP - sh.dy[i];
                blocked |= (hitVal[m] << sft) | ((1 << sft) - 1);
            }
            fitTab[rot * NX + xi] = ~blocked & Y_BITS;
        }
    }
}
function fitsAt(rot: number, x: number, y: number): boolean {
    const xi = x + X_OFF, yi = y + Y_OFF;
    if (xi < 0 || xi >= NX || yi < 0 || yi >= NY) return false;
    return ((fitTab[rot * NX + xi] >>> yi) & 1) === 1;
}

/**
 * 宙の近道: 一番上のブロックより上は全部空いているので、そこ（宙）の状態はどこへでも動ける。
 * 1 回の操作で「ピースの一番下のマスの段」が下がるのは最大 BAND_D 段（ソフトドロップ 1・キック＋向きの違い）なので、
 * 宙から出る直前の状態は必ず「一番下のマスが topR−2−BAND_D 〜 topR−2 段」の帯の中にある。
 * 帯の全状態（置ける x・向き。最後の操作は移動扱い＝宙では T-Spin にならないので結果は同じ）から BFS を始めれば、出現位置から始めたのと同じ置き場所になる。
 * 出現位置の近くまで積まれている時（帯が FREE_MIN_ROW 段より上）は使わない（宙の全状態に届くとは限らないため）
 */
const BAND_D = Math.max(1, ...SHAPES.flatMap((rots, type) => rots.flatMap((sh, rot) => KICKS[type][rot].flatMap((k, d) => {
    const to = SHAPES[type][(rot + (d === 0 ? 1 : 3)) & 3];
    const out: number[] = [];
    for (let i = 0; i < k.length; i += 2) out.push(k[i + 1] + to.dy[to.dy.length - 1] - sh.dy[sh.dy.length - 1]);
    return out;
}))));
const FREE_MIN_ROW = 10;

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
    buildFitTab(b, type);
    return placementsOnFitTab(b, type);
}

/** tetPlacements の本体（fitTab はこの盤面・ミノで作ってあること） */
function placementsOnFitTab(b: Board, type: number): TetPlacement[] {
    const out: TetPlacement[] = [];
    const sy = spawnY(b, type);
    if (sy === null) return out;
    const gen = ++generation;
    const isT = type === 2;
    seenKeys.clear();
    let head = 0, tail = 0;
    const push = (x: number, y: number, rot: number, flag: number) => {
        const id = (rot * NY + y + Y_OFF) * NX + x + X_OFF;
        if (visited[id] === gen) { flagsAt[id] |= 1 << flag; return; }
        visited[id] = gen;
        flagsAt[id] = 1 << flag;
        qx[tail] = x; qy[tail] = y; qr[tail] = rot; tail++;
    };
    let topR = 0;
    while (topR < ROWS && !b[topR]) topR++;
    const bandHi = topR - 2, bandLo = bandHi - BAND_D;
    if (bandLo >= FREE_MIN_ROW) {
        for (let rot = 0; rot < 4; rot++) {
            const sh = SHAPES[type][rot], low = sh.dy[sh.dy.length - 1] + SIM_TOP;
            for (let x = -X_OFF; x < NX - X_OFF; x++) {
                if (!fitTab[rot * NX + x + X_OFF]) continue;
                for (let r = bandLo; r <= bandHi; r++) if (fitsAt(rot, x, r - low)) push(x, r - low, rot, 0);
            }
        }
    } else push(3, sy, 0, 0);
    while (head < tail) {
        const x = qx[head], y = qy[head], rot = qr[head]; head++;
        if (fitsAt(rot, x - 1, y)) push(x - 1, y, rot, 0);
        if (fitsAt(rot, x + 1, y)) push(x + 1, y, rot, 0);
        if (fitsAt(rot, x, y + 1)) push(x, y + 1, rot, 0);
        for (let d = 0; d < 2; d++) {
            const k = KICKS[type][rot][d];
            const to = (rot + (d === 0 ? 1 : 3)) & 3;
            for (let i = 0; i < k.length; i += 2) {
                const nx = x + k[i], ny = y + k[i + 1];
                if (fitsAt(to, nx, ny)) { push(nx, ny, to, isT ? (i === 8 ? 2 : 1) : 0); break; }
            }
        }
    }
    // 接地した位置を、届いた最後の操作の種類ごとに置き場所にする
    for (let q = 0; q < tail; q++) {
        const x = qx[q], y = qy[q], rot = qr[q];
        if (fitsAt(rot, x, y + 1)) continue;
        const sh = SHAPES[type][rot];
        const flags = flagsAt[(rot * NY + y + Y_OFF) * NX + x + X_OFF];
        // 置いたマスの正規形: 一番上の行 + 行マスク（向きの番号が違っても同じマスなら同じ値）
        let cellKey = y + sh.dy[0] + SIM_TOP;
        for (let i = 0; i < sh.dy.length; i++) cellKey = cellKey * 1024 + (x >= 0 ? sh.mask[i] << x : sh.mask[i] >> -x);
        for (let i = sh.dy.length; i < 4; i++) cellKey *= 1024;
        for (let flag = 0; flag < 3; flag++) {
            if (!((flags >> flag) & 1)) continue;
            let spin: 'tspin' | 'mini' | null = null;
            if (isT && flag > 0) {
                const px = x + 1, py = y + 2;
                spin = classifyTSpin(rot, [corner(b, px - 1, py - 1), corner(b, px + 1, py - 1), corner(b, px - 1, py + 1), corner(b, px + 1, py + 1)], flag === 2);
            }
            const key = cellKey * 3 + (spin === null ? 0 : spin === 'mini' ? 1 : 2);
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            out.push({ type, rot, x, y, flag, spin });
        }
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

/**
 * メモのキーに入れる値（設計 §2.4: 条件がこの先で使う値だけ。同じ値になれば合流する）。
 * renCap: REN をこの値で頭打ち（-1 = 入れない）、scoreCap: スコアを頭打ち（-1 = 入れない）
 */
interface KeyMode { ren: number; b2b: boolean; score: number; lines: boolean; times: boolean; }

export function keyModeOf(c: Cond, prune: boolean): KeyMode {
    if (!prune) return { ren: Infinity, b2b: true, score: Infinity, lines: true, times: true };
    const inner = c.type === 'count' ? c.countCondition : c.type;
    const times = c.type === 'count';
    switch (inner) {
        // 得点は REN ボーナス（min(REN, 20)）と B2B で決まる。count の score は累計が countValue に届けば以降は毎手 1 回
        case 'score': return { ren: 20, b2b: true, score: c.type === 'count' ? c.countValue : Infinity, lines: false, times };
        case 'ren': return { ren: c.type === 'count' ? c.countValue : c.value, b2b: false, score: -1, lines: false, times };
        case 'clearLines': case 'lines': return { ren: -1, b2b: false, score: -1, lines: c.type !== 'count', times };
        // allClear・T-Spin 系は「その手」だけで決まる
        default: return { ren: -1, b2b: false, score: -1, lines: false, times };
    }
}

const keyBuf = new Uint16Array(ROWS + 8);
function stateKeyOf(s: State, k: KeyMode): string {
    keyBuf.set(s.b, 0);
    keyBuf[ROWS] = s.idx;
    keyBuf[ROWS + 1] = s.hold + 1;
    keyBuf[ROWS + 2] = k.ren < 0 ? 0 : Math.min(s.ren, k.ren);
    keyBuf[ROWS + 3] = k.b2b && s.b2b ? 1 : 0;
    const score = k.score < 0 ? 0 : Math.min(s.score, k.score);
    keyBuf[ROWS + 4] = score & 0xffff;
    keyBuf[ROWS + 5] = Math.floor(score / 65536);
    keyBuf[ROWS + 6] = k.lines ? s.totalLines : 0;
    keyBuf[ROWS + 7] = k.times ? s.clearTimes : 0;
    return String.fromCharCode.apply(null, keyBuf as unknown as number[]);
}

// ─── 枝刈り（設計 §2.5。解を落とさないものだけ） ───

function popcount(v: number): number { let n = 0; for (; v; v &= v - 1) n++; return n; }
/** 1 行（10 bit）のマス数 */
const POP = Uint8Array.from({ length: 1 << COLS }, (_, v) => popcount(v));

/** 1 手の得点の上限（B2B T-Spin Triple 2400 ＋ PC 1800 ＋ REN 1000） */
const MAX_MOVE_SCORE = 5200;

/**
 * PC に届き得るか。残りに置けるのは最大 left 個。k 個置いて PC なら消す段数 L = (セル数 + 4k) / 10 で、
 * ①一番高いブロックの高さ ≤ L（ブロックの下の段はどれも何か入っている＝L 段全部を消す必要がある）
 * ②下 L 段を「隣り合う 2 列のどちらかが全段で埋まっている」壁で区切った区間ごとに、空きマスが 4 の倍数（pc6 validateRegion・sfinder と同じ）
 * を満たす k が 1 つでもあれば true
 */
function pcPossible(b: Board, left: number): boolean {
    let cells = 0, top = ROWS;
    for (let r = ROWS - 1; r >= 0; r--) { if (b[r]) { cells += popcount(b[r]); top = r; } }
    const h = ROWS - top;
    for (let k = 1; k <= left; k++) {
        if ((cells + 4 * k) % 10) continue;
        const L = (cells + 4 * k) / 10;
        if (L < h || L > ROWS) continue;
        let ok = true, empties = 0;
        for (let x = 0; x < COLS && ok; x++) {
            for (let r = ROWS - L; r < ROWS; r++) if (!((b[r] >> x) & 1)) empties++;
            if (x === COLS - 1) { ok = empties % 4 === 0; break; }
            let wall = true;
            for (let r = ROWS - L; r < ROWS; r++) if (!((b[r] >> x) & 1) && !((b[r] >> (x + 1)) & 1)) { wall = false; break; }
            if (wall) { ok = empties % 4 === 0; empties = 0; }
        }
        if (ok) return true;
    }
    return false;
}

/**
 * state: true なら、この状態からは条件を満たせない。
 * placement: 子の状態を作る前に、置き場所だけで同じ判定をする（T-Spin 系のみ。T-Spin にならない置き場所は回数が増えないので、
 * 段ごとのマス数だけで state と同じ結論になる）。子の 98% 以上がここで落ちるので、盤面の複製・得点の計算を省ける
 */
interface Pruner {
    state: (s: State) => boolean;
    /** begin(s) を状態ごとに 1 回呼んでから、その状態の置き場所ごとに placement を呼ぶ */
    placement: {
        begin: (s: State) => void;
        test: (s: State, p: TetPlacement, idx: number, hold: number) => boolean;
        /** 届くかを考えずに、接地できる位置のどれかが test を通るか（通る位置が無ければ BFS をしない）。fitTab はこの盤面・ミノで作ってあること */
        anySpot: (s: State, type: number, idx: number, hold: number) => boolean;
    } | null;
}

function makePrune(doc: EditorDoc): Pruner {
    const c = doc.cond, n = doc.next.length;
    const inner = c.type === 'count' ? c.countCondition : c.type;
    const needsT = inner === 'tspin' || inner === 'tspinSingle' || inner === 'tspinDouble' || inner === 'tspinTriple';
    // tSuffix[i] = next[i..] の T の数
    const tSuffix = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) tSuffix[i] = tSuffix[i + 1] + (doc.next[i] === 2 ? 1 : 0);
    // T-Spin 1 回で消す段数（0 = 段数を問わない）と、NEXT の T の位置
    const spinLines = !needsT ? 0 : inner === 'tspinSingle' ? 1 : inner === 'tspinDouble' ? 2 : inner === 'tspinTriple' ? 3
        : Math.max(0, c.type === 'count' ? c.countValue : c.value);
    const tPos: number[] = [];
    doc.next.forEach((t, i) => { if (t === 2) tPos.push(i); });
    // firstTAt[i] = next[i..] で最初の T の tPos の番号（無ければ tPos.length）
    const firstTAt = new Array(n + 1).fill(tPos.length);
    for (let i = n - 1; i >= 0; i--) firstTAt[i] = doc.next[i] === 2 ? tPos.indexOf(i) : firstTAt[i + 1];
    /**
     * 段を埋めるマスの予算（設計 §14）: あと必要な T-Spin（各 spinLines 段）j 回分の段は、j 回目の T-Spin までに全部埋まっていなければならない。
     * 段が埋まるのは置いたマスだけ（消えた段の残りは他の段に移らない）なので、
     * 「空きマスの少ない順に j·spinLines 段の空きの合計 ＞ その T までに置けるピース数 × 4」なら届かない。
     * HOLD なしは j 回目の T-Spin が「残りの T のうち 後ろから (残り回数 − j) 個を残した T」より後にはなれない。
     * HOLD ありは T をいくらでも遅らせられるが、その後にあと (残り回数 − j) 回置く分は残す。
     * hist[e] = 空きが e マスの段の数（盤面の 25 段。消えた段は上に足される空の段＝10 として数える）
     */
    const rowBudgetFails = (hist: Int16Array, idx: number, timesLeft: number, left: number): boolean => {
        const firstT = firstTAt[idx];
        const tLeft = tPos.length - firstT;
        let need = 0, e = 0, used = 0;
        for (let j = 1; j <= timesLeft; j++) {
            for (let k = 0; k < spinLines; k++) {
                while (e < COLS && used >= hist[e]) { e++; used = 0; }
                need += e; used++;   // 盤面の段が尽きたら新しい空の段（10 マス）
            }
            const pieces = doc.allowHold ? left - (timesLeft - j) : tPos[firstT + tLeft - timesLeft + j - 1] - idx + 1;
            if (need > 4 * pieces) return true;
        }
        return false;
    };
    // T-Spin 系の判定（state と placement で共通）
    const spinFails = (hist: Int16Array | null, idx: number, hold: number, clearTimes: number): boolean => {
        const left = n - idx;
        const timesLeft = c.type === 'count' ? c.value - clearTimes : 1;
        if (timesLeft > left) return true;
        if (tSuffix[idx] + (hold === 2 ? 1 : 0) < timesLeft) return true;
        return spinLines > 0 && hist !== null && rowBudgetFails(hist, idx, timesLeft, left);
    };
    const stateHist = new Int16Array(COLS + 1), parentHist = new Int16Array(COLS + 1), childHist = new Int16Array(COLS + 1);
    const parentCnt = new Uint8Array(ROWS);
    let parentFull = 0;
    /** その T-Spin が条件の 1 回に数えられるか（scoreLock の判定と同じ） */
    const spinValue = c.type === 'count' ? c.countValue : c.value;
    const spinCounts = (spin: 'tspin' | 'mini', lines: number): boolean =>
        inner === 'tspin' ? lines >= spinValue
            : spin === 'tspin' && lines === (inner === 'tspinSingle' ? 1 : inner === 'tspinDouble' ? 2 : 3);
    const histOf = (b: Board, out: Int16Array) => {
        out.fill(0);
        for (let r = 0; r < ROWS; r++) out[COLS - POP[b[r]]]++;
    };
    const placement = !needsT ? null : {
        begin: (s: State) => {
            for (let r = 0; r < ROWS; r++) parentCnt[r] = POP[s.b[r]];
            histOf(s.b, parentHist);
            // 置く前から埋まっている段（初めの盤面だけ）は、どこに置いても消える＝空の段になる
            parentFull = parentHist[0];
            parentHist[COLS] += parentHist[0]; parentHist[0] = 0;
        },
        test: (s: State, p: TetPlacement, idx: number, hold: number): boolean => {
            // 置いた後の段ごとの空き（触った段だけ差し替える。10 マス埋まった段は消えて空の段になる）と消える段数
            childHist.set(parentHist);
            let lines = parentFull;
            const sh = SHAPES[p.type][p.rot];
            for (let i = 0; i < sh.dy.length; i++) {
                const old = parentCnt[p.y + sh.dy[i] + SIM_TOP], nw = old + POP[sh.mask[i]];
                childHist[COLS - old]--;
                if (nw === COLS) { childHist[COLS]++; lines++; } else childHist[COLS - nw]++;
            }
            // 条件の T-Spin になる手は回数・クリアが変わるので子を作って判定する。それ以外の T-Spin（Mini・段数違い）は置くだけの手と同じ
            if (p.spin !== null && spinCounts(p.spin, lines)) return false;
            return spinFails(spinLines > 0 ? childHist : null, idx, hold, s.clearTimes);
        },
        anySpot(s: State, type: number, idx: number, hold: number): boolean {
            const spot = { type, rot: 0, x: 0, y: 0, flag: 0, spin: null } as TetPlacement;
            for (let rot = 0; rot < 4; rot++) {
                for (let xi = 0; xi < NX; xi++) {
                    const fit = fitTab[rot * NX + xi];
                    // 接地 = その y に置けて y+1 に置けない
                    for (let g = fit & ~(fit >>> 1); g; g &= g - 1) {
                        const y = 31 - Math.clz32(g & -g) - Y_OFF, x = xi - X_OFF;
                        spot.rot = rot; spot.x = x; spot.y = y; spot.spin = null;
                        if (!this.test(s, spot, idx, hold)) return true;
                        if (type === 2) {
                            // 角が 3 つ埋まっていれば回転で入ると T-Spin（通常か Mini）になり得る
                            const px = x + 1, py = y + 2;
                            if (+corner(s.b, px - 1, py - 1) + +corner(s.b, px + 1, py - 1) + +corner(s.b, px - 1, py + 1) + +corner(s.b, px + 1, py + 1) >= 3) {
                                spot.spin = 'tspin'; if (!this.test(s, spot, idx, hold)) return true;
                                spot.spin = 'mini'; if (!this.test(s, spot, idx, hold)) return true;
                            }
                        }
                    }
                }
            }
            return false;
        },
    };
    const state = (s: State): boolean => {
        const left = n - s.idx;   // あと置ける最大の手数（NEXT が尽きたら HOLD 中のピースは置けない）
        const timesLeft = c.type === 'count' ? c.value - s.clearTimes : 1;
        if (timesLeft > left) return true;   // 1 手で数えられるのは 1 回まで
        if (needsT) {
            if (spinLines > 0) histOf(s.b, stateHist);
            if (spinFails(spinLines > 0 ? stateHist : null, s.idx, s.hold, s.clearTimes)) return true;
        }
        switch (inner) {
            case 'allClear': return !pcPossible(s.b, left);
            case 'ren': {
                // あと必要な連続消去: REN を目標まで伸ばす分＋目標以上で消す 1 手
                const target = c.type === 'count' ? c.countValue : c.value;
                if (c.type !== 'count' && Math.max(1, target - s.ren + 1) > left) return true;
                break;
            }
            case 'clearLines': case 'lines': {
                let cells = 0;
                for (let r = 0; r < ROWS; r++) cells += popcount(s.b[r]);
                const maxLines = Math.floor((cells + 4 * left) / 10);   // 1 段消すのに 10 マス要る
                if (c.type === 'count') { if (timesLeft * c.countValue > maxLines) return true; }
                else if (s.totalLines + maxLines < c.value) return true;
                break;
            }
            case 'score':
                if (c.type !== 'count' && s.score + MAX_MOVE_SCORE * left < c.value) return true;
                break;
        }
        return false;
    };
    return { state, placement };
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

/** pre: 子を作る前の枝刈り（Pruner.placement。null なら全部作る）。落とした子は返さない */
function children(doc: EditorDoc, s: State, stats: { calls: number; placements: number }, pre: Pruner['placement'] = null): Child[] {
    const out: Child[] = [];
    let cacheType = -1, cache: TetPlacement[] = [];
    pre?.begin(s);
    let fitType = -1;
    for (const o of options(doc, s)) {
        if (o.type !== fitType) { buildFitTab(s.b, o.type); fitType = o.type; }
        // 枝刈りを通る位置がどこにも無ければ、届く所を調べるまでもない
        if (pre && !pre.anySpot(s, o.type, o.idx, o.holdAfter)) continue;
        // 通常と HOLD が同じ種類なら列挙は 1 回で済む（盤面が同じ）
        if (o.type !== cacheType) { cache = placementsOnFitTab(s.b, o.type); cacheType = o.type; stats.calls++; stats.placements += cache.length; }
        for (const p of cache) {
            if (pre && pre.test(s, p, o.idx, o.holdAfter)) continue;
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
    const partial = new Set<string>();   // 打ち切り・上限で途中までしか数えなかった状態（解の取り出しではここにも入る）
    const stats = { calls: 0, placements: 0 };
    let nodes = 0, found = 0, timedOut = false, stopped = false;
    let lastReport = t0;
    const stopAt = opts.stopAt ?? Infinity;
    const km = keyModeOf(doc.cond, opts.prune !== false);
    const pruner = opts.prune !== false ? makePrune(doc) : null;
    const pruned = pruner ? pruner.state : () => false;
    const pre = pruner ? pruner.placement : null;
    const stateKey = (s: State) => stateKeyOf(s, km);

    // 戻り値はその状態から先の解の数。打ち切り時は「それまでに数えた分」（下限）を返し、メモには残さない
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
        for (const c of children(doc, s, stats, pre)) {
            if (timedOut || stopped) { partial.add(key); return total; }
            if (c.cleared) { total++; if (++found >= stopAt) stopped = true; continue; }
            if (c.state.idx >= doc.next.length) continue;   // NEXT 切れ（HOLD 中のピースだけでは置けない）
            if (pruned(c.state)) continue;
            total += rec(c.state);
        }
        if (timedOut || stopped) { partial.add(key); return total; }
        memo.set(key, total);
        return total;
    };
    // 並列の受け持ち（split）: SPLIT_DEPTH 手目までは浅い所をメモなしでたどり、その深さの子に番号を付けて自分の分だけ rec する。
    // 浅い所の状態は一部しか数えないのでメモに入れない（rec が同じ状態を全部数えてメモに入れても食い違わない）
    const split = opts.split && opts.split.parts > 1 ? opts.split : null;
    let item = 0;
    const top = (s: State, depth: number): number => {
        let total = 0;
        for (const c of children(doc, s, stats, pre)) {
            if (timedOut || stopped) return total;
            if (depth + 1 === SPLIT_DEPTH && item++ % split!.parts !== split!.part) continue;
            if (c.cleared) {
                if (depth + 1 < SPLIT_DEPTH && split!.part !== 0) continue;
                total++; if (++found >= stopAt) stopped = true;
                continue;
            }
            if (c.state.idx >= doc.next.length || pruned(c.state)) continue;
            total += depth + 1 < SPLIT_DEPTH ? top(c.state, depth + 1) : rec(c.state);
        }
        return total;
    };
    const root: State = { b: boardFromField(doc.field), idx: 0, hold: -1, ren: 0, b2b: false, score: 0, totalLines: 0, clearTimes: 0 };
    const count = split ? top(root, 0) : rec(root);
    const searchMs = performance.now() - t0;

    // 解の取り出し: メモで「解が 1 つ以上」と分かっている子と、途中で止めた子だけをたどる（split の浅い所は top と同じ番号で自分の分だけ）
    const solutions: Step[][] = [];
    const path: Step[] = [];
    const walk = (s: State) => {
        for (const c of children(doc, s, { calls: 0, placements: 0 })) {
            if (solutions.length >= opts.maxSolutions) return;
            path.push(c.step);
            if (c.cleared) solutions.push(path.slice());
            else if (c.state.idx < doc.next.length) { const k = stateKey(c.state); if ((memo.get(k) ?? 0) > 0 || partial.has(k)) walk(c.state); }
            path.pop();
        }
    };
    let walkItem = 0;
    const walkTop = (s: State, depth: number) => {
        for (const c of children(doc, s, { calls: 0, placements: 0 }, pre)) {
            if (solutions.length >= opts.maxSolutions) return;
            if (depth + 1 === SPLIT_DEPTH && walkItem++ % split!.parts !== split!.part) continue;
            path.push(c.step);
            if (c.cleared) { if (depth + 1 === SPLIT_DEPTH || split!.part === 0) solutions.push(path.slice()); }
            else if (c.state.idx < doc.next.length && !pruned(c.state)) {
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
