// ─────────────────────────────────────────────
// practice_panel.js
// PRACTICEモードのゲーム内設定パネル（Phase 2 §6）
//
// 設計: source_assets/memory/tetlabo-practice-mode-design.md §6
//   ・開いている間はポーズ（TIMEも停止）
//   ・設定は変更した瞬間に盤面へ反映（ツモ順設定のみ例外＝Phase 3で扱う）
//   ・項目: 落下速度 / NEXT表示数 / HOLD(FREE/ON/OFF) / 色数(puyo) / ゴースト(tet) / 盤面クリア
//   ・Phase 3 §6.2e: おじゃま手動/自動投下（AMT/INTERVAL/AUTO/SEND）もここに同居させた
//
// パネル本体は左サイドの折りたたみドック（#practice-panel-dock。設計 Phase5 §6）。
// 開いている＝ポーズ中。常時見えるのは開閉タブ（#practice-panel-tab、ドック内）と、
// パネルを開かなくても現在値を確認できるミニステータス（#practice-status-left/right）。
//
// PracticeManager（practice.js）の attach()/destroy() から
// _initPracticePanel(manager) / _closePracticePanel() が呼ばれる。
// ─────────────────────────────────────────────

// puyoの自由落下速度の段階（0=自然落下なし＝Phase1既定 / 1=既定250ms / 以降は高速段階）
const PRACTICE_PUYO_FALL_TABLE = [0, 250, 180, 120, 80, 50, 30];

// tetのHOLDモード（左→右のボタン順）。FREEは1手に何度でも使え枠も薄暗くしない、
// ONは通常どおり1手1回、OFFは操作を受け付けない。
const PRACTICE_HOLD_MODES = ['free', 'on', 'off'];

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
    const base = (mgr.rule === 'tet')
        ? ['speed', 'next', 'hold', 'ghost']
        : ['speed', 'next', 'colors'];
    return base.concat(['sequence', 'sequenceEdit', 'ojamaAmount', 'ojamaInterval', 'ojamaAuto', 'ojamaSend', 'ojamaClearAmount', 'ojamaClearGo', 'clear']);
}

// ─────────────────────────────────────────
// 開閉（開く＝ポーズ、閉じる＝再開）
// 左サイドの折りたたみドック形式（設計 Phase5 §6）。カード外クリックで閉じる動作は
// 廃止した（オーバーレイが無くなり「カード外＝盤面」になったため。閉じる手段は
// ⚙タブ・Tabキー・Escの3つ）。
// ─────────────────────────────────────────
function togglePracticePanel() {
    const dock = document.getElementById('practice-panel-dock');
    const mgr = window._practiceManager;
    if (!dock || !mgr || !mgr.gameInstance) return;
    // GAME OVER/FINISH演出中・リザルト中はパネルを開閉させない（設計 Phase5 §4.2）。
    // ここを塞がないと g.pause()/resume() が呼ばれ、止めたはずのエンジンが復活する。
    if (mgr.isEnding || mgr.isFinished) return;
    const opening = !dock.classList.contains('is-open');
    dock.classList.toggle('is-open', opening);
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

    _practicePanelRefresh();
}

function _closePracticePanel() {
    const dock = document.getElementById('practice-panel-dock');
    if (dock) { dock.classList.remove('is-visible'); dock.classList.remove('is-open'); }
    const body = document.getElementById('practice-panel-body');
    if (body) body.innerHTML = '';
    // #practice-status-left は巻き戻しインジケータの静的マークアップ（index.html）を持つため
    // innerHTML は消さず、表示だけ落とす（設計 §2.2）。
    const left = document.getElementById('practice-status-left');
    if (left) left.classList.remove('is-visible');
    const speedArea = document.getElementById('practice-speed-area');
    if (speedArea) speedArea.classList.remove('is-visible');
    _removePracticePanelKeyHandler();
}

