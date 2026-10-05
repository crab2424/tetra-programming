// ─────────────────────────────────────────────
// place.ts
// PLACE モード（設計 §4.5）
//   SOLVE: NEXT の順にミノを置いて解答手順を記録（1手ずつシミュレーション・条件達成チェック）
//   STAMP: 任意のミノを初期盤面に直接置く（盤面作成の補助。ライン消去なし）
// ─────────────────────────────────────────────
import { type EditorDoc, MINO_LETTERS, TET_COLS, TET_ROWS } from './model.ts';
import {
    type Grid, type Piece, type Step, type SimResult,
    simulate, candidates, spawn, fits, moved, rotated, dropDistance, cellsOf, shapeOf,
    gridFromField, visibleField, describeResult, SIM_TOP,
} from './tet-sim.ts';
import { type PlaceBinds, type PlaceTuning, actionFor } from './keybinds.ts';
import { drawCellsCentered } from './render.ts';

export type PlaceSub = 'solve' | 'stamp';

/** 押し続けて連続で動く操作（DAS / ARR。public/game/tet/input.js と同じ考え方） */
type HeldDir = 'left' | 'right' | 'down';
interface Held { codes: Set<string>; t0: number; last: number; }

export interface PlaceCtx {
    doc(): EditorDoc;
    commit(mutate: () => void, key?: string): void;
    renderAll(): void;
    renderField(): void;
    status(msg: string): void;
}

export class PlaceMode {
    sub: PlaceSub = 'solve';
    view = 0;                 // 表示中の手（0 = 初期盤面）
    private active: Piece | null = null;
    private activeKey = '';   // active を出現させた時の前提（変わったら出し直す）
    private useHold = false;
    private lastRot = false;
    private kick5 = false;
    private byMouse = false;  // マウスで位置を決めた（操作経路が無いので T-Spin は推定）
    stampType = 2;
    /**
     * SOLVE の STRICT（ゲームどおり）: 出現位置から 移動・回転・ドロップ で置いた手だけを記録する。
     * 1段上・浮いたままの確定・マウス配置を使えなくする（記録した手順がそのままゲームで入力できる手になる）
     */
    strict = false;
    private simCache: { key: string; sim: SimResult } | null = null;
    private ctx: PlaceCtx;
    private held: Partial<Record<HeldDir, Held>> = {};
    private lastHorizontal: 'left' | 'right' | null = null;
    private repeatRaf = 0;
    private tuning: PlaceTuning = { source: 'default', dasMs: 150, arrMs: 1.6 * 1000 / 60 };

    constructor(ctx: PlaceCtx) { this.ctx = ctx; }

    // ─── シミュレーション（入力が変わった時だけ計算し直す） ───
    sim(): SimResult {
        const d = this.ctx.doc();
        const key = JSON.stringify([d.field, d.next, d.allowHold, d.cond, d.steps]);
        if (this.simCache?.key !== key) this.simCache = { key, sim: simulate(d, d.steps) };
        // 手順が減った直後（Undo・取り消し）でも存在しない手を指さないよう、ここで必ず補正する
        this.clampView();
        return this.simCache.sim;
    }

    private clampView() {
        const n = this.ctx.doc().steps.length;
        if (this.view > n) this.view = n;
        if (this.view < 0) this.view = 0;
    }

    private baseGrid(): Grid {
        if (this.sub === 'stamp') return gridFromField(this.ctx.doc().field);
        this.clampView();
        return this.sim().grids[this.view];
    }

    /** この表示位置で置くミノ（SOLVE）。置けるミノが無ければ null */
    private expectedType(): number | null {
        const d = this.ctx.doc();
        if (this.sub === 'stamp') return this.stampType;
        const sim = this.sim();
        if (sim.firstError && this.view >= sim.firstError) return null;
        const c = candidates(d.next, sim.queues[this.view], d.allowHold);
        if (this.useHold && c.withHold === null) this.useHold = false;
        return this.useHold ? c.withHold : c.normal;
    }

