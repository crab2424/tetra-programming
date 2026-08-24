// ─────────────────────────────────────────────
// settings.js
// キーコンフィグおよびチューニング設定画面の UI ロジック
// ─────────────────────────────────────────────

// ─── デフォルトキー/ボタン割り当て ───────────────────────
// 各アクションにつき最大3枠。枠ごとにキーボード(type:'key')／ゲームパッド(type:'button'|'axis')
// のどちらでも割り当てられる（枠の位置による制限はない）。空き枠は null。
/**
 * @typedef {{type:'key', code:string, label:string} | {type:'button'|'axis', index:number} | null} Bind
 * @type {Object.<string, [Bind, Bind, Bind]>}
 */
const DEFAULT_BINDS = {
  moveLeft: [{ type: 'key', code: 'ArrowLeft', label: '←' }, { type: 'button', index: 14 }, null],
  moveRight: [{ type: 'key', code: 'ArrowRight', label: '→' }, { type: 'button', index: 15 }, null],
  softDrop: [{ type: 'key', code: 'ArrowDown', label: '↓' }, { type: 'button', index: 13 }, null],
  hardDrop: [{ type: 'key', code: 'Space', label: 'SPACE' }, { type: 'button', index: 12 }, null],
  rotateCW: [{ type: 'key', code: 'ArrowUp', label: '↑' }, { type: 'button', index: 0 }, null],
  rotateCCW: [{ type: 'key', code: 'KeyZ', label: 'Z' }, { type: 'button', index: 1 }, null],
  hold: [{ type: 'key', code: 'ShiftLeft', label: 'SHIFT' }, { type: 'button', index: 4 }, { type: 'button', index: 5 }],
  pause: [{ type: 'key', code: 'Escape', label: 'ESC' }, { type: 'button', index: 9 }, null],
  restart: [{ type: 'key', code: 'KeyR', label: 'R' }, { type: 'button', index: 8 }, null],
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

// ─── デフォルト音量設定 ───────────────────────
const DEFAULT_VOLUME = {
  bgm: 0.8,
  se: 0.8,
};

function loadVolume() {
  const saved = localStorage.getItem('game_volume');
  if (saved) {
    try { return { ...DEFAULT_VOLUME, ...JSON.parse(saved) }; }
    catch (e) { localStorage.removeItem('game_volume'); }
  }
  return { ...DEFAULT_VOLUME };
}

let currentVolume = loadVolume();

/**
 * キー/ボタン割り当て (初期化時に読み込まれる。各アクション最大3枠)
 * @type {Object.<string, [Bind, Bind, Bind]>}
 */
let currentBinds = loadBinds();

/**
 * currentBinds から導出する後方互換ビュー。
 * currentKeys[action] = { code, label, codes[] } … codes は割り当て済みキーのcode一覧（0〜3個）
 * currentGamepadConfig[action] = [{type:'button'|'axis', index}, ...] … ボタン/軸の一覧（0〜3個）
 * ゲーム側(input.js等)やメニュー表示側は従来通りこの2つのグローバルを参照する。
 * @type {Object.<string, {code: string, label: string, codes: string[]}>}
 */
let currentKeys = {};
/** @type {Object.<string, Array<{type:string, index:number}>>} */
let currentGamepadConfig = {};
recomputeDerivedBinds();

/**
 * チューニング設定
 * @type {{das: number, arr: number, dcd: number}}
 */
let currentTuning = loadTuning();
// 入力待ち状態（キーボード/ゲームパッド共通の単一セッション。同時に片方だけが待機する）
let listeningBind = null; // { action: string, slot: number }
let _listenKeydownHandler = null;
let _listenGamepadInterval = null;
let _listenPrevButtons = null;
// ゲームパッド設定（デッドゾーン等、割り当てとは別の設定）
let currentGamepadOptions = loadGamepadOptions();

function normalizeBind(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.type === 'key' && typeof b.code === 'string' && b.code) {
    return { type: 'key', code: b.code, label: (typeof b.label === 'string' && b.label) ? b.label : b.code };
  }
  if ((b.type === 'button' || b.type === 'axis') && Number.isFinite(b.index)) {
    return { type: b.type, index: b.index };
  }
  return null;
}

function normalizeBinds(raw) {
  const out = {};
  for (const action in DEFAULT_BINDS) {
    const arr = Array.isArray(raw && raw[action]) ? raw[action] : DEFAULT_BINDS[action];
    out[action] = [0, 1, 2].map(i => normalizeBind(arr[i]));
  }
  return out;
}

