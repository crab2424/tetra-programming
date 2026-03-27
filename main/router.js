// ─────────────────────────────────────────────
// router.js
// 画面遷移（ルーティング）ロジック
// フローチャート: title screen → main menu → mode check → game screen
// ─────────────────────────────────────────────

// ─── モード定義 ───────────────────────────────
// PDFフローチャートでは mode1(marathon), mode2 の2つだが、
// 実装では3つのモードを用意する
const GAME_MODES = {
  marathon: {
    id:          'marathon',
    label:       'MARATHON',
    icon:        '∞',
    description: 'ラインを消してスコアを稼げ。レベルが上がるにつれてミノが加速する。',
    descriptionEn: 'Clear lines to rack up score. Speed increases as your level rises.',
    color:       'var(--accent)',
  },
  sprint: {
    id:          'sprint',
    label:       'SPRINT',
    icon:        '⚡',
    description: '40ラインを最速で消せ。タイムを競え。',
    descriptionEn: 'Clear 40 lines as fast as possible. Race against the clock.',
    color:       'var(--accent3)',
  },
  ultra: {
    id:          'ultra',
    label:       'ULTRA',
    icon:        '★',
    description: '2分間でどれだけスコアを稼げるか。制限時間との勝負。',
    descriptionEn: 'Score as many points as possible in 2 minutes.',
    color:       'var(--accent2)',
  },
};

// ─── 現在選択中のモード ───────────────────────
// mode-check-page に渡す共有変数
let currentGameMode = null;

// ★ ここから追加
let marathonSelectedGoal = 150;

function setMarathonGoal(goal) {
  marathonSelectedGoal = goal;
  document.getElementById('opt-goal-150').classList.toggle('active', goal === 150);
  document.getElementById('opt-goal-endless').classList.toggle('active', goal === 'endless');
}

function updateMarathonLevelDisplay() {
  const val = document.getElementById('marathon-level-slider').value;
  document.getElementById('marathon-level-val').textContent = val;
}
// ★ ここまで追加

// ─── 遷移元ページ追跡 ─────────────────────────
// settings から「戻る」ときに使う（settings.js の window._prevPage と共存）
// ※ settings.js の switchPage() はここで上書きされる

// ─────────────────────────────────────────────
// switchPage() — すべての画面遷移をここで管理
// ─────────────────────────────────────────────
function switchPage(pageId) {
  // 直前のページを記憶（settings 画面から「戻る」ために使用）
  const currentActive = document.querySelector('.page.active');
  if (currentActive && currentActive.id !== 'settings-page') {
    window._prevPage = currentActive.id.replace('-page', '');
  }

  // すべてのページを非表示
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // 対象ページを表示
  const target = document.getElementById(pageId + '-page');
  if (target) target.classList.add('active');

  // ヘッダーは settings ページのみ表示
  const header = document.getElementById('header-area');
  if (header) header.style.display = (pageId === 'settings') ? 'flex' : 'none';

  // ─── ページ別の追加処理 ───────────────────
  if (pageId === 'title') {
    // タイトル画面への遷移（特になし）

  } else if (pageId === 'main-menu') {
    // メインメニューへの遷移（特になし）

  } else if (pageId === 'mode-check') {
    // 準備画面：選択中のモード情報を描画
    renderModeCheck();

  } else if (pageId === 'game') {
    // ゲーム画面への遷移時はキー入力待ちを止める
    if (typeof stopListening === 'function') stopListening();

  } else if (pageId === 'settings') {
    // 設定画面への遷移時
    if (typeof stopListening  === 'function') stopListening();
    if (typeof renderKeyConfig === 'function') renderKeyConfig();
    if (typeof renderTuning    === 'function') renderTuning();
  }
}

// ─────────────────────────────────────────────
// goToModeCheck() — モードを選択して準備画面へ
// ─────────────────────────────────────────────
function goToModeCheck(modeId) {
  currentGameMode = GAME_MODES[modeId] || GAME_MODES.marathon;
  switchPage('mode-check');
}

