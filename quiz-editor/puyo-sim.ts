// ─────────────────────────────────────────────
// puyo-sim.ts
// ぷよの1手シミュレーション（移動・回転・クイックターン・ちぎれ・連鎖・得点・全消し・クリア条件）
// ゲーム本体の挙動を移植したもの。元実装:
//   盤面/出現/固定/連鎖/得点 : public/game/puyo/engine.js（_getCell / _spawnPuyo / _fixPuyo / _findErasableInField / _calcChainScore / _buildDropAnim）
//   移動/回転/着地           : public/game/puyo/input.js（_tryMove / _tryRotate / _canPlace / _calcLimitY）
//   定数                     : public/core/base.js（PConfig）
//   クリア条件               : public/quiz/quiz.js（_checkClear / _checkClearOnPuyoChain）と engine.js の QUIZ ブロック
// ゲーム側を変えたらここも合わせること。最終確認は実機（テストプレイ）で行う。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-puyo-solve.md
// ─────────────────────────────────────────────
import type { EditorDoc, Pair } from './model.ts';

// ─── PConfig ───
const COLS = 6;
const ROWS = 12;            // 可視段
export const HIDDEN = 5;    // 隠し段
const TOTAL = ROWS + HIDDEN;
const ERASE_COUNT = 4;
const OJAMA = 6;
const SCORE_BASE = 10;
const ZENKESHI_BONUS = 2100;
const CHAIN_BONUS = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512];
const COLOR_BONUS = [0, 3, 6, 12, 24];
const GROUP_BONUS = [0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 10];

/** 子ぷよの位置（rot: 0=上 1=右 2=下 3=左） */
const DC = [0, 1, 0, -1];
const DR = [-1, 0, 1, 0];

/** grid[r][c]。r = 論理行 + HIDDEN（＝問題の initialPuyoField を下詰めにした 17 段と同じ） */
export type Grid = number[][];

/** 操作中のペア。y は軸ぷよの論理行（0=可視最上段。半端な値 -0.5 等もある）。qt = クイックターンの空振り回数 */
export interface PairPos { x: number; y: number; rot: number; qt: number; }

export function cloneGrid(g: Grid): Grid { return g.map(r => r.slice()); }
export function gridFromField(field: number[][]): Grid { return cloneGrid(field); }

// ─── 盤面の参照（engine.js _getCell / _setCell / _isCellEmpty） ───
function getCell(g: Grid, c: number, row: number): number | undefined {
    if (row <= -HIDDEN) return 0;   // 一番上の隠し段より上は常に空（ゲームと同じ）
    const r = row + HIDDEN;
    if (r < 0 || r >= g.length) return undefined;
    if (c < 0 || c >= COLS) return undefined;
    return g[r][c];
}
function setCell(g: Grid, c: number, row: number, v: number) {
    const r = row + HIDDEN;
    if (r < 0 || r >= g.length || c < 0 || c >= COLS) return;
    g[r][c] = v;
}
function isEmpty(g: Grid, c: number, row: number): boolean {
    if (c < 0 || c >= COLS) return false;
    if (row >= ROWS) return false;
    const v = getCell(g, c, row);
    return v === 0 || v === undefined;
}
/** 可視段が空か（全消しの判定。engine.js _isFieldEmpty） */
function visibleEmpty(g: Grid): boolean {
    for (let r = HIDDEN; r < TOTAL; r++) for (let c = 0; c < COLS; c++) if (g[r][c] !== 0) return false;
    return true;
}
/** 窒息（出現位置＝3列目の可視最上段が埋まっている） */
export function isDead(g: Grid): boolean { return !isEmpty(g, 2, 0); }

