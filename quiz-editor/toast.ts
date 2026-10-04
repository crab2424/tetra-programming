// ─────────────────────────────────────────────
// toast.ts
// お知らせ（トースト）。画面に重ねて出すので、出ても消えても他の部品の位置・大きさは変わらない。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-save-notify.md §1
// ─────────────────────────────────────────────

export type ToastKind = 'info' | 'warn' | 'error';
export interface ToastAction { label: string; title?: string; run: () => void; }
export interface ToastOpts {
    /** ボタンを付ける（押すと実行してトーストを閉じる）。ボタン付きは閉じるまで残る */
    actions?: ToastAction[];
    /** 閉じるまで残す（error は常に残る） */
    sticky?: boolean;
}
export interface LogEntry { at: Date; kind: ToastKind; msg: string; }

const LIFE: Record<ToastKind, number> = { info: 3000, warn: 4000, error: 0 };
const MAX_SHOWN = 3;
const MAX_LOG = 20;

interface Shown { el: HTMLElement; msg: string; kind: ToastKind; count: number; timer: number; life: number; }

const shown: Shown[] = [];
const log: LogEntry[] = [];
let host: HTMLElement | null = null;
let onLog: (() => void) | null = null;

function ensureHost(): HTMLElement {
    if (host) return host;
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
    return host;
}

function remove(t: Shown) {
    clearTimeout(t.timer);
    t.el.remove();
    const i = shown.indexOf(t);
    if (i >= 0) shown.splice(i, 1);
}

function arm(t: Shown) {
    clearTimeout(t.timer);
    if (t.life > 0) t.timer = window.setTimeout(() => remove(t), t.life);
}

/** お知らせを出す。同じ文言が続いたら1件にまとめて「×n」を付ける */
export function toast(msg: string, kind: ToastKind = 'info', opts: ToastOpts = {}) {
    log.unshift({ at: new Date(), kind, msg });
    if (log.length > MAX_LOG) log.length = MAX_LOG;
    onLog?.();

    const last = shown[shown.length - 1];
    if (last && last.msg === msg && last.kind === kind && !opts.actions) {
        last.count++;
        last.el.querySelector('.toast-n')!.textContent = `×${last.count}`;
        arm(last);
        return;
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const text = document.createElement('span');
    text.className = 'toast-msg';
    text.textContent = msg;
    const n = document.createElement('span');
    n.className = 'toast-n';
    el.append(text, n);
    const life = opts.sticky || opts.actions?.length ? 0 : LIFE[kind];
    const t: Shown = { el, msg, kind, count: 1, timer: 0, life };
    for (const a of opts.actions ?? []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        if (a.title) b.title = a.title;
        b.addEventListener('click', () => { remove(t); a.run(); });
        el.append(b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-x';
    close.setAttribute('aria-label', '閉じる');
    close.textContent = '×';
    close.addEventListener('click', () => remove(t));
    el.append(close);
    // マウスを乗せている間は消さない
    el.addEventListener('mouseenter', () => clearTimeout(t.timer));
    el.addEventListener('mouseleave', () => arm(t));
    ensureHost().append(el);
    shown.push(t);
    arm(t);
    // 消えない物（ボタン付き・エラー）より、自動で消える物から先に押し出す
    while (shown.length > MAX_SHOWN) remove(shown.find(s => s.life > 0) ?? shown[0]);
}

/** ボタン付きのお知らせのうち、文言が一致する物を閉じる（状況が変わって不要になった時） */
export function dismissToasts(match: (msg: string) => boolean) {
    for (const t of [...shown]) if (match(t.msg)) remove(t);
}

/** 直近のお知らせ（新しい順） */
export function toastLog(): readonly LogEntry[] { return log; }
export function onToastLog(fn: () => void) { onLog = fn; }
