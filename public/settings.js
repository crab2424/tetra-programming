// ─────────────────────────────────────────────
// settings.js
// キーコンフィグおよびチューニング設定画面の UI ロジック
// ─────────────────────────────────────────────

// ─── デフォルトキー設定 ───────────────────────
/**
 * キーコードと表示ラベルのマッピング (またはデフォルト設定)
 * @type {Object.<string, {code: string, label: string}>}
 */
const DEFAULT_KEYS = {
  moveLeft: { code: 'ArrowLeft', label: '←' },
  moveRight: { code: 'ArrowRight', label: '→' },
  softDrop: { code: 'ArrowDown', label: '↓' },
  hardDrop: { code: 'Space', label: 'SPACE' },
  rotateCW: { code: 'ArrowUp', label: '↑' },
  rotateCCW: { code: 'KeyZ', label: 'Z' },
  hold: { code: 'ShiftLeft', label: 'SHIFT' },
  pause: { code: 'Escape', label: 'ESC' },
  restart: { code: 'KeyR', label: 'R' },
};

const ACTION_LABELS = {
  moveLeft: { name: '左移動', en: 'Move Left' },
  moveRight: { name: '右移動', en: 'Move Right' },
  rotateCCW: { name: '左回転', en: 'Rotate CCW' },
  rotateCW: { name: '右回転', en: 'Rotate CW' },
  softDrop: { name: 'ソフトドロップ', en: 'Soft Drop' },
  hardDrop: { name: 'ハードドロップ', en: 'Hard Drop' },
  hold: { name: 'ホールド', en: 'Hold' },
  pause: { name: 'ポーズ', en: 'Pause' },
  restart: { name: 'リスタート', en: 'Restart' },
};

/**
 * デフォルトチューニング設定
 * @type {{das: number, arr: number, dcd: number}}
 */
const DEFAULT_TUNING = {
  das: 9.0,
  arr: 1.6,
  dcd: 3.0
};

/**
 * キー設定 (初期化時に読み込まれる)
 * @type {Object.<string, {code: string, label: string}>}
 */
let currentKeys = loadKeys();

/**
 * チューニング設定
 * @type {{das: number, arr: number, dcd: number}}
 */
let currentTuning = loadTuning();
let listeningAction = null;
let _onKeyDown = null;
// ゲームパッド設定
let currentGamepadConfig = loadGamepadConfig();
let currentGamepadOptions = loadGamepadOptions();
let listeningGamepad = null; // { action: string, slot: number }
let _gpListenInterval = null;

function loadKeys() {
  const saved = localStorage.getItem('game_keyconfig');
  if (saved) {
    try {
      return { ...DEFAULT_KEYS, ...JSON.parse(saved) };
    } catch (e) {
      // JSON-parseエラーしか起きないので、エラーが起きたら保存データをリセットする
      localStorage.removeItem('game_keyconfig');
    }
  }
  return JSON.parse(JSON.stringify(DEFAULT_KEYS));
}

function loadTuning() {
  const saved = localStorage.getItem('game_tuning');
  if (saved) {
    try {
      return { ...DEFAULT_TUNING, ...JSON.parse(saved) };
    } catch (e) {
      localStorage.removeItem('game_tuning');
    }
  }
  return JSON.parse(JSON.stringify(DEFAULT_TUNING));
}

function loadGamepadConfig() {
  const DEFAULT_GAMEPAD = {
    moveLeft: [{ type: 'button', index: 14 }],
    moveRight: [{ type: 'button', index: 15 }],
    softDrop: [{ type: 'button', index: 13 }],
    hardDrop: [{ type: 'button', index: 12 }],
    rotateCW: [{ type: 'button', index: 0 }],
    rotateCCW: [{ type: 'button', index: 1 }],
    hold: [{ type: 'button', index: 4 }, { type: 'button', index: 5 }],
    pause: [{ type: 'button', index: 9 }],
    restart: [{ type: 'button', index: 8 }],
  };

  const normalize = (raw) => {
    const out = {};
    for (const action in DEFAULT_GAMEPAD) {
      const v = raw && raw[action];
      if (Array.isArray(v)) {
        out[action] = v.slice(0, 2);
      } else if (v && typeof v === 'object') {
        out[action] = [v];
      } else {
        out[action] = DEFAULT_GAMEPAD[action];
      }
    }
    return out;
  };

  const saved = localStorage.getItem('game_gamepadconfig');
  if (saved) {
    try {
      return normalize({ ...DEFAULT_GAMEPAD, ...JSON.parse(saved) });
    } catch (e) {
      localStorage.removeItem('game_gamepadconfig');
    }
  }
  return normalize(DEFAULT_GAMEPAD);
}

