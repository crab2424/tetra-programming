// ─────────────────────────────────────────────
// keys.ts
// キー操作の一覧（ヘルプ表示用の正）と入力判定ヘルパー
// 実際の処理は main.ts の各ハンドラ。キーを変えたらこの表も必ず直す。
// ─────────────────────────────────────────────

export interface KeyRow { keys: string; desc: string; }
export interface KeySection { title: string; rows: KeyRow[]; }

export const KEY_HELP: KeySection[] = [
    {
        title: 'GLOBAL（テキスト入力中以外。盤面以外にフォーカスがあっても効く）',
        rows: [
            { keys: 'P', desc: 'EDIT（最後に使った PAINT / STAMP / NEXT）⇔ SOLVE' },
            { keys: 'Shift+P', desc: 'PAINT → STAMP → NEXT の順に切替（ぷよは PAINT ⇔ NEXT）' },
            { keys: 'N', desc: 'NEXT モード ⇔ 直前の PAINT / STAMP（PC）' },
            { keys: 'H', desc: 'HOLD 許可の切替（TET・SOLVE 以外）' },
            { keys: 'Ctrl/⌘+Z ・ Ctrl/⌘+Shift+Z (Ctrl+Y)', desc: '元に戻す ・ やり直し' },
            { keys: 'Ctrl/⌘+↑ ・ Ctrl/⌘+↓', desc: '先頭 ・ 末尾へ（NEXT のキャレット・SOLVE の手。Home / End と同じ）' },
            { keys: 'Ctrl/⌘+S', desc: 'JSON をコピー' },
            { keys: 'Ctrl/⌘+P', desc: '問題の一覧（サイドバーの LEVELS）へ。矢印で選択・Enter で開く' },
            { keys: '/', desc: 'LEVELS の絞り込み欄へ（LEVELS を表示中。Esc でタイルへ戻る）' },
            { keys: 'Ctrl/⌘+B', desc: 'サイドバーの開閉（PC）' },
            { keys: 'Alt+1〜5 ・ Alt+0', desc: '難易度 ★1〜5 ・ 未指定' },
            { keys: 'V ・ Shift+V', desc: 'MEMO（中間点の盤面）を盤面の場所に表示 / 戻す ・ 今の盤面（SOLVE は表示中の手の盤面）を MEMO に' },
            { keys: 'Tab ・ Shift+Tab', desc: 'フォーカス移動（キーは今のモードが受け取る）' },
            { keys: 'Esc', desc: '盤面にフォーカスを戻す' },
            { keys: '?', desc: 'このキー一覧' },
        ],
    },
    {
        title: 'PAINT モード',
        rows: [
            { keys: '矢印', desc: 'カーソル移動' },
            { keys: 'Space ・ Enter', desc: '塗る（同じ色なら空にする）／行塗りモードでは行を塗る' },
            { keys: 'Shift+矢印', desc: '塗りながら移動' },
            { keys: 'TET: 1〜8 ・ I O T J L S Z G', desc: '色を選ぶ（8 = G = おじゃま）' },
            { keys: 'PUYO: 1〜5 ・ 6', desc: '色を選ぶ（1 赤・2 青・3 紫・4 緑・5 黄・6 おじゃま）' },
            { keys: '0 ・ Backspace', desc: '空を選ぶ' },
            { keys: 'Q ・ E', desc: 'パレットの前 ・ 次' },
            { keys: 'R', desc: '行塗りモード切替（クリックしたマス以外を塗る）' },
            { keys: 'Alt+矢印', desc: '盤面全体をシフト' },
            { keys: 'M', desc: '左右反転' },
            { keys: 'H', desc: 'HOLD 許可の切替（TET）' },
            { keys: 'Shift+Delete ・ Ctrl/⌘+Backspace', desc: '盤面を全消去' },
            { keys: 'マウス: 左ドラッグ ・ 右ドラッグ（Mac は control+ドラッグも）', desc: '塗る（同色開始なら空で塗る）・ 消す' },
        ],
    },
    {
        title: 'NEXT モード（PC。N で入る・NEXT 列を押しても入る）',
        rows: [
            { keys: 'TET: I O T J L S Z', desc: 'キャレット位置に挿入' },
            { keys: 'PUYO: 1〜5 を2つ', desc: '[軸, 子] のペアを挿入（1 赤・2 青・3 紫・4 緑・5 黄）' },
            { keys: '↑ ↓ ← → ・ Home End（Ctrl/⌘+↑ ↓）', desc: 'キャレット移動（先頭 ・ 末尾）' },
            { keys: 'Alt+↑ ・ Alt+↓', desc: 'キャレットの前の項目を前 ・ 後ろへ移動' },
            { keys: 'Backspace ・ Delete', desc: 'キャレットの前 ・ 後を削除' },
            { keys: 'Shift+Delete ・ Ctrl/⌘+Backspace', desc: 'NEXT を全部消す' },
            { keys: 'X', desc: '（PUYO）キャレット直前のペアの軸/子を入れ替え' },
            { keys: 'B', desc: '（TET）7種1巡をランダム順で追加' },
            { keys: 'マウス', desc: 'NEXT 列のクリックでキャレット移動・ドラッグで並べ替え・盤面を押すと直前のモードに戻ってそのまま塗る' },
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

/** Mac か（キーの表記と、Mac だけの操作に使う） */
export function isMac(): boolean {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = nav.userAgentData?.platform || navigator.platform || navigator.userAgent;
    return /mac/i.test(p);
}

/** キーの表記を Mac 向けにする（Mac 以外はそのまま。polish §3.2） */
export function keyLabel(text: string): string {
    if (!isMac()) return text;
    return text
        .replace(/\s*\(Ctrl\+Y\)/g, '')
        .replace(/Ctrl\/⌘\+/g, '⌘')
        .replace(/Alt\+/g, '⌥')
        .replace(/Shift\+/g, '⇧')
        .replace(/Backspace/g, '⌫')
        .replace(/Shift(?=[ ・]|$)/g, '⇧')
        .replace(/\bDelete\b/g, 'Delete（fn+⌫）')
        .replace(/Home End/g, 'Home End（fn+← →）')
        .replace(/\bHome ・ End\b/g, 'Home ・ End（fn+← ・ fn+→）');
}

/** Ctrl（Mac は ⌘）が押されているか */
export function isMod(e: KeyboardEvent): boolean {
    return e.ctrlKey || e.metaKey;
}
