// ─────────────────────────────────────────────
// solutions.ts
// 解答手順ファイル（ローカル専用・git 管理外）の読み書き（設計 §4.5）
//   場所: source_assets/quizlevels/tsolutions.json（テト）・psolutions.json（ぷよ。段階4）（/source_assets は .gitignore 済み）
//   形式: { "<問題id>": { "steps": Step[] | PuyoStep[], "note": string, "updated": "YYYY-MM-DD" } }
//   読込: Vite dev サーバー経由で fetch
//   書込: dev サーバーの書き込み口（dev-files.ts。Safari も可）→ File System Access API（Chrome/Edge。ハンドルは IndexedDB）。
//         どちらも使えない時はマージ済みの全体をダウンロードする
// ─────────────────────────────────────────────
import type { AnyStep, Rule } from './model.ts';
import { canPickFiles, getHandle, readText, writeText, downloadText } from './fsa.ts';
import { canWriteFiles, devFilesAvailable, devRead, devWrite } from './dev-files.ts';

export { canWriteFiles };

export interface SolutionEntry {
    steps: AnyStep[];
    note: string;
    updated: string;
    /** 保存時刻（ISO）。Gist 同期でどちらが新しいかを決めるのに使う。古いエントリには無い（＝最も古い扱い） */
    updatedAt?: string;
    /** MEMO（中間点の盤面。polish §6）。盤面と同じ形 */
    memo?: number[][];
}
/** 保存する中身があるか（手順か MEMO。どちらも無ければキーごと消す） */
export function hasSolutionContent(e: SolutionEntry): boolean {
    return e.steps.length > 0 || !!e.memo;
}
export type SolutionMap = Record<string, SolutionEntry>;

export type SolutionFileName = 'tsolutions.json' | 'psolutions.json';
export const SOLUTION_FILES: Record<Rule, SolutionFileName> = { tet: 'tsolutions.json', puyo: 'psolutions.json' };
export const RULES: Rule[] = ['tet', 'puyo'];
export function solutionPath(rule: Rule): string { return `source_assets/quizlevels/${SOLUTION_FILES[rule]}`; }

/**
 * 解答ファイルを読む。dev サーバーの口があればそれで読み、ファイルが無ければ {}（＝まだ 1 件も無い。最初の保存で作られる）。
 * 口が無い（プレビュー等）時は fetch。読めなければ null
 */
export async function fetchSolutions(rule: Rule): Promise<SolutionMap | null> {
    try {
        if (devFilesAvailable()) {
            const cur = await devRead(SOLUTION_FILES[rule]);
            if (!cur.exists || !cur.text.trim()) return {};
            const v = JSON.parse(cur.text) as unknown;
            return v && typeof v === 'object' && !Array.isArray(v) ? v as SolutionMap : null;
        }
        const res = await fetch(`/${solutionPath(rule)}`, { cache: 'no-store' });
        if (!res.ok) return null;
        // Vite は存在しないパスで index.html を返すことがあるので JSON か確かめる
        const text = await res.text();
        const v = JSON.parse(text) as unknown;
        return v && typeof v === 'object' && !Array.isArray(v) ? v as SolutionMap : null;
    } catch {
        return null;
    }
}

/** 既存の書式に合わせ、1手を1行にした読みやすい JSON にする */
export function serializeSolutions(map: SolutionMap): string {
    const ids = Object.keys(map);
    const blocks = ids.map(id => {
        const e = map[id];
        const steps = e.steps.map(s => `            ${JSON.stringify(s)}`).join(',\n');
        return `    ${JSON.stringify(id)}: {\n` +
            `        "steps": [${e.steps.length ? `\n${steps}\n        ` : ''}],\n` +
            (e.memo ? `        "memo": [\n${e.memo.map(r => `            ${JSON.stringify(r)}`).join(',\n')}\n        ],\n` : '') +
            `        "note": ${JSON.stringify(e.note ?? '')},\n` +
            `        "updated": ${JSON.stringify(e.updated)}${e.updatedAt ? `,\n        "updatedAt": ${JSON.stringify(e.updatedAt)}` : ''}\n` +
            '    }';
    });
    return `{\n${blocks.join(',\n')}\n}\n`;
}

export function today(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 1問ぶんの解答を保存する（ファイルの他の問題は保持してマージ）。
 * oldId が別名なら旧キーを消す（問題 id の変更に追従）。steps が空ならキーごと削除。
 * 戻り値: 保存後のマップと保存方法
 */
export async function saveSolution(
    rule: Rule, id: string, oldId: string | null, entry: SolutionEntry, fallback: SolutionMap, forcePick = false,
): Promise<{ map: SolutionMap; via: 'file' | 'download'; fileName?: string }> {
    const FILE_NAME = SOLUTION_FILES[rule];
    const apply = (base: SolutionMap): SolutionMap => {
        const m: SolutionMap = { ...base };
        if (oldId && oldId !== id) delete m[oldId];
        if (hasSolutionContent(entry)) m[id] = entry; else delete m[id];
        return m;
    };

    if (devFilesAvailable() && !forcePick) {
        const cur = await devRead(FILE_NAME);
        const map = apply(cur.text.trim() ? JSON.parse(cur.text) as SolutionMap : {});   // 壊れた JSON なら上書きせず例外で止める
        await devWrite(FILE_NAME, serializeSolutions(map), cur.hash);
        return { map, via: 'file', fileName: FILE_NAME };
    }
    if (canPickFiles()) {
        const h = await getHandle(FILE_NAME, 'save', forcePick);
        let base: SolutionMap = {};
        const text = await readText(h);
        if (text.trim()) base = JSON.parse(text) as SolutionMap;   // 壊れた JSON なら上書きせず例外で止める
        const map = apply(base);
        await writeText(h, serializeSolutions(map));
        return { map, via: 'file', fileName: h.name };
    }
    const map = apply(fallback);
    downloadText(FILE_NAME, serializeSolutions(map));
    return { map, via: 'download' };
}

/** ローカルの解答ファイルを読む（dev サーバー経由、無理ならファイルを選ばせる）。Gist への取り込み用 */
export async function readLocalSolutions(rule: Rule): Promise<SolutionMap | null> {
    const FILE_NAME = SOLUTION_FILES[rule];
    const viaServer = await fetchSolutions(rule);
    if (viaServer) return viaServer;
    if (!canPickFiles()) return null;
    const h = await getHandle(FILE_NAME, 'save', false);
    const text = await readText(h);
    return text.trim() ? JSON.parse(text) as SolutionMap : {};
}

/** 解答の全体をローカルファイルへ書き出す（Gist が正本の時のバックアップ用）。非対応ブラウザはダウンロード */
export async function exportSolutionsFile(rule: Rule, map: SolutionMap, forcePick = false): Promise<{ via: 'file' | 'download'; fileName: string }> {
    const FILE_NAME = SOLUTION_FILES[rule];
    const text = serializeSolutions(map);
    if (devFilesAvailable() && !forcePick) {
        await devWrite(FILE_NAME, text, (await devRead(FILE_NAME)).hash);
        return { via: 'file', fileName: FILE_NAME };
    }
    if (canPickFiles()) {
        const h = await getHandle(FILE_NAME, 'save', forcePick);
        await writeText(h, text);
        return { via: 'file', fileName: h.name };
    }
    downloadText(FILE_NAME, text);
    return { via: 'download', fileName: FILE_NAME };
}