// ─── 置ける判定・着地（input.js） ───
function canPlaceGrid(g: Grid, pc: number, pr: number, rot: number): boolean {
    const cc = pc + DC[rot], cr = pr + DR[rot];
    if (pc < 0 || pc >= COLS || cc < 0 || cc >= COLS) return false;
    if (pr >= ROWS || cr >= ROWS) return false;
    const pv = getCell(g, pc, pr);
    if (pv !== 0 && pv !== undefined) return false;
    const cv = getCell(g, cc, cr);
    if (cv !== 0 && cv !== undefined) return false;
    return true;
}
export function canPlace(g: Grid, pc: number, py: number, rot: number): boolean {
    const r1 = Math.floor(py), r2 = Math.ceil(py);
    if (!canPlaceGrid(g, pc, r1, rot)) return false;
    if (r1 !== r2 && !canPlaceGrid(g, pc, r2, rot)) return false;
    return true;
}
/** 着地する軸の行（_calcLimitY） */
export function limitY(g: Grid, pc: number, py: number, rot: number): number {
    const cc = pc + DC[rot];
    let pr = Math.floor(py);
    while (pr < ROWS && isEmpty(g, pc, pr + 1)) pr++;
    let cr = Math.floor(py) + DR[rot];
    while (cr < ROWS && isEmpty(g, cc, cr + 1)) cr++;
    return Math.min(pr, cr - DR[rot]);
}
function limitYSingle(g: Grid, c: number, y: number): number {
    let r = Math.floor(y);
    while (r < ROWS && isEmpty(g, c, r + 1)) r++;
    return r;
}

// ─── 操作 ───
export function spawnPos(): PairPos { return { x: 2, y: -0.5, rot: 0, qt: 0 }; }

export function movedPos(g: Grid, p: PairPos, dx: number): PairPos | null {
    return canPlace(g, p.x + dx, p.y, p.rot) ? { ...p, x: p.x + dx, qt: 0 } : null;
}

/** 0.5 段下（_handleGravity と同じく着地位置で止まる）。位置が変わらなければ null */
export function softDropped(g: Grid, p: PairPos): PairPos | null {
    let y = p.y + 0.5;
    const lim = limitY(g, p.x, y, p.rot);
    if (y >= lim) y = lim;
    return y === p.y ? null : { ...p, y };
}

/** 0.5 段上（自由配置） */
export function raisedPos(g: Grid, p: PairPos): PairPos | null {
    const y = p.y - 0.5;
    return y >= -HIDDEN - 1 && canPlace(g, p.x, y, p.rot) ? { ...p, y } : null;
}

/**
 * 回転（_tryRotate と同じ）。ok=false でも qt（クイックターンの空振り回数）が増えた位置を返すので、呼び出し側はそれを保持する
 */
export function rotatedPos(g: Grid, p: PairPos, dir: 1 | -1): { pos: PairPos; ok: boolean } {
    const isVertical = p.rot === 0 || p.rot === 2;
    const newRot = ((p.rot + dir) % 4 + 4) % 4;
    let x = p.x, y = p.y, ok = false;
    if (newRot === 2 && !isVertical) {
        if (canPlace(g, x, y, newRot)) ok = true;
        else if (canPlace(g, x, y - 1, newRot)) { y -= 1; ok = true; }
    } else if (canPlace(g, x, y, newRot)) ok = true;
    else {
        for (const kick of [-1, 1]) {
            if (canPlace(g, x + kick, y, newRot)) { x += kick; ok = true; break; }
        }
    }
    if (ok) return { pos: { x, y, rot: newRot, qt: 0 }, ok: true };
    if (!isVertical) return { pos: p, ok: false };
    // 縦向きで回れない → 2 回目でクイックターン（180°）
    const qt = p.qt + 1;
    if (qt >= 2) {
        const qtRot = (p.rot + 2) % 4;
        if (p.rot === 0 && canPlace(g, p.x, p.y - 1, qtRot)) return { pos: { x: p.x, y: p.y - 1, rot: qtRot, qt: 0 }, ok: true };
        if (p.rot === 2 && canPlace(g, p.x, p.y, qtRot)) return { pos: { x: p.x, y: p.y, rot: qtRot, qt: 0 }, ok: true };
    }
    return { pos: { ...p, qt }, ok: false };
}

