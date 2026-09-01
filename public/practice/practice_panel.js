// ─────────────────────────────────────────────
// practice_panel.js
// PRACTICEモードのゲーム内設定パネル（Phase 2 §6）
//
// 設計: source_assets/memory/tetlabo-practice-mode-design.md §6
//   ・右側に折りたたみ。開いている間はポーズ（TIMEも停止）
//   ・設定は変更した瞬間に盤面へ反映（ツモ順設定のみ例外＝Phase 3で扱う）
//   ・項目: 落下速度 / NEXT表示数 / HOLD(ON/OFF/FREE) / 色数(puyo) / ゴースト(tet) / 盤面クリア
//
// PracticeManager（practice.js）の attach()/destroy() から
// _initPracticePanel(manager) / _closePracticePanel() が呼ばれる。
// ─────────────────────────────────────────────

// puyoの自由落下速度の段階（0=自然落下なし＝Phase1既定 / 1=既定250ms / 以降は高速段階）
const PRACTICE_PUYO_FALL_TABLE = [0, 250, 180, 120, 80, 50, 30];

// tetのHOLDモード（左→右のボタン順）。ONは通常どおり1手1回、
// OFFは操作を受け付けない、FREEは1手に何度でも使え枠も薄暗くしない。
const PRACTICE_HOLD_MODES = ['on', 'off', 'free'];

function _practiceFallMax() {
    const mgr = window._practiceManager;
    return (mgr && mgr.rule === 'puyo') ? PRACTICE_PUYO_FALL_TABLE.length - 1 : 15;
}

function _practiceFallLabel(lv) {
    const mgr = window._practiceManager;
    if (lv <= 0) return '0';
    if (mgr && mgr.rule === 'puyo') return PRACTICE_PUYO_FALL_TABLE[lv] + 'ms';
    return 'LV' + lv;
}

// パネル内のキーボード操作でフォーカスする行の並び（rule別）
function _practicePanelRowKeys(mgr) {
    return (mgr.rule === 'tet')
        ? ['speed', 'next', 'hold', 'ghost', 'clear']
        : ['speed', 'next', 'colors', 'clear'];
}

// ─────────────────────────────────────────
// 開閉（開く＝ポーズ、閉じる＝再開）
// ─────────────────────────────────────────
function togglePracticePanel() {
    const panel = document.getElementById('practice-panel');
    const mgr = window._practiceManager;
    if (!panel || !mgr || !mgr.gameInstance) return;
    const opening = !panel.classList.contains('is-open');
    panel.classList.toggle('is-open', opening);
    _practicePanelFocusIndex = 0;

    const g = mgr.gameInstance;
    if (opening) {
        // 既存の pause()/resume() をそのまま使う（TIME停止・重力/DAS停止まで一括で面倒を見てくれる）。
        // 大きなポーズモーダルは出したくないので、tetは表示直後に隠す。
        g.pause();
        if (mgr.rule === 'tet' && typeof g.hidePauseOverlay === 'function') g.hidePauseOverlay();
    } else {
        g.resume();
    }

    // 「設定変更中（＝ポーズ中）」を示すインジケーター（バグ報告への対応）
    const overlay = document.getElementById('practice-settings-overlay');
    if (overlay) overlay.classList.toggle('active', opening);

    _practicePanelRefresh();
}

function _closePracticePanel() {
    const panel = document.getElementById('practice-panel');
    if (panel) {
        panel.classList.remove('is-open');
        panel.classList.remove('is-visible');
    }
    const body = document.getElementById('practice-panel-body');
    if (body) body.innerHTML = '';
    const overlay = document.getElementById('practice-settings-overlay');
    if (overlay) overlay.classList.remove('active');
    _removePracticePanelKeyHandler();
}

