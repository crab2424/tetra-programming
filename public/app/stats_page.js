// ─────────────────────────────────────────────
// stats_page.js — STATS ページ（#stats-page）の描画
//
// 中身は config/stats.js（window.Stats）の累計と履歴。設計 source_assets/memory/mode/record/stats/ §8。
// 平均・率はここで割り算して出す（保存していない）。
// タブ: OVERVIEW（全体のまとめ）/ SINGLE（枠ごとのカード）/ VERSUS（ルールの組み合わせごとの表）/
//       ONLINE（ルールの組み合わせごと）/ QUIZ（ルールごと）/ HISTORY（直近の一覧）。
// 見出しの下に、いま見ている成績の持ち主（ゲスト / アカウント）。下に RESET。
// ─────────────────────────────────────────────

(function () {
  const TABS = [
    { id: 'overview', label: 'OVERVIEW' },
    { id: 'single', label: 'SINGLE' },
    { id: 'versus', label: 'VERSUS' },
    { id: 'online', label: 'ONLINE' },
    { id: 'quiz', label: 'QUIZ' },
    { id: 'history', label: 'HISTORY' },
  ];
  const RECENT_N = 10; // 「直近 n 回の平均」に使う件数

  let currentTab = 'overview';

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
  const RULE_LABEL = { tet: 'TET', puyo: 'PUYO', multi: 'MULTI' };
  // CPU レベルの表示名（app/modes.js の CPU_LEVELS。読めなければ番号のまま）
  function cpuLabel(level) {
    try { const c = CPU_LEVELS[level]; if (c && c.label) return String(c.label); } catch (e) { /* 番号で出す */ }
    return 'LV' + level;
  }
  // vs:<自分>:<相手>:<レベル> を分ける（VERSUS の枠でなければ null）
  function parseVs(key) {
    const m = /^vs:(tet|puyo):(tet|puyo):(.+)$/.exec(String(key));
    return m ? { my: m[1], opp: m[2], level: m[3] } : null;
  }
  // ol:<自分>:<相手>（相手は tet / puyo / multi）
  function parseOl(key) {
    const m = /^ol:(tet|puyo):(tet|puyo|multi)$/.exec(String(key));
    return m ? { my: m[1], opp: m[2] } : null;
  }
  const quizRuleOf = (key) => { const m = /^quiz:(tet|puyo)$/.exec(String(key)); return m ? m[1] : null; };
  function label(key) {
    if (quizRuleOf(key)) return 'QUIZ ' + RULE_LABEL[quizRuleOf(key)];
    const vs = parseVs(key);
    if (vs) return `VS ${cpuLabel(vs.level)} ${RULE_LABEL[vs.my]}/${RULE_LABEL[vs.opp]}`;
    const ol = parseOl(key);
    if (ol) return `ONLINE ${RULE_LABEL[ol.my]}/${RULE_LABEL[ol.opp]}`;
    return (window.Records && window.Records.labelFor) ? window.Records.labelFor(key) : String(key).toUpperCase();
  }
  // 1 分あたりの火力
  const apm = (atk, ms) => (ms > 0) ? ((atk || 0) / (ms / 60000)).toFixed(1) : '—';
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

  // ─── OVERVIEW ───────────────────────────
  // 枠 1 つの遊んだ回数（途中でやめた試合・設定を変えた試合も含む）と時間
  const playsOf = (b) => (b.n || 0) + (b.q || 0) + (b.cn || 0) + (b.cq || 0);
  const msOf = (b) => (b.ms || 0) + (b.cms || 0);

  // モード別の行。シングルは枠ごと、VERSUS / ONLINE / QUIZ はまとめて 1 行
  function _overviewRows(buckets) {
    const rows = window.Stats.SINGLE_KEYS.map((key) => ({ name: label(key), keys: [key] }));
    const group = (name, test) => rows.push({ name, keys: Object.keys(buckets).filter(test) });
    group('VERSUS', (k) => !!parseVs(k));
    group('ONLINE', (k) => !!parseOl(k));
    group('QUIZ', (k) => !!quizRuleOf(k));
    return rows.map((r) => {
      let plays = 0, ms = 0;
      r.keys.forEach((k) => { const b = buckets[k]; if (b) { plays += playsOf(b); ms += msOf(b); } });
      return { name: r.name, plays, ms };
    });
  }

  // 勝ち・負けの合計（VERSUS / ONLINE の枠ごとの w / l を足す）
  function _winLoss(buckets, test) {
    let w = 0, l = 0;
    Object.keys(buckets).forEach((k) => { if (test(k)) { w += buckets[k].w || 0; l += buckets[k].l || 0; } });
    return { w, l };
  }

  function _renderOverview(list) {
    const buckets = window.Stats.getBuckets();
    const rows = _overviewRows(buckets);
    const totalPlays = rows.reduce((a, r) => a + r.plays, 0);
    const totalMs = rows.reduce((a, r) => a + r.ms, 0);

    const card = el('div', 'stats-card stats-row-enter');
    const grid = el('div', 'stats-grid');
    grid.appendChild(_cell('TOTAL TIME', fmtTotal(totalMs)));
    grid.appendChild(_cell('TOTAL PLAYS', num(totalPlays)));
    const vs = _winLoss(buckets, (k) => !!parseVs(k));
    grid.appendChild(_cell('VERSUS WIN', pct(vs.w, vs.w + vs.l), vs.w + vs.l > 0 ? `${num(vs.w)} W / ${num(vs.l)} L` : ''));
    const ol = _winLoss(buckets, (k) => !!parseOl(k));
    grid.appendChild(_cell('ONLINE WIN', pct(ol.w, ol.w + ol.l), ol.w + ol.l > 0 ? `${num(ol.w)} W / ${num(ol.l)} L` : ''));
    // クイズの解いた数（今ある問題のうち。問題の一覧を読み込んでいなければ解いた数だけ）
    const cleared = window.Stats.getQuizCleared();
    const levels = ['tet', 'puyo'].flatMap((rule) => { try { return QUIZ_LEVELS[rule] || []; } catch (e) { return []; } });
    if (levels.length > 0) {
      const solved = levels.filter((lv) => cleared[lv.id]).length;
      grid.appendChild(_cell('QUIZ SOLVED', `${num(solved)} / ${num(levels.length)}`, pct(solved, levels.length)));
    } else {
      grid.appendChild(_cell('QUIZ SOLVED', num(Object.keys(cleared).length)));
      if (typeof loadQuizLevels === 'function') {
        loadQuizLevels().then(() => { if (currentTab === 'overview' && _quizTotal('tet') + _quizTotal('puyo') > 0) renderStatsPage(); });
      }
    }
    card.appendChild(grid);
    list.appendChild(card);

    // モード別の回数（横棒）
    const top = Math.max(1, ...rows.map((r) => r.plays));
    const box = el('div', 'stats-card stats-row-enter');
    box.style.animationDelay = '0.05s';
    const head = el('div', 'stats-card-head');
    head.appendChild(el('span', 'stats-card-title', 'PLAYS BY MODE'));
    box.appendChild(head);
    rows.forEach((r) => {
      const row = el('div', 'stats-ov-row' + (r.plays === 0 ? ' stats-ov-empty' : ''));
      row.appendChild(el('span', 'stats-ov-name', r.name));
      const track = el('div', 'stats-ov-track');
      const bar = el('div', 'stats-ov-bar');
      bar.style.width = (r.plays / top * 100) + '%';
      track.appendChild(bar);
      row.appendChild(track);
      row.appendChild(el('span', 'stats-ov-num', num(r.plays)));
      row.appendChild(el('span', 'stats-ov-time', fmtTotal(r.ms)));
      box.appendChild(row);
    });
    list.appendChild(box);
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

  // ぷよの枠の中身（PLAYS / BEST / 平均までは共通で、その先がテトと違う）
  function _puyoCells(grid, card, b) {
    const ch = Array.isArray(b.ch) ? b.ch : [];
    const chains = ch.reduce((a, v) => a + (v || 0), 0);
    grid.appendChild(_cell('MAX CHAIN', num(b.chMax || 0)));
    grid.appendChild(_cell('CHAINS', num(chains)));
    grid.appendChild(_cell('ALL CLEAR', num(b.ac || 0)));
    grid.appendChild(_cell('PAIRS', num(b.pc || 0), b.ms > 0 && b.pc > 0 ? `${(b.pc / (b.ms / 60000)).toFixed(1)} / MIN` : ''));
    grid.appendChild(_cell('PUYOS', num(b.er || 0)));
    card.appendChild(grid);
    if (chains === 0) return;

    // 連鎖の長さごとの回数（1 〜 出たことのある最大まで）
    let last = 0;
    ch.forEach((v, i) => { if (v > 0) last = i; });
    const top = Math.max(...ch.slice(0, last + 1));
    const box = el('div', 'stats-chain');
    box.appendChild(el('span', 'stats-cell-label', 'CHAIN COUNT'));
    const bars = el('div', 'stats-chain-bars');
    for (let i = 0; i <= last; i++) {
      const col = el('div', 'stats-chain-col');
      col.appendChild(el('span', 'stats-chain-num', ch[i] > 0 ? num(ch[i]) : ''));
      const bar = el('div', 'stats-chain-bar');
      bar.style.height = Math.round((ch[i] || 0) / top * 36) + 'px';
      col.appendChild(bar);
      col.appendChild(el('span', 'stats-chain-len', i === 19 ? '20+' : String(i + 1)));
      bars.appendChild(col);
    }
    box.appendChild(bars);
    card.appendChild(box);
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

    if (key === 'puyo') { _puyoCells(grid, card, b); return card; }

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
      // 火力は「対戦なら出ていた量」。ZONE APM は発動していた時間だけで割ったもの
      grid.appendChild(_cell('APM', apm(b.atk, b.ms)));
      grid.appendChild(_cell('ZONE APM', b.znMs > 0 ? apm(b.znAtk, b.znMs) : '—', b.znMs > 0 ? `ZONE TIME ${fmtTotal(b.znMs)}` : ''));
    }
    card.appendChild(grid);
    return card;
  }

  function _renderSingle(list) {
    const buckets = window.Stats.getBuckets();
    const history = window.Stats.getHistory();
    window.Stats.SINGLE_KEYS.forEach((key, i) => list.appendChild(_singleCard(key, buckets[key] || {}, history, i)));
  }

  // ─── VERSUS ─────────────────────────────
  // ルールの組み合わせ（自分 / 相手）ごとに 1 枚。中は CPU レベルごとの行。
  const VS_COMBOS = [['tet', 'tet'], ['tet', 'puyo'], ['puyo', 'puyo'], ['puyo', 'tet']];

  function _vsCard(my, opp, rows, index) {
    const card = el('div', 'stats-card stats-row-enter');
    card.style.animationDelay = (index * 0.05) + 's';
    const sum = (f) => rows.reduce((a, r) => a + (r.b[f] || 0), 0);
    const w = sum('w'), l = sum('l');

    const head = el('div', 'stats-card-head');
    head.appendChild(el('span', 'stats-card-title', `${RULE_LABEL[my]} vs ${RULE_LABEL[opp]}`));
    head.appendChild(el('span', 'stats-card-time', `${num(w)} W / ${num(l)} L · ${pct(w, w + l)} · TIME ${fmtTotal(sum('ms'))}`));
    card.appendChild(head);

    // 火力補正の付いた試合が 1 つでもあれば RAW APM（補正を外した火力）の列を出す
    const showRaw = sum('bias') > 0;
    // ZONE を使った試合が 1 つでもあれば ZONE APM（発動していた時間だけで割った火力）の列を出す
    const showZone = sum('znMs') > 0;
    const table = el('div', 'stats-vs-table');
    const cols = ['CPU', 'W', 'L', 'WIN', 'APM'].concat(showRaw ? ['RAW APM'] : [], showZone ? ['ZONE APM'] : [], ['AVG TIME', 'STREAK']);
    const widths = ['1.6fr', '0.6fr', '0.6fr', '0.8fr', '0.9fr'].concat(showRaw ? ['1fr'] : [], showZone ? ['1.1fr'] : [], ['1.1fr', '0.8fr']).join(' ');
    const headRow = el('div', 'stats-vs-row stats-vs-head');
    headRow.style.gridTemplateColumns = widths;
    cols.forEach((c) => headRow.appendChild(el('span', '', c)));
    table.appendChild(headRow);

    rows.forEach(({ level, b }) => {
      const n = (b.w || 0) + (b.l || 0);
      const row = el('div', 'stats-vs-row');
      row.style.gridTemplateColumns = widths;
      const name = el('span', 'stats-vs-level', cpuLabel(level));
      const notes = [];
      if (b.q > 0) notes.push(`QUIT ${num(b.q)}`);
      if (b.bias > 0) notes.push(`BIAS ${num(b.bias)}`);
      if (notes.length) name.appendChild(el('span', 'stats-cell-sub', notes.join(' / ')));
      row.appendChild(name);
      row.appendChild(el('span', 'stats-result-w', num(b.w || 0)));
      row.appendChild(el('span', 'stats-result-l', num(b.l || 0)));
      row.appendChild(el('span', '', pct(b.w, n)));
      row.appendChild(el('span', '', apm(b.atk, b.ms)));
      if (showRaw) row.appendChild(el('span', '', apm(b.atkRaw, b.ms)));
      if (showZone) {
        const z = el('span', '', b.znMs > 0 ? apm(b.znAtk, b.znMs) : '—');
        // 補正ありの試合がある行は、補正を外した ZONE APM も添える
        if (b.znMs > 0 && b.bias > 0) z.appendChild(el('span', 'stats-cell-sub', 'RAW ' + apm(b.znAtkRaw, b.znMs)));
        row.appendChild(z);
      }
      row.appendChild(el('span', '', n > 0 ? fmtTime((b.ms || 0) / (n + (b.q || 0))) : '—'));
      row.appendChild(el('span', '', num(b.wsMax || 0)));
      table.appendChild(row);
    });
    card.appendChild(table);
    return card;
  }

  function _renderVersus(list) {
    const buckets = window.Stats.getBuckets();
    const groups = {};
    Object.keys(buckets).forEach((key) => {
      const vs = parseVs(key);
      if (!vs) return;
      (groups[vs.my + ':' + vs.opp] ||= []).push({ level: vs.level, b: buckets[key] });
    });
    let shown = 0;
    VS_COMBOS.forEach(([my, opp]) => {
      const rows = groups[my + ':' + opp];
      if (!rows) return;
      rows.sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0));
      list.appendChild(_vsCard(my, opp, rows, shown++));
    });
    if (shown === 0) list.appendChild(el('p', 'ranking-status', 'NO MATCHES'));
  }

  // ─── ONLINE ─────────────────────────────
  // ルールの組み合わせ（自分 / 相手）ごとに 1 枚。勝敗はラウンド単位、SETS は 2 本先取以上の部屋のセット
  const OL_COMBOS = [['tet', 'tet'], ['tet', 'puyo'], ['tet', 'multi'], ['puyo', 'puyo'], ['puyo', 'tet'], ['puyo', 'multi']];

  function _olCard(my, opp, b, index) {
    const card = el('div', 'stats-card stats-row-enter');
    card.style.animationDelay = (index * 0.05) + 's';
    const w = b.w || 0, l = b.l || 0, d = b.d || 0;
    const n = w + l + d;

    const head = el('div', 'stats-card-head');
    head.appendChild(el('span', 'stats-card-title', `${RULE_LABEL[my]} vs ${RULE_LABEL[opp]}`));
    head.appendChild(el('span', 'stats-card-time', `${num(w)} W / ${num(l)} L · ${pct(w, w + l)} · TIME ${fmtTotal(b.ms || 0)}`));
    card.appendChild(head);

    const grid = el('div', 'stats-grid');
    const roundSub = [];
    if (d > 0) roundSub.push(`DRAW ${num(d)}`);
    if (b.q > 0) roundSub.push(`QUIT ${num(b.q)}`);
    grid.appendChild(_cell('ROUNDS', `${num(w)} - ${num(l)}`, roundSub.join(' / ')));
    grid.appendChild(_cell('WIN', pct(w, w + l), b.dcW > 0 ? `DISCONNECT ${num(b.dcW)}` : ''));
    const sets = (b.sw || 0) + (b.sl || 0);
    grid.appendChild(_cell('SETS', sets > 0 ? `${num(b.sw || 0)} - ${num(b.sl || 0)}` : '—', sets > 0 ? pct(b.sw, sets) : ''));
    grid.appendChild(_cell('STREAK', num(b.wsMax || 0)));
    grid.appendChild(_cell('APM', apm(b.atk, b.ms)));
    grid.appendChild(_cell('AVG TIME', n > 0 ? fmtTime((b.ms || 0) / (n + (b.q || 0))) : '—'));
    grid.appendChild(_cell('RECEIVED', num(b.rcv || 0), b.ms > 0 ? `${apm(b.rcv, b.ms)} / MIN` : ''));
    if (my === 'puyo') {
      grid.appendChild(_cell('MAX CHAIN', num(b.chMax || 0)));
      grid.appendChild(_cell('ALL CLEAR', num(b.ac || 0)));
      grid.appendChild(_cell('PAIRS', num(b.pc || 0), b.ms > 0 && b.pc > 0 ? `${(b.pc / (b.ms / 60000)).toFixed(1)} / MIN` : ''));
    } else {
      grid.appendChild(_cell('PPS', pps(b.pc, b.ms)));
      grid.appendChild(_cell('4 LINES', num(b.t4 || 0)));
      grid.appendChild(_cell('T-SPIN', num((b.ts1 || 0) + (b.ts2 || 0) + (b.ts3 || 0)),
        `S ${num(b.ts1 || 0)} / D ${num(b.ts2 || 0)} / T ${num(b.ts3 || 0)} / MINI ${num(b.tsm || 0)}`));
      grid.appendChild(_cell('PERFECT CLEAR', num(b.pcl || 0)));
      grid.appendChild(_cell('MAX REN', num(b.renMax || 0)));
    }
    card.appendChild(grid);
    return card;
  }

  function _renderOnline(list) {
    const buckets = window.Stats.getBuckets();
    let shown = 0;
    OL_COMBOS.forEach(([my, opp]) => {
      const b = buckets[`ol:${my}:${opp}`];
      if (!b) return;
      list.appendChild(_olCard(my, opp, b, shown++));
    });
    if (shown === 0) list.appendChild(el('p', 'ranking-status', 'NO MATCHES'));
  }

  // ─── QUIZ ───────────────────────────────
  // 問題の総数は quiz/quiz.js の QUIZ_LEVELS（まだ読み込んでいなければ読み込んでから描き直す）
  function _quizTotal(rule) {
    try { return (QUIZ_LEVELS[rule] || []).length; } catch (e) { return 0; }
  }

  function _renderQuiz(list) {
    const buckets = window.Stats.getBuckets();
    const cleared = window.Stats.getQuizCleared();
    let loaded = false;
    ['tet', 'puyo'].forEach((rule, i) => {
      const b = buckets['quiz:' + rule] || {};
      const levels = (() => { try { return QUIZ_LEVELS[rule] || []; } catch (e) { return []; } })();
      if (levels.length > 0) loaded = true;
      // 今ある問題のうち解いたもの（消えた問題の id は数えない）
      const solved = levels.filter((l) => cleared[l.id]).length;
      const card = el('div', 'stats-card stats-row-enter');
      card.style.animationDelay = (i * 0.05) + 's';
      const head = el('div', 'stats-card-head');
      head.appendChild(el('span', 'stats-card-title', 'QUIZ ' + RULE_LABEL[rule]));
      head.appendChild(el('span', 'stats-card-time', 'TIME ' + fmtTotal(b.ms || 0)));
      card.appendChild(head);
      const grid = el('div', 'stats-grid');
      const n = b.n || 0;
      grid.appendChild(_cell('SOLVED', levels.length > 0 ? `${num(solved)} / ${num(levels.length)}` : '—',
        levels.length > 0 ? pct(solved, levels.length) : ''));
      grid.appendChild(_cell('ATTEMPTS', num(n), b.q > 0 ? `QUIT ${num(b.q)}` : ''));
      grid.appendChild(_cell('CORRECT', num(b.ok || 0)));
      grid.appendChild(_cell('RATE', pct(b.ok, n)));
      card.appendChild(grid);
      list.appendChild(card);
    });
    if (!loaded && typeof loadQuizLevels === 'function') {
      loadQuizLevels().then(() => { if (currentTab === 'quiz' && _quizTotal('tet') + _quizTotal('puyo') > 0) renderStatsPage(); });
    }
  }

  // ─── HISTORY ────────────────────────────
  // QUIZ の ng は「FAILED」（_historyRow で差し替える）
  const RESULT_LABEL = { ok: 'CLEAR', ng: 'GAME OVER', q: 'QUIT', w: 'WIN', l: 'LOSE', d: 'DRAW' };

  function _historyRow(h, index) {
    const row = el('div', 'stats-history-row' + (index < 12 ? ' stats-row-enter' : ''));
    if (index < 12) row.style.animationDelay = (index * 0.03) + 's';
    row.appendChild(el('span', 'stats-history-date', fmtDate(h.at)));
    row.appendChild(el('span', 'stats-history-mode', label(h.k) + (h.c ? ' *' : '')));
    row.appendChild(el('span', 'stats-history-result stats-result-' + h.r,
      (quizRuleOf(h.k) && h.r === 'ng') ? 'FAILED' : (RESULT_LABEL[h.r] || '')));
    if (quizRuleOf(h.k)) {
      row.appendChild(el('span', 'stats-history-value', h.no ? '#' + h.no : ''));
      row.appendChild(el('span', 'stats-history-sub', fmtTotal(h.ms)));
      return row;
    }
    if (parseVs(h.k)) {
      // 対戦: 主指標は APM。火力補正が付いていた試合は補正の値と、補正を外した APM を添える
      const bias = (h.vs && h.vs.bias) || [0, 0];
      const biased = !!(bias[0] || bias[1]);
      const sign = (v) => (v > 0 ? '+' + v : String(v));
      row.appendChild(el('span', 'stats-history-value', apm(h.atk, h.ms) + ' APM'));
      row.appendChild(el('span', 'stats-history-sub', biased
        ? `${fmtTotal(h.ms)} · BIAS ${sign(bias[0])}/${sign(bias[1])} · RAW ${apm(h.atkRaw, h.ms)}`
        : (h.zms > 0 ? `${fmtTotal(h.ms)} · ZONE ${apm(h.zatk, h.zms)} APM` : fmtTotal(h.ms))));
      return row;
    }
    if (parseOl(h.k)) {
      // オンライン: 主指標は APM。2 本先取以上の部屋は何ラウンド目か・セットの決着を添える
      const sub = [fmtTotal(h.ms)];
      const ol = h.ol || {};
      if (ol.target > 1) sub.push(`R${num(ol.round || 0)} · FT${num(ol.target)}`);
      if (ol.set) sub.push(ol.set === 'w' ? 'SET WIN' : 'SET LOSE');
      if (ol.dc) sub.push('DISCONNECT');
      row.appendChild(el('span', 'stats-history-value', apm(h.atk, h.ms) + ' APM'));
      row.appendChild(el('span', 'stats-history-sub', sub.join(' · ')));
      return row;
    }
    // 主指標: タイムの枠は完走したときだけタイム、それ以外はスコア
    const main = isTimeKey(h.k) ? (h.r === 'ok' ? fmtTime(h.ms) : '—') : num(h.sc);
    row.appendChild(el('span', 'stats-history-value', main));
    row.appendChild(el('span', 'stats-history-sub', h.k === 'puyo'
      ? `${fmtTotal(h.ms)} · MAX ${num(h.cm || 0)} CHAIN`
      : `${fmtTotal(h.ms)} · ${pps(h.pc, h.ms)} PPS`));
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

  // ─── 持ち主の表示・RESET ─────────────────
  function _renderOwner() {
    const box = document.getElementById('stats-owner');
    if (!box) return;
    const me = window.Account && window.Account.me;
    box.textContent = '';
    if (me) {
      box.appendChild(el('span', 'stats-owner-tag', 'ACCOUNT'));
      box.appendChild(el('span', 'stats-owner-text', me.name || ''));
    } else {
      box.appendChild(el('span', 'stats-owner-tag', 'GUEST'));
      box.appendChild(el('span', 'stats-owner-text', 'この端末だけの成績'));
    }
  }

  async function resetStats() {
    if (!window.Stats || !window.TetDialog) return;
    const me = window.Account && window.Account.me;
    const ok = await window.TetDialog.choose({
      title: 'RESET STATS',
      message: me
        ? `アカウント（${me.name || ''}）の成績と、この端末のプレイ履歴をすべて消します。元に戻せません。自己ベストとリプレイは消えません。`
        : 'この端末の成績とプレイ履歴をすべて消します。元に戻せません。自己ベストとリプレイは消えません。',
      buttons: [
        { label: 'CANCEL', value: false, kind: 'secondary', cancel: true },
        { label: 'RESET', value: true, kind: 'danger' },
      ],
      initial: false,
    });
    if (!ok) return;
    window.Stats.reset();
    renderStatsPage();
    if (window.FocusNav && typeof window.FocusNav.refresh === 'function') window.FocusNav.refresh();
    window.showGlobalToast?.('成績を消しました');
  }

  // ─── 入口 ───────────────────────────────
  function renderStatsPage() {
    _renderTabs();
    _renderOwner();
    const list = document.getElementById('stats-list');
    const hint = document.getElementById('stats-hint');
    if (!list || !window.Stats) return;
    list.textContent = '';
    list.scrollTop = 0;
    list.classList.toggle('stats-list-history', currentTab === 'history');
    if (currentTab === 'history') {
      _renderHistory(list);
      if (hint) hint.textContent = `この端末で遊んだ直近 ${window.Stats.HISTORY_MAX} 件です。* は準備画面の設定を変えた試合。`;
    } else if (currentTab === 'quiz') {
      _renderQuiz(list);
      if (hint) hint.textContent = '1 手も置かずにやめた挑戦は数えません。解いた問題には、問題の一覧で印が付きます。';
    } else if (currentTab === 'overview') {
      _renderOverview(list);
      if (hint) hint.textContent = '回数には途中でやめた試合と、準備画面の設定を変えた試合も入ります。勝率は引き分けを除いて出します。';
    } else if (currentTab === 'online') {
      _renderOnline(list);
      if (hint) hint.textContent = 'オンライン対戦の成績です。勝敗はラウンドごと、SETS は 2 本先取以上の部屋のセットの勝敗。自分の通信が切れたラウンドは数えません。';
    } else if (currentTab === 'versus') {
      _renderVersus(list);
      if (hint) hint.textContent = '対 CPU 戦の成績です。設定を変えた試合も数えます。火力補正（BIAS）を付けた試合があると補正を外した火力（RAW APM）、ZONE を使った試合があると発動中だけの火力（ZONE APM）も出ます。';
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
  window.resetStats = resetStats;
})();