/** 着地位置（クイックドロップ） */
export function landedPos(g: Grid, p: PairPos): PairPos { return { ...p, y: limitY(g, p.x, p.y, p.rot) }; }

/** 軸・子のマス（論理行。y が半端なら半端なまま） */
export function pairCells(p: PairPos): { pivot: [number, number]; child: [number, number] } {
    return { pivot: [p.x, p.y], child: [p.x + DC[p.rot], p.y + DR[p.rot]] };
}

/**
 * 着地した位置で固定する（_fixPuyo。浮いた片方はちぎれて落ちる）。g を書き換える。
 * 戻り値は置いた 2 個の最終位置（論理行）
 */
export function fixPair(g: Grid, p: PairPos, pair: Pair): { pivot: [number, number]; child: [number, number] } {
    const pr = Math.round(p.y), pc = p.x;
    const cc = pc + DC[p.rot], cr = pr + DR[p.rot];
    const pivotFloating = isEmpty(g, pc, pr + 1);
    const childFloating = isEmpty(g, cc, cr + 1);
    if (pivotFloating && !childFloating) {
        setCell(g, cc, cr, pair[1]);
        const y = Math.round(limitYSingle(g, pc, pr));
        setCell(g, pc, y, pair[0]);
        return { pivot: [pc, y], child: [cc, cr] };
    }
    if (!pivotFloating && childFloating) {
        setCell(g, pc, pr, pair[0]);
        const y = Math.round(limitYSingle(g, cc, cr));
        setCell(g, cc, y, pair[1]);
        return { pivot: [pc, pr], child: [cc, y] };
    }
    setCell(g, pc, pr, pair[0]);
    setCell(g, cc, cr, pair[1]);
    return { pivot: [pc, pr], child: [cc, cr] };
}

// ─── 消去・連鎖（engine.js） ───
/** 消えるマス（grid の [r, c]。r は grid の行 index）。groups は色ぷよだけ、ojama は巻き込まれるおじゃま */
export function findErasable(g: Grid): { groups: { r: number; c: number; color: number }[][]; ojama: [number, number][] } {
    const visited = g.map(r => r.map(() => false));
    const groups: { r: number; c: number; color: number }[][] = [];
    const D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let r = HIDDEN; r < TOTAL; r++) for (let c = 0; c < COLS; c++) {
        if (visited[r][c]) continue;
        const color = g[r][c];
        if (color <= 0 || color === OJAMA) continue;
        const group: { r: number; c: number; color: number }[] = [];
        const queue: [number, number][] = [[r, c]];
        visited[r][c] = true;
        while (queue.length) {
            const [cr, cc] = queue.shift()!;
            group.push({ r: cr, c: cc, color });
            for (const [dr, dc] of D) {
                const nr = cr + dr, nc = cc + dc;
                if (nr < HIDDEN || nr >= TOTAL || nc < 0 || nc >= COLS) continue;
                if (visited[nr][nc] || g[nr][nc] !== color) continue;
                visited[nr][nc] = true;
                queue.push([nr, nc]);
            }
        }
        if (group.length >= ERASE_COUNT) groups.push(group);
    }
    const ojama: [number, number][] = [];
    const seen = new Set<string>();
    for (const group of groups) for (const cell of group) {
        for (const [dr, dc] of D) {
            const nr = cell.r + dr, nc = cell.c + dc;
            if (nr < HIDDEN || nr >= TOTAL || nc < 0 || nc >= COLS) continue;
            if (g[nr][nc] === OJAMA && !seen.has(`${nr},${nc}`)) { seen.add(`${nr},${nc}`); ojama.push([nr, nc]); }
        }
    }
    return { groups, ojama };
}

