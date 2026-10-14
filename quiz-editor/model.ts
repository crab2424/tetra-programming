// ─────────────────────────────────────────────
// model.ts
// クイズエディタのデータモデル・JSON入出力・クリア条件定義・検証
// データ仕様の正は public/assets/quizlevels/template.txt と public/quiz/quiz.js
// ─────────────────────────────────────────────

import type { Step } from './tet-sim.ts';
import type { PuyoStep } from './puyo-sim.ts';
import { findErasable, isDead } from './puyo-sim.ts';

/** 解答手順の1手（tet: tet-sim の Step / puyo: puyo-sim の PuyoStep） */
export type AnyStep = Step | PuyoStep;

export type Rule = 'tet' | 'puyo';

// ─── 盤面サイズ（public/core/base.js の COLS_COUNT/ROWS_COUNT・PConfig と一致させる） ───
export const TET_COLS = 10;
export const TET_ROWS = 20;
export const PUYO_COLS = 6;
export const PUYO_ROWS = 17;      // 可視12 + 隠し5（PConfig.rows + PConfig.hiddenRows）
export const PUYO_HIDDEN = 5;

// ─── 色ID ───
// tet 盤面: 0=空 1=I 2=O 3=T 4=J 5=L 6=S 7=Z 8=おじゃま（＝ミノtype+1）
// tet NEXT: 0=I 1=O 2=T 3=J 4=L 5=S 6=Z（0始まり）
// puyo   : 0=空 1〜5=色ぷよ 6=おじゃま
export const MINO_LETTERS = ['I', 'O', 'T', 'J', 'L', 'S', 'Z'] as const;
export const TET_GARBAGE = 8;
export const PUYO_OJAMA = 6;
export const PUYO_COLORS = 5;
/** ぷよの色の名前（1〜5。画像 puyo-0〜4 の色。tools §5.3） */
export const PUYO_COLOR_NAMES = ['赤', '青', '紫', '緑', '黄'];

export function cols(rule: Rule): number { return rule === 'tet' ? TET_COLS : PUYO_COLS; }
export function rows(rule: Rule): number { return rule === 'tet' ? TET_ROWS : PUYO_ROWS; }
export function maxColorId(rule: Rule): number { return rule === 'tet' ? TET_GARBAGE : PUYO_OJAMA; }

export type Pair = [number, number]; // [軸色, 子色]

export interface Cond {
    type: string;
    value: number;
    countCondition: string;
    countValue: number;
    description: string;
    descriptionAuto: boolean; // true の間は description を条件から自動生成する
}

export interface EditorDoc {
    rule: Rule;
    id: string;
    description: string;
    diff: number | null;      // null = 出力しない（★非表示）
    allowHold: boolean;       // tet のみ出力
    field: number[][];        // 常にフルサイズ（上→下）。値はJSONと同じID
    next: number[];           // tet: ミノtype(0始まり)
    pairs: Pair[];            // puyo
    cond: Cond;
    steps: AnyStep[];         // 解答手順（rule に合った形）。画面に出ている手（試行中の手も含む）。問題 JSON には出力しない
    /**
     * 条件をクリアした時点の手順（drafts §9・D6）。保存済みとの比較・SAVE SOLUTION・内容のハッシュはこちらを使う
     * （試しに置いただけの手で未保存扱いにしないため）。古い下書きには無い → steps を使う
     */
    solved?: AnyStep[];
    solutionNote: string;     // 解答のメモ（解答ファイルの note）
    /**
     * MEMO（中間点の盤面。polish §6）。field と同じ形。問題の JSON には出さず、解答ファイルの同じ問題のエントリに保存する。
     * 目標（GOAL）ではなく、作る途中で目指す 1 つの形。無ければキーごと無い
     */
    memo?: number[][];
    extra: Record<string, unknown>;     // 読み込んだが未知のキー（書き戻して損失を防ぐ）
    condExtra: Record<string, unknown>; // clearCondition 内の未知のキー
}

// ─────────────────────────────────────────────
// クリア条件の定義（quiz.js の _checkClear / _checkClearOnSecure から逆引き）
// ─────────────────────────────────────────────
export interface CondDef {
    type: string;
    label: string;
    usesValue: boolean;
    valueLabel?: string;
    selectable: boolean;   // false = 既存データの読み込み互換のみ（新規選択肢には出さない）
    note?: string;
}

