// focus_nav.js — UIのキーボード操作・フォーカス枠表示・入力モード切替・スクロール追従
//
// 主な機能:
//  - 入力モード追跡: body.input-mode-kbd / body.input-mode-pointer
//    キー操作開始で kbd、マウス/タッチ操作で pointer に切替
//    pointer 中は .is-focused を付与しない（=枠なし、hoverのみ）
//  - フォーカス item 抽象化: type='button' or type='row'
//    row はラベル要素にフォーカス枠 + ←/→ で値変更（onLeft/onRight）
//  - 既定の 2D 移動は視覚配置(getBoundingClientRect)から行列を作って遷移
//  - フォーカス対象のグループが見えていなければ最小限だけスクロール（自前のばねアニメ）
//  - 矢印キーで項目が変わったらカーソル移動SE（menu_cursor）

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
      // マウス/ホイール操作と取り合わないよう、フォーカス追従スクロールは即中断
      stopFocusScroll();
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

  // ─────────────────────────────────────────────
  // フォーカス追従スクロール
  // 旧実装は scrollIntoView({block:'center', behavior:'smooth'}) だったが、
  //  ①見えているグループへ移っても中央へ寄せ直す
  //  ②長押し（キーリピート）中、グループが変わるたびにブラウザのアニメが速度0からやり直しになり
  //    「急停止→急加速」を繰り返す（実測 約3000px/s→55px/s）
  // という問題があったため、次の方式に置き換えた。
  //  - グループ(scrollAnchor)が余白込みで見えていれば動かさない。見えていなければ最小限だけ動かす。
  //    グループが表示領域より高い場合は、フォーカス項目自体を表示領域に入れる。
  //  - 移動は臨界減衰ばねの自前rAFで行う。途中で目標が変わっても速度を引き継ぐので途切れない。
  //  - prefers-reduced-motion 時は即座に移動する。
  // ─────────────────────────────────────────────
  const SCROLL_OMEGA = 14;       // ばねの固有角振動数（大きいほど速く収束。14で480px移動≒0.45秒）
  const SCROLL_VMAX_PER_VH = 4;  // 速度上限（表示領域の高さ×この値 px/s）
  const reducedMotionMql = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let focusScroll = null; // { sc, pos, v, target, rafId, lastTs }

  function isRootScroller(el){
    return el === document.scrollingElement || el === document.documentElement || el === document.body;
  }

  function getScrollParent(node){
    let el = node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollViewport(sc){
    if (isRootScroller(sc)) return { top: 0, bottom: window.innerHeight };
    const r = sc.getBoundingClientRect();
    const top = r.top + sc.clientTop;
    return { top, bottom: top + sc.clientHeight };
  }

  function stopFocusScroll(){
    if (focusScroll && focusScroll.rafId) cancelAnimationFrame(focusScroll.rafId);
    focusScroll = null;
  }

  function _focusScrollLoop(ts){
    const fs = focusScroll;
    if (!fs) return;
    const sc = fs.sc;
    if (!sc.isConnected) { stopFocusScroll(); return; }
    // 初回フレームは経過時間が不定（rAF登録から描画までの待ち）なので1フレーム分として扱う
    let dt = fs.lastTs === null ? 1 / 60 : Math.min(64, Math.max(0, ts - fs.lastTs)) / 1000;
    fs.lastTs = ts;
    const vMax = Math.max(1200, sc.clientHeight * SCROLL_VMAX_PER_VH);
    // 半陰的オイラーを細かく刻んで積分（高リフレッシュでも低リフレッシュでも同じ動きにする）
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      dt -= h;
      const a = SCROLL_OMEGA * SCROLL_OMEGA * (fs.target - fs.pos) - 2 * SCROLL_OMEGA * fs.v;
      fs.v = Math.max(-vMax, Math.min(vMax, fs.v + a * h));
      fs.pos += fs.v * h;
    }
    // 残り1px前後を何フレームもかけて這うと1pxずつのカクつきに見えるため、早めにスナップする
    const done = Math.abs(fs.target - fs.pos) < 1.5 && Math.abs(fs.v) < 60;
    if (done) fs.pos = fs.target;
    sc.scrollTop = fs.pos;
    if (done) { stopFocusScroll(); return; }
    fs.rafId = requestAnimationFrame(_focusScrollLoop);
  }

  function scrollToTarget(sc, target, edgeSnap){
    const maxTop = Math.max(0, sc.scrollHeight - sc.clientHeight);
    // 端まで余白ぶんも無いなら端に揃える（ページ先頭が数十pxだけ隠れた半端な位置で止めない）
    if (target < edgeSnap) target = 0;
    if (target > maxTop - edgeSnap) target = maxTop;
    target = Math.max(0, Math.min(maxTop, target));
    if (reducedMotionMql && reducedMotionMql.matches) {
      stopFocusScroll();
      sc.scrollTop = target;
      return;
    }
    if (focusScroll && focusScroll.sc === sc) {
      focusScroll.target = target; // 速度は引き継ぐ
      return;
    }
    stopFocusScroll();
    focusScroll = { sc, pos: sc.scrollTop, v: 0, target, rafId: null, lastTs: null };
    focusScroll.rafId = requestAnimationFrame(_focusScrollLoop);
  }

  // rect（現在の表示位置）を、スクロール位置が base の時の位置へ換算して必要な移動量を返す。
  // 余白込みで収まっていれば 0、表示領域より高ければ null。
  function neededDelta(rect, vp, margin, shift){
    const top = rect.top - shift, bottom = rect.bottom - shift;
    const vTop = vp.top + margin, vBottom = vp.bottom - margin;
    if (bottom - top > vBottom - vTop) return null;
    if (top < vTop) return top - vTop;
    if (bottom > vBottom) return bottom - vBottom;
    return 0;
  }

  function scrollGroupIntoView(anchor, itemEl){
    if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
    const sc = getScrollParent(anchor);
    const vp = scrollViewport(sc);
    const vh = vp.bottom - vp.top;
    if (vh <= 0) return;
    const margin = Math.min(vh * 0.25, Math.max(48, vh * 0.12));
    // アニメ中は「向かっている先」を基準に判定する（途中の位置で判定すると、行き先では
    // 見えなくなる項目を見落としたり、戻る必要のない方向へ引き戻したりするため）
    const base = (focusScroll && focusScroll.sc === sc) ? focusScroll.target : sc.scrollTop;
    const shift = base - sc.scrollTop;
    let d = neededDelta(anchor.getBoundingClientRect(), vp, margin, shift);
    if (d === null && itemEl && itemEl !== anchor) {
      d = neededDelta(itemEl.getBoundingClientRect(), vp, margin, shift);
    }
    if (d === null) {
      // 項目自体も表示領域より高い：項目の上端を合わせる
      const r = (itemEl || anchor).getBoundingClientRect();
      d = (r.top - shift) - (vp.top + margin);
    }
    if (Math.abs(d) < 1) return;
    scrollToTarget(sc, base + d, margin);
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
    // カーソル移動SE：矢印キーで実際に項目が変わった時だけ（初期フォーカス・再描画・復元では鳴らさない）
    if (opts.sound && idx !== prevIdx) playCursorSe();
    if (!opts.skipScroll) {
      // 見えていれば何もしないので、同じグループ内の移動でも毎回判定してよい
      // （マウスで他所へスクロールした後にキー操作を再開した時も、フォーカス位置へ戻れる）
      scrollGroupIntoView(getScrollAnchor(it), it.el);
    }
    active._firstFocus = false;
  }

  function playCursorSe(){
    const se = window.SeManager;
    if (!se) return;
    if (typeof se.playExclusive === 'function') se.playExclusive('menu_cursor');
    else se.play('menu_cursor');
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

  // ─────────────────────────────────────────────
  // scrollPane（CREDITS/CHANGELOG等）の慣性スクロール
  // OSのキーリピート間隔には依存せず、押下継続時間から自前で二次関数加速する
  // （DASなし＝押した瞬間から加速が始まる）。離すとease-out的に減衰して止まる。
  // ─────────────────────────────────────────────
  let paneScroll = null; // { pane, dir, held, v, rafId, startTs, lastTs }

  function stopPaneScroll(){
    if (paneScroll && paneScroll.rafId) cancelAnimationFrame(paneScroll.rafId);
    paneScroll = null;
  }

  function _paneScrollLoop(ts){
    const ps = paneScroll;
    if (!ps) return;
    const pane = ps.pane;
    if (!pane.isConnected || pane.offsetParent === null) { stopPaneScroll(); return; }

    const dt = Math.min(64, ts - ps.lastTs) / 1000; // 秒。タブ復帰直後の暴走を防ぐため上限
    ps.lastTs = ts;

    const vMax = Math.max(400, pane.clientHeight * 2.2); // px/s
    if (ps.held) {
      // 初速をvMaxの半分から始める（0からだと押した直後の反応が鈍く感じるため）。
      // そこから二次関数で加速し、約0.35秒でvMaxに到達する。
      const vInit = vMax * 0.5;
      const heldSec = (ts - ps.startTs) / 1000;
      const kAccel = (vMax - vInit) / (0.35 * 0.35);
      ps.v = Math.min(vMax, vInit + kAccel * heldSec * heldSec);
    } else {
      // 離した後は指数減衰でease-out的に止める（1フレーム≈16.7ms換算）
      ps.v *= Math.pow(0.86, (dt * 1000) / 16.7);
      if (ps.v < 20) { stopPaneScroll(); return; }
    }

    const sign = ps.dir === 'down' ? 1 : -1;
    const before = pane.scrollTop;
    pane.scrollTop += sign * ps.v * dt;
    if (pane.scrollTop === before) ps.v = 0; // 端に到達＝次の押下から加速やり直し

    ps.rafId = requestAnimationFrame(_paneScrollLoop);
  }

  function startPaneScroll(pane, dir){
    if (paneScroll && paneScroll.pane === pane) {
      if (paneScroll.dir !== dir) {
        // 方向反転：前の速度を引き継がず、この方向で加速をやり直す
        paneScroll.dir = dir;
        paneScroll.v = 0;
        paneScroll.startTs = performance.now();
      }
      paneScroll.held = true;
      return;
    }
    stopPaneScroll();
    const now = performance.now();
    paneScroll = { pane, dir, held: true, v: 0, rafId: null, startTs: now, lastTs: now };
    paneScroll.rafId = requestAnimationFrame(_paneScrollLoop);
  }

  function releasePaneScroll(pane, dir){
    if (paneScroll && paneScroll.pane === pane && paneScroll.dir === dir) {
      paneScroll.held = false;
    }
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
        // 値が実際に変わった時だけ選択音（スライダー端・ステップ端では鳴らさない）。
        // トグルは .opt-btn 等の click 経由でも選択音が鳴るが、playExclusive の間引きで1回にまとまる。
        const before = rowValueSignature(it.el);
        handler(it);
        if (rowValueSignature(it.el) !== before) playCursorSe();
        // 値変更後に表示が更新される可能性があるため、フォーカスを再適用
        // 左右で値を変えるだけの操作ではページを縦スクロールさせない
        // active.index は mouseover で汚染されうるので .is-focused 由来の cur を使う
        applyFocus(cur, { skipScroll: true });
      }
      return;
    }

    // scrollPane 指定ページ（CREDITS/CHANGELOG等）の上下キーは onKey() 側で
    // startPaneScroll()/releasePaneScroll() に直接ルーティングされるため、ここには来ない。

    if (typeof active.onMove2D === 'function') {
      const next = active.onMove2D(dir, cur, items);
      if (typeof next === 'number' && next >= 0 && next < items.length) {
        applyFocus(next, { sound: true });
        return;
      }
    }
    const next = defaultMove2D(dir, cur, items);
    if (next !== null) applyFocus(next, { sound: true });
  }

  // row 行の「現在値」を表す文字列（表示テキスト＋中のinput値＋activeなボタン）
  function rowValueSignature(el){
    let sig = el.textContent || '';
    el.querySelectorAll('input').forEach(i => { sig += '|' + i.value; });
    el.querySelectorAll('.active').forEach(b => { sig += '|' + (b.textContent || '') + '#' + Array.prototype.indexOf.call(b.parentNode.children, b); });
    return sig;
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
    // 数値の桁スピナー編集モード（PRACTICEの目標値・ツモ順エディタ）が開いている間は、
    // 行移動・2D移動・Enter/Escape をすべて編集側へ譲る。isTypingTarget と同じ役割を
    // 「ネイティブのinputを使わないUI」に対して果たすフラグ。
    if (window.FocusNav && window.FocusNav.suspended) return;
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

    // scrollPane 指定ページ（CREDITS/CHANGELOG等）は上下キーを内部スクロールに割り当てる。
    // OSのキーリピートには乗らず（e.repeatは無視）、押下継続はkeyupまでの経過時間で
    // startPaneScroll()側が自前のrAFループで加速する。preventDefaultによりブラウザの
    // ネイティブスクロールとは二重発火しない。
    {
      const isUp = key === 'ArrowUp' || code === 'KeyW';
      const isDown = key === 'ArrowDown' || code === 'KeyS';
      if ((isUp || isDown) && typeof active.scrollPane === 'function') {
        // scrollPane(現在のフォーカス項目, 方向) が null を返したら通常のフォーカス移動に回す
        // （RANKINGは一覧にフォーカスがある時だけ、かつ端に達していない方向だけスクロール）
        const dir = isDown ? 'down' : 'up';
        const items = currentItems();
        const pane = active.scrollPane(items[currentIndex(items)], dir);
        if (pane) {
          e.preventDefault();
          if (!e.repeat) startPaneScroll(pane, dir);
          return;
        }
        // 長押しで端まで流れ着いた直後のキーリピートで、そのまま隣の項目へ飛ばない
        if (e.repeat && paneScroll) { e.preventDefault(); return; }
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
    stopPaneScroll();
    stopFocusScroll();
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

  // scrollPaneの慣性スクロールを止める側（離した瞬間にease-out減衰へ移行）。
  // onKeyより先/後どちらで発火しても構わない（held=falseを立てるだけ）。
  document.addEventListener('keyup', (e) => {
    if (!paneScroll) return;
    const isUp = e.key === 'ArrowUp' || e.code === 'KeyW';
    const isDown = e.key === 'ArrowDown' || e.code === 'KeyS';
    if ((isUp && paneScroll.dir === 'up') || (isDown && paneScroll.dir === 'down')) {
      releasePaneScroll(paneScroll.pane, paneScroll.dir);
    }
  });

  // alt+tab等でウィンドウがフォーカスを失うとkeyupが発火しないことがあり、
  // held状態のままvMaxで回り続けてしまう。blur時は問答無用で減衰フェーズに移す。
  window.addEventListener('blur', () => {
    if (paneScroll) paneScroll.held = false;
  });

  window.FocusNav = {
    // suspended: 独自の数値編集UIがキー入力を占有している間 true（PRACTICEの桁スピナー等）。
    // rowHandlers: data-nav-row="<name>" の行に紐づく操作ハンドラの登録先。
    suspended: false,
    rowHandlers: {},
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
    // data-nav-row="<name>" が付いた行は、FocusNav.rowHandlers[name] に登録された
    // ハンドラ（onLeft/onRight/onActivate）で操作する。スライダーもトグルも持たない
    // 独自UI（PRACTICEの目標値スピナー等）を items に載せるための口。
    const custom = el.dataset && el.dataset.navRow;
    if (custom && window.FocusNav && window.FocusNav.rowHandlers[custom]) {
      const h = window.FocusNav.rowHandlers[custom];
      return {
        type: 'row', el,
        onLeft:     typeof h.onLeft     === 'function' ? () => h.onLeft(el)     : undefined,
        onRight:    typeof h.onRight    === 'function' ? () => h.onRight(el)    : undefined,
        onActivate: typeof h.onActivate === 'function' ? () => h.onActivate(el) : undefined,
      };
    }
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
    // 初回訪問時（rememberedIndexが無い時）はMARATHONを初期フォーカスにする
    // （チップを先頭に加えたことで既定の0番目がチップになってしまうため）。
    initialIndex: (els) => els.findIndex(el => el && el.classList.contains('mode-btn-marathon')),
    getItems: () => [
      ...withAnchor($$('#account-chip'), document.getElementById('main-menu-logo')),
      ...withAnchor($$('#main-menu-modes-grid button'), document.getElementById('main-menu-modes-grid')),
      ...withAnchor($$('#main-menu-footer button'), document.getElementById('main-menu-footer')),
    ],
    onMove2D: (dir, cur, items) => {
      const curEl = items[cur] && items[cur].el;
      if (!curEl) return null;
      // アカウントチップ ⇔ PUYO を上下キーで直結する（チップは絶対配置で右上に浮いており、
      // 座標ベースの自動移動だと近い位置のボタンに飛んでしまうため明示的に固定する）
      if (dir === 'down' && curEl.id === 'account-chip') {
        const idx = items.findIndex(it => it.el.classList.contains('mode-btn-puyo'));
        if (idx >= 0) return idx;
      }
      if (dir === 'up' && curEl.classList.contains('mode-btn-puyo')) {
        const idx = items.findIndex(it => it.el.id === 'account-chip');
        if (idx >= 0) return idx;
      }
      // CPU TEST → ONLINE → SETTINGS/RANKING を上下キーで直結する
      if (dir === 'down' && curEl.classList.contains('mode-btn-test')) {
        const idx = items.findIndex(it => it.el.classList.contains('mode-btn-online'));
        if (idx >= 0) return idx;
      }
      if (dir === 'down' && curEl.classList.contains('mode-btn-online')) {
        const idx = items.findIndex(it => it.el.id === 'main-menu-settings-btn');
        if (idx >= 0) return idx;
      }
      if (dir === 'up' && curEl.id === 'main-menu-settings-btn') {
        const idx = items.findIndex(it => it.el.classList.contains('mode-btn-online'));
        if (idx >= 0) return idx;
      }
      if (dir === 'up' && curEl.id === 'main-menu-ranking-btn') {
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

  register('practice-help', {
    getItems: () => $$('#practice-help-buttons button'),
    initialIndex: 0,
    scrollPane: () => document.querySelector('#practice-help-page .practice-help-list'),
  });

  register('ranking', {
    getItems: () => {
      const tabToggle = document.getElementById('ranking-mode-toggle');
      const btnAnchor = document.getElementById('ranking-buttons');
      const items = [];
      if (tabToggle) items.push(rowToggle(tabToggle, tabToggle));
      // 一覧はスクロールが必要な時だけ1項目として挟む（タブ ↓ 一覧 ↓ BACK）
      const list = document.getElementById('ranking-list');
      if (list && list.scrollHeight > list.clientHeight) items.push({ el: list });
      $$('#ranking-buttons button').forEach(b => items.push({ el: b, scrollAnchor: btnAnchor }));
      return items;
    },
    initialIndex: 0,
    scrollPane: (it, dir) => {
      const pane = document.getElementById('ranking-list');
      if (!pane || !it || it.el !== pane) return null;
      const atTop = pane.scrollTop <= 0;
      const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
      if ((dir === 'up' && atTop) || (dir === 'down' && atBottom)) return null;
      return pane;
    },
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
