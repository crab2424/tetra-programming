// ─────────────────────────────────────────────
// search-ui.ts
// SEARCH のビュー（段階 S4）: MODE・TIME・RUN / CANCEL・進捗・結果・解の一覧（置いたマスの組でまとめる）・
// 解を SOLVE の手順に読み込む・保存済みの解との比較・問題を変えたら「古い結果」表示。
// 探索そのものは search-client.ts（Worker）。設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-solver.md §6・§13
// ─────────────────────────────────────────────
import { type AnyStep, type EditorDoc, MINO_LETTERS } from './model.ts';
import { cellsOf, describeResult, simulate, type Step } from './tet-sim.ts';
import { describePuyoResult, simulatePuyo, type PuyoStep } from './puyo-sim.ts';
import { SearchRunner, describeOutcome, describeProgress, type SearchOutcome } from './search-client.ts';
import type { SearchMode, SearchProgress } from './search.ts';

export interface SearchUiDeps {
    doc(): EditorDoc;
    /** 解答ファイルに保存済みの手順（無ければ null） */
    savedSteps(): AnyStep[] | null;
    /** 解を SOLVE の手順に読み込む。読み込んだら true（確認で取り消したら false） */
    load(steps: AnyStep[], label: string): Promise<boolean>;
    /** SEARCH のビューが見えているか（見えていない時に終わったらお知らせを出す） */
    visible(): boolean;
    notify(msg: string, kind: 'info' | 'warn'): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const MODE_KEY = 'tetlabo.quizEditor.searchMode';
const TIME_KEY = 'tetlabo.quizEditor.searchTime';
const DIR_MARK = ['↑', '→', '↓', '←'];
/** 一覧に最初に出すまとまりの数（「さらに表示」で増やす） */
const LIST_PAGE = 200;
/** 1 つのまとまりの中で番号ボタンを出す順番違いの数 */
const VARIANT_BUTTONS = 12;

/** 探索の結果を問題の中身で覚える鍵（問題名・GOAL 文言など解に関係しない物は入れない） */
function problemSig(d: EditorDoc): string {
    return JSON.stringify([d.rule, d.field, d.rule === 'tet' ? d.next : d.pairs, d.rule === 'tet' && d.allowHold,
        d.cond.type, d.cond.value, d.cond.countCondition, d.cond.countValue]);
}
const docKey = (d: EditorDoc) => `${d.rule}:${d.id}`;

/** 一覧の 1 行ぶん */
interface SolView {
    steps: AnyStep[];
    seq: string;       // 手の並び（HTML）
    result: string;    // 最後の手の結果
    exact: string;     // 同じ解かの比較用（手ごとの置いたマス・判定・HOLD）
    group: string;     // 順番違いをまとめる鍵（手の集合。HOLD は無視）
}
interface Group { len: number; items: number[]; }
interface Record {
    sig: string;
    doc: EditorDoc;    // 探索した時の問題（解の表示に使う）
    outcome: SearchOutcome;
    sols: SolView[];
    groups: Group[];
    loaded: number | null;   // 最後に読み込んだ解
    savedFor: string;        // savedIdx を求めた時の保存済み手順
    savedIdx: number | null | undefined;   // 保存済みの解と同じ解（無ければ null。未計算は undefined）
}

function cellsKey(s: Step): string {
    return cellsOf({ type: s.piece, rot: s.rot & 3, x: s.x, y: s.y }).map(([x, y]) => y * 16 + x).sort((a, b) => a - b).join('.');
}

/** 解の表示と比較用の鍵。シミュレーターに通らない手順なら null */
function viewOf(d: EditorDoc, steps: AnyStep[]): SolView | null {
    if (d.rule === 'tet') {
        const ts = steps as Step[];
        const sim = simulate(d, ts);
        if (sim.firstError || sim.clearedAt !== ts.length) return null;
        const per = ts.map((s, k) => `${s.piece}:${cellsKey(s)}:${sim.results[k].tspin ?? ''}`);
        return {
            steps,
            // ミノ＋一番左の列（1 始まり）。位置だけが違う解を見分けられるように
            seq: ts.map(s => {
                const left = Math.min(...cellsOf({ type: s.piece, rot: s.rot & 3, x: s.x, y: s.y }).map(([x]) => x)) + 1;
                return `${MINO_LETTERS[s.piece]}<span class="c">${left}</span>${s.hold ? '<span class="h">H</span>' : ''}`;
            }).join(' '),
            result: describeResult(sim.results[ts.length - 1]),
            exact: ts.map((s, k) => `${s.hold ? 'h' : ''}${per[k]}`).join('/'),
            group: per.slice().sort().join('/'),
        };
    }
    const ps = steps as PuyoStep[];
    const sim = simulatePuyo(d, ps);
    if (sim.firstError || sim.clearedAt !== ps.length) return null;
    const placed = sim.frames.map(f => f[0].map(r => r.join('')).join(''));
    const per = ps.map((s, k) => `${[...d.pairs[k]].sort().join('')}:${s.x},${s.y},${s.rot}`);
    return {
        steps,
        seq: ps.map(s => `${s.x + 1}${DIR_MARK[s.rot & 3]}`).join(' '),   // 軸の列＋子の向き（describePlace の短い形）
        result: describePuyoResult(sim.results[ps.length - 1]),
        exact: placed.join('/'),
        group: per.slice().sort().join('/'),
    };
}

/** 保存済みの手順と同じ比較用の鍵（SOLVE で置いた手は向きの番号などが違っても、置いたマスが同じなら同じ解）。scripts/quiz-search-check.ts でも使う */
export function exactOf(d: EditorDoc, steps: AnyStep[]): string | null {
    return steps.length ? viewOf(d, steps)?.exact ?? null : null;
}

export function initSearchUi(deps: SearchUiDeps) {
    const runner = new SearchRunner();
    const records = new Map<string, Record>();     // 問題の中身 → 結果
    const lastSig = new Map<string, string>();      // 問題（ルール:ID）→ 最後に探索した時の中身
    let mode: SearchMode = 'count';
    let timeMs = 10000;
    try {
        const m = localStorage.getItem(MODE_KEY);
        if (m === 'count' || m === 'unique') mode = m;
        const t = Number(localStorage.getItem(TIME_KEY));
        if ([10000, 60000, 300000].includes(t)) timeMs = t;
    } catch { /* 読めない */ }
    let running: { sig: string; key: string; id: string; mode: SearchMode } | null = null;
    let progress: SearchProgress | null = null;
    let listLimit = LIST_PAGE;
    let listKey = '';

    const timeSel = $<HTMLSelectElement>('search-time');
    timeSel.value = String(timeMs);
    timeSel.addEventListener('change', () => {
        timeMs = Number(timeSel.value);
        try { localStorage.setItem(TIME_KEY, String(timeMs)); } catch { /* 保存不可 */ }
    });
    for (const b of document.querySelectorAll<HTMLButtonElement>('#search-mode button')) {
        b.addEventListener('click', () => {
            mode = b.dataset.smode as SearchMode;
            try { localStorage.setItem(MODE_KEY, mode); } catch { /* 保存不可 */ }
            render();
        });
    }
    $('btn-search-run').addEventListener('click', () => void run());
    $('btn-search-cancel').addEventListener('click', () => runner.cancel());
    $('search-list').addEventListener('click', e => {
        const t = e.target as HTMLElement;
        if (t.closest('[data-more]')) { listLimit += LIST_PAGE; listKey = ''; render(); return; }
        const btn = t.closest<HTMLButtonElement>('[data-i]');
        if (btn && !btn.disabled) void loadAt(Number(btn.dataset.i));
    });

    async function run() {
        const d = structuredClone(deps.doc());
        const sig = problemSig(d), key = docKey(d);
        running = { sig, key, id: d.id, mode };
        progress = null;
        render();
        const outcome = await runner.run(d, mode, timeMs, p => { progress = p; renderStatus(); });
        running = null;
        progress = null;
        const sols: SolView[] = [];
        let broken = 0;
        for (const steps of outcome.solutions) {
            const v = viewOf(d, steps);
            if (v) sols.push(v); else broken++;
        }
        if (broken) outcome.bad = Math.max(outcome.bad, broken);
        // 順番違い（HOLD の入替・同じミノの置き場所の入替）を 1 つにまとめる。短い解から
        const byGroup = new Map<string, Group>();
        sols.forEach((v, i) => {
            const g = byGroup.get(v.group);
            if (g) g.items.push(i); else byGroup.set(v.group, { len: v.steps.length, items: [i] });
        });
        const groups = [...byGroup.values()].sort((a, b) => a.len - b.len || a.items[0] - b.items[0]);
        records.set(sig, { sig, doc: d, outcome, sols, groups, loaded: null, savedFor: '', savedIdx: undefined });
        lastSig.set(key, sig);
        listLimit = LIST_PAGE;
        listKey = '';
        if (!deps.visible() && outcome.status !== 'cancelled') {
            const { label, text } = describeOutcome(outcome);
            deps.notify(`SEARCH ${d.id}: ${label} — ${text}`, outcome.bad ? 'warn' : 'info');
        }
        render();
    }

    async function loadAt(i: number) {
        const rec = current();
        if (!rec || rec.stale) return;
        const v = rec.rec.sols[i];
        if (!v) return;
        if (await deps.load(v.steps.map(s => ({ ...s })), `#${i + 1}`)) {
            rec.rec.loaded = i;
            listKey = '';
            render();
        }
    }

    /** 今の問題の結果（中身が変わっていれば stale） */
    function current(): { rec: Record; stale: boolean } | null {
        const d = deps.doc();
        const fresh = records.get(problemSig(d));
        if (fresh) return { rec: fresh, stale: false };
        const old = lastSig.get(docKey(d));
        const rec = old ? records.get(old) : undefined;
        return rec ? { rec, stale: true } : null;
    }

    function savedIndex(rec: Record): number | null {
        const saved = deps.savedSteps();
        const key = JSON.stringify(saved ?? null);
        if (rec.savedIdx !== undefined && rec.savedFor === key) return rec.savedIdx;
        const ex = saved ? exactOf(rec.doc, saved) : null;
        const idx = ex === null ? -1 : rec.sols.findIndex(v => v.exact === ex);
        rec.savedFor = key;
        rec.savedIdx = idx < 0 ? null : idx;
        return rec.savedIdx;
    }

    function renderStatus() {
        const st = $('search-status');
        const d = deps.doc();
        const busy = running !== null;
        $('btn-search-run').hidden = busy;
        $('btn-search-cancel').hidden = !busy;
        document.querySelector('#activity [data-ptab="search"]')?.classList.toggle('busy', busy);
        if (running) {
            const other = running.key !== docKey(d) || running.sig !== problemSig(d);
            st.className = 'goal run';
            st.innerHTML = `<b>RUNNING</b><span>${running.mode === 'unique' ? '別解を探しています' : '解を数えています'}` +
                `${progress ? `（${esc(describeProgress(progress))}）` : '…'}</span>` +
                (other ? `<span class="stale-note">${esc(running.id || '新規')} の${running.key === docKey(d) ? '変更前の内容' : '問題'}を探索中です</span>` : '');
            return;
        }
        const cur = current();
        if (!cur) { st.className = 'goal'; st.textContent = 'RUN で探索します。'; return; }
        const o = cur.rec.outcome;
        const { label, text } = describeOutcome(o);
        const tone = o.bad ? 'err'
            : o.status === 'error' ? 'err'
            : o.status === 'done' ? (o.count === 0 ? 'err' : o.count === 1 ? 'ok' : 'warn')
            : o.status === 'multiple' || o.status === 'capped' ? 'warn' : '';
        st.className = `goal ${tone}${cur.stale ? ' stale' : ''}`;
        st.innerHTML = `<b>${esc(label)}</b><span>${esc(text)}</span>` +
            `<span class="note">${o.mode === 'unique' ? 'UNIQUE' : 'COUNT'}` + (o.parts > 1 ? `・並列 ${o.parts}` : '') +
            (o.status === 'cancelled' || o.status === 'timeout' ? '' : `・${(o.elapsedMs / 1000).toFixed(1)} 秒`) + '</span>' +
            (cur.stale ? '<span class="stale-note">問題を変更したので古い結果です（もう一度 RUN してください）。解の読み込みはできません</span>' : '');
    }

    function renderMeta(cur: { rec: Record; stale: boolean } | null) {
        const meta = $('search-meta');
        if (!cur || running) { meta.innerHTML = ''; return; }
        const { rec } = cur;
        const o = rec.outcome;
        const parts: string[] = [];
        if (o.byLength.length > 1) parts.push(`手数ごと: ${o.byLength.map(([n, c]) => `${n} 手 ${c.toLocaleString('ja-JP')}`).join('・')}`);
        if (rec.sols.length > 1) parts.push(`順番違いをまとめると ${rec.groups.length.toLocaleString('ja-JP')} 種類`);
        const saved = deps.savedSteps();
        if (!saved || !saved.length) parts.push('保存済みの解はありません');
        else if (!cur.stale) {
            const idx = savedIndex(rec);
            const allFound = o.status === 'done' && rec.sols.length === o.count;
            parts.push(idx !== null
                ? `<span class="saved-ok">保存済みの解は #${idx + 1} と同じです</span>`
                : allFound
                    ? '<span class="saved-ng">保存済みの解は見つかった解にありません（ゲームの操作では置けない手か、クリアした後の手が入っているかもしれません）</span>'
                    : '<span class="saved-ng">保存済みの解は、見つけた解の中にはありません（上限・打ち切り・UNIQUE で探していない所にあるかもしれません）</span>');
        }
        meta.innerHTML = parts.join('<br>');
    }

    function renderList(cur: { rec: Record; stale: boolean } | null) {
        const list = $('search-list');
        if (!cur || running) { if (listKey !== '') { list.innerHTML = ''; listKey = ''; } return; }
        const { rec, stale } = cur;
        const saved = stale ? null : savedIndex(rec);
        const key = `${rec.sig}|${stale}|${rec.loaded}|${saved}|${listLimit}`;
        if (key === listKey) return;
        listKey = key;
        const shown = rec.groups.slice(0, listLimit);
        const seqTitle = rec.doc.rule === 'tet' ? ' title="ミノ（小さい数字は一番左の列・H は HOLD を使った手）"' : ' title="数字は軸ぷよの列、矢印は子ぷよの向き"';
        const rows = shown.map(g => {
            const i = g.items.includes(rec.loaded ?? -1) ? rec.loaded! : g.items[0];
            const v = rec.sols[i];
            const on = g.items.includes(rec.loaded ?? -1);
            const vars = g.items.length > 1
                ? `<span class="vars">順番違い ×${g.items.length}` +
                  g.items.slice(0, VARIANT_BUTTONS).map(k => `<button type="button" data-i="${k}" class="${k === rec.loaded ? 'on' : ''}"${stale ? ' disabled' : ''} title="解 #${k + 1} を手順に読み込む">${k + 1}</button>`).join('') +
                  (g.items.length > VARIANT_BUTTONS ? ' …' : '') + '</span>'
                : '';
            const savedMark = g.items.includes(saved ?? -1) ? `<span class="saved" title="保存済みの解（#${saved! + 1}）と同じ">SAVED</span>` : '';
            return `<li class="${on ? 'on' : ''}"><button type="button" class="sol" data-i="${i}"${stale ? ' disabled' : ''} title="この解を SOLVE の手順に読み込む">` +
                `<span class="n">#${i + 1}</span><span class="seq"${seqTitle}>${v.seq}</span><span class="res">${v.steps.length} 手${v.result ? ' ' + esc(v.result) : ''}</span></button>` +
                savedMark + vars + '</li>';
        });
        if (rec.groups.length > shown.length) rows.push(`<li class="more"><button type="button" data-more>さらに表示（残り ${rec.groups.length - shown.length} 種類）</button></li>`);
        list.innerHTML = rows.join('');
    }

    function render() {
        for (const b of document.querySelectorAll<HTMLButtonElement>('#search-mode button')) {
            const on = b.dataset.smode === mode;
            b.classList.toggle('on', on);
            b.setAttribute('aria-checked', String(on));
        }
        renderStatus();
        const cur = current();
        renderMeta(cur);
        renderList(cur);
    }

    render();
    return { render, cancel: () => runner.cancel() };
}
