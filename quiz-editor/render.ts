// ─────────────────────────────────────────────
// render.ts
// ゲームと同じ画像（public/assets/images）で盤面・ミノ・ぷよを描く
// ─────────────────────────────────────────────
import { type Rule, PUYO_HIDDEN, cols, rows } from './model.ts';

// ─── 画像 ───
// tet: block-0..7（0=I … 6=Z, 7=おじゃま）／ puyo: puyo-0..5（5=おじゃま）
const tetImages: HTMLImageElement[] = [];
const puyoImages: HTMLImageElement[] = [];

export function loadImages(onLoad: () => void): void {
    const load = (src: string) => {
        const img = new Image();
        img.onload = onLoad;
        img.src = src;
        return img;
    };
    for (let i = 0; i < 8; i++) tetImages[i] = load(`/assets/images/t_images/block-${i}.png`);
    for (let i = 0; i < 6; i++) puyoImages[i] = load(`/assets/images/p_images/puyo/puyo-${i}.png`);
}

/** 盤面の色ID（1始まり）に対応する画像 */
export function cellImage(rule: Rule, v: number): HTMLImageElement | undefined {
    if (v <= 0) return undefined;
    return rule === 'tet' ? tetImages[v - 1] : puyoImages[v - 1];
}

function drawImg(ctx: CanvasRenderingContext2D, img: HTMLImageElement | undefined, x: number, y: number, s: number) {
    if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, x, y, s, s);
}

// ─── ミノ形状（public/core/base.js の Mino.initBlocks・回転0 と同じ） ───
export const MINO_SHAPES: [number, number][][] = [
    [[0, 1], [1, 1], [2, 1], [3, 1]], // I
    [[1, 1], [2, 1], [1, 2], [2, 2]], // O
    [[1, 1], [0, 2], [1, 2], [2, 2]], // T
    [[0, 1], [0, 2], [1, 2], [2, 2]], // J
    [[2, 1], [0, 2], [1, 2], [2, 2]], // L
    [[1, 1], [2, 1], [0, 2], [1, 2]], // S
    [[0, 1], [1, 1], [1, 2], [2, 2]], // Z
];

/** ミノを (cx, cy) を中心に描く。type は 0始まり */
export function drawMinoCentered(ctx: CanvasRenderingContext2D, type: number, cx: number, cy: number, s: number) {
    const shape = MINO_SHAPES[type];
    if (shape) drawCellsCentered(ctx, type, shape, cx, cy, s);
}

