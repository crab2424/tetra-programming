// ─────────────────────────────────────────────
// search.ts
// SEARCH（解の探索・解の数え上げ）の入口。段階 S1 = 探索コアのみ（Worker・画面は S3/S4）
// 「解」= クリア条件を満たすまでの手順（各手の置き場所の並び。HOLD の入替も別。設計 §0.1 Q1）。
// 置き場所は STRICT 相当（出現位置からゲームの操作で届く所だけ。Q3）。T-Spin の判定が違えば別の置き方（Q2）。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-solver.md
// ─────────────────────────────────────────────
import type { EditorDoc } from './model.ts';
import { simulate, type Step } from './tet-sim.ts';
import { simulatePuyo, type PuyoStep } from './puyo-sim.ts';
import { searchTet } from './search-tet.ts';
import { searchPuyo } from './search-puyo.ts';

export interface SearchOptions {
    timeLimitMs: number;
    /** 取り出す解の最大数（数え上げとは別。0 なら取り出さない） */
    maxSolutions: number;
    /** この数の解が見つかったら止める（UNIQUE＝2。省略で全探索） */
    stopAt?: number;
    /** 枝刈りと条件に合わせたメモのキーの縮約（設計 §2.4・§2.5）。既定 true。false は確認用（数は同じになるはず） */
    prune?: boolean;
    /** 探索中に約 0.2 秒ごとに呼ばれる */
    onProgress?: (p: SearchProgress) => void;
    /**
     * 並列で分け合う時の受け持ち（設計 §14）。SPLIT_DEPTH 手目の子を順に番号付けし、番号 % parts === part の物だけを数える。
     * それより浅い手でクリアした解は part 0 が数える。全部の part の数の和が全体の数（メモは part ごと）
     */
    split?: { part: number; parts: number };
}

/** split で分け合う手の深さ（2 手目の置き場所で分ける。1 手目だけだと受け持ちの偏りが大きい） */
export const SPLIT_DEPTH = 2;

export interface SearchProgress {
    nodes: number;      // 展開しようとした状態の数
    found: number;      // ここまでに数えた解の数
    elapsedMs: number;
}

/**
 * COUNT で数える解の上限。人が見渡せる数を超えたら、それ以上は数えずに止める（ユーザー指示 2026-10-22: HOLD の重複なども合わせて 1000 程度）
 */
export const SOLUTION_CAP = 1000;

/** UNIQUE = 別解チェック（2 つ目で止める）、COUNT = 数える（SOLUTION_CAP で止める）。設計 §0.1 */
export type SearchMode = 'unique' | 'count';

/** モードごとの探索オプション */
export function modeOptions(mode: SearchMode, timeLimitMs: number): SearchOptions {
    return mode === 'unique'
        ? { timeLimitMs, maxSolutions: 2, stopAt: 2 }
        : { timeLimitMs, maxSolutions: SOLUTION_CAP, stopAt: SOLUTION_CAP };
}

export interface SearchResult<S> {
    /** 解の数。complete でなければ下限（それまでに数えた分） */
    count: number;
    complete: boolean;
    timedOut: boolean;
    stopped: boolean;        // stopAt に達して止めた
    nodes: number;           // 展開しようとした状態の数（メモのヒットも含む）
    memoSize: number;        // 展開し終えた状態の数
    placementCalls: number;  // 置き場所の列挙を呼んだ回数
    placements: number;      // 列挙した置き場所の合計
    searchMs: number;
    totalMs: number;         // 解の取り出しを含む
    solutions: S[][];
}

export type AnySearchResult = SearchResult<Step> | SearchResult<PuyoStep>;

export function searchDoc(doc: EditorDoc, opts: SearchOptions): AnySearchResult {
    return doc.rule === 'tet' ? searchTet(doc, opts) : searchPuyo(doc, opts);
}

/** 解をシミュレーター（simulate / simulatePuyo）で検算する。最後の手でちょうどクリアし、エラーが無ければ正しい。正しくない解の index を返す */
export function verifySolutions(doc: EditorDoc, solutions: (Step | PuyoStep)[][]): number[] {
    const bad: number[] = [];
    solutions.forEach((steps, i) => {
        const r = doc.rule === 'tet' ? simulate(doc, steps as Step[]) : simulatePuyo(doc, steps as PuyoStep[]);
        if (r.firstError || r.clearedAt !== steps.length) bad.push(i);
    });
    return bad;
}