function saveGamepadConfig() {
  localStorage.setItem('game_gamepadconfig', JSON.stringify(currentGamepadConfig));
}

function loadGamepadOptions() {
  const DEFAULT_GAMEPAD_OPTIONS = {
    deadzone: 0.45,
  };
  const saved = localStorage.getItem('game_gamepad_options');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      const deadzone = Number(parsed.deadzone);
      return {
        deadzone: Number.isFinite(deadzone) ? Math.min(0.95, Math.max(0.05, deadzone)) : DEFAULT_GAMEPAD_OPTIONS.deadzone,
      };
    } catch (e) {
      localStorage.removeItem('game_gamepad_options');
    }
  }
  return { ...DEFAULT_GAMEPAD_OPTIONS };
}

function saveGamepadOptions() {
  localStorage.setItem('game_gamepad_options', JSON.stringify(currentGamepadOptions));
}

function formatGamepadLabel(mapping) {
  if (!mapping) return '';
  // D-Pad indices to friendly names
  if (mapping.type === 'button') {
    if (mapping.index === 14) return 'DPad←';
    if (mapping.index === 15) return 'DPad→';
    if (mapping.index === 12) return 'DPad↑';
    if (mapping.index === 13) return 'DPad↓';

    // Try to show vendor-friendly alias (A/B/X/Y, Cross/Circle/□/△, etc.)
    const vendor = detectConnectedGamepadVendor();
    const alias = getGamepadAlias(mapping.index, vendor);
    if (alias) return `${alias} (Btn${mapping.index})`;
    return 'Btn' + mapping.index;
  }
  if (mapping.type === 'axis') return 'Axis' + mapping.index;
  return '';
}

function formatGamepadBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) return '-';
  return bindings.map(formatGamepadLabel).join(' / ');
}

function detectConnectedGamepadVendor() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected && p.id) {
      const id = p.id.toLowerCase();
      if (id.indexOf('playstation') !== -1 || id.indexOf('sony') !== -1) return 'playstation';
      if (id.indexOf('xbox') !== -1 || id.indexOf('x-input') !== -1) return 'xbox';
      if (id.indexOf('nintendo') !== -1 || id.indexOf('switch') !== -1) return 'nintendo';
      return 'generic';
    }
  }
  return null;
}

function getGamepadAlias(index, vendor) {
  const generic = ['A', 'B', 'X', 'Y']; // indices 0..3
  const xbox = ['A', 'B', 'X', 'Y'];
  const ps = ['Cross', 'Circle', 'Square', 'Triangle']; // PS style
  const nintendo = ['B', 'A', 'Y', 'X'];

  const map = (vendor === 'playstation') ? ps : (vendor === 'nintendo') ? nintendo : xbox;
  if (index >= 0 && index < map.length) return map[index];
  return null;
}

// ─── 画面切り替え（SPA仕様） ───────────────────────────
// ★ 注意：この関数は router.js の switchPage() に統合されました。
//　 router.js が settings.js より後に読み込まれるため、
// 　 router.js の定義がこちらを上書きします。
// 　 後方互換のためここにコメントとして残しておきます。
//
// function switchPage(pageId) {
//   const currentActive = document.querySelector('.page.active');
//   if (currentActive && currentActive.id !== 'settings-page') {
//     window._prevPage = currentActive.id.replace('-page', '');
//   }
//   document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
//   const target = document.getElementById(pageId + '-page');
//   if (target) target.classList.add('active');

// ─── 設定画面の描画 (キー) ────────────────────
function renderKeyConfig() {
  const grid = document.getElementById('key-config-grid');
  grid.innerHTML = '';

  for (const action in ACTION_LABELS) {
    const info = ACTION_LABELS[action];
    const keyInfo = currentKeys[action];

    const gpBinds = Array.isArray(currentGamepadConfig[action])
      ? currentGamepadConfig[action]
      : (currentGamepadConfig[action] ? [currentGamepadConfig[action]] : []);
    const gp0 = gpBinds[0] || null;
    const gp1 = gpBinds[1] || null;

    const row = document.createElement('div');
    row.className = 'key-row';
    row.innerHTML = `
      <div class="key-action-name">
        ${info.name}
        <small>${info.en}</small>
      </div>
      <div class="key-badge" id="badge-${action}" onclick="startListening('${action}')">
        ${keyInfo.label}
      </div>
      <div class="gp-bind-group">
        <div class="key-badge gp-badge" id="gpb-${action}-0" onclick="startListeningGamepad('${action}', 0)">
          ${formatGamepadLabel(gp0) || '未設定'}
        </div>
        <div class="key-badge gp-badge" id="gpb-${action}-1" onclick="startListeningGamepad('${action}', 1)">
          ${formatGamepadLabel(gp1) || '+'}
        </div>
      </div>
    `;
    grid.appendChild(row);
  }
  checkConflicts();
}

