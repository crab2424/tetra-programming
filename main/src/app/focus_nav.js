// focus_nav.js — UIのキーボード操作・フォーカス枠表示・入力モード切替・スクロール追従
//
// 主な機能:
//  - 入力モード追跡: body.input-mode-kbd / body.input-mode-pointer
//    キー操作開始で kbd、マウス/タッチ操作で pointer に切替
//    pointer 中は .is-focused を付与しない（=枠なし、hoverのみ）
//  - フォーカス item 抽象化: type='button' or type='row'
//    row はラベル要素にフォーカス枠 + ←/→ で値変更（onLeft/onRight）
//  - 既定の 2D 移動は視覚配置(getBoundingClientRect)から行列を作って遷移
//  - フォーカス対象が画面外なら scrollIntoView({block:'nearest'})

(function(){
  const FOCUS_CLASS = 'is-focused';
  const registry = {};
  let active = null;
  let inputMode = 'pointer'; // 初期はpointer。最初のキー入力でkbdへ
  document.body.classList.add('input-mode-pointer');

  // ─────────────────────────────────────────────
  // 入力モード切替
  // ─────────────────────────────────────────────
  function setInputMode(mode){
    if (inputMode === mode) return;
    inputMode = mode;
    document.body.classList.toggle('input-mode-kbd', mode === 'kbd');
    document.body.classList.toggle('input-mode-pointer', mode === 'pointer');
    if (mode === 'pointer') {
      clearFocus();
    } else if (active) {
      // kbd 復帰: 直前indexを再フォーカス
      applyFocus(active.index || 0);
    }
  }

  const NAV_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape','Tab',' ']);
  const NAV_CODES = new Set(['KeyW','KeyA','KeyS','KeyD','Space']);

  window.addEventListener('keydown', (e) => {
    if (NAV_KEYS.has(e.key) || NAV_CODES.has(e.code)) {
      setInputMode('kbd');
    }
  }, true);

  // mousemove は微小なノイズで誤切替しないよう閾値あり
  let _lastMouseX = null, _lastMouseY = null;
  window.addEventListener('mousemove', (e) => {
    if (_lastMouseX === null) { _lastMouseX = e.clientX; _lastMouseY = e.clientY; return; }
    const dx = e.clientX - _lastMouseX, dy = e.clientY - _lastMouseY;
    if (dx*dx + dy*dy < 9) return; // 3px未満は無視
    _lastMouseX = e.clientX; _lastMouseY = e.clientY;
    setInputMode('pointer');
  }, { passive: true });
  ['mousedown','pointerdown','touchstart','wheel'].forEach(t => {
    window.addEventListener(t, () => setInputMode('pointer'), { passive: true });
  });

  // ─────────────────────────────────────────────
  // item 取得・可視判定
  // ─────────────────────────────────────────────
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

  function normalizeItem(it){
    if (!it) return null;
    if (it instanceof Element) return { type: 'button', el: it };
    if (it.el instanceof Element) {
      return Object.assign({ type: 'button' }, it);
    }
    return null;
  }

  function currentItems(){
    if (!active) return [];
    let list = [];
    try {
      if (typeof active.getItems === 'function') list = active.getItems() || [];
      else if (typeof active.getButtons === 'function') list = active.getButtons() || [];
    } catch (e) { list = []; }
    return list.map(normalizeItem).filter(it => it && isVisible(it.el));
  }

  function clearFocus(){
    document.querySelectorAll('.' + FOCUS_CLASS).forEach(el => el.classList.remove(FOCUS_CLASS));
  }

  function scrollItemIntoView(el, instant){
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try {
      // 縦中心に寄せる。スクロール余地が無い (キャンバス端等) ならブラウザが自動で no-op になる
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: instant ? 'auto' : 'smooth' });
    } catch (e) {
      el.scrollIntoView(false);
    }
  }

  function applyFocus(idx){
    const items = currentItems();
    clearFocus();
    if (!items.length) { if (active) active.index = 0; return; }
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    active.index = idx;
    if (inputMode !== 'kbd') return; // pointer中は class を付けない（=枠無し）
    const it = items[idx];
    it.el.classList.add(FOCUS_CLASS);
    scrollItemIntoView(it.el, active._firstFocus);
    active._firstFocus = false;
  }

  function currentIndex(items){
    for (let i = 0; i < items.length; i++) {
      if (items[i].el.classList.contains(FOCUS_CLASS)) return i;
    }
    return (active.index >= 0 && active.index < items.length) ? active.index : 0;
  }

  // ─────────────────────────────────────────────
  // 視覚配置からの 2D 移動（既定）
  // ─────────────────────────────────────────────
  function _buildVisualGrid(items){
    const cells = items.map((it, i) => {
      const r = it.el.getBoundingClientRect();
      return { i, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }).filter(c => c.cx || c.cy);

    const sorted = [...cells].sort((a, b) => a.cy - b.cy);
    const rows = [];
    const tol = 24;
    for (const c of sorted) {
      const row = rows.find(r => Math.abs(r.cy - c.cy) <= tol);
      if (row) {
        row.items.push(c);
        row.cy = row.items.reduce((s, x) => s + x.cy, 0) / row.items.length;
      } else {
        rows.push({ cy: c.cy, items: [c] });
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
  function _nearestInRow(row, curX){
    let best = row.items[0], bestD = Math.abs(best.cx - curX);
    for (let k = 1; k < row.items.length; k++) {
      const d = Math.abs(row.items[k].cx - curX);
      if (d < bestD) { best = row.items[k]; bestD = d; }
    }
    return { best, bestD };
  }
  function defaultMove2D(dir, cur, items){
    const rows = _buildVisualGrid(items);
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
      const X_TOL = 120;
      const nrows = rows.length;
      // 方向順に探索（wrapしない）: 最初に X_TOL 以内に収まる行があれば即採用
      // 見つからなければ「隣接行 (step=1) の nearest」を採用
      // それも無ければ（端から動けない場合）逆端へ wrap
      let firstAdjacent = null;
      for (let step = 1; step < nrows; step++) {
        const ri = pos.row + delta * step;
        if (ri < 0 || ri >= nrows) break;
        const { best, bestD } = _nearestInRow(rows[ri], curX);
        if (step === 1) firstAdjacent = best.i;
        if (bestD <= X_TOL) return best.i;
      }
      if (firstAdjacent !== null) return firstAdjacent;
      // 端で wrap: 逆端の行の nearest
      const wrapRow = rows[delta > 0 ? 0 : nrows - 1];
      return _nearestInRow(wrapRow, curX).best.i;
    }
    return null;
  }

  function move2D(dir){
    const items = currentItems();
    if (!items.length) return;
    const cur = currentIndex(items);
    const it = items[cur];

    // row 型は ←/→ で値変更
    if ((dir === 'left' || dir === 'right') && it && it.type === 'row') {
      const handler = dir === 'left' ? it.onLeft : it.onRight;
      if (typeof handler === 'function') {
        handler(it);
        // 値変更後に表示が更新される可能性があるため、フォーカスを再適用
        applyFocus(active.index);
      }
      return;
    }

    if (typeof active.onMove2D === 'function') {
      const next = active.onMove2D(dir, cur, items);
      if (typeof next === 'number' && next >= 0 && next < items.length) {
        applyFocus(next);
        return;
      }
    }
    const next = defaultMove2D(dir, cur, items);
    if (next !== null) applyFocus(next);
  }

  function activateButton(it){
    if (!it) return;
    if (typeof it.onActivate === 'function') { it.onActivate(it); return; }
    if (typeof active?.onActivate === 'function') active.onActivate(it.el);
    else it.el.click();
  }

  function findByText(re){
    return currentItems().find(it => re.test((it.el.textContent || '').trim()));
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
    if (document.querySelector('.key-badge.listening')) return;

    const code = e.code;
    const key = e.key;

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
      const items = currentItems();
      const idx = (active.index >= 0 && active.index < items.length) ? active.index : 0;
      if (items[idx]) {
        e.preventDefault();
        activateButton(items[idx]);
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
    active = Object.assign({ pageId, root, index: 0, _firstFocus: true }, cfg);

    requestAnimationFrame(() => {
      if (!active || active.pageId !== pageId) return;
      const items = currentItems();
      if (!items.length) return;
      let init = 0;
      if (typeof cfg.initialIndex === 'function') init = cfg.initialIndex(items.map(it => it.el)) || 0;
      else if (typeof cfg.initialIndex === 'number') init = cfg.initialIndex;
      if (init < 0 || init >= items.length) init = 0;
      applyFocus(init);
    });
  }

  function register(pageId, cfg){
    registry[pageId] = cfg;
  }

  // マウスhoverでindex追従（キー操作再開時の起点を合わせる）
  document.addEventListener('mouseover', (e) => {
    if (!active) return;
    const target = e.target && e.target.closest && e.target.closest('button, .slider-row, .option-row');
    if (!target) return;
    const items = currentItems();
    const idx = items.findIndex(it => it.el === target);
    if (idx >= 0) active.index = idx;
  });

  document.addEventListener('keydown', onKey);

  window.FocusNav = {
    register,
    activate,
    deactivate,
    refresh: () => { if (active) applyFocus(active.index || 0); },
    getInputMode: () => inputMode,
  };

  // ─────────────────────────────────────────────
  // ヘルパ
  // ─────────────────────────────────────────────
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // .option-toggle 内の .active を ±1 移動して click
  function stepOptionToggle(toggleEl, delta){
    if (!toggleEl) return;
    const btns = $$('.opt-btn', toggleEl).filter(isVisible);
    if (!btns.length) return;
    let cur = btns.findIndex(b => b.classList.contains('active'));
    if (cur < 0) cur = 0;
    const next = ((cur + delta) % btns.length + btns.length) % btns.length;
    btns[next].click();
  }

  // <input type="range"> を step だけ ±1
  function stepSlider(slider, delta){
    if (!slider) return;
    const step = parseFloat(slider.step) || 1;
    const min = parseFloat(slider.min); const max = parseFloat(slider.max);
    let v = parseFloat(slider.value) + delta * step;
    if (!isNaN(min)) v = Math.max(min, v);
    if (!isNaN(max)) v = Math.min(max, v);
    // step精度を保持
    v = Math.round(v / step) * step;
    slider.value = v;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // row item ヘルパ
  function rowToggle(el, toggleEl){
    return {
      type: 'row', el,
      onLeft:  () => stepOptionToggle(toggleEl || el.querySelector('.option-toggle'), -1),
      onRight: () => stepOptionToggle(toggleEl || el.querySelector('.option-toggle'), +1),
    };
  }
  function rowSlider(el, slider){
    return {
      type: 'row', el,
      onLeft:  () => stepSlider(slider, -1),
      onRight: () => stepSlider(slider, +1),
    };
  }
  // .option-row 内の slider があれば優先、無ければ option-toggle を ±
  function rowAuto(el){
    const slider = el.querySelector('input[type="range"]');
    if (slider) return rowSlider(el, slider);
    const toggle = el.querySelector('.option-toggle');
    if (toggle) return rowToggle(el, toggle);
    return null;
  }

  // ─────────────────────────────────────────────
  // ページ登録
  // ─────────────────────────────────────────────

  register('main-menu', {
    getItems: () => [
      ...$$('#main-menu-modes-grid button'),
      ...$$('#main-menu-footer button'),
    ],
    // main-menu は既定の 2D で問題ない（同じロジック）
  });

  register('mode-check', {
    getItems: () => {
      const items = [];
      $$('#mode-check-options .option-row').forEach(row => {
        const it = rowAuto(row);
        if (it) items.push(it);
      });
      // option-row 外に裸で置かれたボタンがあれば拾う
      $$('#mode-check-options > button').forEach(b => items.push(b));
      $$('#mode-check-buttons button').forEach(b => items.push(b));
      return items;
    },
    initialIndex: (els) => els.findIndex(b => b && b.id === 'mode-check-start-btn'),
  });

  register('versus-check', {
    getItems: () => {
      const items = [];
      const playerRow = document.querySelector('#versus-rule-options .option-row:nth-child(1)');
      const cpuRow    = document.querySelector('#versus-rule-options .option-row:nth-child(2)');
      const cpuLvRow  = document.querySelector('#versus-cpu-options .option-row');
      if (playerRow) items.push(rowToggle(playerRow, document.getElementById('versus-player-rule-toggle')));
      if (cpuRow)    items.push(rowToggle(cpuRow,    document.getElementById('versus-cpu-rule-toggle')));
      if (cpuLvRow)  items.push(rowToggle(cpuLvRow,  document.getElementById('cpu-level-toggle')));
      $$('#versus-check-buttons button').forEach(b => items.push(b));
      return items;
    },
    initialIndex: (els) => els.findIndex(b => b && b.id === 'versus-check-start-btn'),
  });

  register('vs-settings', {
    getItems: () => $$('#vs-settings-buttons button'),
    initialIndex: 0,
  });

  // QUIZ 準備画面（レベルリストは 10×N の2D配置を維持＝既定2D移動が対応）
  register('quiz-check', {
    getItems: () => [
      ...$$('#quiz-rule-select button'),
      ...$$('#quiz-level-list button'),
      ...$$('#quiz-check-page .menu-btn'),
    ],
    initialIndex: (els) => {
      const i = els.findIndex(b => b.classList.contains('quiz-level-btn'));
      return i >= 0 ? i : 0;
    },
  });

  register('result', {
    getItems: () => $$('#result-page #result-buttons button'),
    initialIndex: 0,
    onRestart: () => {
      const btn = document.getElementById('result-retry-btn');
      if (btn && isVisible(btn)) btn.click();
    },
  });

  register('versus-result', {
    getItems: () => $$('#versus-result-page #result-buttons button'),
    initialIndex: 0,
    onRestart: () => {
      const btn = $$('#versus-result-page #result-buttons button')
        .find(b => /RETRY/i.test(b.textContent || ''));
      if (btn) btn.click();
    },
  });

  register('quiz-result', {
    getItems: () => $$('#quiz-result-page #result-buttons button'),
    initialIndex: (els) => {
      const next = els.findIndex(b => b.id === 'quiz-result-next-btn');
      if (next >= 0) return next;
      const retry = els.findIndex(b => b.id === 'quiz-result-retry-btn');
      return retry >= 0 ? retry : 0;
    },
    onRestart: () => {
      const btn = document.getElementById('quiz-result-retry-btn');
      if (btn && isVisible(btn)) btn.click();
    },
  });

  // 設定画面: 音量スライダー/キー設定badge群/チューニングスライダー/RESET・SAVE をまとめて item 化
  register('settings', {
    getItems: () => {
      const items = [];
      $$('.settings-header .btn-back').forEach(b => items.push(b));
      // 音量
      const bgmSlider = document.getElementById('slider-bgm-volume');
      const seSlider  = document.getElementById('slider-se-volume');
      const bgmRow = bgmSlider && bgmSlider.closest('.slider-row');
      const seRow  = seSlider  && seSlider.closest('.slider-row');
      if (bgmRow) items.push(rowSlider(bgmRow, bgmSlider));
      if (seRow)  items.push(rowSlider(seRow,  seSlider));
      // キー設定: 各 .key-row 内の .key-badge を 1個ずつ button として登録（左右で badge 間遷移）
      $$('#key-config-grid .key-row').forEach(row => {
        $$('.key-badge', row).forEach(b => items.push(b));
      });
      // チューニング
      ['slider-das', 'slider-arr', 'slider-dcd'].forEach(id => {
        const s = document.getElementById(id);
        const row = s && s.closest('.slider-row');
        if (row) items.push(rowSlider(row, s));
      });
      // RESET / SAVE
      $$('#settings-page .btn-reset, #settings-page .btn-save').forEach(b => items.push(b));
      return items;
    },
    initialIndex: 0,
  });

  // ─────────────────────────────────────────────
  // ポーズオーバーレイ
  // ─────────────────────────────────────────────
  function setupOverlayWatcher(overlayId, getButtons, initialSelector){
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;

    register(overlayId, {
      root: overlay,
      getItems: getButtons,
      initialIndex: (els) => {
        if (!initialSelector) return 0;
        const idx = els.findIndex(b => b.matches && b.matches(initialSelector));
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