/** 連鎖 1 回ぶんの得点（_calcChainScore） */
function chainScore(groups: { color: number }[][], chain: number): number {
    const n = groups.reduce((a, g) => a + g.length, 0);
    const cb = CHAIN_BONUS[Math.min(Math.max(0, chain - 1), CHAIN_BONUS.length - 1)];
    const colors = new Set(groups.flatMap(g => g.map(cell => cell.color))).size;
    const colorB = COLOR_BONUS[Math.min(Math.max(0, colors - 1), COLOR_BONUS.length - 1)];
    let groupB = 0;
    for (const g of groups) groupB += GROUP_BONUS[Math.min(g.length, GROUP_BONUS.length - 1)];
    return SCORE_BASE * n * Math.max(1, cb + colorB + groupB);
}

/** 宙に浮いたぷよを下に詰める（_buildDropAnim。隠し段も含む） */
function applyGravity(g: Grid) {
    for (let c = 0; c < COLS; c++) {
        let w = TOTAL - 1;
        for (let r = TOTAL - 1; r >= 0; r--) {
            if (g[r][c] === 0) continue;
            const v = g[r][c];
            g[r][c] = 0;
            g[w--][c] = v;
        }
    }
}

export interface ChainLink { erase: [number, number][]; score: number; }
/**
 * 置いた後の盤面 g から連鎖を最後まで進める（g を書き換える）。
 * frames[0] = 置いた直後、frames[i] = i 連鎖目が消えて落ちた後（最後の frame ＝ 連鎖後の盤面）。links[i] は frames[i] で消えるぷよ
 */
export function resolveChains(g: Grid): { frames: Grid[]; links: ChainLink[] } {
    const frames: Grid[] = [cloneGrid(g)];
    const links: ChainLink[] = [];
    for (;;) {
        const { groups, ojama } = findErasable(g);
        if (!groups.length) break;
        const erase: [number, number][] = [...groups.flat().map(cell => [cell.r, cell.c] as [number, number]), ...ojama];
        links.push({ erase, score: chainScore(groups, links.length + 1) });
        for (const [r, c] of erase) g[r][c] = 0;
        applyGravity(g);
        frames.push(cloneGrid(g));
    }
    return { frames, links };
}

// ─────────────────────────────────────────────
// 手順（解答）のシミュレーション
// ─────────────────────────────────────────────

/** 1手の記録（psolutions.json に保存する形） */
export interface PuyoStep {
    x: number;       // 軸ぷよの列（0〜5）
    y: number;       // 着地後の軸ぷよの論理行（0=可視最上段）
    rot: number;     // 0=子が上 1=右 2=下 3=左
    free?: boolean;  // STRICT ではない操作（マウス・1段上）で置いた
}

export interface PuyoStepResult {
    error: string | null;
    pair: Pair | null;
    chain: number;        // この手の連鎖数
    chainScore: number;   // この手の得点（全消しボーナス込み）
    score: number;        // 累計（ソフトドロップの加点は含まない）
    allClear: boolean;    // この手で全消し
    dead: boolean;        // この手の後に窒息（クリアしていなければゲームオーバー）
    condMet: boolean;     // count 条件の「1回」に当たるか
    clearTimes: number;   // count 条件の累計
    cleared: boolean;
}

export interface PuyoSimResult {
    grids: Grid[];            // grids[k] = k 手置いた後（連鎖後）。grids[0] = 初期盤面
    frames: Grid[][];         // frames[k] = k+1 手目の途中の盤面（置いた直後〜連鎖後）
    links: ChainLink[][];     // links[k] = k+1 手目の連鎖（links[k][i] は frames[k][i] で消えるぷよ）
    results: PuyoStepResult[];
    clearedAt: number;        // 最初にクリアした手（1始まり）。未達なら 0
    firstError: number;       // 最初にエラーになった手（1始まり）。無ければ 0
    deadAt: number;           // 窒息した手（1始まり。初期盤面で窒息なら -1）。無ければ 0
}

/** その手で置く位置が正しいか（置けて、そこが着地位置） */
export function validLanding(g: Grid, s: PuyoStep): boolean {
    return Number.isInteger(s.x) && Number.isInteger(s.y) && s.rot >= 0 && s.rot <= 3 &&
        canPlace(g, s.x, s.y, s.rot) && limitY(g, s.x, s.y, s.rot) === s.y;
}