    /** 前提（盤面・表示位置・置くミノ）が変わっていたら出現し直す */
    private ensureActive() {
        const type = this.expectedType();
        const key = JSON.stringify([this.sub, this.view, type, this.useHold, this.sub === 'stamp' ? this.ctx.doc().field : this.sim().grids[this.view]]);
        if (key === this.activeKey && (this.active === null) === (type === null)) return;
        this.activeKey = key;
        this.respawn(type);
    }

    private respawn(type: number | null) {
        this.lastRot = false; this.kick5 = false; this.byMouse = false;
        if (type === null) { this.active = null; return; }
        const g = this.baseGrid();
        this.active = spawn(g, type) ?? { type, rot: 0, x: TET_COLS / 2 - 2, y: type === 0 ? -1 : -2 };
    }

    resetActive() { this.activeKey = ''; }

    // ─── 描画用 ───
    fieldView(): { field: number[][]; piece: { cells: [number, number][]; type: number; valid: boolean } | null; ghost: [number, number][] | null } {
        this.ensureActive();
        const g = this.baseGrid();
        const field = visibleField(g);
        if (!this.active) return { field, piece: null, ghost: null };
        const valid = fits(g, this.active);
        const ghost = valid ? cellsOf({ ...this.active, y: this.active.y + dropDistance(g, this.active) }) : null;
        return { field, piece: { cells: cellsOf(this.active), type: this.active.type, valid }, ghost };
    }

    // ─── 操作 ───
    private setActive(p: Piece | null, opts: { rot?: boolean; kick5?: boolean } = {}) {
        if (!p) return false;
        this.active = p;
        this.lastRot = !!opts.rot;
        this.kick5 = !!opts.kick5;
        this.byMouse = false;
        this.ctx.renderField();
        return true;
    }

    /** 操作中のミノの向き（STAMP のボタン表示用） */
    get activeRot(): number { return this.active?.rot ?? 0; }

    private get strictSolve(): boolean { return this.strict && this.sub === 'solve'; }

    move(dx: number, dy: number): boolean {
        if (!this.active) return false;
        if (dy < 0 && this.strictSolve) { this.ctx.status('STRICT: 1段上へは動かせません'); return false; }
        return this.setActive(moved(this.baseGrid(), this.active, dx, dy));
    }

    // ─── 連続移動（キーを押している間だけ requestAnimationFrame で回す） ───
    setTuning(t: PlaceTuning) { this.tuning = t; }

    private step(dir: HeldDir): boolean {
        return dir === 'left' ? this.move(-1, 0) : dir === 'right' ? this.move(1, 0) : this.move(0, 1);
    }
    /** ARR=0 用: 動けなくなるまで動かす */
    private stepAll(dir: HeldDir) {
        for (let i = 0; i < 40 && this.step(dir); i++) { /* 壁・床まで */ }
    }

    private press(dir: HeldDir, code: string) {
        const h = this.held[dir];
        if (h) { h.codes.add(code); return; }   // 同じ操作の別キー: 押し直し扱いにしない
        const now = performance.now();
        this.held[dir] = { codes: new Set([code]), t0: now, last: now };
        if (dir !== 'down') this.lastHorizontal = dir;
        this.step(dir);                          // 押した瞬間に1回
        if (dir === 'down' && this.tuning.arrMs <= 0) this.stepAll('down');
        if (!this.repeatRaf) this.repeatRaf = requestAnimationFrame(this.tick);
    }

    /** keyup。押下中の操作からこのキーを外す */
    keyUp(code: string) {
        for (const dir of ['left', 'right', 'down'] as HeldDir[]) {
            const h = this.held[dir];
            if (!h?.codes.delete(code) || h.codes.size) continue;
            delete this.held[dir];
            // 片方を離した時に反対側が押されていれば、そちらを優先（後押し優先の解除）
            if (dir !== 'down' && this.lastHorizontal === dir) {
                const other = dir === 'left' ? 'right' : 'left';
                this.lastHorizontal = this.held[other] ? other : null;
                // 反対側は押し直したのと同じく DAS からやり直す（ゲームと同じく溜めは引き継がない）
                const o = this.held[other];
                if (o) { o.t0 = performance.now(); o.last = o.t0; }
            }
        }
    }