// 導出: currentBinds から currentKeys(キーボード用) / currentGamepadConfig(パッド用) を再構築する。
// currentBinds を書き換えた後は必ず呼ぶこと。
function recomputeDerivedBinds() {
  const keys = {};
  const gp = {};
  for (const action in currentBinds) {
    const slots = currentBinds[action];
    const keyBinds = slots.filter(b => b && b.type === 'key');
    const gpBinds = slots.filter(b => b && (b.type === 'button' || b.type === 'axis'));
    const first = keyBinds[0];
    keys[action] = {
      code: first ? first.code : '',
      label: first ? first.label : '',
      codes: keyBinds.map(b => b.code),
    };
    gp[action] = gpBinds.map(b => ({ type: b.type, index: b.index }));
  }
  currentKeys = keys;
  currentGamepadConfig = gp;
}

// 旧形式(game_keyconfig + game_gamepadconfig)からの一度きりの移行。
// game_binds が既にあれば何もしない。
function migrateLegacyBinds() {
  let keyCfg = null, gpCfg = null;
  try {
    const raw = localStorage.getItem('game_keyconfig');
    if (raw) keyCfg = JSON.parse(raw);
  } catch (e) { localStorage.removeItem('game_keyconfig'); }
  try {
    const raw = localStorage.getItem('game_gamepadconfig');
    if (raw) gpCfg = JSON.parse(raw);
  } catch (e) { localStorage.removeItem('game_gamepadconfig'); }
  if (!keyCfg && !gpCfg) return null;

  const out = {};
  for (const action in DEFAULT_BINDS) {
    const kb = keyCfg && keyCfg[action] && typeof keyCfg[action].code === 'string'
      ? { type: 'key', code: keyCfg[action].code, label: keyCfg[action].label || keyCfg[action].code }
      : DEFAULT_BINDS[action][0];
    let gpList = gpCfg ? gpCfg[action] : null;
    if (!Array.isArray(gpList)) gpList = gpList ? [gpList] : [];
    const gp0 = gpList[0] ? normalizeBind(gpList[0]) : null;
    const gp1 = gpList[1] ? normalizeBind(gpList[1]) : null;
    out[action] = [kb, gp0, gp1];
  }
  return out;
}

function loadBinds() {
  const saved = localStorage.getItem('game_binds');
  if (saved) {
    try {
      return normalizeBinds(JSON.parse(saved));
    } catch (e) {
      localStorage.removeItem('game_binds');
    }
  }
  const migrated = migrateLegacyBinds();
  if (migrated) return normalizeBinds(migrated);
  return normalizeBinds(DEFAULT_BINDS);
}

function saveBinds() {
  localStorage.setItem('game_binds', JSON.stringify(currentBinds));
}

// 後方互換: ゲームエンジン側(input.js等)はこの関数でキー設定を取得する。
// currentKeys と等価な内容を常に最新のlocalStorageから読み直して返す。
function loadKeys() {
  const binds = loadBinds();
  const keys = {};
  for (const action in binds) {
    const keyBinds = binds[action].filter(b => b && b.type === 'key');
    const first = keyBinds[0];
    keys[action] = {
      code: first ? first.code : '',
      label: first ? first.label : '',
      codes: keyBinds.map(b => b.code),
    };
  }
  return keys;
}