// ─────────────────────────────────────────
// 初期化（PracticeManager.attach() の最後で呼ばれる）
// ─────────────────────────────────────────
function _initPracticePanel(manager) {
    const dock = document.getElementById('practice-panel-dock');
    if (!dock) return;
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
    if (typeof manager._syncLevelDisplay === 'function') manager._syncLevelDisplay();

    dock.classList.add('is-visible');
    dock.classList.remove('is-open');
    const left = document.getElementById('practice-status-left');
    if (left) left.classList.add('is-visible');
    // SPEED+COLORSブロックはpuyoのみ（tetはLEVEL枠を流用する。設計 §3.1）
    const speedArea = document.getElementById('practice-speed-area');
    if (speedArea) speedArea.classList.toggle('is-visible', manager.rule === 'puyo');

    _practicePanelFocusIndex = 0;
    _practicePanelRefresh();
    _installPracticePanelKeyHandler();
}

// ─────────────────────────────────────────
// 描画（設定パネルの中身 ＋ 常時表示のミニステータス）
// ─────────────────────────────────────────
function _practicePanelRefresh() {
    const mgr = window._practiceManager;
    const body = document.getElementById('practice-panel-body');
    if (!mgr || !mgr.gameInstance || !body) return;
    const g = mgr.gameInstance;
    const isTet = (mgr.rule === 'tet');
    const dock = document.getElementById('practice-panel-dock');
    const isOpen = !!(dock && dock.classList.contains('is-open'));
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

    // HOLDはFREE/ON/OFFの3択。ボタンの大きさはGHOST等と同じ(.practice-panel-toggleのみ)にする。
    const holdMode = g.practiceHoldMode || 'on';
    const holdRow = `
      <div class="practice-panel-row${focusCls('hold')}">
        <span class="practice-panel-label">HOLD</span>
        <div class="option-toggle practice-panel-toggle">
          <button class="opt-btn ${holdMode === 'free' ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="setPracticeHoldMode('free')">FREE</button>
          <button class="opt-btn ${holdMode === 'on' ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="setPracticeHoldMode('on')">ON</button>
          <button class="opt-btn ${holdMode === 'off' ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="setPracticeHoldMode('off')">OFF</button>
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

    // ─── SEQUENCE（設計 §5.1）：ゲーム中でもON/OFF切替とエディタ編集ができる ───
    const seqEnabled = (typeof PracticeSequence !== 'undefined') && PracticeSequence.isEnabled(mgr.rule);
    html += `
      <div class="practice-panel-row${focusCls('sequence')}">
        <span class="practice-panel-label">SEQUENCE</span>
        <div class="option-toggle practice-panel-toggle">
          <button class="opt-btn ${!seqEnabled ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="practicePanelSetSequenceEnabled(false)">OFF</button>
          <button class="opt-btn ${seqEnabled ? 'active' : ''}" onmousedown="event.preventDefault()" onclick="practicePanelSetSequenceEnabled(true)">ON</button>
        </div>
      </div>`;
    html += `
      <div class="practice-panel-row practice-panel-row-action${focusCls('sequenceEdit')}">
        <button class="practice-panel-send-btn" onmousedown="event.preventDefault()" onclick="practicePanelOpenSequenceEditor()">EDIT SEQUENCE →</button>
      </div>`;

    // ─── おじゃま投下（設計 §6.2e）───
    html += stepRow('ojamaAmount', 'OJAMA AMT', mgr.ojama.amount, 'practiceStepOjamaAmount(-1)', 'practiceStepOjamaAmount(1)');
    html += stepRow('ojamaInterval', 'INTERVAL', mgr.ojama.intervalSec + 's', 'practiceStepOjamaInterval(-1)', 'practiceStepOjamaInterval(1)');
    html += toggleRow('ojamaAuto', 'AUTO', mgr.ojama.auto, 'setPracticeOjamaAuto(true)', 'setPracticeOjamaAuto(false)');
    html += `
      <div class="practice-panel-row practice-panel-row-action${focusCls('ojamaSend')}">
        <button class="practice-panel-send-btn" onmousedown="event.preventDefault()" onclick="practiceOjamaSend()">おじゃま送る</button>
      </div>`;

    // ─── 盤面クリア：おじゃま部分削除（設計 §4.2）───
    html += stepRow('ojamaClearAmount', 'CLEAR OJAMA', mgr.ojamaClearAmount,
        'practiceStepOjamaClearAmount(-1)', 'practiceStepOjamaClearAmount(1)');
    html += `
      <div class="practice-panel-row practice-panel-row-action${focusCls('ojamaClearGo')}">
        <button class="practice-panel-clear-btn" onmousedown="event.preventDefault()" onclick="practiceOjamaClearGo()">DELETE</button>
      </div>`;

    html += `
      <div class="practice-panel-row practice-panel-row-action${focusCls('clear')}">
        <button class="practice-panel-clear-btn" onmousedown="event.preventDefault()" onclick="practiceClearBoard()">盤面クリア</button>
      </div>`;

    body.innerHTML = html;
    _practiceStatusRefresh(mgr, g, isTet);
}

// NEXT/GHOST/HOLD/OJAMAは盤面を見れば分かるためミニステータスから撤去済み（設計 §3.3）。
// 残るpuyoのSPEED/COLORSは #practice-speed-area（tetのLEVEL枠に相当するHUDブロック）へ集約する。
function _practiceStatusRefresh(mgr, g, isTet) {
    if (isTet) return; // tetはLEVEL枠(#level-value)にSPEEDを表示済み（§3.1）
    const valueEl = document.getElementById('practice-speed-value');
    const colorsEl = document.getElementById('practice-speed-colors');
    if (valueEl) valueEl.textContent = _practiceFallLabel(mgr.fallLevel);
    if (colorsEl) colorsEl.textContent = 'COLORS ' + PConfig.colorCount;
}

// ─────────────────────────────────────────
// キーボード操作（パネルの開閉・項目移動・値変更）
// ─────────────────────────────────────────
let _practicePanelFocusIndex = 0;
let _practicePanelKeyHandler = null;

function _practicePanelOpenKeyCodes() {
    const keys = (typeof loadKeys === 'function') ? loadKeys() : null;
    const k = keys && keys.practicePanel;
    return (k && k.codes && k.codes.length) ? k.codes : ['Tab'];
}

// キー方向(-1/+1)を各項目の操作へ変換する。
// ボタンの並びは常に左=ON/右=OFF なので、2値トグルは方向をそのまま on/off に
// 割り当てず「現在値を反転」させる（＝端で止めずに反対側へ回り込む。設計 §6.2）。
function _practicePanelApplyDir(rowKey, dir) {
    const mgr = window._practiceManager;
    const g = mgr && mgr.gameInstance;
    switch (rowKey) {
        case 'speed':         practiceStepFallLevel(dir); break;
        case 'next':          practiceStepNextCount(dir); break;
        case 'hold':          practiceStepHoldMode(dir); break;
        case 'ghost':         if (g) setPracticeGhostEnabled(g.showGhost === false); break;
        case 'colors':        practiceStepColorCount(dir); break;
        case 'ojamaAmount':   practiceStepOjamaAmount(dir); break;
        case 'ojamaInterval': practiceStepOjamaInterval(dir); break;
        case 'ojamaAuto':     if (mgr) setPracticeOjamaAuto(!mgr.ojama.auto); break;
        case 'ojamaClearAmount': practiceStepOjamaClearAmount(dir); break;
        case 'sequence':
            if (mgr && typeof PracticeSequence !== 'undefined') {
                practicePanelSetSequenceEnabled(!PracticeSequence.isEnabled(mgr.rule));
            }
            break;
    }
}

function _practicePanelActivate(rowKey) {
    if (rowKey === 'clear') practiceClearBoard();
    else if (rowKey === 'hold') practiceStepHoldMode(1);
    else if (rowKey === 'ghost') {
        const g = window._practiceManager && window._practiceManager.gameInstance;
        if (g) setPracticeGhostEnabled(g.showGhost === false);
    } else if (rowKey === 'ojamaAuto') {
        const mgr = window._practiceManager;
        if (mgr) setPracticeOjamaAuto(!mgr.ojama.auto);
    } else if (rowKey === 'ojamaSend') {
        practiceOjamaSend();
    } else if (rowKey === 'ojamaClearGo') {
        practiceOjamaClearGo();
    } else if (rowKey === 'sequenceEdit') {
        practicePanelOpenSequenceEditor();
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
        // GAME OVER/FINISH演出中・リザルト中はパネル開閉キー(Tab)ごと無効化する（設計 Phase5 §4.2）
        if (mgr.isEnding || mgr.isFinished) return;

        // SEQUENCEエディタが開いている間は、その専用ハンドラ（capture段）に矢印/Enter/Escを
        // 譲る（ここで奪うとエディタが操作不能になる。設計 §5.1）
        const seqModal = document.getElementById('practice-seq-modal');
        if (seqModal && seqModal.classList.contains('active')) return;

        const dock = document.getElementById('practice-panel-dock');
        const isOpen = !!(dock && dock.classList.contains('is-open'));

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
        mgr._syncLevelDisplay(); // updateStatsDisplay()の次回呼び出しを待たず即時反映（設計 §3.1）
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
// HOLD FREE/ON/OFF（tetのみ）
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
// おじゃま手動/自動投下（設計 §6.2e）
// 実際の投入・タイマー管理は PracticeManager 側（practice.js）に持たせ、
// ここではパネルの表示値のステップ操作だけを行う。
// ─────────────────────────────────────────
function _practiceOjamaAmountMax(mgr) {
    return (mgr.rule === 'puyo') ? 30 : 20;
}

function practiceStepOjamaAmount(delta) {
    const mgr = window._practiceManager;
    if (!mgr) return;
    const max = _practiceOjamaAmountMax(mgr);
    mgr.ojama.amount = Math.max(1, Math.min(max, mgr.ojama.amount + delta));
    _practicePanelRefresh();
}

function practiceStepOjamaInterval(delta) {
    const mgr = window._practiceManager;
    if (!mgr) return;
    mgr.setOjamaIntervalSec(mgr.ojama.intervalSec + delta);
    _practicePanelRefresh();
}

function setPracticeOjamaAuto(on) {
    const mgr = window._practiceManager;
    if (!mgr) return;
    mgr.setOjamaAuto(on);
    _practicePanelRefresh();
}

function practiceOjamaSend() {
    const mgr = window._practiceManager;
    if (!mgr) return;
    mgr.sendOjama(mgr.ojama.amount);
}

// ─────────────────────────────────────────
// 盤面クリア：おじゃま部分削除（設計 §4.2）
// 投下量と同じレンジ（tet 1〜20ライン / puyo 1〜30個）にする。
// ─────────────────────────────────────────
function _practiceOjamaClearMax(mgr) {
    return (mgr.rule === 'puyo') ? 30 : 20;
}

function practiceStepOjamaClearAmount(delta) {
    const mgr = window._practiceManager;
    if (!mgr) return;
    const max = _practiceOjamaClearMax(mgr);
    mgr.ojamaClearAmount = Math.max(1, Math.min(max, (mgr.ojamaClearAmount || 1) + delta));
    _practicePanelRefresh();
}

function practiceOjamaClearGo() {
    const mgr = window._practiceManager;
    if (!mgr) return;
    mgr.clearOjamaPartial(mgr.ojamaClearAmount || 1);
}

// ─────────────────────────────────────────
// ゲーム中の SEQUENCE 編集（設計 §5.1）
// ─────────────────────────────────────────
function practicePanelSetSequenceEnabled(on) {
    const mgr = window._practiceManager;
    if (!mgr || typeof PracticeSequence === 'undefined') return;
    PracticeSequence.setEnabled(mgr.rule, on);
    if (typeof mgr.applySequenceEdit === 'function') mgr.applySequenceEdit();
}

function practicePanelOpenSequenceEditor() {
    const mgr = window._practiceManager;
    if (!mgr || typeof PracticeSequence === 'undefined') return;
    PracticeSequence.openEditor(mgr.rule, () => {
        if (typeof mgr.applySequenceEdit === 'function') mgr.applySequenceEdit();
    });
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