    /** フォーカスが外れた・モードを変えた時など。押しっぱなし扱いを残さない */
    releaseAll() {
        this.held = {};
        this.lastHorizontal = null;
        cancelAnimationFrame(this.repeatRaf);
        this.repeatRaf = 0;
    }

    private tick = (now: number) => {
        this.repeatRaf = 0;
        const { dasMs, arrMs } = this.tuning;
        // 左右: 両方押されていれば後から押した方
        const dir: HeldDir | null = this.held.left && this.held.right ? this.lastHorizontal
            : this.held.left ? 'left' : this.held.right ? 'right' : null;
        const h = dir ? this.held[dir] : undefined;
        if (dir && h && now - h.t0 >= dasMs && now - h.last >= arrMs) {
            if (arrMs <= 0) this.stepAll(dir); else this.step(dir);
            h.last = now;
        }
        // ソフトドロップ: DAS なしで ARR ごと
        const d = this.held.down;
        if (d && now - d.last >= arrMs) {
            if (arrMs <= 0) this.stepAll('down'); else this.step('down');
            d.last = now;
        }
        if (this.held.left || this.held.right || this.held.down) this.repeatRaf = requestAnimationFrame(this.tick);
    };

    rotate(dir: 1 | -1) {
        if (!this.active) return;
        const r = rotated(this.baseGrid(), this.active, dir);
        if (r) this.setActive(r.piece, { rot: true, kick5: r.kick5 });
    }

    sonicDrop() {
        if (!this.active) return;
        const d = dropDistance(this.baseGrid(), this.active);
        if (d > 0) this.setActive({ ...this.active, y: this.active.y + d });
    }

    toggleHold() {
        const d = this.ctx.doc();
        if (this.sub !== 'solve') return;
        if (!d.allowHold) { this.ctx.status('この問題は HOLD が許可されていません'); return; }
        const c = candidates(d.next, this.sim().queues[this.view], true);
        if (!this.useHold && c.withHold === null) { this.ctx.status('HOLD で出せるミノがありません'); return; }
        this.useHold = !this.useHold;
        this.resetActive();
        this.ctx.renderAll();
    }

    /** ハードドロップ（落ちたら回転フラグは消える＝ゲームと同じ）して確定 */
    hardDrop() {
        if (!this.active) return;
        const d = dropDistance(this.baseGrid(), this.active);
        if (d > 0) { this.active = { ...this.active, y: this.active.y + d }; this.lastRot = false; this.kick5 = false; }
        this.lock();
    }

    /** 今の位置で確定（浮いていても置く。STRICT では接地している時だけ） */
    lock() {
        const p = this.active;
        if (!p) return;
        const g = this.baseGrid();
        if (!fits(g, p)) { this.ctx.status('その位置には置けません'); return; }
        if (this.strictSolve && dropDistance(g, p) > 0) { this.ctx.status('STRICT: 浮いた位置では確定できません（DROP か、↓で接地させてから LOCK）'); return; }
        if (this.sub === 'stamp') {
            const hidden = cellsOf(p).some(([, y]) => y < 0);
            this.ctx.commit(() => {
                const f = this.ctx.doc().field;
                for (const [x, y] of cellsOf(p)) if (y >= 0 && y < TET_ROWS) f[y][x] = p.type + 1;
            });
            if (hidden) this.ctx.status('盤面より上にはみ出した部分は置かれません');
            this.resetActive();
            this.ctx.renderAll();
            return;
        }
        const step: Step = { piece: p.type, rot: p.rot, x: p.x, y: p.y, hold: this.useHold };
        if (this.lastRot) step.lastRot = true;
        if (this.kick5) step.kick5 = true;
        if (this.byMouse) {
            step.estimated = true;
            if (p.type === 2) step.lastRot = true;   // 回転入れと見なす（推定）
        }
        const d = this.ctx.doc();
        const truncated = d.steps.length - this.view;
        const at = this.view;
        this.ctx.commit(() => { d.steps.splice(at); d.steps.push(step); });
        this.view = at + 1;
        this.useHold = false;
        this.resetActive();
        if (truncated > 0) this.ctx.status(`${at + 1}手目以降の ${truncated} 手を置き換えました（UNDO で戻せます）`);
        this.ctx.renderAll();
    }