// ─────────────────────────────────────────
// 初期化（PracticeManager.attach() の最後で呼ばれる）
// ─────────────────────────────────────────
function _initPracticePanel(manager) {
    const panel = document.getElementById('practice-panel');
    if (!panel) return;
    const g = manager.gameInstance;

    // 既定値（設計 §1.3/§6.2 の初期状態）
    manager.fallLevel = 0;
    g.gravityDisabled = (manager.rule === 'tet') ? true : g.gravityDisabled;
    if (manager.rule === 'puyo') g.practiceFallMs = 0;
    g.practiceNoLock = true;
    g.practiceNextCount = (manager.rule === 'tet') ? 5 : 2;
    g.practiceHoldMode = 'on';
    g.showGhost = true;
    if (typeof g.resizeNextCanvas === 'function') g.resizeNextCanvas();

    panel.classList.add('is-visible');
    panel.classList.remove('is-open');
    _practicePanelFocusIndex = 0;
    _practicePanelRefresh();
    _installPracticePanelKeyHandler();
}

// ─────────────────────────────────────────
// 描画
// ─────────────────────────────────────────
function _practicePanelRefresh() {
    const mgr = window._practiceManager;
    const body = document.getElementById('practice-panel-body');
    if (!mgr || !mgr.gameInstance || !body) return;
    const g = mgr.gameInstance;
    const isTet = (mgr.rule === 'tet');
    const panel = document.getElementById('practice-panel');
    const isOpen = !!(panel && panel.classList.contains('is-open'));
    const rowKeys = _practicePanelRowKeys(mgr);
    const focusCls = (key) => (isOpen && rowKeys[_practicePanelFocusIndex] === key) ? ' is-focused' : '';

    const stepRow = (key, label, valueHtml, onDec, onInc) => `
      <div class="practice-panel-row${focusCls(key)}">
        <span class="practice-panel-label">${label}</span>
        <div class="practice-panel-stepper">
          <button onmousedown="event.preventDefault()" onclick="${onDec}">−</button>
          <span class="practice-panel-value">${valueHtml}</span>
          <button onmousedown="event.preventDefault()" onclick="${onInc}">＋</button>
        </div>
      </div>`;

    const toggleRow = (key, label, isOn, onOnClick, onOffClick) => `
      <div class="practice-panel-row${focusCls(key)}">
        <span class="practice-panel-label">${label}</span>
        <div class="option-toggle practice-panel-toggle">
          <button class="opt-btn ${isOn ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="${onOnClick}">ON</button>
          <button class="opt-btn ${!isOn ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="${onOffClick}">OFF</button>
        </div>
      </div>`;

    const holdMode = g.practiceHoldMode || 'on';
    const holdRow = `
      <div class="practice-panel-row${focusCls('hold')}">
        <span class="practice-panel-label">HOLD</span>
        <div class="option-toggle practice-panel-toggle practice-panel-toggle-3">
          <button class="opt-btn ${holdMode === 'on' ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="setPracticeHoldMode('on')">ON</button>
          <button class="opt-btn ${holdMode === 'off' ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="setPracticeHoldMode('off')">OFF</button>
          <button class="opt-btn ${holdMode === 'free' ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="setPracticeHoldMode('free')">FREE</button>
        </div>
      </div>`;

    let html = '';
    html += stepRow('speed', 'SPEED', _practiceFallLabel(mgr.fallLevel), 'practiceStepFallLevel(-1)', 'practiceStepFallLevel(1)');
    html += stepRow('next', 'NEXT', g.practiceNextCount, 'practiceStepNextCount(-1)', 'practiceStepNextCount(1)');
    if (isTet) {
        html += holdRow;
        html += toggleRow('ghost', 'GHOST', g.showGhost !== false, 'setPracticeGhostEnabled(true)', 'setPracticeGhostEnabled(false)');
    } else {
        html += stepRow('colors', 'COLORS', PConfig.colorCount, 'practiceStepColorCount(-1)', 'practiceStepColorCount(1)');
    }
    html += `
      <div class="practice-panel-row practice-panel-row-action${focusCls('clear')}">
        <button class="practice-panel-clear-btn" onmousedown="event.preventDefault()" onclick="practiceClearBoard()">盤面クリア</button>
      </div>`;

    body.innerHTML = html;
}

// ─────────────────────────────────────────
// キーボード操作（新規: パネルの開閉・項目移動・値変更）
// ─────────────────────────────────────────
let _practicePanelFocusIndex = 0;
let _practicePanelKeyHandler = null;

function _practicePanelOpenKeyCodes() {
    const keys = (typeof loadKeys === 'function') ? loadKeys() : null;
    const k = keys && keys.practicePanel;
    return (k && k.codes && k.codes.length) ? k.codes : ['Tab'];
}

