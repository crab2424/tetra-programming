// ─────────────────────────────────────────────
// settings.js
// キーコンフィグ設定画面の UI ロジック
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
};

// アクションの表示名
const ACTION_LABELS = {
  moveLeft:  { name: '左移動',       en: 'Move Left'   },
  moveRight: { name: '右移動',       en: 'Move Right'  },
  softDrop:  { name: 'ソフトドロップ', en: 'Soft Drop'   },
  hardDrop:  { name: 'ハードドロップ', en: 'Hard Drop'   },
  rotateCW:  { name: '右回転',       en: 'Rotate CW'   },
  rotateCCW: { name: '左回転',       en: 'Rotate CCW'  },
  hold:      { name: 'ホールド',     en: 'Hold'        },
};

// ─── 状態 ────────────────────────────────────
let currentKeys     = loadKeys();
let listeningAction = null;
let _onKeyDown      = null;

// ─── localStorage 読み込み ────────────────────
function loadKeys() {
  try {
    const saved = localStorage.getItem('tetris_keyconfig');
    if (saved) return JSON.parse(saved);
  } catch (e) { /* フォールバック */ }
  return JSON.parse(JSON.stringify(DEFAULT_KEYS));
}

// ─── タブ切り替え ─────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tab + '-page').classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.textContent.toLowerCase().includes(tab === 'game' ? 'game' : 'set')) {
      b.classList.add('active');
    }
  });
  stopListening();
  renderKeyConfig();
}

// ─── 設定画面の描画 ───────────────────────────
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

// ─── キー入力待ち開始 ─────────────────────────
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

// ─── キー入力待ち解除 ─────────────────────────
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

// ─── キー名を人間が読める形式に変換 ─────────────
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

// ─── 重複キー検出 ─────────────────────────────
function checkConflicts() {
  const codes  = Object.values(currentKeys).map(k => k.code);
  const hasDup = codes.length !== new Set(codes).size;

  document.getElementById('conflict-warning').classList.toggle('show', hasDup);

  // 重複しているバッジを赤くハイライト
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

// ─── 設定を保存 ───────────────────────────────
function saveSettings() {
  localStorage.setItem('tetris_keyconfig', JSON.stringify(currentKeys));
  // ゲームが起動中なら即座にキーバインドを更新
  if (window._game) window._game.setKeyEvent();
  showToast();
}

// ─── デフォルトに戻す ─────────────────────────
function resetToDefaults() {
  currentKeys = JSON.parse(JSON.stringify(DEFAULT_KEYS));
  renderKeyConfig();
}

// ─── トースト通知 ─────────────────────────────
function showToast() {
  const toast = document.getElementById('settings-toast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ─── 初期描画 ─────────────────────────────────
renderKeyConfig();
