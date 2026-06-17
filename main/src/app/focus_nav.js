// focus_nav.js — UIボタンのキーボード操作（矢印/Enter/Esc/R）と擬似フォーカス表示
// 既存 hoverスタイルを .is-focused でも適用するように style.css 側を拡張済み

(function(){
  const FOCUS_CLASS = 'is-focused';
  const registry = {};
  let active = null;

  function isVisible(el){
    if (!el || el.disabled) return false;
    if (el.offsetParent === null) {
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed') return false;
    }
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return true;
  }

  function currentButtons(){
    if (!active) return [];
    let list = [];
    try {
      list = active.getButtons() || [];
    } catch (e) { list = []; }
    return list.filter(isVisible);
  }

  function clearFocus(){
    document.querySelectorAll('.' + FOCUS_CLASS).forEach(el => el.classList.remove(FOCUS_CLASS));
  }

  function applyFocus(idx){
    const btns = currentButtons();
    clearFocus();
    if (!btns.length) { if (active) active.index = 0; return; }
    if (idx < 0) idx = btns.length - 1;
    if (idx >= btns.length) idx = 0;
    btns[idx].classList.add(FOCUS_CLASS);
    active.index = idx;
  }

  function currentIndex(btns){
    for (let i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains(FOCUS_CLASS)) return i;
    }
    return (active.index >= 0 && active.index < btns.length) ? active.index : 0;
  }

  function move(delta){
    const btns = currentButtons();
    if (!btns.length) return;
    applyFocus(currentIndex(btns) + delta);
  }

  function move2D(dir){
    const btns = currentButtons();
    if (!btns.length) return;
    if (typeof active.onMove2D === 'function') {
      const next = active.onMove2D(dir, currentIndex(btns), btns);
      if (typeof next === 'number' && next >= 0 && next < btns.length) {
        applyFocus(next);
        return;
      }
    }
    // フォールバック: 1次元
    const delta = (dir === 'down' || dir === 'right') ? +1 : -1;
    move(delta);
  }

  function activateButton(btn){
    if (!btn) return;
    if (typeof active?.onActivate === 'function') active.onActivate(btn);
    else btn.click();
  }

  function findByText(re){
    return currentButtons().find(b => re.test((b.textContent || '').trim()));
  }

  function isTypingTarget(el){
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function rootIsActive(){
    if (!active || !active.root) return false;
    return active.root.classList.contains('active');
  }

  function onKey(e){
    if (!active) return;
    if (!rootIsActive()) { deactivate(); return; }
    if (isTypingTarget(document.activeElement)) return;
    // 設定画面でキーバインド入力受付中はFocusNavを停止
    if (document.querySelector('.key-badge.listening')) return;

    const code = e.code;
    const key = e.key;

    // R = リトライ（リザルト系のみ onRestart を持つ）
    if (typeof active.onRestart === 'function') {
      const keys = (typeof loadKeys === 'function') ? loadKeys() : null;
      const restartCode = (keys && keys.restart && keys.restart.code) ? keys.restart.code : 'KeyR';
      if (code === restartCode) {
        if (e.repeat) return;
        e.preventDefault();
        active.onRestart();
        return;
      }
    }

    if (key === 'ArrowUp'    || code === 'KeyW') { e.preventDefault(); move2D('up');    return; }
    if (key === 'ArrowDown'  || code === 'KeyS') { e.preventDefault(); move2D('down');  return; }
    if (key === 'ArrowLeft'  || code === 'KeyA') { e.preventDefault(); move2D('left');  return; }
    if (key === 'ArrowRight' || code === 'KeyD') { e.preventDefault(); move2D('right'); return; }
    if (key === 'Enter' || code === 'Space') {
      const btns = currentButtons();
      const idx = (active.index >= 0 && active.index < btns.length) ? active.index : 0;
      if (btns[idx]) {
        e.preventDefault();
        activateButton(btns[idx]);
      }
      return;
    }
    if (key === 'Escape') {
      const back = findByText(/^(◀|⌂)?\s*(BACK|MAIN\s*MENU|MODE\s*SELECT|LEVEL\s*SELECT|DONE|RESUME)/i);
      if (back) { e.preventDefault(); activateButton(back); }
      return;
    }
  }

  function deactivate(){
    clearFocus();
    active = null;
  }

  function activate(pageId){
    const cfg = registry[pageId];
    deactivate();
    if (!cfg) return;
    const root = cfg.root || document.getElementById(pageId + '-page') || document.getElementById(pageId);
    if (!root) return;
    active = Object.assign({ pageId, root, index: 0 }, cfg);

    // 動的描画（renderQuizCheck等）が終わってからフォーカスを当てる
    requestAnimationFrame(() => {
      if (!active || active.pageId !== pageId) return;
      const btns = currentButtons();
      if (!btns.length) return;
      let init = 0;
      if (typeof cfg.initialIndex === 'function') init = cfg.initialIndex(btns) || 0;
      else if (typeof cfg.initialIndex === 'number') init = cfg.initialIndex;
      if (init < 0 || init >= btns.length) init = 0;
      applyFocus(init);
    });
  }

  function register(pageId, cfg){
    registry[pageId] = cfg;
  }

  // マウスでhoverした際にFocusNav側のindexも追従させる（キー操作再開時の起点を合わせる）
  document.addEventListener('mouseover', (e) => {
    if (!active) return;
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const btns = currentButtons();
    const idx = btns.indexOf(btn);
    if (idx >= 0) active.index = idx;
  });

  document.addEventListener('keydown', onKey);

  window.FocusNav = {
    register,
    activate,
    deactivate,
    refresh: () => { if (active) applyFocus(active.index || 0); },
  };

  // ─────────────────────────────────────────────
  // ページ登録
  // ─────────────────────────────────────────────

  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // メインメニュー: 視覚配置(getBoundingClientRect)から行を再構築して2D移動
  function _buildVisualGrid(btns){
    const items = btns.map((b, i) => {
      const r = b.getBoundingClientRect();
      return { i, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }).filter(it => it.cx || it.cy); // 不可視は除外

    const sorted = [...items].sort((a, b) => a.cy - b.cy);
    const rows = [];
    const tol = 24; // 同じ行とみなすy差の閾値
    for (const it of sorted) {
      const row = rows.find(r => Math.abs(r.cy - it.cy) <= tol);
      if (row) {
        row.items.push(it);
        row.cy = row.items.reduce((s, x) => s + x.cy, 0) / row.items.length;
      } else {
        rows.push({ cy: it.cy, items: [it] });
      }
    }
    rows.forEach(r => r.items.sort((a, b) => a.cx - b.cx));
    return rows;
  }
  function _locate(idx, rows){
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].items.findIndex(it => it.i === idx);
      if (c >= 0) return { row: r, col: c };
    }
    return null;
  }
  function _nearestInRow(targetX, row){
    let best = row.items[0];
    let bestD = Math.abs(best.cx - targetX);
    for (let k = 1; k < row.items.length; k++) {
      const d = Math.abs(row.items[k].cx - targetX);
      if (d < bestD) { best = row.items[k]; bestD = d; }
    }
    return best.i;
  }
  register('main-menu', {
    getButtons: () => [
      ...$$('#main-menu-modes-grid button'),
      ...$$('#main-menu-footer button'),
    ],
    onMove2D: (dir, cur, btns) => {
      const rows = _buildVisualGrid(btns);
      if (!rows.length) return null;
      const pos = _locate(cur, rows);
      if (!pos) return null;
      const wrap = (v, n) => ((v % n) + n) % n;

      if (dir === 'left' || dir === 'right') {
        const row = rows[pos.row];
        const delta = dir === 'right' ? +1 : -1;
        return row.items[wrap(pos.col + delta, row.items.length)].i;
      }
      if (dir === 'up' || dir === 'down') {
        const delta = dir === 'down' ? +1 : -1;
        const curX = rows[pos.row].items[pos.col].cx;
        // x方向に十分近いボタンを持つ行を、進行方向に向かって探す（同じ列を保ちたい）
        const X_TOL = 120; // この距離以内に候補があれば「同じ列」とみなす
        for (let step = 1; step <= rows.length; step++) {
          const row = rows[wrap(pos.row + delta * step, rows.length)];
          let best = row.items[0], bestD = Math.abs(best.cx - curX);
          for (let k = 1; k < row.items.length; k++) {
            const d = Math.abs(row.items[k].cx - curX);
            if (d < bestD) { best = row.items[k]; bestD = d; }
          }
          if (bestD <= X_TOL || step === rows.length) return best.i;
        }
        // フォールバック: 隣接行のx最近
        return _nearestInRow(curX, rows[wrap(pos.row + delta, rows.length)]);
      }
      return null;
    },
  });

  // 準備画面（シングル）
  register('mode-check', {
    getButtons: () => [
      ...$$('#mode-check-options button'),
      ...$$('#mode-check-buttons button'),
    ],
    initialIndex: (btns) => btns.findIndex(b => b.id === 'mode-check-start-btn'),
  });

  // VERSUS 準備画面
  register('versus-check', {
    getButtons: () => [
      ...$$('#versus-player-rule-toggle button'),
      ...$$('#versus-cpu-rule-toggle button'),
      ...$$('#cpu-level-toggle button'),
      ...$$('#versus-check-buttons button'),
    ],
    initialIndex: (btns) => btns.findIndex(b => b.id === 'versus-check-start-btn'),
  });

  // QUIZ 準備画面
  register('quiz-check', {
    getButtons: () => [
      ...$$('#quiz-rule-select button'),
      ...$$('#quiz-level-list button'),
      ...$$('#quiz-check-page .menu-btn'),
    ],
    initialIndex: (btns) => {
      const i = btns.findIndex(b => b.classList.contains('quiz-level-btn'));
      return i >= 0 ? i : 0;
    },
  });

  // シングルリザルト
  register('result', {
    getButtons: () => $$('#result-page #result-buttons button'),
    initialIndex: 0,
    onRestart: () => {
      const btn = document.getElementById('result-retry-btn');
      if (btn && isVisible(btn)) btn.click();
    },
  });

  // VERSUS リザルト
  register('versus-result', {
    getButtons: () => $$('#versus-result-page #result-buttons button'),
    initialIndex: 0,
    onRestart: () => {
      const btn = $$('#versus-result-page #result-buttons button')
        .find(b => /RETRY/i.test(b.textContent || ''));
      if (btn) btn.click();
    },
  });

  // QUIZ リザルト
  register('quiz-result', {
    getButtons: () => $$('#quiz-result-page #result-buttons button'),
    initialIndex: (btns) => {
      const next = btns.findIndex(b => b.id === 'quiz-result-next-btn');
      if (next >= 0) return next;
      const retry = btns.findIndex(b => b.id === 'quiz-result-retry-btn');
      return retry >= 0 ? retry : 0;
    },
    onRestart: () => {
      const btn = document.getElementById('quiz-result-retry-btn');
      if (btn && isVisible(btn)) btn.click();
    },
  });

  // 設定画面（BACK / RESET / SAVE のみ。キーバインド入力欄はFocusNavの対象外）
  register('settings', {
    getButtons: () => [
      ...$$('.settings-header .btn-back'),
      ...$$('#settings-page .btn-reset, #settings-page .btn-save'),
    ],
  });

  // ─────────────────────────────────────────────
  // ポーズオーバーレイ（ページではなくoverlayの.activeを監視）
  // ─────────────────────────────────────────────
  function setupOverlayWatcher(overlayId, getButtons, initialSelector){
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;

    register(overlayId, {
      root: overlay,
      getButtons,
      initialIndex: (btns) => {
        if (!initialSelector) return 0;
        const idx = btns.findIndex(b => b.matches(initialSelector));
        return idx >= 0 ? idx : 0;
      },
    });

    const obs = new MutationObserver(() => {
      if (overlay.classList.contains('active')) {
        activate(overlayId);
      } else if (active && active.pageId === overlayId) {
        deactivate();
      }
    });
    obs.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }

  // DOM準備完了後にオーバーレイを設定
  function setupOverlays(){
    setupOverlayWatcher(
      'pause-overlay',
      () => $$('#pause-overlay #pause-buttons button'),
      '.btn-resume'
    );
    setupOverlayWatcher(
      'versus-pause-overlay',
      () => $$('#versus-pause-overlay #versus-pause-buttons button'),
      '.btn-resume'
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOverlays);
  } else {
    setupOverlays();
  }
})();