// ─── 設定画面の描画 (チューニング) ────────────
function renderTuning() {
  document.getElementById('slider-das').value = currentTuning.das;
  document.getElementById('slider-arr').value = currentTuning.arr;
  document.getElementById('slider-dcd').value = currentTuning.dcd;
  updateTuningDisplay();
}

function updateTuningDisplay() {
  const frameMs = 1000 / 60;
  const dasF = parseFloat(document.getElementById('slider-das').value);
  const arrF = parseFloat(document.getElementById('slider-arr').value);
  const dcdF = parseFloat(document.getElementById('slider-dcd').value);

  document.getElementById('val-das').textContent = `${dasF.toFixed(1)}f (${Math.round(dasF * frameMs)}ms)`;
  document.getElementById('val-arr').textContent = `${arrF.toFixed(1)}f (${Math.round(arrF * frameMs)}ms)`;
  document.getElementById('val-dcd').textContent = `${dcdF.toFixed(1)}f (${Math.round(dcdF * frameMs)}ms)`;

  currentTuning.das = dasF;
  currentTuning.arr = arrF;
  currentTuning.dcd = dcdF;
}

function renderGamepadOptions() {
  const slider = document.getElementById('slider-deadzone');
  const label = document.getElementById('val-deadzone');
  if (!slider || !label) return;

  slider.value = String(currentGamepadOptions.deadzone);
  const pct = Math.round(currentGamepadOptions.deadzone * 100);
  label.textContent = `${currentGamepadOptions.deadzone.toFixed(2)} (${pct}%)`;
}

function updateGamepadOptionsDisplay() {
  const slider = document.getElementById('slider-deadzone');
  const label = document.getElementById('val-deadzone');
  if (!slider || !label) return;

  const v = parseFloat(slider.value);
  currentGamepadOptions.deadzone = Number.isFinite(v) ? Math.min(0.95, Math.max(0.05, v)) : 0.45;
  const pct = Math.round(currentGamepadOptions.deadzone * 100);
  label.textContent = `${currentGamepadOptions.deadzone.toFixed(2)} (${pct}%)`;
}

function renderOnlineSettings() {
  const signalUrlInput = document.getElementById('settings-online-signalurl');
  if (signalUrlInput) signalUrlInput.value = localStorage.getItem('tetlaboServerUrl') || '';
}

document.getElementById('slider-das').addEventListener('input', updateTuningDisplay);
document.getElementById('slider-arr').addEventListener('input', updateTuningDisplay);
document.getElementById('slider-dcd').addEventListener('input', updateTuningDisplay);
const _deadzoneSlider = document.getElementById('slider-deadzone');
if (_deadzoneSlider) _deadzoneSlider.addEventListener('input', updateGamepadOptionsDisplay);


// ─── キー入力待ち ─────────────────────────
function startListening(action) {
  // 同じボタンをもう一度押すとキャンセル
  if (listeningAction === action) {
    stopListening();
    return;
  }
  stopListening();
  listeningAction = action;

  const badge = document.getElementById('badge-' + action);
  if (badge) { badge.classList.add('listening'); badge.textContent = 'キーを入力...'; }

  _onKeyDown = function (e) {
    e.preventDefault();
    currentKeys[action] = { code: e.code, label: getKeyLabel(e) };
    stopListening();
    renderKeyConfig();
  };
  document.addEventListener('keydown', _onKeyDown);
}

function stopListening() {
  if (_onKeyDown) {
    document.removeEventListener('keydown', _onKeyDown);
    _onKeyDown = null;
  }
  if (listeningAction) {
    const badge = document.getElementById('badge-' + listeningAction);
    if (badge) badge.classList.remove('listening');
    listeningAction = null;
  }
}

function getKeyLabel(e) {
  const specialMap = {
    'Space': 'SPACE',
    'ArrowLeft': '←',
    'ArrowRight': '→',
    'ArrowUp': '↑',
    'ArrowDown': '↓',
    'ShiftLeft': 'L-SHIFT',
    'ShiftRight': 'R-SHIFT',
    'ControlLeft': 'L-CTRL',
    'ControlRight': 'R-CTRL',
    'AltLeft': 'L-ALT',
    'AltRight': 'R-ALT',
    'Enter': 'ENTER',
    'Backspace': 'BS',
    'Tab': 'TAB',
    'Escape': 'ESC',
  };
  if (specialMap[e.code]) return specialMap[e.code];
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.code.replace('Key', '').replace('Digit', '');
}

