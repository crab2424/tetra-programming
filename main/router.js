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
  test: {
    id:          'test',
    label:       'CPU TEST',
    icon:        '🤖',
    description: 'CPUの動作確認用モードです。人間は操作しません。',
    descriptionEn: 'Test mode for CPU behavior. CPU ONLY.',
    color:       'var(--success)', // 緑色など任意のカラー
  },
};

let testCpuControl = true; // TESTモードのCPU自動操作フラグ（デフォルトON）

function setTestCpuControl(isOn) {
  testCpuControl = isOn;
  renderModeCheck();
}

// ─── 現在選択中のモード ───────────────────────
// mode-check-page に渡す共有変数
let currentGameMode = null;

// ─── VERSUSモード用グローバル変数 ──────────────
// CPU難易度 Lv1〜5（パラメータは将来の実装のために定義）
const CPU_LEVELS = {
  1: { label: 'LV 1', desc: '超ゆっくり。ほぼ止まっている。',      gravityLevel: 1  },
  2: { label: 'LV 2', desc: '少しゆっくり。ちょうど良い練習相手。', gravityLevel: 3  },
  3: { label: 'LV 3', desc: '普通の速さ。そこそこ強い。',           gravityLevel: 6  },
  4: { label: 'LV 4', desc: '速い。かなり手強い。',                 gravityLevel: 10 },
  5: { label: 'LV 5', desc: '最速。ほぼ人間には止められない。',     gravityLevel: 15 },
};
let selectedCpuLevel = 1; // デフォルト難易度

// ─────────────────────────────────────────────
// goToVersusCheck() — 対戦確認画面へ遷移
// ─────────────────────────────────────────────
function goToVersusCheck() {
  switchPage('versus-check');
}

// ─────────────────────────────────────────────
// renderVersusCheck() — 対戦確認画面の描画
// ─────────────────────────────────────────────
function renderVersusCheck() {
  // CPU難易度ボタンを生成
  const toggle = document.getElementById('cpu-level-toggle');
  if (toggle) {
    toggle.innerHTML = '';
    for (let lv = 1; lv <= 5; lv++) {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (lv === selectedCpuLevel ? ' active' : '');
      btn.style.minWidth = '48px';
      btn.textContent = CPU_LEVELS[lv].label;
      btn.onclick = (function(lvCopy) {
        return function() { setCpuLevel(lvCopy); };
      })(lv);
      toggle.appendChild(btn);
    }
  }
  // 説明文を更新
  const descEl = document.getElementById('versus-cpu-desc');
  if (descEl) descEl.textContent = CPU_LEVELS[selectedCpuLevel].desc;

  // コントロール表示をプレイヤーの現在キー設定で更新
  const grid = document.getElementById('versus-check-controls-grid');
  if (grid && typeof currentKeys !== 'undefined') {
    grid.innerHTML = `
      <span class="ctrl-key">${currentKeys.moveLeft.label}${currentKeys.moveRight.label}</span><span class="ctrl-desc">移動</span>
      <span class="ctrl-key">${currentKeys.rotateCW.label}</span><span class="ctrl-desc">右回転</span>
      <span class="ctrl-key">${currentKeys.rotateCCW.label}</span><span class="ctrl-desc">左回転</span>
      <span class="ctrl-key">${currentKeys.softDrop.label}</span><span class="ctrl-desc">ソフトドロップ</span>
      <span class="ctrl-key">${currentKeys.hardDrop.label}</span><span class="ctrl-desc">ハードドロップ</span>
      <span class="ctrl-key">${currentKeys.hold.label}</span><span class="ctrl-desc">ホールド</span>
      <span class="ctrl-key">${currentKeys.pause.label}</span><span class="ctrl-desc">ポーズ</span>
    `;
  }
}