export const TET_CONDS: CondDef[] = [
    { type: 'clearLines',  label: 'ライン消去（累計）',        usesValue: true,  valueLabel: 'ライン数', selectable: true },
    { type: 'allClear',    label: 'パーフェクトクリア',        usesValue: false, selectable: true },
    { type: 'tspinSingle', label: 'T-Spin Single',            usesValue: false, selectable: true, note: 'mini は含まない' },
    { type: 'tspinDouble', label: 'T-Spin Double',            usesValue: false, selectable: true, note: 'mini は含まない' },
    { type: 'tspinTriple', label: 'T-Spin Triple',            usesValue: false, selectable: true, note: 'mini は含まない' },
    { type: 'tspin',       label: 'T-Spin（mini含む）で消去',  usesValue: true,  valueLabel: 'ライン数以上', selectable: true },
    { type: 'ren',         label: 'REN',                      usesValue: true,  valueLabel: 'REN数以上', selectable: true },
    { type: 'score',       label: 'スコア',                    usesValue: true,  valueLabel: '点以上', selectable: true },
    { type: 'count',       label: '回数（下の条件をN回）',      usesValue: true,  valueLabel: '回数', selectable: true },
    { type: 'lines',       label: 'ライン消去（旧: lines）',    usesValue: true,  valueLabel: 'ライン数', selectable: false, note: 'clearLines と同じ意味の旧形式' },
];

export const PUYO_CONDS: CondDef[] = [
    { type: 'chain',    label: '連鎖',   usesValue: true,  valueLabel: '連鎖以上', selectable: true },
    { type: 'allClear', label: '全消し', usesValue: false, selectable: true },
    { type: 'score',    label: 'スコア', usesValue: true,  valueLabel: '点以上', selectable: true },
    { type: 'count',    label: '回数（下の条件をN回）', usesValue: true, valueLabel: '回数', selectable: true,
      note: '連鎖があった手だけ数える（engine.js → quiz.js _checkClearOnPuyoChain）' },
];

// count の中身（countCondition）。usesCountValue=false でも countValue は常に出力する（既存データと同じ）
export interface CountDef { type: string; label: string; usesCountValue: boolean; countValueLabel?: string; }

export const TET_COUNT_CONDS: CountDef[] = [
    { type: 'clearLines',  label: 'ライン消去',            usesCountValue: true,  countValueLabel: 'ライン以上' },
    { type: 'tspinSingle', label: 'T-Spin Single',        usesCountValue: false },
    { type: 'tspinDouble', label: 'T-Spin Double',        usesCountValue: false },
    { type: 'tspinTriple', label: 'T-Spin Triple',        usesCountValue: false },
    { type: 'tspin',       label: 'T-Spin（mini含む）',    usesCountValue: true,  countValueLabel: 'ライン以上' },
    { type: 'ren',         label: 'REN',                  usesCountValue: true,  countValueLabel: 'REN以上' },
    { type: 'allClear',    label: 'パーフェクトクリア',    usesCountValue: false },
    { type: 'score',       label: 'スコア',                usesCountValue: true,  countValueLabel: '点以上' },
];

export const PUYO_COUNT_CONDS: CountDef[] = [
    { type: 'chain',    label: '連鎖',   usesCountValue: true, countValueLabel: '連鎖以上' },
    { type: 'allClear', label: '全消し', usesCountValue: false },
    { type: 'score',    label: 'スコア', usesCountValue: true, countValueLabel: '点以上' },
];

export function condDefs(rule: Rule): CondDef[] { return rule === 'tet' ? TET_CONDS : PUYO_CONDS; }
export function countDefs(rule: Rule): CountDef[] { return rule === 'tet' ? TET_COUNT_CONDS : PUYO_COUNT_CONDS; }
export function findCondDef(rule: Rule, type: string): CondDef | undefined { return condDefs(rule).find(d => d.type === type); }
export function findCountDef(rule: Rule, type: string): CountDef | undefined { return countDefs(rule).find(d => d.type === type); }

