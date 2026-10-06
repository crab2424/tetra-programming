// ─────────────────────────────────────────────
// dev-files.ts
// dev サーバーの読み書き口（scripts/quiz-editor-files.ts）を使う。Safari でも書ける。
// 起動時に probeDevFiles() で使えるか確かめる（プレビュー・本番のビルドには口が無い → false）。
// 設計: tetlabo-quiz-editor-drafts.md §1.3 A
// ─────────────────────────────────────────────

import { canPickFiles } from './fsa.ts';

export type DevFileName = 'tdata.json' | 'pdata.json' | 'tsolutions.json';
const BASE = '/__quiz-editor';

let available = false;

/** 外で変更されていた（読んだ後に他の何かが書いた） */
export class DevFileConflictError extends Error {
    constructor() { super('ファイルが外で変更されています。もう一度試してください'); }
}

export function devFilesAvailable(): boolean { return available; }

/** ファイルに直接書けるか（dev サーバーの口 か File System Access） */
export function canWriteFiles(): boolean { return available || canPickFiles(); }

export async function probeDevFiles(): Promise<boolean> {
    if (!import.meta.env.DEV) return false;
    try {
        const res = await fetch(`${BASE}/files`, { cache: 'no-store' });
        const o = res.ok ? await res.json() as { files?: unknown } : null;
        available = Array.isArray(o?.files);
    } catch {
        available = false;
    }
    return available;
}

/** 今の中身と、書く時に渡す hash（ファイルが無ければ text='' / hash=''） */
export async function devRead(name: DevFileName): Promise<{ text: string; hash: string; exists: boolean }> {
    const res = await fetch(`${BASE}/file?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${name} を読めませんでした（HTTP ${res.status}）`);
    return await res.json() as { text: string; hash: string; exists: boolean };
}

/** base = devRead で得た hash。その後に外で変わっていたら DevFileConflictError */
export async function devWrite(name: DevFileName, text: string, base: string): Promise<void> {
    const res = await fetch(`${BASE}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text, base }),
    });
    if (res.status === 409) throw new DevFileConflictError();
    if (!res.ok) {
        const o = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(o?.error ?? `HTTP ${res.status}`);
    }
}