// ─────────────────────────────────────────────
// setCpuLevel() — CPU難易度を変更
// ─────────────────────────────────────────────
function setCpuLevel(lv) {
  selectedCpuLevel = lv;
  // ボタンのactive状態を更新
  const toggle = document.getElementById('cpu-level-toggle');
  if (toggle) {
    toggle.querySelectorAll('.opt-btn').forEach((btn, idx) => {
      btn.classList.toggle('active', idx + 1 === lv);
    });
  }
  // 説明文を更新
  const descEl = document.getElementById('versus-cpu-desc');
  if (descEl) descEl.textContent = CPU_LEVELS[lv].desc;
}

// ─────────────────────────────────────────────
// startVersusGame() — 対戦ゲームを開始
// ─────────────────────────────────────────────
function startVersusGame() {
  if (!window._game) return;

  const cpuConfig = CPU_LEVELS[selectedCpuLevel];
  switchPage('versus');

  const cpuLevelDisp = document.getElementById('versus-cpu-level-display');
  if (cpuLevelDisp) cpuLevelDisp.textContent = 'CPU ' + cpuConfig.label;

  // ─── プレイヤーゲームの初期化 ───
  window._game.currentMode = 'versus';
  window._game.marathonGoal = Infinity;       
  window._game.isVersusMode = true;           
  window._game.canvasPrefix = 'player';       
  window._game.statsPrefix = 'player';        
  window._game._labelsInitialized = false;    
  window._game.initMainCanvas();              
  window._game.initNextCanvas();
  window._game.initHoldCanvas();

  // ─── CPUゲームの初期化 ───
  if (!window._cpuGame) {
    window._cpuGame = new Game('cpu');
  }
  window._cpuGame.currentMode = 'versus';
  window._cpuGame.marathonGoal = Infinity;
  window._cpuGame.isVersusMode = true;
  window._cpuGame.canvasPrefix = 'cpu';       
  window._cpuGame.statsPrefix = 'cpu';
  window._cpuGame.isCpuControlled = true;
  window._cpuGame._labelsInitialized = false;
  window._cpuGame.initMainCanvas();
  window._cpuGame.initNextCanvas();
  window._cpuGame.initHoldCanvas();

  // 前回のポーズ状態リセット
  document.getElementById('pause-overlay')?.classList.remove('active');
  document.getElementById('versus-pause-overlay')?.classList.remove('active');

  // 両ゲームの状態初期化
  window._game._initGameState();
  window._cpuGame._initGameState();

  // DAS先行チャージ等を受け付けるため、カウントダウン前にキーイベントをセット
  window._game.setKeyEvent();

  // レベルを設定
  window._game.level = 2;
  window._cpuGame.level = 2;
  window._game.updateStatsDisplay();
  window._cpuGame.updateStatsDisplay();

  // プレイヤー側カウントダウン
  runCountdown('player-countdown-overlay', 'player-countdown-text', () => {
    window._game._startGameplay();
  }, null);

  // CPU側カウントダウン（同時実行）
  runCountdown('cpu-countdown-overlay', 'cpu-countdown-text', () => {
    window._cpuGame._startGameplay();

    // ★ 追加：START! の瞬間にCPUの思考ループを起動する
    if (!window._cpuController) {
      window._cpuController = new CPU(window._cpuGame);
    }
    window._cpuController.start();

  }, null);

  // 対戦用ポーズキーを設定
  setupVersusPauseKey();
}

// ─────────────────────────────────────────────
// setupVersusPauseKey() — 対戦中のポーズ処理
// ─────────────────────────────────────────────
function setupVersusPauseKey() {
  // 既存のリスナーを一旦削除
  if (window._versusPauseHandler) {
    document.removeEventListener('keydown', window._versusPauseHandler);
  }
  const keys = (typeof loadKeys === 'function') ? loadKeys() : { pause: { code: 'Escape' } };
  window._versusPauseHandler = function(e) {
    // 対戦ページがアクティブな時のみ動作
    const versusPage = document.getElementById('versus-page');
    if (!versusPage || !versusPage.classList.contains('active')) return;
    if (e.code === keys.pause.code) {
      e.preventDefault();
      toggleVersusPause();
    }
  };
  document.addEventListener('keydown', window._versusPauseHandler);
}

