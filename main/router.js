// ─────────────────────────────────────────────
// router.js
// 画面遷移（ルーティング）ロジック
// フローチャート: title screen → main menu → mode check → game screen
// ─────────────────────────────────────────────

// ─── モード定義 ───────────────────────────────
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
    color:       'var(--success)',
  },
};

let testCpuControl = true; 

function setTestCpuControl(isOn) {
  testCpuControl = isOn;
  renderModeCheck();
}

let currentGameMode = null;

// ─── VERSUSモード用グローバル変数 ──────────────
const CPU_LEVELS = {
  1: { label: 'LV 1', desc: '超ゆっくり。ほぼ止まっている。',      gravityLevel: 1  },
  2: { label: 'LV 2', desc: '少しゆっくり。ちょうど良い練習相手。', gravityLevel: 2  },
  3: { label: 'LV 3', desc: '普通の速さ。そこそこ強い。',           gravityLevel: 2  },
  4: { label: 'LV 4', desc: '速い。かなり手強い。',                 gravityLevel: 2 },
  5: { label: 'LV 5', desc: '最速。ほぼ人間には止められない。',     gravityLevel: 2 },
};
let selectedCpuLevel = 3; 

// ★修正：レベル1は元の cpu.js（JSのみ版）を読み込むように設定を修正しました
//★修正：各レベルのディレクトリ（lv2, lv3...）をパスに追加
const CPU_CONFIGS = {
  1: { className: 'CPU',  src: 'cpu/cpu.js' },  // ← ここを修正
  2: { className: 'CPU2', src: 'cpu/lv2/cpu2.js' },
  3: { className: 'CPU3', src: 'cpu/lv3/cpu3.js' },
  4: { className: 'CPU4', src: 'cpu/lv4/cpu4.js' }, // ※まだ未作成の場合は選ぶと404になります
  5: { className: 'CPU5', src: 'cpu/lv5/cpu5.js' }  // ※まだ未作成の場合は選ぶと404になります
};

// ─── CPU動的ロード・破棄システム ──────────────
let activeCpuScript = null;
let activeCpuClassName = null;

/**
 * 指定レベルのCPUスクリプトを動的にロードする
 */
function loadCpuScript(level) {
  return new Promise((resolve, reject) => {
    const config = CPU_CONFIGS[level];
    if (!config) return reject(new Error("Invalid CPU Level"));

    if (activeCpuClassName === config.className && window[config.className]) {
      return resolve(window[config.className]);
    }

    unloadCpuScript();

    const script = document.createElement('script');
    script.src = config.src;
    script.id = `dynamic-cpu-script`;
    
    script.onload = () => {
      activeCpuScript = script;
      activeCpuClassName = config.className;
      resolve(window[config.className]);
    };
    script.onerror = (e) => {
      console.error(`CPUスクリプトのロードに失敗しました: ${config.src}`, e);
      reject(e);
    };
    document.body.appendChild(script);
  });
}

/**
 * ロードされているCPUスクリプトとWorkerを完全に破棄する
 */
function unloadCpuScript() {
  if (window._cpuController) {
    window._cpuController.stop(); 
    window._cpuController = null;
  }

  if (activeCpuScript && activeCpuScript.parentNode) {
    activeCpuScript.parentNode.removeChild(activeCpuScript);
    activeCpuScript = null;
  }

  if (activeCpuClassName && window[activeCpuClassName]) {
    delete window[activeCpuClassName];
    activeCpuClassName = null;
  }
}

// ─────────────────────────────────────────────
function goToVersusCheck() {
  switchPage('versus-check');
}