// ─────────────────────────────────────────────
// renderModeCheck() — 準備画面の内容をモードに合わせて更新
// ─────────────────────────────────────────────
function renderModeCheck() {
  const mode = currentGameMode || GAME_MODES.marathon;

  // モードラベル
  const labelEl = document.getElementById('mode-check-label');
  if (labelEl) {
    labelEl.textContent  = mode.label;
    labelEl.style.color  = mode.color;
  }

  // モードアイコン
  const iconEl = document.getElementById('mode-check-icon');
  if (iconEl) {
    iconEl.textContent = mode.icon;
    iconEl.style.color = mode.color;
  }

  // モード説明文
  const descJaEl = document.getElementById('mode-check-desc-ja');
  if (descJaEl) descJaEl.textContent = mode.description;

  const descEnEl = document.getElementById('mode-check-desc-en');
  if (descEnEl) descEnEl.textContent = mode.descriptionEn;

  // ★ ここから追加：Marathon用オプション表示の切り替え
  const optionsEl = document.getElementById('mode-check-options');
  if (optionsEl) {
    if (mode.id === 'marathon') {
      optionsEl.style.display = 'flex';
      // モードに合わせて文字・枠線の色を変更
      const levelVal = document.getElementById('marathon-level-val');
      if (levelVal) levelVal.style.color = mode.color;
      document.querySelectorAll('.opt-btn.active').forEach(btn => {
          btn.style.color = mode.color;
          btn.style.borderColor = mode.color;
      });
    } else {
      optionsEl.style.display = 'none';
    }
  }

  // STARTボタンのアクセントカラーを動的に変える（CSS変数は上書きできないためインラインで）
  const startBtn = document.getElementById('mode-check-start-btn');
  if (startBtn) {
    // グラデーションの開始色だけモードカラーに合わせる
    if (mode.id === 'sprint') {
      startBtn.style.background = 'linear-gradient(135deg, var(--accent3) 0%, var(--accent) 100%)';
    } else if (mode.id === 'ultra') {
      startBtn.style.background = 'linear-gradient(135deg, var(--accent2) 0%, var(--accent) 100%)';
    } else {
      // marathon（デフォルト）
      startBtn.style.background = 'linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%)';
    }
  }
}

// ─────────────────────────────────────────────
// startGameFromModeCheck() — 準備画面のSTARTボタン押下
// モードを game.js に伝えてゲームを開始する
// ─────────────────────────────────────────────
function startGameFromModeCheck() {
  if (!window._game) return;

  const modeId = currentGameMode ? currentGameMode.id : 'marathon';
  window._game.currentMode = modeId;

  // ★ 追加：Marathon時の設定を game.js に渡す
  if (modeId === 'marathon') {
    window._game.marathonGoal = (marathonSelectedGoal === 'endless') ? Infinity : 150;
    const levelSlider = document.getElementById('marathon-level-slider');
    window._game.marathonStartLevel = levelSlider ? parseInt(levelSlider.value, 10) : 1;
  }

  switchPage('game');
  window._game.start();
}

// ─────────────────────────────────────────────
// タイトル画面の「ANY KEY / CLICK」でメインメニューへ
// ─────────────────────────────────────────────
// ★ bodyの末尾でscriptが読み込まれるためDOMは構築済み。
//   DOMContentLoaded を使わず直接登録する。
(function setupTitleScreen() {
  const titlePage = document.getElementById('title-page');
  if (!titlePage) return;

  // クリック or タップでメインメニューへ
  titlePage.addEventListener('click', function () {
    switchPage('main-menu');
  });

  // キー入力でもメインメニューへ（F1〜F12・特殊キーは除外）
  document.addEventListener('keydown', function onTitleKey(e) {
    if (!document.getElementById('title-page').classList.contains('active')) return;
    // 特殊キーは無視
    if (['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
        'Tab','CapsLock','ScrollLock','NumLock','PrintScreen','Pause'].includes(e.key)) return;
    switchPage('main-menu');
  });
})();