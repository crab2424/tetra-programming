// ─────────────────────────────────────────────
// stats_page.js — STATS ページ（#stats-page）の描画
//
// 中身は config/stats.js（window.Stats）の累計と履歴。設計 source_assets/memory/mode/record/stats/ §8。
// 平均・率はここで割り算して出す（保存していない）。
// タブ: SINGLE（枠ごとのカード）/ HISTORY（直近の一覧）。VERSUS・ONLINE・QUIZ・OVERVIEW は後の段階で足す。
// ─────────────────────────────────────────────

(function () {
  const TABS = [
    { id: 'single', label: 'SINGLE' },
    { id: 'history', label: 'HISTORY' },
  ];
  const RECENT_N = 10; // 「直近 n 回の平均」に使う件数

  let currentTab = 'single';

  // ─── 整形 ───────────────────────────────
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v).toLocaleString('en-US') : '—';

  // 記録のタイム（分:秒.百分の一）
  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
  }

  // 遊んだ時間の合計（時間:分:秒）
  function fmtTotal(ms) {
    if (!(ms > 0)) return '0:00:00';
    const t = Math.floor(ms / 1000);
    return Math.floor(t / 3600) + ':' + String(Math.floor((t % 3600) / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const pct = (a, b) => (b > 0) ? Math.round((a || 0) / b * 100) + '%' : '—';
  const pps = (pc, ms) => (ms > 0 && pc > 0) ? (pc / (ms / 1000)).toFixed(2) : '—';
  const label = (key) => (window.Records && window.Records.labelFor) ? window.Records.labelFor(key) : String(key).toUpperCase();
  const isTimeKey = (key) => key === 'sprint:40'; // 主指標がタイムの枠

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ─── タブ ───────────────────────────────
  function _renderTabs() {
    const toggle = document.getElementById('stats-tab-toggle');
    if (!toggle) return;
    if (toggle.childElementCount === 0) {
      TABS.forEach((t) => {
        const btn = el('button', 'opt-btn', t.label);
        btn.type = 'button';
        btn.dataset.tab = t.id;
        btn.onclick = () => setStatsTab(t.id);
        toggle.appendChild(btn);
      });
    }
    toggle.querySelectorAll('.opt-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === currentTab));
  }

  // ─── SINGLE ─────────────────────────────
  // 履歴から、その枠の直近 RECENT_N 回の平均（タイムの枠は完走だけ・設定を変えた試合は除く）
  function _recentAvg(history, key) {
    const time = isTimeKey(key);
    const rows = history.filter((h) => h.k === key && !h.c && (time ? h.r === 'ok' : (h.r === 'ok' || h.r === 'ng'))).slice(0, RECENT_N);
    if (rows.length === 0) return null;
    const sum = rows.reduce((a, h) => a + (time ? h.ms : h.sc), 0);
    return { value: sum / rows.length, count: rows.length };
  }

  function _cell(name, value, sub) {
    const c = el('div', 'stats-cell');
    c.appendChild(el('span', 'stats-cell-label', name));
    const v = el('span', 'stats-cell-value', value);
    if (sub) v.appendChild(el('span', 'stats-cell-sub', sub));
    c.appendChild(v);
    return c;
  }

  function _singleCard(key, b, history, index) {
    const card = el('div', 'stats-card stats-row-enter');
    card.style.animationDelay = (index * 0.05) + 's';
    const n = b.n || 0;
    const q = b.q || 0;
    const played = n + q + (b.cn || 0) + (b.cq || 0);

    const head = el('div', 'stats-card-head');
    head.appendChild(el('span', 'stats-card-title', label(key)));
    head.appendChild(el('span', 'stats-card-time', played > 0 ? 'TIME ' + fmtTotal((b.ms || 0) + (b.cms || 0)) : 'NO PLAYS'));
    card.appendChild(head);
    if (played === 0) { card.classList.add('stats-card-empty'); return card; }

    const grid = el('div', 'stats-grid');
    const playsSub = [];
    if (q > 0) playsSub.push(`QUIT ${num(q)}`);
    if ((b.cn || 0) + (b.cq || 0) > 0) playsSub.push(`CUSTOM ${num((b.cn || 0) + (b.cq || 0))}`);
    grid.appendChild(_cell('PLAYS', num(n), playsSub.join(' / ')));

    const best = window.Records && window.Records.get(key);
    grid.appendChild(_cell('BEST', best ? window.Records.format(key, best) : '—'));

    const time = isTimeKey(key);
    const recent = _recentAvg(history, key);
    if (time) {
      grid.appendChild(_cell('AVG TIME', b.ok > 0 ? fmtTime(b.okMs / b.ok) : '—'));
      grid.appendChild(_cell(`LAST ${RECENT_N}`, recent ? fmtTime(recent.value) : '—'));
    } else {
      grid.appendChild(_cell('AVG SCORE', n > 0 ? num((b.sc || 0) / n) : '—'));
      grid.appendChild(_cell(`LAST ${RECENT_N}`, recent ? num(recent.value) : '—'));
    }

    // ENDLESS には完走が無い
    if (key !== 'marathon:endless') grid.appendChild(_cell('CLEAR', pct(b.ok, n), n > 0 ? `${num(b.ok || 0)} / ${num(n)}` : ''));
    grid.appendChild(_cell('PPS', pps(b.pc, b.ms)));
    grid.appendChild(_cell('LINES', num(b.ln || 0)));
    grid.appendChild(_cell('4 LINES', num(b.t4 || 0)));
    grid.appendChild(_cell('T-SPIN', num((b.ts1 || 0) + (b.ts2 || 0) + (b.ts3 || 0)),
      `S ${num(b.ts1 || 0)} / D ${num(b.ts2 || 0)} / T ${num(b.ts3 || 0)} / MINI ${num(b.tsm || 0)}`));
    grid.appendChild(_cell('PERFECT CLEAR', num(b.pcl || 0)));
    grid.appendChild(_cell('MAX REN', num(b.renMax || 0)));
    grid.appendChild(_cell('MAX B2B', num(b.b2bMax || 0)));
    if (key === 'zone:150') {
      grid.appendChild(_cell('ZONE', '×' + num(b.zn || 0), `${num(b.znLn || 0)} LINES / MAX ${num(b.znMax || 0)}`));
    }
    card.appendChild(grid);
    return card;
  }

  function _renderSingle(list) {
    const buckets = window.Stats.getBuckets();
    const history = window.Stats.getHistory();
    window.Stats.SINGLE_KEYS.forEach((key, i) => list.appendChild(_singleCard(key, buckets[key] || {}, history, i)));
  }

  // ─── HISTORY ────────────────────────────
  const RESULT_LABEL = { ok: 'CLEAR', ng: 'GAME OVER', q: 'QUIT', w: 'WIN', l: 'LOSE', d: 'DRAW' };

  function _historyRow(h, index) {
    const row = el('div', 'stats-history-row' + (index < 12 ? ' stats-row-enter' : ''));
    if (index < 12) row.style.animationDelay = (index * 0.03) + 's';
    row.appendChild(el('span', 'stats-history-date', fmtDate(h.at)));
    row.appendChild(el('span', 'stats-history-mode', label(h.k) + (h.c ? ' *' : '')));
    row.appendChild(el('span', 'stats-history-result stats-result-' + h.r, RESULT_LABEL[h.r] || ''));
    // 主指標: タイムの枠は完走したときだけタイム、それ以外はスコア
    const main = isTimeKey(h.k) ? (h.r === 'ok' ? fmtTime(h.ms) : '—') : num(h.sc);
    row.appendChild(el('span', 'stats-history-value', main));
    row.appendChild(el('span', 'stats-history-sub', `${fmtTotal(h.ms)} · ${pps(h.pc, h.ms)} PPS`));
    return row;
  }

  function _renderHistory(list) {
    const history = window.Stats.getHistory();
    if (history.length === 0) {
      list.appendChild(el('p', 'ranking-status', 'NO HISTORY'));
      return;
    }
    history.forEach((h, i) => list.appendChild(_historyRow(h, i)));
  }

  // ─── 入口 ───────────────────────────────
  function renderStatsPage() {
    _renderTabs();
    const list = document.getElementById('stats-list');
    const hint = document.getElementById('stats-hint');
    if (!list || !window.Stats) return;
    list.textContent = '';
    list.scrollTop = 0;
    list.classList.toggle('stats-list-history', currentTab === 'history');
    if (currentTab === 'history') {
      _renderHistory(list);
      if (hint) hint.textContent = `この端末で遊んだ直近 ${window.Stats.HISTORY_MAX} 件です。* は準備画面の設定を変えた試合。`;
    } else {
      _renderSingle(list);
      if (hint) hint.textContent = '1 手も置かずにやり直した試合は数えません。準備画面の設定を変えた試合（CUSTOM）は回数と時間だけ数えます。';
    }
  }

  function setStatsTab(tab) {
    if (tab === currentTab) return;
    currentTab = tab;
    renderStatsPage();
    // 一覧の項目数が変わるので、キー操作の項目を取り直す
    if (window.FocusNav && typeof window.FocusNav.refresh === 'function') window.FocusNav.refresh();
  }

  window.renderStatsPage = renderStatsPage;
  window.setStatsTab = setStatsTab;
})();
