// ─────────────────────────────────────────────
// ask.ts
// ページ内の確認ダイアログ（ブラウザ標準の confirm() の代わり）。
// 戻せる確認には「次回から表示しない」を付けられる（このブラウザの localStorage に覚える）。
// 設計: tetlabo-quiz-editor-polish.md §7
// ─────────────────────────────────────────────

/** 「次回から表示しない」を付ける確認 */
export type SkipId = 'rule-switch' | 'delete-gist' | 'to-initial';
export const SKIP_LABELS: Record<SkipId, string> = {
    'rule-switch': 'TET / PUYO の切り替え',
    'delete-gist': 'Gist の下書きの DELETE',
    'to-initial': 'SET AS INITIAL（表示中の盤面を初期盤面に）',
};
const SKIP_KEY = 'tetlabo.quizEditor.skipConfirm';

function readSkips(): Partial<Record<SkipId, true>> {
    try {
        const v = JSON.parse(localStorage.getItem(SKIP_KEY) ?? '{}') as unknown;
        return v && typeof v === 'object' ? v as Partial<Record<SkipId, true>> : {};
    } catch {
        return {};
    }
}
function writeSkips(v: Partial<Record<SkipId, true>>) {
    try { localStorage.setItem(SKIP_KEY, JSON.stringify(v)); } catch { /* 保存不可 */ }
}
/** 表示しないことにした確認 */
export function skippedConfirms(): SkipId[] {
    return (Object.keys(readSkips()) as SkipId[]).filter(k => k in SKIP_LABELS);
}
export function resetSkippedConfirms() { writeSkips({}); }

let dlg: HTMLDialogElement | null = null;
function dialog(): HTMLDialogElement {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'ask-dlg';
    dlg.innerHTML = '<form method="dialog"><h2>CONFIRM</h2><p class="ask-msg"></p>' +
        '<label class="ask-skip"><input type="checkbox"> 次回から表示しない</label>' +
        '<div class="row end"><button type="button" value="cancel">CANCEL</button><button type="submit" value="ok" class="primary">OK</button></div></form>';
    document.body.append(dlg);
    return dlg;
}

/**
 * 確認する。OK なら true。skipId を渡すと「次回から表示しない」を出し、チェックして OK した物は以後聞かずに true を返す
 * （キャンセルした時はチェックを覚えない）
 */
export function ask(msg: string, opts: { ok?: string; skipId?: SkipId } = {}): Promise<boolean> {
    if (opts.skipId && readSkips()[opts.skipId]) return Promise.resolve(true);
    const d = dialog();
    d.querySelector<HTMLElement>('.ask-msg')!.textContent = msg;
    const skip = d.querySelector<HTMLLabelElement>('.ask-skip')!;
    const box = skip.querySelector('input')!;
    skip.hidden = !opts.skipId;
    box.checked = false;
    const okBtn = d.querySelector<HTMLButtonElement>('button[value=ok]')!;
    okBtn.textContent = opts.ok ?? 'OK';
    d.returnValue = '';
    d.showModal();
    okBtn.focus();
    // ボタンの click で決める（close イベントは画面が非表示の間は遅れて届くことがあるため、Esc 等の保険にだけ使う）
    return new Promise(res => {
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            d.removeEventListener('click', onClick);
            if (ok && opts.skipId && box.checked) writeSkips({ ...readSkips(), [opts.skipId]: true });
            res(ok);
        };
        const onClick = (e: Event) => {
            const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
            if (!b) return;
            e.preventDefault();
            d.close(b.value);
            finish(b.value === 'ok');
        };
        d.addEventListener('click', onClick);
        d.addEventListener('close', () => finish(d.returnValue === 'ok'), { once: true });
    });
}