    undoLastStep() {
        const d = this.ctx.doc();
        if (this.sub !== 'solve' || !d.steps.length) return;
        this.ctx.commit(() => { d.steps.pop(); });
        this.view = Math.min(this.view, d.steps.length);
        this.resetActive();
        this.ctx.renderAll();
    }

    truncateAfterView() {
        const d = this.ctx.doc();
        if (this.view >= d.steps.length) return;
        const at = this.view;
        this.ctx.commit(() => { d.steps.splice(at); });
        this.resetActive();
        this.ctx.renderAll();
    }

    /** 表示中の手の盤面を初期盤面にする（盤面作成の補助） */
    viewToInitial() {
        const g = this.sim().grids[this.view];
        const above = g.slice(0, SIM_TOP).some(r => r.some(v => v));
        if (!confirm('表示中の盤面を初期盤面にし、記録した手順を消去します（UNDO で戻せます）。よろしいですか？')) return;
        const d = this.ctx.doc();
        this.ctx.commit(() => { d.field = visibleField(g); d.steps = []; });
        this.view = 0;
        this.resetActive();
        if (above) this.ctx.status('盤面より上のブロックは初期盤面に入りません');
        this.ctx.renderAll();
    }

    goto(view: number) {
        this.view = view;
        this.clampView();
        this.useHold = false;
        this.resetActive();
        this.ctx.renderAll();
    }

    setSub(sub: PlaceSub) {
        this.sub = sub;
        this.useHold = false;
        this.resetActive();
        this.ctx.renderAll();
    }

    setStamp(type: number, rot = 0) {
        this.stampType = type;
        this.resetActive();
        this.ensureActive();
        for (let i = 0; i < rot && this.active; i++) {
            const r = rotated(this.baseGrid(), this.active, 1);
            if (r) this.active = r.piece;
        }
        this.ctx.renderAll();
    }

    // ─── マウス（テト譜のミノ配置: ホバーで位置・ホイールで回転・クリックで確定） ───
    hoverAt(r: number, c: number) {
        this.ensureActive();
        if (!this.active || this.strictSolve) return;   // STRICT は操作経路の無いマウス配置を使わない
        // ミノの見た目の中心をカーソルのマスに合わせる
        const sh = shapeOf(this.active.type, this.active.rot);
        const cx = Math.round(sh.reduce((a, b) => a + b[0], 0) / 4 - 0.01);
        const cy = Math.round(sh.reduce((a, b) => a + b[1], 0) / 4 - 0.01);
        const q = { ...this.active, x: c - cx, y: r - cy };
        // 端のマスを指した時にはみ出さないよう、左右・下の盤面内へ押し戻す
        const xs = sh.map(b => q.x + b[0]), ys = sh.map(b => q.y + b[1]);
        q.x += Math.max(0, -Math.min(...xs)) - Math.max(0, Math.max(...xs) - (TET_COLS - 1));
        q.y -= Math.max(0, Math.max(...ys) - (TET_ROWS - 1));
        if (q.x === this.active.x && q.y === this.active.y) return;
        this.active = q;
        this.lastRot = false; this.kick5 = false; this.byMouse = true;
        this.ctx.renderField();
    }

    wheel(dir: 1 | -1) {
        if (!this.active) return;
        if (this.strictSolve) { this.rotate(dir); return; }   // STRICT は通常の回転（SRS キック）
        const r = rotated(this.baseGrid(), this.active, dir);
        // マウス操作中は位置を保ったまま向きだけ変える（置けなければキック後の位置）
        const same = { ...this.active, rot: (this.active.rot + (dir === 1 ? 1 : 3)) % 4 };
        this.active = fits(this.baseGrid(), same) ? same : (r?.piece ?? same);
        this.byMouse = true;
        this.ctx.renderField();
    }