export function simulatePuyo(doc: EditorDoc, steps: PuyoStep[]): PuyoSimResult {
    let g = gridFromField(doc.field);
    const out: PuyoSimResult = { grids: [cloneGrid(g)], frames: [], links: [], results: [], clearedAt: 0, firstError: 0, deadAt: isDead(g) ? -1 : 0 };
    let score = 0, chainMax = 0, clearTimes = 0, isAllClear = false;
    const c = doc.cond;

    steps.forEach((s, i) => {
        const r: PuyoStepResult = {
            error: null, pair: doc.pairs[i] ?? null, chain: 0, chainScore: 0, score, allClear: false, dead: false,
            condMet: false, clearTimes, cleared: false,
        };
        out.results.push(r);
        const stay = () => { out.grids.push(cloneGrid(g)); out.frames.push([cloneGrid(g)]); out.links.push([]); };
        if (out.firstError) { r.error = '前の手にエラーがあります'; stay(); return; }
        if (!r.pair) r.error = 'NEXT が足りません';
        else if (out.clearedAt) r.error = 'クリア後の手です（ゲームでは置けません）';
        else if (out.deadAt) r.error = out.deadAt < 0 ? '初期盤面で窒息しています（3列目の最上段が埋まっている）' : '窒息した後の手です（ゲームオーバー）';
        else if (!validLanding(g, s)) r.error = '置けない位置です';
        if (r.error) { out.firstError = i + 1; stay(); return; }

        g = cloneGrid(g);
        fixPair(g, { x: s.x, y: s.y, rot: s.rot, qt: 0 }, r.pair!);
        const { frames, links } = resolveChains(g);
        r.chain = links.length;
        r.chainScore = links.reduce((a, l) => a + l.score, 0);
        if (r.chain > 0) {
            isAllClear = false;
            if (visibleEmpty(g)) { r.chainScore += ZENKESHI_BONUS; r.allClear = true; isAllClear = true; }
        }
        score += r.chainScore;
        chainMax = Math.max(chainMax, r.chain);
        r.score = score;

        // ─── クリア条件（engine.js の QUIZ ブロック → quiz.js）。count は連鎖があった手だけ数える ───
        if (c.type === 'count') {
            if (r.chain > 0) {
                const cv = c.countValue ?? 1;
                const inner = c.countCondition === 'chain' ? r.chain >= cv
                    : c.countCondition === 'allClear' ? isAllClear
                    : c.countCondition === 'score' ? score >= cv : false;
                if (inner) { clearTimes++; r.condMet = true; }
            }
            r.clearTimes = clearTimes;
            r.cleared = clearTimes >= c.value;
        } else {
            r.cleared = c.type === 'chain' ? chainMax >= c.value
                : c.type === 'allClear' ? isAllClear
                : c.type === 'score' ? score >= c.value : false;
        }
        if (r.cleared && !out.clearedAt) out.clearedAt = i + 1;
        else if (!r.cleared && isDead(g)) { r.dead = true; out.deadAt = i + 1; }

        out.grids.push(cloneGrid(g));
        out.frames.push(frames);
        out.links.push(links);
    });
    return out;
}

const DIR_MARK = ['↑', '→', '↓', '←'];
/** 置いた位置の短い説明（「3列 ↑」＝軸が 3 列目・子が上） */
export function describePlace(s: PuyoStep): string { return `${s.x + 1}列 ${DIR_MARK[s.rot & 3]}`; }

/** 手順リスト用の結果の説明 */
export function describePuyoResult(r: PuyoStepResult): string {
    const parts: string[] = [];
    if (r.chain) parts.push(`${r.chain}連鎖 ${r.chainScore.toLocaleString()}点`);
    if (r.allClear) parts.push('全消し');
    return parts.join(' / ');
}
