// ─────────────────────────────────────────────
// tet-sim.ts
// テトの1手シミュレーション（回転・キック・T-Spin・ライン消去・REN・スコア・クリア条件）
// ゲーム本体の挙動を移植したもの。元実装:
//   回転/キック/T-Spin : public/game/tet/rotation.js（tryRotate / validRotated / checkTSpin）
//   出現/固定/消去     : public/game/tet/board.js（popMino / secureMino / valid）
//   スコア             : public/game/tet/scoring.js（Scoring。QUIZ はレベル1）
//   クリア条件         : public/quiz/quiz.js（_checkClear / _checkClearOnSecure）
// ゲーム側を変えたらここも合わせること。最終確認は実機（テストプレイ）で行う。
// ─────────────────────────────────────────────
import { type EditorDoc, TET_COLS, TET_ROWS } from './model.ts';

/** 盤面の上に持つ見えない段数（ゲームの valid は y >= -5 まで許可） */
export const SIM_TOP = 5;
const SIM_ROWS = TET_ROWS + SIM_TOP;

/** grid[r][x]。r = y + SIM_TOP（y は盤面座標、0=可視最上段）。値は盤面の色ID（1始まり） */
export type Grid = number[][];

export interface Piece { type: number; rot: number; x: number; y: number; }

// ─── ミノ形状（Mino.initBlocks と pivot。回転は Mino.rotate と同じ計算で事前生成） ───
const BASE: { blocks: [number, number][]; pivot: [number, number] }[] = [
    { blocks: [[0, 1], [1, 1], [2, 1], [3, 1]], pivot: [1.5, 1.5] }, // I
    { blocks: [[1, 1], [2, 1], [1, 2], [2, 2]], pivot: [1.5, 1.5] }, // O
    { blocks: [[1, 1], [0, 2], [1, 2], [2, 2]], pivot: [1, 2] },     // T
    { blocks: [[0, 1], [0, 2], [1, 2], [2, 2]], pivot: [1, 2] },     // J
    { blocks: [[2, 1], [0, 2], [1, 2], [2, 2]], pivot: [1, 2] },     // L
    { blocks: [[1, 1], [2, 1], [0, 2], [1, 2]], pivot: [1, 2] },     // S
    { blocks: [[0, 1], [1, 1], [1, 2], [2, 2]], pivot: [1, 2] },     // Z
];

const SHAPES: [number, number][][][] = BASE.map(({ blocks, pivot: [px, py] }) => {
    const states: [number, number][][] = [blocks];
    for (let r = 1; r < 4; r++) {
        states.push(states[r - 1].map(([bx, by]) => {
            const relX = bx - px, relY = by - py;
            return [Math.round(-relY + px), Math.round(relX + py)] as [number, number];
        }));
    }
    return states;
});

export function shapeOf(type: number, rot: number): [number, number][] { return SHAPES[type][rot & 3]; }

export function cellsOf(p: Piece): [number, number][] {
    return shapeOf(p.type, p.rot).map(([bx, by]) => [p.x + bx, p.y + by]);
}

// ─── 盤面 ───
export function gridFromField(field: number[][]): Grid {
    const g: Grid = Array.from({ length: SIM_TOP }, () => new Array(TET_COLS).fill(0));
    for (const row of field) g.push(row.slice());
    return g;
}
export function visibleField(g: Grid): number[][] { return g.slice(SIM_TOP).map(r => r.slice()); }
export function cloneGrid(g: Grid): Grid { return g.map(r => r.slice()); }

function occupied(g: Grid, x: number, y: number): boolean {
    return g[y + SIM_TOP]?.[x] !== 0;
}

/** board.js valid() と同じ範囲判定（左右・床・上は y >= -5） */
export function fits(g: Grid, p: Piece): boolean {
    for (const [x, y] of cellsOf(p)) {
        if (x < 0 || x >= TET_COLS || y < -SIM_TOP || y >= TET_ROWS) return false;
        if (occupied(g, x, y)) return false;
    }
    return true;
}