// ─── GOAL 文言の自動生成（既存データの言い回しに合わせる） ───
export function autoCondDescription(rule: Rule, c: Cond): string {
    const n = c.value;
    switch (c.type) {
        case 'clearLines':  return `${n}ライン消去`;
        case 'lines':       return `合計${n}ライン消去`;
        case 'allClear':    return rule === 'tet' ? 'パーフェクトクリア' : '全消し';
        case 'score':       return `スコア${n}以上`;
        case 'ren':         return `${n}REN以上`;
        case 'tspin':       return `T-Spin（mini含む）で${n}ライン以上消去`;
        case 'tspinSingle': return 'T-Spin singleを決める';
        case 'tspinDouble': return 'T-Spin doubleを決める';
        case 'tspinTriple': return 'T-Spin tripleを決める';
        case 'chain':       return `${n}連鎖`;
        case 'count': {
            const cv = c.countValue;
            switch (c.countCondition) {
                case 'clearLines':  return cv <= 1 ? `ライン消去を${n}回行う` : `${cv}ライン以上の消去を${n}回行う`;
                case 'tspin':       return `T-Spin（mini含む）で${cv}ライン以上の消去を${n}回行う`;
                case 'tspinSingle': return `T-Spin singleを${n}回決める`;
                case 'tspinDouble': return `T-Spin doubleを${n}回決める`;
                case 'tspinTriple': return `T-Spin tripleを${n}回決める`;
                case 'ren':         return `${cv}REN以上を${n}回達成`;
                case 'allClear':    return rule === 'tet' ? `パーフェクトクリアを${n}回達成` : `全消しを${n}回達成`;
                case 'score':       return `スコア${cv}以上を${n}回達成`;
                case 'chain':       return `${cv}連鎖以上を${n}回達成`;
            }
            return '';
        }
    }
    return '';
}

// ─────────────────────────────────────────────
// 生成・複製
// ─────────────────────────────────────────────
export function emptyField(rule: Rule): number[][] {
    return Array.from({ length: rows(rule) }, () => new Array(cols(rule)).fill(0));
}

export function defaultCond(rule: Rule): Cond {
    const c: Cond = rule === 'tet'
        ? { type: 'allClear', value: 0, countCondition: 'tspinDouble', countValue: 1, description: '', descriptionAuto: true }
        : { type: 'chain', value: 2, countCondition: 'chain', countValue: 1, description: '', descriptionAuto: true };
    c.description = autoCondDescription(rule, c);
    return c;
}

export function newDoc(rule: Rule): EditorDoc {
    return {
        rule, id: '', description: '', diff: 1, allowHold: false,
        field: emptyField(rule), next: [], pairs: [],
        cond: defaultCond(rule), steps: [], solved: [], solutionNote: '', extra: {}, condExtra: {},
    };
}

/** 比較・保存に使う手順（クリアした時点の手順。無ければ画面の手順） */
export function solvedSteps(d: EditorDoc): AnyStep[] { return d.solved ?? d.steps; }

export function cloneDoc(d: EditorDoc): EditorDoc {
    return JSON.parse(JSON.stringify(d)) as EditorDoc;
}

// ─────────────────────────────────────────────
// JSON → EditorDoc
// ─────────────────────────────────────────────
const KNOWN_KEYS = new Set(['id', 'diff', 'description', 'rule', 'allowHold',
    'initialField', 'initialPuyoField', 'nextPieces', 'nextPuyoPairs', 'clearCondition']);