// キー方向(-1/+1)を各項目の操作へ変換する
function _practicePanelApplyDir(rowKey, dir) {
    switch (rowKey) {
        case 'speed':  practiceStepFallLevel(dir); break;
        case 'next':   practiceStepNextCount(dir); break;
        case 'hold':   practiceStepHoldMode(dir); break;
        case 'ghost':  setPracticeGhostEnabled(dir > 0); break;
        case 'colors': practiceStepColorCount(dir); break;
    }
}

function _practicePanelActivate(rowKey) {
    if (rowKey === 'clear') practiceClearBoard();
    else if (rowKey === 'hold') practiceStepHoldMode(1);
    else if (rowKey === 'ghost') {
        const g = window._practiceManager && window._practiceManager.gameInstance;
        if (g) setPracticeGhostEnabled(g.showGhost === false);
    }
}

// game-page がアクティブな間、PRACTICEのパネル開閉キー(既定Tab)を常時監視し、
// パネルが開いている間だけ上下左右/Enter/Escapeを奪ってゲーム本体に渡さない
// （奪わないと、パネル操作のつもりの矢印キーがそのままミノ移動等に使われてしまう）。
function _installPracticePanelKeyHandler() {
    _removePracticePanelKeyHandler();
    _practicePanelKeyHandler = (e) => {
        const mgr = window._practiceManager;
        if (!mgr) return;
        const gamePage = document.getElementById('game-page');
        if (!gamePage || !gamePage.classList.contains('active')) return;

        const panel = document.getElementById('practice-panel');
        const isOpen = !!(panel && panel.classList.contains('is-open'));

        if (_practicePanelOpenKeyCodes().includes(e.code)) {
            if (e.repeat) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            togglePracticePanel();
            return;
        }

        if (!isOpen) return; // 閉じている間は他のキーに介入しない

        const rows = _practicePanelRowKeys(mgr);
        let handled = true;
        if (e.code === 'ArrowUp') {
            _practicePanelFocusIndex = (_practicePanelFocusIndex - 1 + rows.length) % rows.length;
        } else if (e.code === 'ArrowDown') {
            _practicePanelFocusIndex = (_practicePanelFocusIndex + 1) % rows.length;
        } else if (e.code === 'ArrowLeft') {
            _practicePanelApplyDir(rows[_practicePanelFocusIndex], -1);
        } else if (e.code === 'ArrowRight') {
            _practicePanelApplyDir(rows[_practicePanelFocusIndex], 1);
        } else if (e.code === 'Enter' || e.code === 'Space') {
            _practicePanelActivate(rows[_practicePanelFocusIndex]);
        } else if (e.code === 'Escape') {
            togglePracticePanel();
        } else {
            handled = false;
        }

        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
            _practicePanelRefresh();
        }
    };
    // capture段階で先取りする（tet/puyoそれぞれのキー入力ハンドラより先に奪うため）
    document.addEventListener('keydown', _practicePanelKeyHandler, true);
}

function _removePracticePanelKeyHandler() {
    if (_practicePanelKeyHandler) {
        document.removeEventListener('keydown', _practicePanelKeyHandler, true);
        _practicePanelKeyHandler = null;
    }
}

// ─────────────────────────────────────────
// 落下速度
// ─────────────────────────────────────────
function practiceStepFallLevel(delta) {
    const mgr = window._practiceManager;
    if (!mgr || !mgr.gameInstance) return;
    const max = _practiceFallMax();
    mgr.fallLevel = Math.max(0, Math.min(max, mgr.fallLevel + delta));

    const g = mgr.gameInstance;
    if (mgr.rule === 'tet') {
        if (mgr.fallLevel <= 0) {
            g.gravityDisabled = true;
            g.practiceFallSpeedMs = null;
        } else {
            g.gravityDisabled = false;
            g.practiceFallSpeedMs = LEVEL_SPEEDS[mgr.fallLevel] || 7;
        }
        g.practiceNoLock = (mgr.fallLevel <= 0);
    } else {
        g.practiceFallMs = PRACTICE_PUYO_FALL_TABLE[mgr.fallLevel] || 0;
        g.practiceNoLock = (g.practiceFallMs <= 0);
    }
    _practicePanelRefresh();
}