function checkConflicts() {
  const codes = Object.values(currentKeys).map(k => k.code);
  const hasDup = codes.length !== new Set(codes).size;

  document.getElementById('conflict-warning').classList.toggle('show', hasDup);

  const count = {};
  codes.forEach(c => { count[c] = (count[c] || 0) + 1; });

  for (const action in currentKeys) {
    const badge = document.getElementById('badge-' + action);
    if (!badge) continue;
    const isDup = count[currentKeys[action].code] > 1;
    badge.style.borderColor = isDup ? 'var(--danger)' : '';
    badge.style.color = isDup ? 'var(--danger)' : '';
  }

  return hasDup;
}

function resetToDefaults() {
  currentKeys = JSON.parse(JSON.stringify(DEFAULT_KEYS));
  currentTuning = JSON.parse(JSON.stringify(DEFAULT_TUNING));
  localStorage.removeItem('game_gamepadconfig');
  localStorage.removeItem('game_gamepad_options');
  currentGamepadConfig = loadGamepadConfig();
  currentGamepadOptions = loadGamepadOptions();
  localStorage.removeItem('tetlaboServerUrl');
  renderKeyConfig();
  renderTuning();
  renderGamepadOptions();
  renderOnlineSettings();
  updateMenuControlsDisplay();
}