// ─────────────────────────────────────────────
// toggleVersusPause() / resumeVersus()
// ─────────────────────────────────────────────
function toggleVersusPause() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (!overlay) return;
  const isPaused = overlay.classList.contains('active');
  if (isPaused) {
    resumeVersus();
  } else {
    // 両方のゲームをポーズ
    if (window._game) window._game.pause();
    if (window._cpuGame) window._cpuGame.pause();
    overlay.classList.add('active');
  }
}

function resumeVersus() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');
  if (window._game) window._game.resume();
  if (window._cpuGame) window._cpuGame.resume();
}

function restartVersus() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');
  startVersusGame();
}

function restartVersusFromResult() {
  startVersusGame();
  switchPage('versus');
}

// ─────────────────────────────────────────────
// versusGameOver() — 対戦終了処理（game.js から呼ばれる）
// loser: 'player' | 'cpu'
// ─────────────────────────────────────────────
function versusGameOver(loser) {
  // 両方のゲームを停止
  if (window._game) {
    clearInterval(window._game.timer);
    window._game.timer = null;
    clearTimeout(window._game.lockTimer);
    window._game.lockTimer = null;
    window._game.isPaused = true;
    if (window._game.isTimerRunning) {
      window._game.elapsedTime += performance.now() - window._game.startTime;
      window._game.isTimerRunning = false;
      cancelAnimationFrame(window._game.timerReqId);
    }
    // キーイベントの無効化
    if (window._game._keyDownHandler) document.removeEventListener('keydown', window._game._keyDownHandler);
    if (window._game._keyUpHandler)   document.removeEventListener('keyup',   window._game._keyUpHandler);
    if (window._game._keyLoop)        clearInterval(window._game._keyLoop);
  }

  if(window._cpuController) window._cpuController.stop();

  if (window._cpuGame) {
    clearInterval(window._cpuGame.timer);
    window._cpuGame.timer = null;
    clearTimeout(window._cpuGame.lockTimer);
    window._cpuGame.lockTimer = null;
    window._cpuGame.isPaused = true;
    if (window._cpuGame.isTimerRunning) {
      window._cpuGame.elapsedTime += performance.now() - window._cpuGame.startTime;
      window._cpuGame.isTimerRunning = false;
      cancelAnimationFrame(window._cpuGame.timerReqId);
    }
  }
  // ポーズオーバーレイを念のため非表示
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');

  // ★ 追加：プレイヤーとCPUそれぞれのフィールドに結果演出を同時表示
  const playerText  = (loser === 'player') ? 'LOSE...' : 'WIN!';
  const cpuText     = (loser === 'cpu')    ? 'LOSE...' : 'WIN!';
  const playerClass = (loser === 'player') ? 'finish-gameover' : 'finish-clear';
  const cpuClass    = (loser === 'cpu')    ? 'finish-gameover' : 'finish-clear';

  // 両側のフィールドに同時に演出を表示（1400ms 後にリザルトへ）
  showFinishOverlay('player-finish-overlay', 'player-finish-text', playerText, playerClass, 1400, null);
  showFinishOverlay('cpu-finish-overlay',    'cpu-finish-text',    cpuText,    cpuClass,    1400, () => {
    // リザルト画面に結果を表示（cpu側のコールバックで1回だけ実行）
    const winner = (loser === 'player') ? 'CPU' : 'YOU';
    const titleEl = document.getElementById('versus-result-title');
    const winnerEl = document.getElementById('versus-result-winner');
    if (titleEl) {
      if (loser === 'player') {
        titleEl.textContent = 'YOU LOSE';
        titleEl.style.color = 'var(--danger)';
        titleEl.style.background = 'none';
        titleEl.style.webkitTextFillColor = 'var(--danger)';
      } else {
        titleEl.textContent = 'YOU WIN!';
        titleEl.style.color = 'var(--success)';
        titleEl.style.background = 'none';
        titleEl.style.webkitTextFillColor = 'var(--success)';
      }
    }
    if (winnerEl) winnerEl.textContent = winner;
    document.getElementById('versus-result-player-score').textContent = window._game ? window._game.score : 0;
    document.getElementById('versus-result-cpu-score').textContent    = window._cpuGame ? window._cpuGame.score : 0;
    document.getElementById('versus-result-player-lines').textContent = window._game ? window._game.lines : 0;
    switchPage('versus-result');
  });
}

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

  } else if (pageId === 'versus-check') {
    // 対戦確認画面への遷移時
    renderVersusCheck();

  } else if (pageId === 'versus') {
    // 対戦ゲーム画面への遷移時
    if (typeof stopListening === 'function') stopListening();
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
    } else if (mode.id === 'test') {
      optionsEl.style.display = 'flex';
      optionsEl.innerHTML = `
        <div class="option-row">
          <span class="option-label">CPU CONTROL</span>
          <div class="option-toggle" id="test-cpu-control-toggle">
            <button class="opt-btn ${testCpuControl ? 'active' : ''}" onclick="setTestCpuControl(true)">ON</button>
            <button class="opt-btn ${!testCpuControl ? 'active' : ''}" onclick="setTestCpuControl(false)">OFF</button>
          </div>
        </div>
        <div class="option-row">
          <span class="option-label">CPU LEVEL</span>
          <div class="option-toggle" id="test-cpu-level-toggle"></div>
        </div>
      `;
      // レベルトグルの生成
      const toggle = document.getElementById('test-cpu-level-toggle');
      for (let lv = 1; lv <= 5; lv++) {
        const btn = document.createElement('button');
        btn.className = 'opt-btn' + (lv === selectedCpuLevel ? ' active' : '');
        btn.textContent = 'LV' + lv;
        btn.onclick = () => {
          selectedCpuLevel = lv;
          renderModeCheck(); 
        };
        toggle.appendChild(btn);
      }
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

  // ★修正：対戦モードからシングルプレイに戻ってきた時のために、バインドを通常に戻す
  window._game.isVersusMode = false;
  window._game.canvasPrefix = null;
  window._game.statsPrefix = null;
  window._game._labelsInitialized = false;
  window._game.initMainCanvas();
  window._game.initNextCanvas();
  window._game.initHoldCanvas();

  // ★修正：前回のポーズ状態が残っている場合に備えて強制リセット
  document.getElementById('pause-overlay')?.classList.remove('active');
  document.getElementById('versus-pause-overlay')?.classList.remove('active');

  // Marathon時の設定を game.js に渡す
  if (modeId === 'marathon') {
    window._game.marathonGoal = (marathonSelectedGoal === 'endless') ? Infinity : 150;
    const levelSlider = document.getElementById('marathon-level-slider');
    window._game.marathonStartLevel = levelSlider ? parseInt(levelSlider.value, 10) : 1;
  }

  // ★ 追加：TESTモードの時だけ評価点エリアを表示する
  const evalArea = document.getElementById('eval-area');
  if (evalArea) {
    evalArea.style.display = (modeId === 'test') ? 'block' : 'none';
  }

  switchPage('game');
  window._game.start();

  // ★ 変更: TESTモードならCPUコントローラーをシングルプレイ側にアタッチ
  if (modeId === 'test') {
    window._game.isCpuControlled = testCpuControl; // ONなら人間操作不可、OFFなら人間操作可能
    if (!window._cpuController) {
      window._cpuController = new CPU(window._game);
    } else {
      window._cpuController.game = window._game;
    }
    window._cpuController.isAutoPlay = testCpuControl; // CPUクラスに自動操作モードかを伝達
    window._cpuController.start();
  }
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