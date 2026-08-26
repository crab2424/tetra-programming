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
  const rememberedIndex = {};
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
    // <input>/<textarea>/contenteditable にフォーカスがある間は
    // ボタン遷移用のkbdモード切替も抑止（WASD等の文字入力と衝突するため）
    if (isTypingTarget(document.activeElement)) return;
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

  function scrollGroupIntoView(anchor){
    if (!anchor || typeof anchor.scrollIntoView !== 'function') return;
    try {
      anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch (e) {
      anchor.scrollIntoView(false);
    }
  }

  function getScrollAnchor(it){
    if (it.scrollAnchor) return it.scrollAnchor;
    return it.el;
  }

  function applyFocus(idx, opts){
    opts = opts || {};
    const items = currentItems();
    clearFocus();
    if (!items.length) { if (active) active.index = 0; return; }
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    const prevIdx = active.index;
    active.index = idx;
    if (active.rememberIndex) rememberedIndex[active.pageId] = idx;
    if (inputMode !== 'kbd') return;
    const it = items[idx];
    it.el.classList.add(FOCUS_CLASS);
    if (!opts.skipScroll) {
      const prevAnchor = (prevIdx >= 0 && prevIdx < items.length) ? getScrollAnchor(items[prevIdx]) : null;
      const newAnchor = getScrollAnchor(it);
      if (newAnchor !== prevAnchor || active._firstFocus) {
        scrollGroupIntoView(newAnchor);
      }
    }
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
      // 隣接行の nearest を常に採用（行をスキップしない）
      // 隣接行が無ければ逆端へ wrap
      const adjRi = pos.row + delta;
      if (adjRi >= 0 && adjRi < nrows) {
        return _nearestInRow(rows[adjRi], curX).best.i;
      }
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
        // 左右で値を変えるだけの操作ではページを縦スクロールさせない
        // active.index は mouseover で汚染されうるので .is-focused 由来の cur を使う
        applyFocus(cur, { skipScroll: true });
      }
      return;
    }

    // scrollPane 指定ページ（CREDITS/CHANGELOG等）は上下キーを内部スクロールに割り当てる。
    // ブラウザのネイティブスクロールとは onKey() 側の e.preventDefault() で二重発火しない。
    if ((dir === 'up' || dir === 'down') && typeof active.scrollPane === 'function') {
      const pane = active.scrollPane();
      if (pane) {
        const step = Math.max(60, Math.round(pane.clientHeight * 0.25));
        pane.scrollTop += (dir === 'down' ? step : -step);
        return;
      }
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
    if (typeof active.isActive === 'function') return !!active.isActive();
    const cls = active.rootActiveClass || 'active';
    return active.root.classList.contains(cls);
  }

  // typing対象（input/select/textarea）にフォーカスが移っている間、onKeyは早期returnして
  // ネイティブ操作（文字入力・range矢印キー・select開閉）に譲る。Escapeだけはここで拾い、
  // 対象を blur してナビゲーション（フォーカス枠）を再開する。
  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key !== 'Escape') return;
    const el = document.activeElement;
    if (!isTypingTarget(el)) return;
    const items = currentItems();
    if (!items.some(it => it.el === el)) return;
    e.preventDefault();
    // blur直後にbubbleフェーズのonKey（同じEscape押下）まで走ると、既にblur済みで
    // isTypingTarget判定を通過してしまい、同じ一回の押下でescapeAction（キャンセル等の
    // クリック）まで発火してしまう。ここで伝播を止めて「今回はblurだけ」を保証する。
    e.stopPropagation();
    el.blur();
    applyFocus(active.index, { skipScroll: true });
  }, true);

  function onKey(e){
    if (!active) return;
    if (!rootIsActive()) { deactivate(); return; }
    if (isTypingTarget(document.activeElement)) return;
    if (document.querySelector('.key-badge.listening')) return;

    const code = e.code;
    const key = e.key;

    if (typeof active.onRestart === 'function') {
      const keys = (typeof loadKeys === 'function') ? loadKeys() : null;
      const restartCodes = (keys && keys.restart && keys.restart.codes && keys.restart.codes.length) ? keys.restart.codes : ['KeyR'];
      if (restartCodes.includes(code)) {
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
        e.stopImmediatePropagation();
        activateButton(items[idx]);
      }
      return;
    }
    if (key === 'Escape') {
      // escapeAction を明示指定したページはそれだけに従う（未指定=既定のBACK/RESUME等探索、
      // 指定してnull/undefinedが返れば「今は安全な対象が無い」= 何もしない）。
      if ('escapeAction' in active) {
        const target = typeof active.escapeAction === 'function' ? active.escapeAction(currentItems()) : null;
        if (target) { e.preventDefault(); e.stopImmediatePropagation(); activateButton(normalizeItem(target)); }
        return;
      }
      const back = findByText(/^(▶|◀|⌂)?\s*(BACK|MAIN\s*MENU|MODE\s*SELECT|LEVEL\s*SELECT|DONE|RESUME)/i);
      if (back) { e.preventDefault(); e.stopImmediatePropagation(); activateButton(back); }
      return;
    }
  }

  function deactivate(){
    clearFocus();
    active = null;
  }

  // online系は activate() 呼び出し時点でまだページに 'active' が付いていない（描画→表示が
  // 非同期に分かれている）ケースがあり、items が一時的に空(=不可視)なことがある。単発の rAF で
  // 諦めると「表示された後にキーを押しても最初の数回は無反応」になるため、ページが実際に
  // アクティブになって items が見つかるまで数フレーム分だけ再試行する。
  const ACTIVATE_RETRY_FRAMES = 60; // 約1秒（60Hz想定）で諦める
  function activate(pageId){
    const cfg = registry[pageId];
    deactivate();
    if (!cfg) return;
    const root = cfg.root || document.getElementById(pageId + '-page') || document.getElementById(pageId);
    if (!root) return;
    active = Object.assign({ pageId, root, index: 0, _firstFocus: true }, cfg);

    let framesLeft = ACTIVATE_RETRY_FRAMES;
    const tryInit = () => {
      if (!active || active.pageId !== pageId) return;
      const items = currentItems();
      if (!items.length) {
        if (--framesLeft > 0) requestAnimationFrame(tryInit);
        return;
      }
      let init = 0;
      if (cfg.rememberIndex && typeof rememberedIndex[pageId] === 'number') init = rememberedIndex[pageId];
      else if (typeof cfg.initialIndex === 'function') init = cfg.initialIndex(items.map(it => it.el)) || 0;
      else if (typeof cfg.initialIndex === 'number') init = cfg.initialIndex;
      if (init < 0 || init >= items.length) init = 0;
      applyFocus(init, { skipScroll: cfg.skipInitialScroll === true });
    };
    requestAnimationFrame(tryInit);
  }

  function register(pageId, cfg){
    registry[pageId] = cfg;
  }

  function getActivePageId(){
    return active ? active.pageId : null;
  }

  // DOM再生成（一覧の自動更新など）で要素参照が失われた後、同じ`key`を持つ項目へ
  // フォーカスを復元する。見つからなければ現在のindexをクランプするだけに留める
  // （スクロールは動かさない＝背景更新でビューが動く体験を避ける）。
  function restoreFocus(key){
    if (!active) return;
    const items = currentItems();
    if (key != null) {
      const idx = items.findIndex(it => it.key === key);
      if (idx >= 0) { applyFocus(idx, { skipScroll: true }); return; }
    }
    const clamped = Math.max(0, Math.min(active.index || 0, items.length - 1));
    applyFocus(items.length ? clamped : 0, { skipScroll: true });
  }

  function currentFocusKey(){
    if (!active) return null;
    const items = currentItems();
    const it = items[currentIndex(items)];
    return (it && it.key != null) ? it.key : null;
  }

  // マウスhoverでindex追従（キー操作再開時の起点を合わせる）
  // kbdモード中は無視: スムーズスクロール中に mouseover が発火して active.index を汚染し、
  // 直後の横キーで applyFocus(active.index) がフォーカス枠を別行へ飛ばす不具合があったため
  document.addEventListener('mouseover', (e) => {
    if (!active) return;
    if (inputMode !== 'pointer') return;
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
    getActivePageId,
    restoreFocus,
    currentFocusKey,
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
  function withAnchor(items, anchor) {
    return items.map(it => {
      if (it instanceof Element) return { el: it, scrollAnchor: anchor };
      if (it.el) return Object.assign({}, it, { scrollAnchor: anchor });
      return it;
    });
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
    rememberIndex: true,
    skipInitialScroll: true,
    getItems: () => [
      ...withAnchor($$('#main-menu-modes-grid button'), document.getElementById('main-menu-modes-grid')),
      ...withAnchor($$('#main-menu-footer button'), document.getElementById('main-menu-footer')),
    ],
    onMove2D: (dir, cur, items) => {
      const curEl = items[cur] && items[cur].el;
      if (!curEl) return null;
      // CPU TEST → ONLINE → SETTINGS を上下キーで直結する
      if (dir === 'down' && curEl.classList.contains('mode-btn-test')) {
        const idx = items.findIndex(it => it.el.classList.contains('mode-btn-online'));
        if (idx >= 0) return idx;
      }
      if (dir === 'down' && curEl.classList.contains('mode-btn-online')) {
        const idx = items.findIndex(it => it.el.classList.contains('btn-secondary') && /SETTINGS/i.test(it.el.textContent));
        if (idx >= 0) return idx;
      }
      if (dir === 'up' && curEl.classList.contains('btn-secondary') && /SETTINGS/i.test(curEl.textContent)) {
        const idx = items.findIndex(it => it.el.classList.contains('mode-btn-online'));
        if (idx >= 0) return idx;
      }
      if (dir === 'up' && curEl.classList.contains('mode-btn-online')) {
        const idx = items.findIndex(it => it.el.classList.contains('mode-btn-test'));
        if (idx >= 0) return idx;
      }
      return null;
    },
  });

  register('mode-check', {
    getItems: () => {
      const optAnchor = document.getElementById('mode-check-options');
      const btnAnchor = document.getElementById('mode-check-buttons');
      const items = [];
      $$('#mode-check-options .option-row').forEach(row => {
        const it = rowAuto(row);
        if (it) { it.scrollAnchor = optAnchor; items.push(it); }
      });
      $$('#mode-check-options > button').forEach(b => items.push({ el: b, scrollAnchor: optAnchor }));
      items.push(...withAnchor($$('#mode-check-buttons button'), btnAnchor));
      return items;
    },
    initialIndex: (els) => els.findIndex(b => b && b.id === 'mode-check-start-btn'),
  });

  register('versus-check', {
    getItems: () => {
      const ruleAnchor  = document.getElementById('versus-rule-options');
      const cpuAnchor   = document.getElementById('versus-cpu-options');
      const btnAnchor   = document.getElementById('versus-check-buttons');
      const items = [];
      const playerRow = document.querySelector('#versus-rule-options .option-row:nth-child(1)');
      const cpuRow    = document.querySelector('#versus-rule-options .option-row:nth-child(2)');
      const cpuLvRow  = document.querySelector('#versus-cpu-options .option-row');
      if (playerRow) { const it = rowToggle(playerRow, document.getElementById('versus-player-rule-toggle')); it.scrollAnchor = ruleAnchor; items.push(it); }
      if (cpuRow)    { const it = rowToggle(cpuRow,    document.getElementById('versus-cpu-rule-toggle'));    it.scrollAnchor = ruleAnchor; items.push(it); }
      if (cpuLvRow)  { const it = rowToggle(cpuLvRow,  document.getElementById('cpu-level-toggle'));         it.scrollAnchor = cpuAnchor;  items.push(it); }
      items.push(...withAnchor($$('#versus-check-buttons button'), btnAnchor));
      return items;
    },
    initialIndex: (els) => els.findIndex(b => b && b.id === 'versus-check-start-btn'),
  });

  register('vs-settings', {
    getItems: () => {
      const itemsContainer = document.getElementById('vs-settings-items');
      const btnAnchor      = document.getElementById('vs-settings-buttons');
      const items = [];
      if (itemsContainer) {
        $$('.vs-setting-section', itemsContainer).forEach(section => {
          $$('.vs-setting-row', section).forEach(row => {
            const slider = row.querySelector('input[type="range"]');
            if (slider) {
              const it = rowSlider(row, slider); it.scrollAnchor = section; items.push(it);
            } else {
              const btnGroup = row.querySelector('.vs-setting-btn-group');
              if (btnGroup) {
                const btns = $$('.vs-setting-step-btn', btnGroup);
                items.push({
                  type: 'row', el: row, scrollAnchor: section,
                  onLeft:  () => { const cur = btns.findIndex(b => b.classList.contains('active')); if (cur > 0) btns[cur - 1].click(); },
                  onRight: () => { const cur = btns.findIndex(b => b.classList.contains('active')); if (cur < btns.length - 1) btns[cur + 1].click(); },
                });
              }
            }
          });
        });
        $$('.vs-settings-reset-btn', itemsContainer).forEach(b => items.push({ el: b, scrollAnchor: btnAnchor }));
      }
      $$('#vs-settings-buttons button').forEach(b => items.push({ el: b, scrollAnchor: btnAnchor }));
      return items;
    },
    initialIndex: 0,
  });

  register('quiz-check', {
    getItems: () => [
      ...withAnchor($$('#quiz-rule-select button'), document.getElementById('quiz-rule-select')),
      ...withAnchor($$('#quiz-level-list button'), document.getElementById('quiz-level-list')),
      ...withAnchor($$('#quiz-check-page .menu-btn'), document.querySelector('#quiz-check-page > div:last-child') || document.getElementById('quiz-check-page')),
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

  register('credits', {
    getItems: () => $$('#credits-buttons button'),
    initialIndex: 0,
    scrollPane: () => document.querySelector('#credits-page .credits-list'),
  });

  register('changelog', {
    getItems: () => $$('#changelog-page .btn-back'),
    initialIndex: 0,
    scrollPane: () => document.querySelector('#changelog-page .changelog-list'),
  });

  register('settings', {
    getItems: () => {
      const headerAnchor  = document.querySelector('.settings-header');
      const keyAnchor     = document.getElementById('key-config-grid');
      const actionsAnchor = document.querySelector('#settings-page .settings-actions');
      const items = [];
      $$('.settings-header .btn-back').forEach(b => items.push({ el: b, scrollAnchor: headerAnchor }));
      const bgmSlider = document.getElementById('slider-bgm-volume');
      const seSlider  = document.getElementById('slider-se-volume');
      const bgmRow = bgmSlider && bgmSlider.closest('.slider-row');
      const seRow  = seSlider  && seSlider.closest('.slider-row');
      const volAnchor = bgmRow && bgmRow.closest('.tuning-container');
      if (bgmRow) { const it = rowSlider(bgmRow, bgmSlider); it.scrollAnchor = volAnchor; items.push(it); }
      if (seRow)  { const it = rowSlider(seRow,  seSlider);   it.scrollAnchor = volAnchor; items.push(it); }
      $$('#key-config-grid .key-row').forEach(row => {
        $$('.key-badge', row).forEach(b => items.push({ el: b, scrollAnchor: keyAnchor }));
      });
      const tuningContainer = document.getElementById('tuning-tet-section');
      ['slider-das', 'slider-arr', 'slider-dcd'].forEach(id => {
        const s = document.getElementById(id);
        const row = s && s.closest('.slider-row');
        if (row) { const it = rowSlider(row, s); it.scrollAnchor = tuningContainer || row; items.push(it); }
      });
      const displaySection = document.getElementById('display-section');
      $$('#display-section .option-row').forEach(row => {
        const it = rowAuto(row);
        if (it) { it.scrollAnchor = displaySection; items.push(it); }
        else {
          // RESET RECORDS 行はトグルではなくボタン単体
          const btn = row.querySelector('button');
          if (btn) items.push({ el: btn, scrollAnchor: displaySection });
        }
      });
      $$('#settings-page .btn-reset, #settings-page .btn-save').forEach(b => items.push({ el: b, scrollAnchor: actionsAnchor }));
      return items;
    },
    initialIndex: 0,
  });

  // ─────────────────────────────────────────────
  // ポーズオーバーレイ
  // ─────────────────────────────────────────────
  // watchAttr: 'class'なら overlay.active クラス、'style'なら display!=='none' を可視判定に使う
  // （online系の一部オーバーレイは class ではなく style.display で開閉するため）。
  //
  // ★ 複数オーバーレイの重ね表示に対応する（online対戦のリザルト画面(ol-winner-overlay)の
  //   上にロード画面(ol-loading-overlay)が被って開く等）。各オーバーレイのMutationObserverは
  //   「自分自身のstyle/class変化」でしか発火しないため、上に被さっていた方だけが閉じても
  //   下のオーバーレイ側では何もイベントが起きない。そのままdeactivate()するとFocusNavが
  //   非activeのまま固定され、下のオーバーレイがまだ開いているのに矢印キーが一切効かなく
  //   なる不具合があった（RETRY→ロード画面キャンセル後にリザルト画面のRETRY/ROOM/LEAVEへ
  //   フォーカスが戻らない）。閉じた側が今のactiveだった場合、他に開いたままのオーバーレイが
  //   無いか探し、あればそちらへactivateし直す。
  const overlayWatchers = [];
  function setupOverlayWatcher(overlayId, getButtons, initialSelector, extra){
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;
    extra = extra || {};
    const watchAttr = extra.watchAttr || 'class';
    const isOpen = watchAttr === 'style'
      ? () => overlay.style.display !== 'none'
      : () => overlay.classList.contains('active');

    overlayWatchers.push({ overlayId, isOpen });

    register(overlayId, Object.assign({
      root: overlay,
      getItems: getButtons,
      initialIndex: (els) => {
        if (!initialSelector) return 0;
        const idx = els.findIndex(b => b.matches && b.matches(initialSelector));
        return idx >= 0 ? idx : 0;
      },
      isActive: isOpen,
    }, extra.pageCfg || {}));

    const obs = new MutationObserver(() => {
      if (isOpen()) {
        activate(overlayId);
      } else if (active && active.pageId === overlayId) {
        const stillOpen = overlayWatchers.find(w => w.overlayId !== overlayId && w.isOpen());
        if (stillOpen) activate(stillOpen.overlayId);
        else deactivate();
      }
    });
    obs.observe(overlay, { attributes: true, attributeFilter: [watchAttr] });
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

    // ── online対戦オーバーレイ（class ではなく style.display で開閉するため watchAttr:'style'）──
    setupOverlayWatcher(
      'ol-winner-overlay',
      () => $$('#ol-winner-overlay #ol-post-match-buttons button:not(:disabled)'),
      '#ol-btn-rematch',
      {
        watchAttr: 'style',
        // RETRY/ROOMは遷移を伴い、LEAVEは破壊的操作＝安全なEscape対象が無いため明示的に無効化。
        pageCfg: { escapeAction: () => null },
      }
    );
    setupOverlayWatcher(
      'ol-pause-overlay',
      () => $$('#ol-pause-overlay button:not(:disabled)'),
      null,
      { watchAttr: 'style' }
    );
    setupOverlayWatcher(
      'ol-loading-overlay',
      () => $$('#ol-loading-overlay button:not(:disabled)'),
      '#ol-loading-cancel',
      {
        watchAttr: 'style',
        pageCfg: {
          escapeAction: () => {
            const btn = document.getElementById('ol-loading-cancel');
            return (btn && btn.style.display !== 'none' && !btn.disabled) ? btn : null;
          },
        },
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOverlays);
  } else {
    setupOverlays();
  }
})();