function showToast() {
  const toast = document.getElementById('settings-toast');
  if (!toast) return;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ゲームパッド向けのキー受け取り
function startListeningGamepad(action, slot = 0) {
  // 同じボタンをもう一度押すとキャンセル
  if (listeningGamepad && listeningGamepad.action === action && listeningGamepad.slot === slot) {
    stopListeningGamepad();
    return;
  }
  stopListeningGamepad();
  listeningGamepad = { action, slot };

  const badge = document.getElementById(`gpb-${action}-${slot}`);
  if (badge) { badge.classList.add('listening'); badge.textContent = 'ボタンを入力...'; }

  // 前状態を取り、ポーリングで押下を検出する
  let prev = [];
  _gpListenInterval = setInterval(() => {
    const pads = (navigator.getGamepads) ? navigator.getGamepads() : [];
    let pad = null;
    for (let i = 0; i < pads.length; i++) { if (pads[i]) { pad = pads[i]; break } }
    if (!pad) return;
    // 初回に prev を初期化
    if (prev.length === 0) { prev = pad.buttons.map(b => !!(b && b.pressed)); return; }
    for (let i = 0; i < pad.buttons.length; i++) {
      const pressed = !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (pressed && !prev[i]) {
        // 新規押下を検出 -> 保存
        const arr = Array.isArray(currentGamepadConfig[action])
          ? currentGamepadConfig[action].slice(0, 2)
          : (currentGamepadConfig[action] ? [currentGamepadConfig[action]] : []);
        arr[slot] = { type: 'button', index: i };
        currentGamepadConfig[action] = arr.filter(Boolean).slice(0, 2);
        saveGamepadConfig();
        stopListeningGamepad();
        renderKeyConfig();
        updateMenuControlsDisplay();
        return;
      }
    }
    prev = pad.buttons.map(b => !!(b && b.pressed));
  }, 100);
}

function stopListeningGamepad() {
  if (_gpListenInterval) { clearInterval(_gpListenInterval); _gpListenInterval = null; }
  if (listeningGamepad) {
    const { action, slot } = listeningGamepad;
    const badge = document.getElementById(`gpb-${action}-${slot}`);
    const arr = Array.isArray(currentGamepadConfig[action])
      ? currentGamepadConfig[action]
      : (currentGamepadConfig[action] ? [currentGamepadConfig[action]] : []);
    const mapping = arr[slot] || null;
    if (badge) {
      badge.classList.remove('listening');
      badge.textContent = formatGamepadLabel(mapping) || (slot === 0 ? '未設定' : '+');
    }
    listeningGamepad = null;
  }
}

// メインメニューのコントロール表示を更新する関数
function updateMenuControlsDisplay() {
  // ─── 旧メインメニュー（後方互換） ───
  const grid = document.getElementById('menu-controls-grid');
  if (grid) {
    grid.innerHTML = `
      <span class="ctrl-key">${currentKeys.moveLeft.label}${currentKeys.moveRight.label} / ${formatGamepadBindings(currentGamepadConfig.moveLeft)} + ${formatGamepadBindings(currentGamepadConfig.moveRight)}</span><span class="ctrl-desc">移動</span>
      <span class="ctrl-key">${currentKeys.rotateCW.label} / ${formatGamepadBindings(currentGamepadConfig.rotateCW)}</span><span class="ctrl-desc">右回転</span>
      <span class="ctrl-key">${currentKeys.rotateCCW.label} / ${formatGamepadBindings(currentGamepadConfig.rotateCCW)}</span><span class="ctrl-desc">左回転</span>
      <span class="ctrl-key">${currentKeys.softDrop.label} / ${formatGamepadBindings(currentGamepadConfig.softDrop)}</span><span class="ctrl-desc">ソフトドロップ</span>
      <span class="ctrl-key">${currentKeys.hardDrop.label} / ${formatGamepadBindings(currentGamepadConfig.hardDrop)}</span><span class="ctrl-desc">ハードドロップ</span>
      <span class="ctrl-key">${currentKeys.hold.label} / ${formatGamepadBindings(currentGamepadConfig.hold)}</span><span class="ctrl-desc">ホールド</span>
      <span class="ctrl-key">${currentKeys.pause.label} / ${formatGamepadBindings(currentGamepadConfig.pause)}</span><span class="ctrl-desc">ポーズ</span>
      <span class="ctrl-key">${currentKeys.restart.label} / ${formatGamepadBindings(currentGamepadConfig.restart)}</span><span class="ctrl-desc">リスタート</span>
    `;
  }

  // ★ 追加：準備画面のコントロールグリッドも同じ内容で更新
  const modeCheckGrid = document.getElementById('mode-check-controls-grid');
  if (modeCheckGrid) {
    modeCheckGrid.innerHTML = `
      <span class="ctrl-key">${currentKeys.moveLeft.label}${currentKeys.moveRight.label} / ${formatGamepadBindings(currentGamepadConfig.moveLeft)} + ${formatGamepadBindings(currentGamepadConfig.moveRight)}</span><span class="ctrl-desc">移動</span>
      <span class="ctrl-key">${currentKeys.rotateCW.label} / ${formatGamepadBindings(currentGamepadConfig.rotateCW)}</span><span class="ctrl-desc">右回転</span>
      <span class="ctrl-key">${currentKeys.rotateCCW.label} / ${formatGamepadBindings(currentGamepadConfig.rotateCCW)}</span><span class="ctrl-desc">左回転</span>
      <span class="ctrl-key">${currentKeys.softDrop.label} / ${formatGamepadBindings(currentGamepadConfig.softDrop)}</span><span class="ctrl-desc">ソフトドロップ</span>
      <span class="ctrl-key">${currentKeys.hardDrop.label} / ${formatGamepadBindings(currentGamepadConfig.hardDrop)}</span><span class="ctrl-desc">ハードドロップ</span>
      <span class="ctrl-key">${currentKeys.hold.label} / ${formatGamepadBindings(currentGamepadConfig.hold)}</span><span class="ctrl-desc">ホールド</span>
      <span class="ctrl-key">${currentKeys.pause.label} / ${formatGamepadBindings(currentGamepadConfig.pause)}</span><span class="ctrl-desc">ポーズ</span>
      <span class="ctrl-key">${currentKeys.restart.label} / ${formatGamepadBindings(currentGamepadConfig.restart)}</span><span class="ctrl-desc">リスタート</span>
    `;
  }
}

// 既存の saveSettings 関数を書き換えて、保存時にメニュー表示も更新するようにします
function saveSettings() {
  localStorage.setItem('game_keyconfig', JSON.stringify(currentKeys));
  localStorage.setItem('game_tuning', JSON.stringify(currentTuning));
  saveGamepadConfig();
  saveGamepadOptions();
  if (window._game) window._game.setKeyEvent();
  if (window._cpuGame && typeof window._cpuGame.setKeyEvent === 'function') window._cpuGame.setKeyEvent();
  if (window._puyoGame && typeof window._puyoGame._setKeyHandlers === 'function') window._puyoGame._setKeyHandlers();
  if (window._cpuPuyoGame && typeof window._cpuPuyoGame._setKeyHandlers === 'function') window._cpuPuyoGame._setKeyHandlers();

  const signalUrl = document.getElementById('settings-online-signalurl')?.value || '';
  localStorage.setItem('tetlaboServerUrl', signalUrl);

  updateMenuControlsDisplay(); // ★追加：保存時にメインメニューの表示を更新
  showToast();
}

document.addEventListener('DOMContentLoaded', () => {
  // ページ読み込み時の初期描画
  renderKeyConfig();
  renderTuning();
  renderGamepadOptions();
  renderOnlineSettings();
  updateMenuControlsDisplay(); // ★追加：初期表示でも実行
});
