// ─────────────────────────────────────────────
// solutions.ts
// 解答手順ファイル（ローカル専用・git 管理外）の読み書き（設計 §4.5）
//   場所: source_assets/quizlevels/tsolutions.json（/source_assets は .gitignore 済み）
//   形式: { "<問題id>": { "steps": Step[], "note": string, "updated": "YYYY-MM-DD" } }
//   読込: Vite dev サーバー経由で fetch
//   書込: File System Access API（Chrome/Edge）。ファイルハンドルは IndexedDB に保持。
//         使えないブラウザではマージ済みの全体をダウンロードする
// ─────────────────────────────────────────────
import type { Step } from './tet-sim.ts';
import { canWriteFiles, getHandle, readText, writeText, downloadText } from './fsa.ts';

export { canWriteFiles };

export interface SolutionEntry { steps: Step[]; note: string; updated: string; }
export type SolutionMap = Record<string, SolutionEntry>;

export const SOLUTION_PATH = 'source_assets/quizlevels/tsolutions.json';
const FILE_NAME = 'tsolutions.json';

export async function fetchSolutions(): Promise<SolutionMap | null> {
    try {
        const res = await fetch(`/${SOLUTION_PATH}`, { cache: 'no-store' });
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
            `        "note": ${JSON.stringify(e.note ?? '')},\n` +
            `        "updated": ${JSON.stringify(e.updated)}\n` +
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
    id: string, oldId: string | null, entry: SolutionEntry, fallback: SolutionMap, forcePick = false,
): Promise<{ map: SolutionMap; via: 'file' | 'download'; fileName?: string }> {
    const apply = (base: SolutionMap): SolutionMap => {
        const m: SolutionMap = { ...base };
        if (oldId && oldId !== id) delete m[oldId];
        if (entry.steps.length) m[id] = entry; else delete m[id];
        return m;
    };

    if (canWriteFiles()) {
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