    // ─── キー ───
    /** 同期キー（TETLABO の KEY CONFIG）を最優先し、エディタ固有キーはその後に見る */
    handleKey(e: KeyboardEvent, binds: PlaceBinds): boolean {
        const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
        const action = plain ? actionFor(binds, e.code) : null;
        // OS のキーリピートは使わない: 移動は自前の DAS/ARR、確定・回転などの単発操作は押した瞬間の1回だけ
        // （以前はハードドロップを押し続けると手が何手も記録された）
        if (action && e.repeat) return true;
        switch (action) {
            case 'moveLeft': this.press('left', e.code); return true;
            case 'moveRight': this.press('right', e.code); return true;
            case 'softDrop': this.press('down', e.code); return true;
            case 'hardDrop': this.hardDrop(); return true;
            case 'rotateCW': this.rotate(1); return true;
            case 'rotateCCW': this.rotate(-1); return true;
            case 'hold': this.toggleHold(); return true;
        }
        if (e.altKey && e.code === 'ArrowUp') { this.move(0, -1); return true; }
        if (e.altKey && e.code === 'ArrowDown') { this.sonicDrop(); return true; }
        if (!plain) return false;
        if (e.code === 'ArrowUp') { this.move(0, -1); return true; }
        if (e.code === 'Enter') { if (!e.repeat) this.lock(); return true; }
        if (e.code === 'Backspace') { if (!e.repeat) this.undoLastStep(); return true; }
        if (e.code === 'BracketLeft') { this.goto(this.view - 1); return true; }
        if (e.code === 'BracketRight') { this.goto(this.view + 1); return true; }
        if (e.code === 'Home') { this.goto(0); return true; }
        if (e.code === 'End') { this.goto(this.ctx.doc().steps.length); return true; }
        if (this.sub === 'stamp') {
            const letter = /^Key([A-Z])$/.exec(e.code)?.[1] ?? '';
            const t = (MINO_LETTERS as readonly string[]).indexOf(letter);
            if (t >= 0) { this.setStamp(t); return true; }
        }
        return false;
    }

    // ─── 盤面の横の HOLD・NEXT 表示（PC） ───
    /** SOLVE で今 HOLD にあるミノ（HOLD を使う手を選んでいる時は、代わりに HOLD へ入るミノ） */
    holdPiece(): number | null {
        if (this.sub !== 'solve') return null;
        const d = this.ctx.doc();
        const q = this.sim().queues[this.view];
        if (!q) return null;
        return this.useHold ? candidates(d.next, q, d.allowHold).normal : q.hold;
    }
    /** SOLVE で NEXT の何個目までを使い終えたか（used）・今置いているミノがどこまでか（now） */
    nextUsage(): { used: number; now: number } | null {
        if (this.sub !== 'solve') return null;
        const q = this.sim().queues[this.view];
        if (!q) return null;
        return { used: q.idx, now: q.idx + (this.useHold && q.hold === null ? 2 : 1) };
    }

