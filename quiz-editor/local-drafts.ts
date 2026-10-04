// ─────────────────────────────────────────────
// local-drafts.ts
// 端末内の下書き（自動保存の保存先）。1 問につき 1 つで、複数の問題ぶんを持てる。
// Gist へは SAVE を押した時だけ送る（sync.ts）。設計: tetlabo-quiz-editor-save-notify.md §3
// ─────────────────────────────────────────────
import type { EditorDoc, Rule } from './model.ts';

/** 最後に Gist へ保存した（または Gist から開いた）時の rev と内容 */
export interface SentMark { rev: number; hash: string; }

export interface LocalDraft {
    doc: EditorDoc;
    sourceId: string | null;   // 既存問題から開いた場合の元 id
    draftId: string;           // Gist に保存する時のファイル名（draft-<id>.json）。1 問につき 1 つで固定
    updatedAt: string;         // ISO
    sent?: SentMark;
}

/** 開いている問題（再読み込みした時にこれを開く） */
export interface CurrentRef { key: string; rule: Rule; sourceId: string | null; draftId: string; }

const DRAFTS_KEY = 'tetlabo.quizEditor.localDrafts';
const CURRENT_KEY = 'tetlabo.quizEditor.current';
const LEGACY_KEY = 'tetlabo.quizEditor.draft';   // 旧: 開いている 1 問だけ
/** これを超えたら DRAFTS で整理を促す（自動では消さない） */
export const LOCAL_DRAFT_WARN = 30;

/** 既存問題は「ルール:元 id」、新規は「new:draftId」。同じ問題を開き直しても下書きは増えない */
export function draftKey(rule: Rule, sourceId: string | null, draftId: string): string {
    return sourceId !== null ? `${rule}:${sourceId}` : `new:${draftId}`;
}

/** 内容の比較用の短い値（FNV-1a 32bit ＋長さ） */
export function contentHash(doc: EditorDoc, sourceId: string | null): string {
    const s = JSON.stringify([doc, sourceId]);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36) + '.' + s.length.toString(36);
}

function read<T>(key: string): T | null {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

export class LocalDrafts {
    private map: Record<string, LocalDraft> = {};
    /** 保存できなかった（容量不足など）時に呼ぶ */
    onError: (err: unknown) => void = () => { };

    constructor() {
        const m = read<Record<string, LocalDraft>>(DRAFTS_KEY);
        if (m && typeof m === 'object') {
            for (const [k, d] of Object.entries(m)) if (d && d.doc && Array.isArray(d.doc.field) && d.draftId) this.map[k] = d;
        }
    }

    get(key: string): LocalDraft | undefined { return this.map[key]; }
    count(): number { return Object.keys(this.map).length; }
    /** 新しい順 */
    all(): [string, LocalDraft][] {
        return Object.entries(this.map).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
    }
    findByDraftId(id: string): [string, LocalDraft] | undefined {
        return Object.entries(this.map).find(([, d]) => d.draftId === id);
    }

    put(key: string, d: LocalDraft) {
        this.map[key] = d;
        this.persist();
    }
    remove(key: string) {
        if (!(key in this.map)) return;
        delete this.map[key];
        this.persist();
    }
    setSent(key: string, sent: SentMark | undefined) {
        const d = this.map[key];
        if (!d) return;
        if (sent) d.sent = sent; else delete d.sent;
        this.persist();
    }

    current(): CurrentRef | null { return read<CurrentRef>(CURRENT_KEY); }
    setCurrent(ref: CurrentRef) {
        try { localStorage.setItem(CURRENT_KEY, JSON.stringify(ref)); } catch { /* 開き直す問題が分からなくなるだけ */ }
    }

    /** 旧形式（開いている 1 問だけ）があれば取り出して消す */
    takeLegacy(): { doc: EditorDoc; sourceId: string | null; draftId: string | null } | null {
        const o = read<{ doc: EditorDoc; sourceId: string | null; draftId?: string | null }>(LEGACY_KEY);
        try { localStorage.removeItem(LEGACY_KEY); } catch { /* 読めないなら消せなくてもよい */ }
        if (!o || !o.doc || !Array.isArray(o.doc.field)) return null;
        return { doc: o.doc, sourceId: o.sourceId ?? null, draftId: o.draftId ?? null };
    }

    private persist() {
        try {
            localStorage.setItem(DRAFTS_KEY, JSON.stringify(this.map));
        } catch (err) {
            this.onError(err);
        }
    }
}
