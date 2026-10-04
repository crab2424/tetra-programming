// ─────────────────────────────────────────────
// levels-file.ts
// tdata.json / pdata.json の「テキスト」を直接編集する（設計 §4.7・Q7）
//   既存ファイルは書式が不揃い（pdata の一部は12スペース等）なので、全体を再シリアライズすると
//   無関係な問題まで差分が出る。そこで各問題（配列の要素）の文字範囲を特定し、
//   編集した問題の範囲だけを差し替える／挿入する／取り除く。他の問題のテキストは1文字も変えない。
// ─────────────────────────────────────────────

/** 配列直下の要素（オブジェクト）の文字範囲 [start, end)。start は '{'、end は対応する '}' の次 */
export interface Span { start: number; end: number; }

/** トップレベル配列の要素範囲を返す（文字列リテラル内の括弧は無視） */
export function topLevelSpans(text: string): Span[] {
    const spans: Span[] = [];
    let depth = 0, inStr = false, esc = false, start = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '[' || ch === '{') {
            if (depth === 1 && ch === '{') start = i;
            depth++;
        } else if (ch === ']' || ch === '}') {
            depth--;
            if (depth === 1 && ch === '}' && start >= 0) { spans.push({ start, end: i + 1 }); start = -1; }
        }
    }
    return spans;
}

function lineStart(text: string, pos: number): number { return text.lastIndexOf('\n', pos - 1) + 1; }

/** 要素 k を取り除く（前後の区切りの「,」と改行も一緒に） */
export function removeAt(text: string, k: number): string {
    const sp = topLevelSpans(text);
    if (k < 0 || k >= sp.length) throw new Error(`要素 ${k} がありません`);
    if (k > 0) return text.slice(0, sp[k - 1].end) + text.slice(sp[k].end);
    if (sp.length > 1) return text.slice(0, lineStart(text, sp[0].start)) + text.slice(lineStart(text, sp[1].start));
    // 唯一の要素 → 空配列にする
    const open = text.indexOf('[');
    const close = text.lastIndexOf(']');
    return text.slice(0, open + 1) + '\n' + text.slice(close);
}

/**
 * index の位置に要素を挿入する（index = 要素数なら末尾）。
 * block は「先頭インデント4・末尾改行なし」の1問ぶん（model.serializeLevel(doc, 1)）
 */
export function insertAt(text: string, index: number, block: string): string {
    const sp = topLevelSpans(text);
    if (sp.length === 0) {
        const open = text.indexOf('[');
        const close = text.lastIndexOf(']');
        if (open < 0 || close < open) throw new Error('配列が見つかりません');
        return text.slice(0, open + 1) + '\n' + block + '\n' + text.slice(close);
    }
    if (index >= sp.length) {
        const last = sp[sp.length - 1];
        return text.slice(0, last.end) + ',\n' + block + text.slice(last.end);
    }
    const ls = lineStart(text, sp[index].start);
    return text.slice(0, ls) + block + ',\n' + text.slice(ls);
}

/** 要素 k の範囲だけを block に置き換える（要素の前のインデントは元のまま残す） */
export function replaceAt(text: string, k: number, block: string): string {
    const sp = topLevelSpans(text);
    if (k < 0 || k >= sp.length) throw new Error(`要素 ${k} がありません`);
    return text.slice(0, sp[k].start) + block.trimStart() + text.slice(sp[k].end);
}

export interface WritePlan {
    text: string;            // 書き込む全文
    index: number;           // 書き込んだ問題の位置（0始まり）
    action: 'replace' | 'move' | 'insert';
}

/**
 * 1問を書き込んだ後の全文を作り、他の問題のテキストが変わっていないことを検証する。
 *   srcIndex: 元の問題の位置（新規なら -1）
 *   dstIndex: 置きたい位置（srcIndex と同じなら置換、-1 なら元の位置 or 末尾）
 */
export function planWrite(text: string, srcIndex: number, dstIndex: number, block: string, expected: unknown): WritePlan {
    const before = topLevelSpans(text);
    const others = before.map(s => text.slice(s.start, s.end)).filter((_, i) => i !== srcIndex);
    let out: string, index: number, action: WritePlan['action'];
    if (srcIndex >= 0 && (dstIndex < 0 || dstIndex === srcIndex)) {
        out = replaceAt(text, srcIndex, block); index = srcIndex; action = 'replace';
    } else if (srcIndex >= 0) {
        const removed = removeAt(text, srcIndex);
        index = Math.min(dstIndex, before.length - 1);
        out = insertAt(removed, index, block); action = 'move';
    } else {
        index = dstIndex < 0 ? before.length : Math.min(dstIndex, before.length);
        out = insertAt(text, index, block); action = 'insert';
    }

    // ── 検証: JSON として正しい／他の問題のテキストが順番も含めて不変／書いた問題が期待どおり ──
    const parsed = JSON.parse(out) as unknown[];
    const after = topLevelSpans(out);
    const othersAfter = after.map(s => out.slice(s.start, s.end)).filter((_, i) => i !== index);
    if (othersAfter.length !== others.length || othersAfter.some((t, i) => t !== others[i])) {
        throw new Error('他の問題のテキストが変わってしまうため中止しました');
    }
    if (JSON.stringify(parsed[index]) !== JSON.stringify(expected)) {
        throw new Error('書き込んだ問題の内容が期待と一致しないため中止しました');
    }
    return { text: out, index, action };
}