function renderVersusCheck() {
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
  const descEl = document.getElementById('versus-cpu-desc');
  if (descEl) descEl.textContent = CPU_LEVELS[selectedCpuLevel].desc;

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

function setCpuLevel(lv) {
  selectedCpuLevel = lv;
  const toggle = document.getElementById('cpu-level-toggle');
  if (toggle) {
    toggle.querySelectorAll('.opt-btn').forEach((btn, idx) => {
      btn.classList.toggle('active', idx + 1 === lv);
    });
  }
  const descEl = document.getElementById('versus-cpu-desc');
  if (descEl) descEl.textContent = CPU_LEVELS[lv].desc;
}

async function startVersusGame() {
  if (!window._game) return;

  const cpuConfig = CPU_LEVELS[selectedCpuLevel];
  switchPage('versus');

  const cpuLevelDisp = document.getElementById('versus-cpu-level-display');
  if (cpuLevelDisp) cpuLevelDisp.textContent = 'CPU ' + cpuConfig.label;

  window._game.currentMode = 'versus';
  window._game.marathonGoal = Infinity;
  window._game.isVersusMode = true;
  window._game.canvasPrefix = 'player';
  window._game.statsPrefix = 'player';
  window._game._labelsInitialized = false;
  window._game.isCpuControlled = false;
  window._game.initMainCanvas();
  window._game.initNextCanvas();
  window._game.initHoldCanvas();

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

  document.getElementById('pause-overlay')?.classList.remove('active');
  document.getElementById('versus-pause-overlay')?.classList.remove('active');

  window._game._initGameState();
  window._cpuGame._initGameState();
  window._game.setKeyEvent();

  window._game.level = 2;
  window._cpuGame.level = 2;
  window._game.updateStatsDisplay();
  window._cpuGame.updateStatsDisplay();

  let CPUClass;
  try {
    CPUClass = await loadCpuScript(selectedCpuLevel);
  } catch (e) {
    alert("CPUスクリプトの読み込みに失敗しました。");
    return;
  }

  runCountdown('player-countdown-overlay', 'player-countdown-text', () => {
    window._game._startGameplay();
  }, null);

  runCountdown('cpu-countdown-overlay', 'cpu-countdown-text', () => {
    window._cpuGame._startGameplay();
    
    window._cpuController = new CPUClass(window._cpuGame);
    window._cpuController.start();
  }, null);

  setupVersusPauseKey();
}

function setupVersusPauseKey() {
  if (window._versusPauseHandler) {
    document.removeEventListener('keydown', window._versusPauseHandler);
  }
  const keys = (typeof loadKeys === 'function') ? loadKeys() : { pause: { code: 'Escape' } };
  window._versusPauseHandler = function(e) {
    const versusPage = document.getElementById('versus-page');
    if (!versusPage || !versusPage.classList.contains('active')) return;
    if (e.code === keys.pause.code) {
      e.preventDefault();
      toggleVersusPause();
    }
  };
  document.addEventListener('keydown', window._versusPauseHandler);
}

function toggleVersusPause() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (!overlay) return;
  const isPaused = overlay.classList.contains('active');
  if (isPaused) {
    resumeVersus();
  } else {
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

function versusGameOver(loser) {
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

  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');

  const playerText  = (loser === 'player') ? 'LOSE...' : 'WIN!';
  const cpuText     = (loser === 'cpu')    ? 'LOSE...' : 'WIN!';
  const playerClass = (loser === 'player') ? 'finish-gameover' : 'finish-clear';
  const cpuClass    = (loser === 'cpu')    ? 'finish-gameover' : 'finish-clear';

  showFinishOverlay('player-finish-overlay', 'player-finish-text', playerText, playerClass, 1400, null);
  showFinishOverlay('cpu-finish-overlay',    'cpu-finish-text',    cpuText,    cpuClass,    1400, () => {
    const winner = (loser === 'player') ? 'CPU' : 'YOU';
    const titleEl = document.getElementById('versus-result-title');
    const winnerEl = document.getElementById('versus-result-winner');
    if (titleEl) {
      if (loser === 'player') {
        titleEl.textContent = 'YOU LOSE';
        titleEl.style.color = 'var(--danger)';
        titleEl.style.webkitTextFillColor = 'var(--danger)';
      } else {
        titleEl.textContent = 'YOU WIN!';
        titleEl.style.color = 'var(--success)';
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

function switchPage(pageId) {
  const currentActive = document.querySelector('.page.active');
  if (currentActive && currentActive.id !== 'settings-page') {
    window._prevPage = currentActive.id.replace('-page', '');
  }

  if (pageId === 'main-menu' || pageId === 'title') {
    unloadCpuScript();
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  const target = document.getElementById(pageId + '-page');
  if (target) target.classList.add('active');

  const header = document.getElementById('header-area');
  if (header) header.style.display = (pageId === 'settings') ? 'flex' : 'none';

  if (pageId === 'game' || pageId === 'settings' || pageId === 'versus') {
    if (typeof stopListening === 'function') stopListening();
  }
  
  if (pageId === 'settings') {
    if (typeof renderKeyConfig === 'function') renderKeyConfig();
    if (typeof renderTuning    === 'function') renderTuning();
  } else if (pageId === 'versus-check') {
    renderVersusCheck();
  } else if (pageId === 'mode-check') {
    renderModeCheck(); 
  }
}

function goToModeCheck(modeId) {
  currentGameMode = GAME_MODES[modeId] || GAME_MODES.marathon;
  switchPage('mode-check');
}

function renderModeCheck() {
  const mode = currentGameMode || GAME_MODES.marathon;

  const labelEl = document.getElementById('mode-check-label');
  if (labelEl) {
    labelEl.textContent  = mode.label;
    labelEl.style.color  = mode.color;
  }

  const iconEl = document.getElementById('mode-check-icon');
  if (iconEl) {
    iconEl.textContent = mode.icon;
    iconEl.style.color = mode.color;
  }

  const descJaEl = document.getElementById('mode-check-desc-ja');
  if (descJaEl) descJaEl.textContent = mode.description;

  const descEnEl = document.getElementById('mode-check-desc-en');
  if (descEnEl) descEnEl.textContent = mode.descriptionEn;

  const optionsEl = document.getElementById('mode-check-options');
  if (optionsEl) {
    if (mode.id === 'marathon') {
      optionsEl.style.display = 'flex';
      const startLevel = (window._game && window._game.marathonStartLevel) ? window._game.marathonStartLevel : 1;

      optionsEl.innerHTML = `
        <div class="option-row">
          <span class="option-label">GOAL</span>
          <div class="option-toggle">
            <button class="opt-btn ${marathonSelectedGoal === 150 ? 'active' : ''}" id="opt-goal-150" onclick="setMarathonGoal(150)">150 LINES</button>
            <button class="opt-btn ${marathonSelectedGoal === 'endless' ? 'active' : ''}" id="opt-goal-endless" onclick="setMarathonGoal('endless')">ENDLESS</button>
          </div>
        </div>
        <div class="option-row">
          <span class="option-label">START LEVEL</span>
          <div class="option-slider">
            <input type="range" id="marathon-level-slider" min="1" max="15" value="${startLevel}" oninput="updateMarathonLevelDisplay()">
            <span id="marathon-level-val" class="option-val">${startLevel}</span>
          </div>
        </div>
      `;
      const levelVal = document.getElementById('marathon-level-val');
      if (levelVal) levelVal.style.color = mode.color;
      optionsEl.querySelectorAll('.opt-btn.active').forEach(btn => {
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
      optionsEl.innerHTML = '';
    }
  }

  const startBtn = document.getElementById('mode-check-start-btn');
  if (startBtn) {
    if (mode.id === 'sprint') {
      startBtn.style.background = 'linear-gradient(135deg, var(--accent3) 0%, var(--accent) 100%)';
    } else if (mode.id === 'ultra') {
      startBtn.style.background = 'linear-gradient(135deg, var(--accent2) 0%, var(--accent) 100%)';
    } else {
      startBtn.style.background = 'linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%)';
    }
  }
}

async function startGameFromModeCheck() {
  if (!window._game) return;

  const modeId = currentGameMode ? currentGameMode.id : 'marathon';
  window._game.currentMode = modeId;

  if (modeId !== 'test') {
    unloadCpuScript();
  }

  window._game.isVersusMode = false;
  window._game.canvasPrefix = null;
  window._game.statsPrefix = null;
  window._game._labelsInitialized = false;
  window._game.isCpuControlled = false;
  window._game.initMainCanvas();
  window._game.initNextCanvas();
  window._game.initHoldCanvas();

  document.getElementById('pause-overlay')?.classList.remove('active');
  document.getElementById('versus-pause-overlay')?.classList.remove('active');

  if (modeId === 'marathon') {
    window._game.marathonGoal = (marathonSelectedGoal === 'endless') ? Infinity : 150;
    const levelSlider = document.getElementById('marathon-level-slider');
    window._game.marathonStartLevel = levelSlider ? parseInt(levelSlider.value, 10) : 1;
  }

  const evalArea = document.getElementById('eval-area');
  if (evalArea) {
    evalArea.style.display = (modeId === 'test') ? 'block' : 'none';
  }

  switchPage('game');
  window._game.start();

  if (modeId === 'test') {
    window._game.isCpuControlled = testCpuControl;

    let CPUClass;
    try {
      CPUClass = await loadCpuScript(selectedCpuLevel);
    } catch (e) {
      alert("CPUスクリプトの読み込みに失敗しました。");
      return;
    }

    window._cpuController = new CPUClass(window._game);
    window._cpuController.isAutoPlay = testCpuControl;
    window._cpuController.start();
  }
}

(function setupTitleScreen() {
  const titlePage = document.getElementById('title-page');
  if (!titlePage) return;

  titlePage.addEventListener('click', function () {
    switchPage('main-menu');
  });

  document.addEventListener('keydown', function onTitleKey(e) {
    if (!document.getElementById('title-page').classList.contains('active')) return;
    if (['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
        'Tab','CapsLock','ScrollLock','NumLock','PrintScreen','Pause'].includes(e.key)) return;
    switchPage('main-menu');
  });
})();