const KNOWN_COND_KEYS = new Set(['type', 'value', 'countCondition', 'countValue', 'description']);

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 既存データ1問を EditorDoc に変換する（下詰めでフルサイズ盤面に展開） */
export function docFromLevel(level: Record<string, unknown>): EditorDoc {
    const rule: Rule = level.rule === 'puyo' ? 'puyo' : 'tet';
    const d = newDoc(rule);
    d.id = typeof level.id === 'string' ? level.id : '';
    d.description = typeof level.description === 'string' ? level.description : '';
    d.diff = typeof level.diff === 'number' ? level.diff : null;
    d.allowHold = level.allowHold === true;

    const src = (rule === 'tet' ? level.initialField : level.initialPuyoField) as unknown;
    if (Array.isArray(src)) {
        const R = rows(rule), C = cols(rule);
        const start = R - src.length;   // quiz.js と同じ下詰め
        src.forEach((row, i) => {
            const r = start + i;
            if (r < 0 || r >= R || !Array.isArray(row)) return;
            for (let c = 0; c < C; c++) d.field[r][c] = num(row[c], 0);
        });
    }
    if (rule === 'tet' && Array.isArray(level.nextPieces)) {
        d.next = (level.nextPieces as unknown[]).map(v => num(v, 0));
    }
    if (rule === 'puyo' && Array.isArray(level.nextPuyoPairs)) {
        d.pairs = (level.nextPuyoPairs as unknown[]).map(p =>
            (Array.isArray(p) ? [num(p[0], 1), num(p[1], 1)] : [1, 1]) as Pair);
    }

    const cc = (level.clearCondition ?? {}) as Record<string, unknown>;
    const base = defaultCond(rule);
    d.cond = {
        type: typeof cc.type === 'string' ? cc.type : base.type,
        value: num(cc.value, 0),
        countCondition: typeof cc.countCondition === 'string' ? cc.countCondition : base.countCondition,
        countValue: num(cc.countValue, 1),
        description: typeof cc.description === 'string' ? cc.description : '',
        descriptionAuto: false,
    };
    d.cond.descriptionAuto = d.cond.description === autoCondDescription(rule, d.cond);

    for (const k of Object.keys(level)) if (!KNOWN_KEYS.has(k)) d.extra[k] = level[k];
    for (const k of Object.keys(cc)) if (!KNOWN_COND_KEYS.has(k)) d.condExtra[k] = cc[k];
    return d;
}

// ─────────────────────────────────────────────
// EditorDoc → 出力オブジェクト（正規化つき・§4.4）
// ─────────────────────────────────────────────

/** 上側の空行を落とした盤面（下詰めで読まれるので結果は同じ）。全空なら空行1つ（既存データ tet-11 と同じ） */
export function trimmedField(d: EditorDoc): number[][] {
    let top = d.field.findIndex(row => row.some(v => v !== 0));
    if (top < 0) top = d.field.length - 1;
    return d.field.slice(top).map(r => r.slice());
}

export function buildClearCondition(d: EditorDoc): Record<string, unknown> {
    const c = d.cond;
    const def = findCondDef(d.rule, c.type);
    const out: Record<string, unknown> = { type: c.type };
    // value は使う type だけ出力。count は回数なので必ず出力（Q7）
    if (c.type === 'count' || (def ? def.usesValue : true)) out.value = c.value;
    if (c.type === 'count') {
        out.countCondition = c.countCondition;
        out.countValue = c.countValue;
    }
    Object.assign(out, d.condExtra);
    out.description = c.description;
    return out;
}

export function buildLevel(d: EditorDoc): Record<string, unknown> {
    const out: Record<string, unknown> = { id: d.id };
    if (d.diff !== null) out.diff = d.diff;
    out.description = d.description;
    out.rule = d.rule;
    if (d.rule === 'tet') {
        out.allowHold = d.allowHold;
        out.initialField = trimmedField(d);
        out.nextPieces = d.next.slice();
    } else {
        out.initialPuyoField = trimmedField(d);
        out.nextPuyoPairs = d.pairs.map(p => [p[0], p[1]]);
    }
    for (const k of Object.keys(d.extra)) out[k] = d.extra[k];
    out.clearCondition = buildClearCondition(d);
    return out;
}

// ─────────────────────────────────────────────
// シリアライザ（既存 tdata/pdata.json と同じ書式）
//   インデント4／tet 盤面行は `[3,3,0,...]`（空白なし）／puyo 盤面行は `[0, 0, ...]`
//   nextPieces は `[3, 2, 4, 0]`／nextPuyoPairs は `[[2, 4], [2, 4]]`
// ─────────────────────────────────────────────
const IND = '    ';

function fmtValue(key: string, v: unknown, depth: number, rule: Rule): string {
    const pad = IND.repeat(depth);
    if ((key === 'initialField' || key === 'initialPuyoField') && Array.isArray(v)) {
        const sep = key === 'initialField' ? ',' : ', ';
        const rowsTxt = (v as number[][]).map(r => `${pad}${IND}[${r.join(sep)}]`);
        return `[\n${rowsTxt.join(',\n')}\n${pad}]`;
    }
    if (key === 'nextPieces' && Array.isArray(v)) return `[${(v as number[]).join(', ')}]`;
    if (key === 'nextPuyoPairs' && Array.isArray(v)) {
        return `[${(v as number[][]).map(p => `[${p.join(', ')}]`).join(', ')}]`;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return fmtObject(v as Record<string, unknown>, depth, rule);
    }
    // その他（未知キー等）は JSON.stringify の4インデントを現在の深さに合わせる
    return JSON.stringify(v, null, 4).replace(/\n/g, `\n${pad}`);
}

