// ─────────────────────────────────────────────
// settings.js
// キーコンフィグおよびチューニング設定画面の UI ロジック
// ─────────────────────────────────────────────

// ─── デフォルトキー設定 ───────────────────────
const DEFAULT_KEYS = {
  moveLeft:  { code: 'ArrowLeft',  label: '←'     },
  moveRight: { code: 'ArrowRight', label: '→'     },
  softDrop:  { code: 'ArrowDown',  label: '↓'     },
  hardDrop:  { code: 'Space',      label: 'SPACE' },
  rotateCW:  { code: 'ArrowUp',    label: '↑'     },
  rotateCCW: { code: 'KeyZ',       label: 'Z'     },
  hold:      { code: 'ShiftLeft',  label: 'SHIFT' },
  pause:     { code: 'Escape',     label: 'ESC'   },
  restart:   { code: 'KeyR',       label: 'R'     }, 
};

const ACTION_LABELS = {
  moveLeft:  { name: '左移動',       en: 'Move Left'   },
  moveRight: { name: '右移動',       en: 'Move Right'  },
  softDrop:  { name: 'ソフトドロップ', en: 'Soft Drop'   },
  hardDrop:  { name: 'ハードドロップ', en: 'Hard Drop'   },
  rotateCW:  { name: '右回転',       en: 'Rotate CW'   },
  rotateCCW: { name: '左回転',       en: 'Rotate CCW'  },
  hold:      { name: 'ホールド',     en: 'Hold'        },
  pause:     { name: 'ポーズ',       en: 'Pause'       },
  restart:   { name: 'リスタート',   en: 'Restart'     }, 
};

const DEFAULT_TUNING = {
  das: 9.0,
  arr: 1.1,
  dcd: 3.0
};

let currentKeys     = loadKeys();
let currentTuning   = loadTuning();
let listeningAction = null;
let _onKeyDown      = null;

function loadKeys() {
  try {
    const saved = localStorage.getItem('game_keyconfig');
    if (saved) return { ...DEFAULT_KEYS, ...JSON.parse(saved) };
  } catch (e) { }
  return JSON.parse(JSON.stringify(DEFAULT_KEYS));
}

function loadTuning() {
  try {
    const saved = localStorage.getItem('game_tuning');
    if (saved) return { ...DEFAULT_TUNING, ...JSON.parse(saved) };
  } catch(e) { }
  return JSON.parse(JSON.stringify(DEFAULT_TUNING));
}

// ─── 画面切り替え（SPA仕様） ───────────────────────────
function switchPage(pageId) {
  // 直前のページを記憶（設定画面から戻るため）
  const currentActive = document.querySelector('.page.active');
  if (currentActive && currentActive.id !== 'settings-page') {
    window._prevPage = currentActive.id.replace('-page', '');
  }

  // すべてのページを非表示
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // 対象のページを表示
  const target = document.getElementById(pageId + '-page');
  if (target) target.classList.add('active');

  // ヘッダーは settings ページのみ表示
  const header = document.getElementById('header-area');
  if (header) header.style.display = (pageId === 'settings') ? 'flex' : 'none';

  // 表示時に必要な処理を実行
  if (pageId === 'game') {
    stopListening();
  } else if (pageId === 'settings') {
    stopListening();
    renderKeyConfig();
    renderTuning();
  }
}

// ─── 設定画面の描画 (キー) ────────────────────
function renderKeyConfig() {
  const grid = document.getElementById('key-config-grid');
  grid.innerHTML = '';

  for (const action in ACTION_LABELS) {
    const info    = ACTION_LABELS[action];
    const keyInfo = currentKeys[action];

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

document.getElementById('slider-das').addEventListener('input', updateTuningDisplay);
document.getElementById('slider-arr').addEventListener('input', updateTuningDisplay);
document.getElementById('slider-dcd').addEventListener('input', updateTuningDisplay);


// ─── キー入力待ち ─────────────────────────
function startListening(action) {
  stopListening();
  listeningAction = action;

  const badge = document.getElementById('badge-' + action);
  badge.classList.add('listening');
  badge.textContent = '...';

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
    'Space':        'SPACE',
    'ArrowLeft':    '←',
    'ArrowRight':   '→',
    'ArrowUp':      '↑',
    'ArrowDown':    '↓',
    'ShiftLeft':    'L-SHIFT',
    'ShiftRight':   'R-SHIFT',
    'ControlLeft':  'L-CTRL',
    'ControlRight': 'R-CTRL',
    'AltLeft':      'L-ALT',
    'AltRight':     'R-ALT',
    'Enter':        'ENTER',
    'Backspace':    'BS',
    'Tab':          'TAB',
    'Escape':       'ESC',
  };
  if (specialMap[e.code])  return specialMap[e.code];
  if (e.key.length === 1)  return e.key.toUpperCase();
  return e.code.replace('Key', '').replace('Digit', '');
}

function checkConflicts() {
  const codes  = Object.values(currentKeys).map(k => k.code);
  const hasDup = codes.length !== new Set(codes).size;

  document.getElementById('conflict-warning').classList.toggle('show', hasDup);

  const count = {};
  codes.forEach(c => { count[c] = (count[c] || 0) + 1; });

  for (const action in currentKeys) {
    const badge = document.getElementById('badge-' + action);
    if (!badge) continue;
    const isDup = count[currentKeys[action].code] > 1;
    badge.style.borderColor = isDup ? 'var(--danger)' : '';
    badge.style.color       = isDup ? 'var(--danger)' : '';
  }

  return hasDup;
}

function resetToDefaults() {
  currentKeys   = JSON.parse(JSON.stringify(DEFAULT_KEYS));
  currentTuning = JSON.parse(JSON.stringify(DEFAULT_TUNING));
  renderKeyConfig();
  renderTuning();
}

function showToast() {
  const toast = document.getElementById('settings-toast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// メインメニューのコントロール表示を更新する関数
function updateMenuControlsDisplay() {
  const grid = document.getElementById('menu-controls-grid');
  if (!grid) return;

  grid.innerHTML = `
    <span class="ctrl-key">${currentKeys.moveLeft.label}${currentKeys.moveRight.label}</span><span class="ctrl-desc">移動</span>
    <span class="ctrl-key">${currentKeys.rotateCW.label}</span><span class="ctrl-desc">右回転</span>
    <span class="ctrl-key">${currentKeys.rotateCCW.label}</span><span class="ctrl-desc">左回転</span>
    <span class="ctrl-key">${currentKeys.softDrop.label}</span><span class="ctrl-desc">ソフトドロップ</span>
    <span class="ctrl-key">${currentKeys.hardDrop.label}</span><span class="ctrl-desc">ハードドロップ</span>
    <span class="ctrl-key">${currentKeys.hold.label}</span><span class="ctrl-desc">ホールド</span>
    <span class="ctrl-key">${currentKeys.pause.label}</span><span class="ctrl-desc">ポーズ</span>
    <span class="ctrl-key">${currentKeys.restart.label}</span><span class="ctrl-desc">リスタート</span>
  `;
}

// 既存の saveSettings 関数を書き換えて、保存時にメニュー表示も更新するようにします
function saveSettings() {
  localStorage.setItem('game_keyconfig', JSON.stringify(currentKeys));
  localStorage.setItem('game_tuning', JSON.stringify(currentTuning));
  if (window._game) window._game.setKeyEvent();
  
  updateMenuControlsDisplay(); // ★追加：保存時にメインメニューの表示を更新
  showToast();
}

// ページ読み込み時の初期描画
renderKeyConfig();
renderTuning();
updateMenuControlsDisplay(); // ★追加：初期表示でも実行