/** Mino.spawn() ＋ popMino の「塞がっていたら1段上で再判定」。置けなければ null（＝ゲームオーバー） */
export function spawn(g: Grid, type: number): Piece | null {
    const p: Piece = { type, rot: 0, x: TET_COLS / 2 - 2, y: type === 0 ? -1 : -2 };
    if (fits(g, p)) return p;
    p.y -= 1;
    return fits(g, p) ? p : null;
}

export function moved(g: Grid, p: Piece, dx: number, dy: number): Piece | null {
    const q = { ...p, x: p.x + dx, y: p.y + dy };
    return fits(g, q) ? q : null;
}

export function dropDistance(g: Grid, p: Piece): number {
    let d = 0;
    while (fits(g, { ...p, y: p.y + d + 1 })) d++;
    return d;
}

export function isGrounded(g: Grid, p: Piece): boolean { return !fits(g, { ...p, y: p.y + 1 }); }

// ─── SRS キック（rotation.js と同じ表。[dx, dy] は「上が正」なので位置には (dx, -dy) を足す） ───
type Kicks = Record<string, [number, number][]>;
const KICK_CW_I: Kicks = {
    '0->1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '1->2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '2->3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '3->0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
};
const KICK_CW: Kicks = {
    '0->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '1->2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '2->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '3->0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
};
const KICK_CCW_I: Kicks = {
    '0->3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '3->2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '2->1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '1->0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
};
const KICK_CCW: Kicks = {
    '0->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '3->2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '2->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '1->0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

/** 回転（dir: 1=右 / -1=左）。成功時は回転後のミノと「5番目のキックを使ったか」 */
export function rotated(g: Grid, p: Piece, dir: 1 | -1): { piece: Piece; kick5: boolean } | null {
    const to = (p.rot + (dir === 1 ? 1 : 3)) % 4;
    const isI = p.type === 0;
    const table = (dir === 1 ? (isI ? KICK_CW_I : KICK_CW) : (isI ? KICK_CCW_I : KICK_CCW))[`${p.rot}->${to}`];
    if (!table) return null;
    for (let i = 0; i < table.length; i++) {
        const [dx, dy] = table[i];
        const q: Piece = { type: p.type, rot: to, x: p.x + dx, y: p.y - dy };
        if (fits(g, q)) return { piece: q, kick5: i === 4 };
    }
    return null;
}

/** rotation.js checkTSpin と同じ3コーナー判定。lastRot=false なら常に null */
export function checkTSpin(g: Grid, p: Piece, lastRot: boolean, kick5: boolean): 'tspin' | 'mini' | null {
    if (p.type !== 2 || !lastRot) return null;
    const px = p.x + 1, py = p.y + 2;  // T の pivot (1,2) は回転しても不変
    const corner = (x: number, y: number) => x < 0 || x >= TET_COLS || y >= TET_ROWS || (y >= -SIM_TOP && occupied(g, x, y));
    const occ = [corner(px - 1, py - 1), corner(px + 1, py - 1), corner(px - 1, py + 1), corner(px + 1, py + 1)];
    const [ab, cd] = ([
        [[0, 1], [2, 3]], [[1, 3], [0, 2]], [[3, 2], [1, 0]], [[2, 0], [3, 1]],
    ] as const)[p.rot];
    const abN = ab.filter(i => occ[i]).length, cdN = cd.filter(i => occ[i]).length;
    if (abN === 2 && cdN >= 1) return 'tspin';
    if (cdN === 2 && abN >= 1) return kick5 ? 'tspin' : 'mini';
    return null;
}

/** 固定してライン消去。消えた段数を返す（g は書き換える） */
export function lockPiece(g: Grid, p: Piece): number {
    for (const [x, y] of cellsOf(p)) {
        if (y >= -SIM_TOP) g[y + SIM_TOP][x] = p.type + 1;
    }
    let lines = 0;
    for (let r = SIM_ROWS - 1; r >= 0; r--) {
        if (g[r].every(v => v !== 0)) {
            g.splice(r, 1);
            g.unshift(new Array(TET_COLS).fill(0));
            lines++;
            r++;
        }
    }
    return lines;
}

// ─────────────────────────────────────────────
// 手順（解答）のシミュレーション
// ─────────────────────────────────────────────

/** 1手の記録（解答ファイルに保存する形） */
export interface Step {
    piece: number;      // 0=I … 6=Z
    rot: number;        // 0〜3（0=出現向き、1=右回転1回）
    x: number;          // Mino.x（4×4 枠の左上。盤面座標）
    y: number;          // Mino.y
    hold: boolean;      // この手で HOLD を使ったか
    lastRot?: boolean;  // 最後の操作が回転だったか（T-Spin 判定に使う）
    kick5?: boolean;    // その回転で5番目のキックを使ったか（Mini → T-Spin 昇格）
    estimated?: boolean; // マウスで直接置いた（操作経路が無いので T-Spin は推定）
}

export interface QueueState { idx: number; hold: number | null; }

/** その時点で置けるミノ（通常 / HOLD 使用時）。無ければ null */
export function candidates(next: number[], q: QueueState, allowHold: boolean): { normal: number | null; withHold: number | null } {
    const normal = q.idx < next.length ? next[q.idx] : null;
    let withHold: number | null = null;
    if (allowHold && normal !== null) {
        withHold = q.hold !== null ? q.hold : (q.idx + 1 < next.length ? next[q.idx + 1] : null);
    }
    return { normal, withHold };
}

export function advanceQueue(next: number[], q: QueueState, hold: boolean): QueueState {
    if (!hold) return { idx: q.idx + 1, hold: q.hold };
    if (q.hold === null) return { idx: q.idx + 2, hold: next[q.idx] };
    return { idx: q.idx + 1, hold: next[q.idx] };
}

export interface StepResult {
    error: string | null;
    lines: number;
    tspin: 'tspin' | 'mini' | null;
    ren: number;          // 加算前の REN（ゲームの「n REN」表示・quiz.js の判定と同じ値）
    pc: boolean;
    b2b: boolean;
    score: number;        // 累計（ドロップ加点は含まない）
    totalLines: number;
    floating: boolean;    // 接地していない位置に置いた
    condMet: boolean;     // count 条件の「1回」に当たるか
    clearTimes: number;   // count 条件の累計
    cleared: boolean;     // この手でクリア条件を満たした
}

export interface SimResult {
    grids: Grid[];            // grids[k] = k 手置いた後（grids[0] = 初期盤面）
    queues: QueueState[];     // queues[k] = k 手置いた後のキュー状態
    results: StepResult[];    // results[k] = k+1 手目の結果
    clearedAt: number;        // 最初にクリアした手（1始まり）。未達なら 0
    firstError: number;       // 最初にエラーになった手（1始まり）。無ければ 0
}

/** 初期盤面から手順を順に適用する（エラーの手以降は盤面を進めない） */
export function simulate(doc: EditorDoc, steps: Step[]): SimResult {
    let g = gridFromField(doc.field);
    let q: QueueState = { idx: 0, hold: null };
    const out: SimResult = { grids: [cloneGrid(g)], queues: [q], results: [], clearedAt: 0, firstError: 0 };
    let ren = 0, b2b = false, score = 0, totalLines = 0, clearTimes = 0;

    steps.forEach((s, i) => {
        const r: StepResult = {
            error: null, lines: 0, tspin: null, ren: 0, pc: false, b2b: false, score, totalLines,
            floating: false, condMet: false, clearTimes, cleared: false,
        };
        out.results.push(r);
        if (out.firstError) { r.error = '前の手にエラーがあります'; out.grids.push(cloneGrid(g)); out.queues.push(q); return; }

        const cand = candidates(doc.next, q, doc.allowHold);
        const expected = s.hold ? cand.withHold : cand.normal;
        const p: Piece = { type: s.piece, rot: s.rot & 3, x: s.x, y: s.y };
        if (s.hold && !doc.allowHold) r.error = 'HOLD が許可されていません';
        else if (expected === null) r.error = 'NEXT が足りません';
        else if (expected !== s.piece) r.error = `NEXT と一致しません（この手は ${'IOTJLSZ'[expected]}）`;
        else if (out.clearedAt) r.error = 'クリア後の手です（ゲームでは置けません）';
        else if (!fits(g, p)) r.error = '置けない位置です';
        if (r.error) {
            out.firstError = i + 1;
            out.grids.push(cloneGrid(g)); out.queues.push(q);
            return;
        }

        r.floating = !isGrounded(g, p);
        r.tspin = checkTSpin(g, p, !!s.lastRot, !!s.kick5);
        g = cloneGrid(g);
        r.lines = lockPiece(g, p);
        r.pc = g.every(row => row.every(v => v === 0));

        // ─── scoring.js Scoring()（level=1） ───
        let base = 0;
        if (r.tspin === 'tspin') base = [400, 800, 1200, 1600][r.lines] ?? 0;
        else if (r.tspin === 'mini') base = [100, 200][r.lines] ?? 0;
        else base = [0, 100, 300, 500, 800][r.lines] ?? 0;
        const btbAction = r.lines > 0 && (r.lines === 4 || r.tspin !== null);
        if (btbAction) { if (b2b) { base = Math.floor(base * 1.5); r.b2b = true; } b2b = true; }
        else if (r.lines > 0) b2b = false;
        if (r.pc) base += [0, 800, 1000, 1800, 2000][r.lines] ?? 0;
        r.ren = ren;
        let renBonus = 0;
        if (r.lines > 0) { renBonus = Math.min(ren, 20) * 50; ren++; } else ren = 0;
        score += Math.floor(base + renBonus);
        totalLines += r.lines;
        r.score = score;
        r.totalLines = totalLines;

        // ─── クリア条件（quiz.js） ───
        const c = doc.cond;
        const isT = r.tspin === 'tspin';
        const met = (type: string, v: number): boolean => {
            switch (type) {
                case 'clearLines': case 'lines': return totalLines >= v;
                case 'allClear': return r.pc && totalLines > 0;
                case 'score': return score >= v;
                case 'ren': return r.lines > 0 && r.ren >= v;
                case 'tspin': return r.tspin !== null && r.lines >= v;
                case 'tspinSingle': return isT && r.lines === 1;
                case 'tspinDouble': return isT && r.lines === 2;
                case 'tspinTriple': return isT && r.lines === 3;
            }
            return false;
        };
        if (c.type === 'count') {
            // count の中身は「その手」で判定（clearLines は今回の消去数、score は累計）
            const cv = c.countValue ?? 1;
            const inner = c.countCondition === 'clearLines' ? r.lines >= cv
                : c.countCondition === 'allClear' ? r.pc && r.lines > 0
                : met(c.countCondition, cv);
            if (inner) { clearTimes++; r.condMet = true; }
            r.clearTimes = clearTimes;
            r.cleared = clearTimes >= c.value;
        } else {
            r.cleared = met(c.type, c.value);
        }
        if (r.cleared && !out.clearedAt) out.clearedAt = i + 1;

        q = advanceQueue(doc.next, q, s.hold);
        out.grids.push(cloneGrid(g));
        out.queues.push(q);
    });
    return out;
}

/** 手順リスト用の短い説明 */
export function describeResult(r: StepResult): string {
    const parts: string[] = [];
    const names = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', '4-LINES'];
    if (r.tspin) parts.push(`${r.tspin === 'mini' ? 'T-SPIN MINI' : 'T-SPIN'}${r.lines ? ' ' + names[r.lines] : ''}`);
    else if (r.lines) parts.push(names[r.lines] ?? `${r.lines}L`);
    if (r.b2b) parts.push('B2B');
    if (r.lines > 0 && r.ren > 0) parts.push(`${r.ren} REN`);
    if (r.pc) parts.push('PC');
    return parts.join(' / ');
}