function fmtObject(o: Record<string, unknown>, depth: number, rule: Rule): string {
    const pad = IND.repeat(depth);
    const lines = Object.keys(o).map(k => `${pad}${IND}${JSON.stringify(k)}: ${fmtValue(k, o[k], depth + 1, rule)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
}

/** 1問を、配列の要素として貼れる形（先頭インデント4）で文字列化する */
export function serializeLevel(d: EditorDoc, baseDepth = 1): string {
    return IND.repeat(baseDepth) + fmtObject(buildLevel(d), baseDepth, d.rule);
}

// ─────────────────────────────────────────────
// 貼り付けテキストの解釈（1問 or 配列。template.txt 由来の先頭/末尾カンマも許容）
// ─────────────────────────────────────────────
export function parseLevelsText(text: string): Record<string, unknown>[] {
    const t = text.trim().replace(/^,+/, '').replace(/,+$/, '').trim();
    const v = JSON.parse(t) as unknown;
    const arr = Array.isArray(v) ? v : [v];
    return arr.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x));
}

// ─────────────────────────────────────────────
// 検証（§7）
// ─────────────────────────────────────────────
export type IssueLevel = 'error' | 'warn' | 'info';
export interface Issue { level: IssueLevel; msg: string; }

export function validate(d: EditorDoc, otherIds: string[]): Issue[] {
    const out: Issue[] = [];
    const err = (msg: string) => out.push({ level: 'error', msg });
    const warn = (msg: string) => out.push({ level: 'warn', msg });
    const info = (msg: string) => out.push({ level: 'info', msg });

    // ── 問題情報 ──
    if (!d.id.trim()) err('ID が空です');
    else if (otherIds.includes(d.id)) err(`ID「${d.id}」は既存の問題と重複しています`);
    if (!d.description.trim()) warn('問題名（description）が空です');
    if (d.diff === null) info('難易度が未指定のため★は表示されません');
    if ('title' in d.extra) warn('旧仕様の title キーが残っています（現行では表示に使われません）');

    // ── NEXT ──
    const nextCount = d.rule === 'tet' ? d.next.length : d.pairs.length;
    if (nextCount === 0) err('NEXT が0個です');
    if (d.rule === 'tet' && d.allowHold && d.next.length === 1) warn('HOLD 許可ですが NEXT が1個しかありません');

    // ── クリア条件 ──
    const c = d.cond;
    const def = findCondDef(d.rule, c.type);
    if (!def) err(`未知のクリア条件 type「${c.type}」です`);
    else {
        if (!def.selectable) warn(`クリア条件「${c.type}」: ${def.note ?? '旧形式です'}`);
        if ((def.usesValue || c.type === 'count') && !(Number.isInteger(c.value) && c.value >= 1)) {
            err(`クリア条件の値（${def.valueLabel ?? 'value'}）は1以上の整数にしてください`);
        }
    }
    if (c.type === 'count') {
        const cd = findCountDef(d.rule, c.countCondition);
        if (!cd) err(`未知の countCondition「${c.countCondition}」です`);
        else if (cd.usesCountValue && !(Number.isInteger(c.countValue) && c.countValue >= 1)) {
            err('回数条件の閾値（countValue）は1以上の整数にしてください');
        }
    }
    if (!c.description.trim()) err('GOAL 文言（clearCondition.description）が空です');
    else if (!c.descriptionAuto && c.description !== autoCondDescription(d.rule, c)) {
        info(`GOAL 文言は手書きです（自動生成なら「${autoCondDescription(d.rule, c)}」）`);
    }

    // ── 盤面 ──
    if (d.rule === 'tet') {
        const full = d.field.map((r, i) => (r.every(v => v !== 0) ? i : -1)).filter(i => i >= 0);
        if (full.length) warn(`揃っている行があります（下から ${full.map(i => TET_ROWS - i).join(', ')} 段目）。開始時には消えません`);
        // 出現位置: Mino.spawn() は x=3, y=-2（I は y=-1）で、可視の最上段（row 0）の x=3〜6 に掛かる。
        // quiz.js の popMino は塞がっていれば1段上で再判定するので即ゲームオーバーにはならない（tet-10 が該当）
        if ([3, 4, 5, 6].some(x => d.field[0][x] !== 0)) {
            info('最上段の中央4列にブロックがあるため、ミノは1段上から出現します');
        }
    } else {
        let floating = 0, hidden = 0;
        for (let x = 0; x < PUYO_COLS; x++) {
            let seenEmptyBelow = false;
            for (let r = PUYO_ROWS - 1; r >= 0; r--) {
                const v = d.field[r][x];
                if (v === 0) seenEmptyBelow = true;
                else {
                    if (seenEmptyBelow) floating++;
                    if (r < PUYO_HIDDEN) hidden++;
                }
            }
        }
        if (floating) warn(`浮いているぷよが ${floating} 個あります（そのままの位置で配置されます）`);
        if (hidden) warn(`隠し段にぷよが ${hidden} 個あります`);
        // エディタが描くのは下から 14 段まで（polish2 §3）。それより上にあると見えず・編集できない
        const above = d.field.slice(0, PUYO_ROWS - 14).reduce((n, row) => n + row.filter(v => v !== 0).length, 0);
        if (above) err(`15 段目より上にぷよが ${above} 個あります（エディタは下から 14 段まで）`);
        // 消える判定はゲームと同じく可視 12 段だけ（puyo-sim.findErasable）。最初の手を置いた時に一緒に消える
        const big = findErasable(d.field).groups.length;
        if (big) warn(`同色4個以上つながっているグループが ${big} 個あります（最初の手を置いた時に消えます）`);
        if (isDead(d.field)) err('3列目の最上段（出現位置）が埋まっているため、開始と同時に窒息します');
    }
    return out;
}


// ─────────────────────────────────────────────
// NEXT のテキスト表現（貼り付け・並べ替え用）
// ─────────────────────────────────────────────
export function nextToText(next: number[]): string {
    return next.map(t => MINO_LETTERS[t] ?? '?').join('');
}
export function textToNext(text: string): number[] {
    const out: number[] = [];
    for (const ch of text.toUpperCase()) {
        const i = (MINO_LETTERS as readonly string[]).indexOf(ch);
        if (i >= 0) out.push(i);
    }
    return out;
}
export function pairsToText(pairs: Pair[]): string {
    return pairs.map(p => `${p[0]}${p[1]}`).join(' ');
}
export function textToPairs(text: string): Pair[] {
    const digits = (text.match(/[1-5]/g) ?? []).map(Number);
    const out: Pair[] = [];
    for (let i = 0; i + 1 < digits.length; i += 2) out.push([digits[i], digits[i + 1]]);
    return out;
}

/** 7種1巡（バッグ）をランダム順で返す */
export function randomBag(): number[] {
    const a = [0, 1, 2, 3, 4, 5, 6];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ─────────────────────────────────────────────
// 変更点（ファイルの元の問題と比べて何が変わったか。状態表示・WRITE FILE の確認・DRAFTS で使う）
//   どちらも buildLevel を通した形で比べる（不要 value の削除などの正規化だけの差は変更に数えない）
// ─────────────────────────────────────────────
const CHANGE_GROUPS: [string[], string][] = [
    [['id'], 'ID'], [['description'], '問題名'], [['diff'], '難易度'], [['allowHold'], 'HOLD'],
    [['initialField', 'initialPuyoField'], '盤面'], [['nextPieces', 'nextPuyoPairs'], 'NEXT'],
    [['clearCondition'], 'GOAL'], [['rule'], 'ルール'],
];
export function levelChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
    const out: string[] = [];
    const known = new Set(CHANGE_GROUPS.flatMap(g => g[0]));
    for (const [keys, label] of CHANGE_GROUPS) {
        if (keys.some(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) out.push(label);
    }
    const others = new Set([...Object.keys(before), ...Object.keys(after)].filter(k => !known.has(k)));
    if ([...others].some(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) out.push('その他');
    return out;
}