// 後方互換: ゲームエンジン側はこの関数でパッド割り当てを取得する。
function loadGamepadConfig() {
  const binds = loadBinds();
  const gp = {};
  for (const action in binds) {
    gp[action] = binds[action]
      .filter(b => b && (b.type === 'button' || b.type === 'axis'))
      .map(b => ({ type: b.type, index: b.index }));
  }
  return gp;
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
function formatBindLabel(bind) {
  if (!bind) return '';
  if (bind.type === 'key') return bind.label || bind.code;
  return formatGamepadLabel(bind);
}

function renderKeyConfig() {
  const grid = document.getElementById('key-config-grid');
  grid.innerHTML = '';

  for (const action in ACTION_LABELS) {
    const info = ACTION_LABELS[action];
    const slots = currentBinds[action];

    const badges = [0, 1, 2].map(i => `
        <div class="key-badge bind-badge" id="bind-${action}-${i}" onclick="startListeningBind('${action}', ${i})">
          ${formatBindLabel(slots[i]) || '+'}
        </div>`).join('');

    const row = document.createElement('div');
    row.className = 'key-row';
    row.innerHTML = `
      <div class="key-action-name">
        ${info.name}
        <small>${info.en}</small>
      </div>
      <div class="bind-group">${badges}</div>
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

function renderVolume() {
  document.getElementById('slider-bgm-volume').value = Math.round(currentVolume.bgm * 100);
  document.getElementById('slider-se-volume').value = Math.round(currentVolume.se * 100);
  updateVolumeDisplay();
}

function updateVolumeDisplay() {
  const bgmVal = parseInt(document.getElementById('slider-bgm-volume').value);
  const seVal = parseInt(document.getElementById('slider-se-volume').value);

  document.getElementById('val-bgm-volume').textContent = bgmVal + '%';
  document.getElementById('val-se-volume').textContent = seVal + '%';

  // スライダー操作中にリアルタイムで反映
  currentVolume.bgm = bgmVal / 100;
  currentVolume.se = seVal / 100;
  if (window.BgmManager) window.BgmManager.setVolume(currentVolume.bgm);
  if (window.SeManager) window.SeManager.setVolume(currentVolume.se);
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
  const backendUrlInput = document.getElementById('settings-online-backend');
  if (backendUrlInput) backendUrlInput.value = localStorage.getItem('tetlaboServerUrl') || '';
}

document.getElementById('slider-das').addEventListener('input', updateTuningDisplay);
document.getElementById('slider-arr').addEventListener('input', updateTuningDisplay);
document.getElementById('slider-dcd').addEventListener('input', updateTuningDisplay);
const _deadzoneSlider = document.getElementById('slider-deadzone');
if (_deadzoneSlider) _deadzoneSlider.addEventListener('input', updateGamepadOptionsDisplay);


// ─── 入力待ち（キーボード/ゲームパッド共通の単一セッション） ─────────────────
// 1枠につきキーボードのキー入力とゲームパッドのボタン押下を同時に待ち受け、
// 先に検出できた方をその枠に割り当てる。待機中に別の枠をクリックすると
// 今の待機は解除されてから新しい枠の待機が始まる（同じ枠を再クリックした場合はキャンセルのみ）。
// 待機中に Delete / BackSpace を押すとその枠の割り当てを解除する。
function startListeningBind(action, slot) {
  if (listeningBind && listeningBind.action === action && listeningBind.slot === slot) {
    stopListeningBind();
    return;
  }
  stopListeningBind();
  listeningBind = { action, slot };

  const badge = document.getElementById(`bind-${action}-${slot}`);
  if (badge) { badge.classList.add('listening'); badge.textContent = '入力待ち...'; }

  _listenKeydownHandler = function (e) {
    e.preventDefault();
    if (e.code === 'Delete' || e.code === 'Backspace') {
      setBind(action, slot, null);
      stopListeningBind();
      return;
    }
    setBind(action, slot, { type: 'key', code: e.code, label: getKeyLabel(e) });
    stopListeningBind();
  };
  document.addEventListener('keydown', _listenKeydownHandler);

  _listenPrevButtons = null;
  _listenGamepadInterval = setInterval(() => {
    const pads = (navigator.getGamepads) ? navigator.getGamepads() : [];
    let pad = null;
    for (let i = 0; i < pads.length; i++) { if (pads[i]) { pad = pads[i]; break } }
    if (!pad) return;
    // 初回に prev を初期化
    if (!_listenPrevButtons) { _listenPrevButtons = pad.buttons.map(b => !!(b && b.pressed)); return; }
    for (let i = 0; i < pad.buttons.length; i++) {
      const pressed = !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (pressed && !_listenPrevButtons[i]) {
        setBind(action, slot, { type: 'button', index: i });
        stopListeningBind();
        return;
      }
    }
    _listenPrevButtons = pad.buttons.map(b => !!(b && b.pressed));
  }, 100);
}

function stopListeningBind() {
  if (_listenKeydownHandler) {
    document.removeEventListener('keydown', _listenKeydownHandler);
    _listenKeydownHandler = null;
  }
  if (_listenGamepadInterval) {
    clearInterval(_listenGamepadInterval);
    _listenGamepadInterval = null;
  }
  _listenPrevButtons = null;
  if (listeningBind) {
    const { action, slot } = listeningBind;
    const badge = document.getElementById(`bind-${action}-${slot}`);
    if (badge) {
      badge.classList.remove('listening');
      badge.textContent = formatBindLabel(currentBinds[action][slot]) || '+';
    }
    listeningBind = null;
  }
}

function setBind(action, slot, bind) {
  currentBinds[action][slot] = bind;
  recomputeDerivedBinds();
  renderKeyConfig();
  updateMenuControlsDisplay();
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

// キー同士・ボタン同士の重複を全枠横断でチェックする（枠の位置は問わない）
function checkConflicts() {
  const identity = (b) => b ? (b.type === 'key' ? ('key:' + b.code) : (b.type + ':' + b.index)) : null;

  const count = {};
  for (const action in currentBinds) {
    currentBinds[action].forEach(b => {
      const id = identity(b);
      if (id) count[id] = (count[id] || 0) + 1;
    });
  }

  let hasDup = false;
  for (const action in currentBinds) {
    currentBinds[action].forEach((b, i) => {
      const badge = document.getElementById(`bind-${action}-${i}`);
      if (!badge) return;
      const id = identity(b);
      const isDup = !!id && count[id] > 1;
      if (isDup) hasDup = true;
      badge.style.borderColor = isDup ? 'var(--danger)' : '';
      badge.style.color = isDup ? 'var(--danger)' : '';
    });
  }

  const warnEl = document.getElementById('conflict-warning');
  if (warnEl) warnEl.classList.toggle('show', hasDup);

  return hasDup;
}

function resetToDefaults() {
  currentBinds = normalizeBinds(JSON.parse(JSON.stringify(DEFAULT_BINDS)));
  recomputeDerivedBinds();
  currentTuning = JSON.parse(JSON.stringify(DEFAULT_TUNING));
  currentVolume = JSON.parse(JSON.stringify(DEFAULT_VOLUME));
  currentGamepadOptions = { deadzone: 0.45 };
  localStorage.removeItem('game_gamepad_options');
  localStorage.removeItem('tetlaboServerUrl');
  renderKeyConfig();
  renderTuning();
  renderVolume();
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

  // versus準備画面のコントロールグリッドも更新
  const versusCheckGrid = document.getElementById('versus-check-controls-grid');
  if (versusCheckGrid) {
    versusCheckGrid.innerHTML = `
      <span class="ctrl-key">${currentKeys.moveLeft.label}${currentKeys.moveRight.label} / ${formatGamepadBindings(currentGamepadConfig.moveLeft)} + ${formatGamepadBindings(currentGamepadConfig.moveRight)}</span><span class="ctrl-desc">移動</span>
      <span class="ctrl-key">${currentKeys.rotateCW.label} / ${formatGamepadBindings(currentGamepadConfig.rotateCW)}</span><span class="ctrl-desc">右回転</span>
      <span class="ctrl-key">${currentKeys.rotateCCW.label} / ${formatGamepadBindings(currentGamepadConfig.rotateCCW)}</span><span class="ctrl-desc">左回転</span>
      <span class="ctrl-key">${currentKeys.softDrop.label} / ${formatGamepadBindings(currentGamepadConfig.softDrop)}</span><span class="ctrl-desc">ソフトドロップ</span>
      <span class="ctrl-key">${currentKeys.hardDrop.label} / ${formatGamepadBindings(currentGamepadConfig.hardDrop)}</span><span class="ctrl-desc">ハードドロップ</span>
      <span class="ctrl-key">${currentKeys.hold.label} / ${formatGamepadBindings(currentGamepadConfig.hold)}</span><span class="ctrl-desc">ホールド</span>
      <span class="ctrl-key">${currentKeys.pause.label} / ${formatGamepadBindings(currentGamepadConfig.pause)}</span><span class="ctrl-desc">ポーズ</span>
    `;
  }
}

// 既存の saveSettings 関数を書き換えて、保存時にメニュー表示も更新するようにします
function saveSettings() {
  saveBinds();
  localStorage.setItem('game_tuning', JSON.stringify(currentTuning));
  localStorage.setItem('game_volume', JSON.stringify(currentVolume));
  saveGamepadOptions();
  if (window._game && typeof window._game.setKeyEvent === 'function'
    && currentGameMode && currentGameMode.id !== 'puyo') window._game.setKeyEvent();
  if (window._puyoGame && typeof window._puyoGame._setKeyHandlers === 'function') window._puyoGame._setKeyHandlers();

  /** @type {string} */
  let backendUrl = document.getElementById('settings-online-backend')?.value || '';

  if (backendUrl.includes("/")) {
    backendUrl = backendUrl.replace(/(http|ws)s*:\/\//, '');
    backendUrl = backendUrl.replace(/\/+$/, '');
  }

  document.getElementById('settings-online-backend').value = backendUrl;

  localStorage.setItem('tetlaboServerUrl', backendUrl);

  updateMenuControlsDisplay(); // ★追加：保存時にメインメニューの表示を更新
  showToast();
}

document.addEventListener('DOMContentLoaded', () => {
  // ページ読み込み時の初期描画
  renderKeyConfig();
  renderTuning();
  renderVolume();
  renderGamepadOptions();
  renderOnlineSettings();
  updateMenuControlsDisplay(); // ★追加：初期表示でも実行
});