// ─────────────────────────────────────────
// NEXT表示数（1〜10。設計 §1.5）
// ─────────────────────────────────────────
function practiceStepNextCount(delta) {
    const mgr = window._practiceManager;
    if (!mgr || !mgr.gameInstance) return;
    const g = mgr.gameInstance;
    const cur = g.practiceNextCount || (mgr.rule === 'tet' ? 5 : 2);
    g.practiceNextCount = Math.max(1, Math.min(10, cur + delta));
    if (typeof g.resizeNextCanvas === 'function') g.resizeNextCanvas();
    if (mgr.rule === 'tet') {
        if (typeof g.drawAll === 'function') g.drawAll();
    } else if (typeof g._renderNext === 'function') {
        g._renderNext();
    }
    _practicePanelRefresh();
}

// ─────────────────────────────────────────
// HOLD ON/OFF/FREE（tetのみ）
// FREE: 1手につき何度でもホールドでき、枠のミノも薄暗くしない
// ─────────────────────────────────────────
function setPracticeHoldMode(mode) {
    const mgr = window._practiceManager;
    if (!mgr || mgr.rule !== 'tet' || !mgr.gameInstance) return;
    const g = mgr.gameInstance;
    g.practiceHoldMode = mode;
    if (typeof _setHoldOverlayVisible === 'function') _setHoldOverlayVisible(mode === 'off');
    g.drawAll();
    _practicePanelRefresh();
}

function practiceStepHoldMode(dir) {
    const mgr = window._practiceManager;
    if (!mgr || mgr.rule !== 'tet' || !mgr.gameInstance) return;
    const cur = PRACTICE_HOLD_MODES.indexOf(mgr.gameInstance.practiceHoldMode || 'on');
    const next = (cur + dir + PRACTICE_HOLD_MODES.length) % PRACTICE_HOLD_MODES.length;
    setPracticeHoldMode(PRACTICE_HOLD_MODES[next]);
}

// ─────────────────────────────────────────
// ゴースト ON/OFF（tetのみ。設計 §6.2f）
// ─────────────────────────────────────────
function setPracticeGhostEnabled(on) {
    const mgr = window._practiceManager;
    if (!mgr || mgr.rule !== 'tet' || !mgr.gameInstance) return;
    mgr.gameInstance.showGhost = on;
    mgr.gameInstance.drawAll();
    _practicePanelRefresh();
}

// ─────────────────────────────────────────
// 色数（puyoのみ、3〜5。設計 §6.2d / §2.1a）
// _colorOrder は PracticeManager.attach() が凍結済み（先頭n個を取り直すだけで
// 「多い色数が少ない色数を包含する」が成立する）。
// ─────────────────────────────────────────
function practiceStepColorCount(delta) {
    const mgr = window._practiceManager;
    if (!mgr || mgr.rule !== 'puyo' || !mgr.gameInstance) return;
    const g = mgr.gameInstance;
    const n = Math.max(3, Math.min(5, PConfig.colorCount + delta));
    if (n === PConfig.colorCount) return;
    PConfig.colorCount = n;
    g.activeColors = (g._colorOrder || [1, 2, 3, 4, 5]).slice(0, n);
    // 内部キュー（20個）を作り直す（設計 §6.2d）
    g.nextQueue = [];
    while (g.nextQueue.length < 20) g.nextQueue.push(g._makePair());
    if (typeof g._renderNext === 'function') g._renderNext();
    _practicePanelRefresh();
}

// ─────────────────────────────────────────
// 盤面クリア（設計 §6.2g）
// ─────────────────────────────────────────
function practiceClearBoard() {
    const mgr = window._practiceManager;
    if (!mgr || !mgr.gameInstance) return;
    const g = mgr.gameInstance;
    if (mgr.rule === 'tet') {
        g.field = new Field();
        g.field.markDirty();
        g.drawAll();
    } else {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        for (let r = 0; r < totalRows; r++) {
            for (let c = 0; c < PConfig.cols; c++) g.field[r][c] = 0;
        }
        if (typeof g._render === 'function') g._render();
    }
}