/** 任意の形（回転後など）のマス群を (cx, cy) を中心に描く */
export function drawCellsCentered(ctx: CanvasRenderingContext2D, type: number, cells: [number, number][], cx: number, cy: number, s: number) {
    const xs = cells.map(b => b[0]), ys = cells.map(b => b[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = (Math.max(...xs) - minX + 1) * s, h = (Math.max(...ys) - minY + 1) * s;
    for (const [bx, by] of cells) {
        drawImg(ctx, tetImages[type], cx - w / 2 + (bx - minX) * s, cy - h / 2 + (by - minY) * s, s);
    }
}

/** ぷよペアを縦に描く（上=子、下=軸。ゲームの出現向きと同じ） */
export function drawPairCentered(ctx: CanvasRenderingContext2D, pair: [number, number], cx: number, cy: number, s: number) {
    drawImg(ctx, puyoImages[pair[1] - 1], cx - s / 2, cy - s, s);
    drawImg(ctx, puyoImages[pair[0] - 1], cx - s / 2, cy, s);
}

export function drawCellSwatch(ctx: CanvasRenderingContext2D, rule: Rule, v: number, s: number) {
    ctx.clearRect(0, 0, s, s);
    if (v === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(2.5, 2.5, s - 5, s - 5);
        ctx.setLineDash([]);
        return;
    }
    drawImg(ctx, cellImage(rule, v), 0, 0, s);
}

// ─── 盤面 ───
export interface FieldView {
    rule: Rule;
    field: number[][];
    cell: number;
    cursor: { r: number; c: number } | null;   // キーボードカーソル
    hover: { r: number; c: number } | null;
    rowMode: boolean;
    showCursor: boolean;
    /** PLACE モードの操作中ミノ（盤面座標のマス・type は 0始まり）。valid=false なら置けない位置 */
    piece?: { cells: [number, number][]; type: number; valid: boolean } | null;
    ghost?: [number, number][] | null;
}

export function fieldCellSize(rule: Rule): number { return rule === 'tet' ? 28 : 32; }

export function drawField(canvas: HTMLCanvasElement, v: FieldView) {
    const C = cols(v.rule), R = rows(v.rule), s = v.cell;
    const dpr = window.devicePixelRatio || 1;
    const W = C * s, H = R * s;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#0d0d16';
    ctx.fillRect(0, 0, W, H);

    // グリッド
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < C; c++) { ctx.moveTo(c * s + 0.5, 0); ctx.lineTo(c * s + 0.5, H); }
    for (let r = 1; r < R; r++) { ctx.moveTo(0, r * s + 0.5); ctx.lineTo(W, r * s + 0.5); }
    ctx.stroke();

    // ブロック
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
        drawImg(ctx, cellImage(v.rule, v.field[r][c]), c * s, r * s, s);
    }

    // ゴースト・操作中ミノ（PLACE モード）
    if (v.ghost && v.piece) {
        ctx.globalAlpha = 0.3;
        for (const [x, y] of v.ghost) if (y >= 0) drawImg(ctx, tetImages[v.piece.type], x * s, y * s, s);
        ctx.globalAlpha = 1;
    }
    if (v.piece) {
        for (const [x, y] of v.piece.cells) {
            if (y < 0) continue;
            drawImg(ctx, tetImages[v.piece.type], x * s, y * s, s);
            if (!v.piece.valid) {
                ctx.fillStyle = 'rgba(245,90,90,0.55)';
                ctx.fillRect(x * s, y * s, s, s);
            }
        }
        // 盤面より上にはみ出している列を上端の印で示す
        ctx.fillStyle = '#f58542';
        for (const [x, y] of v.piece.cells) if (y < 0) ctx.fillRect(x * s + 4, 0, s - 8, 3);
    }

    if (v.rule === 'tet') {
        // 揃っている行（開始時には消えない＝ミスの可能性）を強調（テト譜 1.10b 由来）
        for (let r = 0; r < R; r++) {
            if (v.field[r].every(x => x !== 0)) {
                ctx.fillStyle = 'rgba(255,255,255,0.28)';
                ctx.fillRect(0, r * s, W, s);
            }
        }
    } else {
        // 隠し段を暗く・可視境界線
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, W, PUYO_HIDDEN * s);
        ctx.strokeStyle = 'rgba(245,133,66,0.6)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, PUYO_HIDDEN * s + 0.5); ctx.lineTo(W, PUYO_HIDDEN * s + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        // 窒息点（3列目・可視最上段）
        ctx.strokeStyle = 'rgba(245,90,90,0.7)';
        const dx = 2 * s, dy = PUYO_HIDDEN * s;
        ctx.beginPath();
        ctx.moveTo(dx + 6, dy + 6); ctx.lineTo(dx + s - 6, dy + s - 6);
        ctx.moveTo(dx + s - 6, dy + 6); ctx.lineTo(dx + 6, dy + s - 6);
        ctx.stroke();
    }

    // ホバー（行塗りモードでは行全体）
    if (v.hover) {
        ctx.fillStyle = 'rgba(245,133,66,0.18)';
        if (v.rowMode) ctx.fillRect(0, v.hover.r * s, W, s);
        else ctx.fillRect(v.hover.c * s, v.hover.r * s, s, s);
    }
    // キーボードカーソル
    if (v.cursor && v.showCursor) {
        ctx.strokeStyle = '#f58542';
        ctx.lineWidth = 2;
        if (v.rowMode) ctx.strokeRect(1, v.cursor.r * s + 1, W - 2, s - 2);
        ctx.strokeRect(v.cursor.c * s + 1, v.cursor.r * s + 1, s - 2, s - 2);
    }
}