    // ─── 手順パネル ───
    renderPanel(root: HTMLElement) {
        const d = this.ctx.doc();
        this.ensureActive();
        const sim = this.sim();
        const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

        root.querySelector<HTMLElement>('#solve-box')!.hidden = this.sub !== 'solve';
        root.querySelector<HTMLElement>('#stamp-box')!.hidden = this.sub !== 'stamp';

        if (this.sub === 'stamp') {
            const grid = root.querySelector<HTMLElement>('#stamp-grid');
            if (grid) drawStampButtons(grid, this.stampType, this.activeRot);
            return;
        }

        // 置くミノ・HOLD・残り NEXT
        const q = sim.queues[this.view];
        const c = candidates(d.next, q, d.allowHold);
        const L = (t: number | null) => (t === null ? '—' : MINO_LETTERS[t]);
        const rest = d.next.slice(q.idx + (this.useHold && q.hold === null ? 2 : 1)).map(t => MINO_LETTERS[t]).join('');
        root.querySelector('#solve-now')!.innerHTML =
            `<span>NOW <b>${L(this.useHold ? c.withHold : c.normal)}</b>${this.useHold ? ' <small>(HOLD 使用)</small>' : ''}</span>` +
            (d.allowHold ? `<span>HOLD <b>${L(this.useHold ? c.normal : q.hold)}</b></span>` : '<span class="dim">HOLD 不可</span>') +
            `<span>NEXT <b>${rest || '—'}</b></span>`;

        root.querySelector('#step-pos')!.textContent = `${this.view} / ${d.steps.length}`;

        // 達成状況
        const goal = root.querySelector<HTMLElement>('#solve-goal')!;
        if (sim.firstError) { goal.className = 'goal err'; goal.textContent = `${sim.firstError}手目にエラーがあります`; }
        else if (sim.clearedAt) {
            goal.className = 'goal ok';
            goal.textContent = `CLEAR — ${sim.clearedAt}手目でクリア条件を満たします` +
                (sim.clearedAt < d.steps.length ? `（${sim.clearedAt + 1}手目以降は不要）` : '');
        } else if (d.steps.length) {
            const usedAll = sim.queues[d.steps.length].idx >= d.next.length;
            goal.className = 'goal warn';
            goal.textContent = usedAll ? 'NEXT を使い切りましたがクリア条件を満たしていません' : 'まだクリア条件を満たしていません';
        } else { goal.className = 'goal'; goal.textContent = '手順はまだありません'; }

        // 手順リスト
        const rows = d.steps.map((s, i) => {
            const r = sim.results[i];
            const desc = r.error ? `<span class="e">${esc(r.error)}</span>` : esc(describeResult(r)) || '<span class="dim">—</span>';
            const flags = [
                s.hold ? 'HOLD' : '',
                r.floating && !r.error ? '浮き' : '',
                s.estimated && s.piece === 2 && r.tspin ? '推定' : '',
                r.condMet ? `${r.clearTimes}回目` : '',
            ].filter(Boolean).map(f => `<i>${f}</i>`).join('');
            const mark = r.cleared ? '<b class="ok">✓</b>' : '';
            return `<li data-view="${i + 1}" class="${this.view === i + 1 ? 'on' : ''}${r.error ? ' bad' : ''}">` +
                `<span class="n">${i + 1}</span><span class="p">${MINO_LETTERS[s.piece]}</span>` +
                `<span class="r">${desc}</span>${flags}${mark}</li>`;
        });
        root.querySelector('#step-list')!.innerHTML =
            `<li data-view="0" class="${this.view === 0 ? 'on' : ''}"><span class="n">0</span><span class="r dim">初期盤面</span></li>` + rows.join('');
    }
}

/** STAMP 用のミノ 7 個（1 行）。形は描画時に今の回転で描く（drawStampButtons）。layout §5・tools §3.2（NEXT モードと同じ並び） */
export function buildStampGrid(root: HTMLElement) {
    root.innerHTML = '';
    for (let t = 0; t < 7; t++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.stamp = String(t);
        b.title = `${MINO_LETTERS[t]}（選択中にもう一度押すと右回転・右クリックで左回転）`;
        const k = document.createElement('span');   // ミノ文字（NEXT モードのボタンと同じ形。tools §3.2）
        k.className = 'k';
        k.textContent = MINO_LETTERS[t];
        const cv = document.createElement('canvas');
        const rot = document.createElement('span');
        rot.className = 'rot';
        b.append(k, cv, rot);
        root.append(b);
    }
    drawStampButtons(root, -1, 0);
}

const ROT_NAMES = ['0', 'R', '2', 'L'];
/** STAMP のボタンを描き直す。選んでいるミノ（type）だけ今の回転（rot）で描き、向きを右下に出す */
export function drawStampButtons(root: HTMLElement, type: number, rot: number) {
    const dpr = window.devicePixelRatio || 1;
    const s = 30;
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-stamp]')) {
        const t = Number(b.dataset.stamp);
        const on = t === type;
        const r = on ? rot : 0;
        b.classList.toggle('on', on);
        if (b.dataset.drawn === `${r}`) continue;
        b.dataset.drawn = `${r}`;
        const cv = b.querySelector('canvas')!;
        cv.width = s * dpr; cv.height = s * dpr;
        cv.style.width = `${s}px`; cv.style.height = `${s}px`;
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, s, s);
        drawCellsCentered(ctx, t, shapeOf(t, r), s / 2, s / 2, 6);
        b.querySelector('.rot')!.textContent = on ? ROT_NAMES[r] : '';
    }
}
