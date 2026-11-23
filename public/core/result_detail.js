// ─────────────────────────────────────────────
// result_detail.js — リザルト画面の右の列「DETAIL」（各種 T-Spin の回数・消したぷよ・PC など）
//
//   ResultDetail.render(id, games, opts) … id の箱（#result-detail / #versus-result-detail）を描く
//       games: [盤面]（シングル）か [1P, 2P]（対戦）。opts.names = ['1P', '2P'] など列の見出し
//   ResultDetail.clear(id)              … 箱を空にして隠す（PRACTICE・QUIZ など詳細を出さない画面）
//
//   値は盤面がもともと持っている数（playStats＝成績 STATS と同じカウンタ・score・lines・attackSent・getActiveMs）
//   を読むだけ。数え方は game/tet/scoring.js（l1〜3・ts0〜3・tsm0/tsm・pcl・renMax・b2bMax）と
//   game/puyo/engine.js（sp・ch・ac）。箱が空のときは CSS で左の列だけの今までの見た目に戻る。
//   見出しの文言は英語大文字（UI 文言の規約）。
// ─────────────────────────────────────────────

window.ResultDetail = (() => {
    const isPuyo = (g) => !!g && (g.chainMax !== undefined && g.clearedPuyos !== undefined);

    function activeMs(g) {
        try { return typeof g.getActiveMs === 'function' ? g.getActiveMs() : (g.elapsedTime || g.elapsed || 0); }
        catch (e) { return 0; }
    }
    function perMin(n, ms) { return ms > 0 ? ((n || 0) / (ms / 60000)).toFixed(1) : '—'; }
    function perSec(n, ms) { return ms > 0 ? ((n || 0) / (ms / 1000)).toFixed(2) : '—'; }

    function pieces(g) {
        const ps = g.playStats || {};
        return isPuyo(g) ? (ps.sp || 0) : (ps.pc || 0);
    }

    // 盤面 1 枚ぶんの値。key → 表示する文字（当てはまらない行は入れない）
    function values(g, versus) {
        const out = {};
        if (!g) return out;
        const ps = g.playStats || {};
        const ms = activeMs(g);
        const n = pieces(g);
        out.pieces = String(n);
        out.pps = perSec(n, ms);
        if (versus) {
            out.attack = String(g.attackSent || 0);
            out.apm = perMin(g.attackSent, ms);
        }
        if (isPuyo(g)) {
            out.erased = String(g.clearedPuyos || 0);
            out.maxChain = String(g.chainMax || 0);
            out.allClear = String(ps.ac || 0);
            const ch = Array.isArray(ps.ch) ? ps.ch : [];
            for (let k = 0; k < ch.length; k++) out['ch' + (k + 1)] = String(ch[k] || 0);
            out._chains = ch;
        } else {
            out.lines = String(g.lines || 0);
            out.lpm = perMin(g.lines, ms);
            out.l1 = String(ps.l1 || 0);
            out.l2 = String(ps.l2 || 0);
            out.l3 = String(ps.l3 || 0);
            out.t4 = String(ps.t4 || 0);
            out.ts0 = String(ps.ts0 || 0);
            out.ts1 = String(ps.ts1 || 0);
            out.ts2 = String(ps.ts2 || 0);
            out.ts3 = String(ps.ts3 || 0);
            out.tsm0 = String(ps.tsm0 || 0);
            out.tsm = String(ps.tsm || 0);
            out.pcl = String(ps.pcl || 0);
            out.renMax = String(ps.renMax || 0);
            out.b2bMax = String(ps.b2bMax || 0);
        }
        return out;
    }

    // 節と行（どの盤面にも値が無い行は出さない）
    const SECTIONS = [
        { title: 'PACE', rows: [
            ['pieces', 'PIECES'], ['pps', 'PPS'], ['attack', 'ATTACK'], ['apm', 'APM'], ['lines', 'LINES'], ['lpm', 'LPM'],
        ] },
        { title: 'LINE CLEARS', rows: [
            ['l1', 'SINGLE'], ['l2', 'DOUBLE'], ['l3', 'TRIPLE'], ['t4', '4-LINES'], ['pcl', 'PERFECT CLEAR'],
        ] },
        { title: 'T-SPIN', rows: [
            ['ts0', 'T-SPIN ZERO'], ['ts1', 'T-SPIN SINGLE'], ['ts2', 'T-SPIN DOUBLE'], ['ts3', 'T-SPIN TRIPLE'],
            ['tsm0', 'MINI ZERO'], ['tsm', 'MINI'],
        ] },
        { title: 'COMBO', rows: [['renMax', 'MAX REN'], ['b2bMax', 'MAX B2B']] },
        { title: 'PUYO', rows: [['erased', 'ERASED PUYO'], ['maxChain', 'MAX CHAIN'], ['allClear', 'ALL CLEAR']] },
        { title: 'CHAINS', chains: true },
    ];

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function box(id) { return document.getElementById(id); }

    function clear(id) {
        const b = box(id);
        if (!b) return;
        b.innerHTML = '';
        b.style.display = 'none';
        b.closest('.result-split')?.classList.remove('has-detail');
    }

    function render(id, games, opts = {}) {
        const b = box(id);
        if (!b) return;
        const list = (games || []).filter(Boolean);
        if (!list.length) { clear(id); return; }
        const versus = list.length > 1 || !!opts.versus;
        const vals = list.map((g) => values(g, versus));
        const cols = vals.length;
        b.innerHTML = '';
        b.appendChild(el('div', 'result-detail-title', 'DETAIL'));
        const table = el('div', 'result-detail-table');
        table.style.setProperty('--rd-cols', String(cols));
        if (cols > 1) {
            const head = el('div', 'result-detail-row result-detail-head');
            head.appendChild(el('span', 'result-detail-label', ''));
            (opts.names || []).slice(0, cols).forEach((nm) => head.appendChild(el('span', 'result-detail-value', nm)));
            table.appendChild(head);
        }
        const addRow = (label, cells, cls) => {
            const row = el('div', 'result-detail-row' + (cls ? ' ' + cls : ''));
            row.appendChild(el('span', 'result-detail-label', label));
            cells.forEach((c) => row.appendChild(el('span', 'result-detail-value' + (c === '—' ? ' is-none' : ''), c)));
            table.appendChild(row);
        };
        for (const sec of SECTIONS) {
            const rows = [];
            if (sec.chains) {
                // 連鎖の長さごとの回数（どれかの盤面で 1 回以上あった長さだけ。20 以上は 20+）
                let maxK = 0;
                vals.forEach((v) => (v._chains || []).forEach((c, k) => { if (c > 0 && k + 1 > maxK) maxK = k + 1; }));
                for (let k = 1; k <= maxK; k++) {
                    const cells = vals.map((v) => (v._chains ? String(v._chains[k - 1] || 0) : '—'));
                    if (cells.every((c) => c === '0' || c === '—')) continue;
                    rows.push([k >= 20 ? '20+ CHAIN' : `${k} CHAIN`, cells]);
                }
            } else {
                for (const [key, label] of sec.rows) {
                    if (!vals.some((v) => v[key] !== undefined)) continue;
                    rows.push([label, vals.map((v) => (v[key] !== undefined ? v[key] : '—'))]);
                }
            }
            if (!rows.length) continue;
            table.appendChild(el('div', 'result-detail-sec', sec.title));
            rows.forEach(([label, cells]) => addRow(label, cells, cells.every((c) => c === '0' || c === '—') ? 'is-zero' : ''));
        }
        b.appendChild(table);
        b.style.display = '';
        b.closest('.result-split')?.classList.add('has-detail');
    }

    return { render, clear, values };
})();
