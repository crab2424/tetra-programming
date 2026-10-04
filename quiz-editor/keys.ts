// ─────────────────────────────────────────────
// keys.ts
// キー操作の一覧（ヘルプ表示用の正）と入力判定ヘルパー
// 実際の処理は main.ts の各ハンドラ。キーを変えたらこの表も必ず直す。
// ─────────────────────────────────────────────

export interface KeyRow { keys: string; desc: string; }
export interface KeySection { title: string; rows: KeyRow[]; }

export const KEY_HELP: KeySection[] = [
    {
        title: 'GLOBAL（テキスト入力中以外）',
        rows: [
            { keys: 'Ctrl/⌘+Z ・ Ctrl/⌘+Shift+Z (Ctrl+Y)', desc: '元に戻す ・ やり直し' },
            { keys: 'Ctrl/⌘+S', desc: 'JSON をコピー' },
            { keys: 'Alt+1〜5 ・ Alt+0', desc: '難易度 ★1〜5 ・ 未指定' },
            { keys: 'Tab ・ Shift+Tab', desc: 'エリア移動（盤面 → NEXT → …）' },
            { keys: 'Esc', desc: '盤面にフォーカスを戻す' },
            { keys: '?', desc: 'このキー一覧' },
        ],
    },
    {
        title: 'FIELD（盤面にフォーカス）',
        rows: [
            { keys: '矢印', desc: 'カーソル移動' },
            { keys: 'Space ・ Enter', desc: '塗る（同じ色なら空にする）／行塗りモードでは行を塗る' },
            { keys: 'Shift+矢印', desc: '塗りながら移動' },
            { keys: 'TET: 1〜8 ・ I O T J L S Z G', desc: '色を選ぶ（8 = G = おじゃま）' },
            { keys: 'PUYO: 1〜5 ・ 6', desc: '色を選ぶ（6 = おじゃま）' },
            { keys: '0 ・ Backspace', desc: '空を選ぶ' },
            { keys: 'Q ・ E', desc: 'パレットの前 ・ 次' },
            { keys: 'R', desc: '行塗りモード切替（クリックしたマス以外を塗る）' },
            { keys: 'Alt+矢印', desc: '盤面全体をシフト' },
            { keys: 'M', desc: '左右反転' },
            { keys: 'H', desc: 'HOLD 許可の切替（TET）' },
            { keys: 'Shift+Delete', desc: '盤面を全消去' },
            { keys: 'マウス: 左ドラッグ ・ 右ドラッグ', desc: '塗る（同色開始なら空で塗る）・ 消す' },
        ],
    },
    {
        title: 'NEXT（NEXT 欄にフォーカス）',
        rows: [
            { keys: 'TET: I O T J L S Z', desc: 'キャレット位置に挿入' },
            { keys: 'PUYO: 1〜5 を2つ', desc: '[軸, 子] のペアを挿入' },
            { keys: '← → ・ Home End', desc: 'キャレット移動' },
            { keys: 'Backspace ・ Delete', desc: 'キャレットの前 ・ 後を削除' },
            { keys: 'X', desc: '（PUYO）キャレット直前のペアの軸/子を入れ替え' },
            { keys: 'B', desc: '（TET）7種1巡をランダム順で追加' },
            { keys: 'マウス', desc: 'クリックでキャレット移動・ドラッグで並べ替え' },
        ],
    },
];

/** テキスト入力中か（グローバルキーを無効にする判定） */
export function isTextInput(el: Element | null): boolean {
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLSelectElement) return true;
    if (el instanceof HTMLInputElement) {
        return !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
    }
    return (el as HTMLElement).isContentEditable === true;
}

/** Ctrl（Mac は ⌘）が押されているか */
export function isMod(e: KeyboardEvent): boolean {
    return e.ctrlKey || e.metaKey;
}
