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
    description: 'レベルが上がるにつれてミノが加速する。',
    descriptionEn: 'Speed increases as your level rises.',
    color:       'var(--accent)',
  },
  sprint: {
    id:          'sprint',
    label:       'SPRINT',
    icon:        '⚡',
    description: '40ラインのタイムアタック。',
    descriptionEn: 'Clear 40 lines as fast as possible.',
    color:       'var(--accent3)',
  },
  ultra: {
    id:          'ultra',
    label:       'ULTRA',
    icon:        '★',
    description: '2分間のスコアアタック。',
    descriptionEn: 'Score as many points as possible in 2 minutes.',
    color:       'var(--accent2)',
  },
  test: {
    id:          'test',
    label:       'CPU TEST',
    icon:        '🤖',
    description: 'CPUの動作確認用モードです。',
    descriptionEn: 'Test mode for CPU behavior. ',
    color:       'var(--success)',
  },
  puyo: {
    id:          'puyo',
    label:       'PUYO',
    icon:        '🫧',
    description: 'ぷよモードシングルプレイ。',
    descriptionEn: 'Chain combos to score as high as possible.',
    color:       'var(--accent2)',
  },
  // ─── QUIZモード ───────────────────────────────
  quiz: {
    id:          'quiz',
    label:       'QUIZ',
    icon:        '❓',
    description: '謎解きパズルモード。テト・ぷよ両対応。',
    descriptionEn: 'Puzzle challenge mode for both Tet and Puyo.',
    color:       '#f5c542',
  },
};

let testCpuControl = true; 
let testRule = 'puyo';

function setTestCpuControl(isOn) {
  testCpuControl = isOn;
  renderModeCheck();
}

function setTestRule(rule) {
  testRule = rule;
  renderModeCheck();
}

let currentGameMode = null;
let versusRule = 'puyo'; // 既存の互換性のため残す
let versusPlayerRule = 'puyo'; // プレイヤー側のルール ('tet' or 'puyo')
let versusCpuRule = 'puyo';    // CPU側のルール ('tet' or 'puyo')

// カウントダウン中の中断を防ぐためのセッション管理
let currentSessionId = 0;

// ─── VERSUSモード用グローバル変数 ──────────────
const CPU_LEVELS = {
  1: { label: 'LV 1', desc: '初心者向け', gravityLevel: 1  },
  2: { label: 'LV 2', desc: '初級者向け', gravityLevel: 2  },
  3: { label: 'LV 3', desc: '中級者向け', gravityLevel: 2  },
  4: { label: 'LV 4', desc: '上級者向け', gravityLevel: 2 },
  5: { label: 'LV 5', desc: '最上級者向け', gravityLevel: 2 },
};
let selectedCpuLevel = 1; 

const CPU_CONFIGS = {
  tet: {
    1: { className: 'CPU',  src: 'cpu/tet/lv1/cpu.js' },  
    2: { className: 'CPU2', src: 'cpu/tet/lv2/cpu2.js' },
    3: { className: 'CPU3', src: 'cpu/tet/lv3/cpu3.js' },
    4: { className: 'CPU4', src: 'cpu/tet/lv4/cpu4.js' }, 
    5: { className: 'CPU5', src: 'cpu/tet/lv5/cpu5.js' },
    6: { className: 'CPU6', src: 'cpu/tet/lv6/cpu6.js' }  
  },
  puyo: {
    1: { className: 'PuyoCPU',  src: 'cpu/puyo/lv1/cpu1.js' },  
    2: { className: 'PuyoCPU2', src: 'cpu/puyo/lv2/cpu2.js' },
    3: { className: 'PuyoCPU3', src: 'cpu/puyo/lv3/cpu3.js' },
    4: { className: 'PuyoCPU4', src: 'cpu/puyo/lv4/cpu4.js' }, 
    5: { className: 'PuyoCPU5', src: 'cpu/puyo/lv5/cpu5.js' }  
  }
};

// ─── ゲーム進行の中断・破棄機能 ──────────────
// 進行中の全てのゲーム（tet/PUYO、プレイヤー/CPU）を強制停止し、状態を破棄する
function stopAllGames() {
    currentSessionId++; // セッションを更新し、進行中の非同期処理やカウントダウンを無効化
    
    const stopGameInstance = (gameInst) => {
        if (!gameInst) return;
        console.log("🛑 Stopping game instance:", gameInst);
        // ★ 修正: PuyoGame と Tet (Game) インスタンスを確実に区別して停止処理を行う
        if (gameInst === window._puyoGame || gameInst === window._puyoGamePlayer || gameInst === window._puyoGameCpu) {
            // Puyo の停止処理
            if (typeof gameInst.stop === 'function') {
                gameInst.stop();
            }
        } else {
            // tet の停止処理
            if (typeof gameInst.gameOver === 'function') { 
                if (gameInst.timer) { clearInterval(gameInst.timer); gameInst.timer = null; }
                if (gameInst.lockTimer) { clearTimeout(gameInst.lockTimer); gameInst.lockTimer = null; }
                gameInst.isPaused = true;
                if (gameInst.isTimerRunning) {
                    gameInst.elapsedTime += performance.now() - gameInst.startTime;
                    gameInst.isTimerRunning = false;
                    if (gameInst.timerReqId) cancelAnimationFrame(gameInst.timerReqId);
                }
                if (gameInst._keyDownHandler) document.removeEventListener('keydown', gameInst._keyDownHandler);
                if (gameInst._keyUpHandler)   document.removeEventListener('keyup',   gameInst._keyUpHandler);
                if (gameInst._keyLoop) { clearInterval(gameInst._keyLoop); gameInst._keyLoop = null; }
            }
        }
    };

    // 存在しうる全インスタンスを停止
    stopGameInstance(window._game);
    stopGameInstance(window._cpuGame);
    stopGameInstance(window._puyoGame);
    stopGameInstance(window._puyoGamePlayer);
    stopGameInstance(window._puyoGameCpu);
    stopGameInstance(window._tetGamePlayer);
    stopGameInstance(window._tetGameCpu);

    if (window._cpuController && typeof window._cpuController.stop === 'function') {
        window._cpuController.stop();
    }
    window._cpuController = null;
    unloadCpuScript();

    // カウントダウン・フィニッシュのオーバーレイを消去し、リセット
    document.querySelectorAll('.field-overlay').forEach(el => {
        el.classList.remove('active');
        el.style.opacity = '';
        el.classList.remove('fadeout');
    });
    
    // pause overlay も消す
    document.getElementById('pause-overlay')?.classList.remove('active');
    document.getElementById('versus-pause-overlay')?.classList.remove('active');

    // ─── QUIZマネージャーの破棄（quiz.js）───
    if (typeof _stopQuizIfActive === 'function') _stopQuizIfActive();

    // オーバーレイ内のテキストも消去
    document.querySelectorAll('.countdown-text, .finish-text').forEach(el => {
        el.textContent = '';
        el.className = el.className.replace(/countdown-pop|finish-clear|finish-gameover/g, '').trim();
    });

    document.querySelectorAll('.garbage-gauge, .attack-gauge').forEach(el => {
        el.innerHTML = '';
        if (el.classList.contains('attack-gauge')) {
            el.style.display = 'none';
        }
    });
}

// ─── CPU動的ロード・破棄システム ──────────────
let activeCpuScript = null;
let activeCpuClassName = null;

function loadCpuScript(level, rule) {
  return new Promise((resolve, reject) => {
    const config = CPU_CONFIGS[rule][level];
    if (!config) return reject(new Error("Invalid CPU Level or Rule"));

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

// ★ フォールバック付きのCPUロード関数（カウントダウン中に非同期で呼ばれる）
async function loadCpuWithFallback(targetLevel, rule) {
  for (let lv = targetLevel; lv >= 1; lv--) {
    try {
      const CPUClass = await loadCpuScript(lv, rule);
      if (lv !== targetLevel) {
        alert(`指定されたCPU(LV ${targetLevel})の読み込みに失敗しました。\n現在CPUは LV ${lv} まで実装しています。\nLV ${lv} を読み込んで開始します。`);
      }
      return CPUClass;
    } catch (e) {
      console.warn(`CPU LV ${lv} (${rule}) の読み込みに失敗しました。`);
      // 失敗した場合は1つ下のレベルを試すループが続く
    }
  }
  throw new Error("CPUスクリプトのロードに全て失敗しました。");
}

function unloadCpuScript() {
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

function setVersusPlayerRule(rule) {
  versusPlayerRule = rule;
  const tetBtn = document.getElementById('opt-rule-player-tet');
  const puyoBtn = document.getElementById('opt-rule-player-puyo');
  if (tetBtn) tetBtn.classList.toggle('active', rule === 'tet');
  if (puyoBtn) puyoBtn.classList.toggle('active', rule === 'puyo');
}

function setVersusCpuRule(rule) {
  versusCpuRule = rule;
  const tetBtn = document.getElementById('opt-rule-cpu-tet');
  const puyoBtn = document.getElementById('opt-rule-cpu-puyo');
  if (tetBtn) tetBtn.classList.toggle('active', rule === 'tet');
  if (puyoBtn) puyoBtn.classList.toggle('active', rule === 'puyo');
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

function _switchToVersusPuyoLayout(isPuyo) {
    const tetCanvases = [
        'player-main-canvas', 'player-next-canvas', 'player-hold-canvas',
        'cpu-main-canvas', 'cpu-next-canvas', 'cpu-hold-canvas'
    ];
    const puyoCanvases = [
        'player-puyo-main-canvas', 'player-puyo-next-canvas',
        'cpu-puyo-main-canvas', 'cpu-puyo-next-canvas'
    ];

    tetCanvases.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isPuyo ? 'none' : '';
    });
    puyoCanvases.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isPuyo ? '' : 'none';
    });

    document.querySelectorAll('.versus-label-hold, .versus-label-hold-cpu').forEach(el => {
        el.style.display = isPuyo ? 'none' : '';
    });
}

function _switchToVersusMixedLayout(playerRule, cpuRule) {
    const isPlayerPuyo = playerRule === 'puyo';
    const isCpuPuyo = cpuRule === 'puyo';

    // Player側のキャンバス切り替え
    const playerTetCanvases = ['player-main-canvas', 'player-next-canvas', 'player-hold-canvas'];
    const playerPuyoCanvases = ['player-puyo-main-canvas', 'player-puyo-next-canvas'];

    playerTetCanvases.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isPlayerPuyo ? 'none' : '';
    });
    playerPuyoCanvases.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isPlayerPuyo ? '' : 'none';
    });
    document.querySelectorAll('.versus-label-hold').forEach(el => {
        el.style.display = isPlayerPuyo ? 'none' : '';
    });

    // CPU側のキャンバス切り替え
    const cpuTetCanvases = ['cpu-main-canvas', 'cpu-next-canvas', 'cpu-hold-canvas'];
    const cpuPuyoCanvases = ['cpu-puyo-main-canvas', 'cpu-puyo-next-canvas'];

    cpuTetCanvases.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isCpuPuyo ? 'none' : '';
    });
    cpuPuyoCanvases.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isCpuPuyo ? '' : 'none';
    });
    document.querySelectorAll('.versus-label-hold-cpu').forEach(el => {
        el.style.display = isCpuPuyo ? 'none' : '';
    });
}

function createSeededRandom(seed) {
    let s = seed;
    return function() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        return (s >>> 0) / 4294967296;
    }
}

async function startVersusGame() {
  stopAllGames(); // 開始前に完全に状態をリセット
  const sessionId = currentSessionId; // カウントダウン後にセッションが有効か確認するために保持

  const cpuConfig = CPU_LEVELS[selectedCpuLevel];
  switchPage('versus');

  const cpuLevelDisp = document.getElementById('versus-cpu-level-display');
  if (cpuLevelDisp) cpuLevelDisp.textContent = 'CPU ' + cpuConfig.label;

  const cpuSideLabel = document.getElementById('versus-cpu-side-label');
  if (cpuSideLabel) cpuSideLabel.textContent = 'CPU ' + cpuConfig.label;

  const sharedSeed = Math.floor(Math.random() * 1000000);

  const isPlayerPuyo = versusPlayerRule === 'puyo';
  const isCpuPuyo = versusCpuRule === 'puyo';

  // 混合レイアウトの適用
  _switchToVersusMixedLayout(versusPlayerRule, versusCpuRule);

  // ─── Player インスタンス生成 ───
  if (isPlayerPuyo) {
      if (!window._puyoGamePlayer) window._puyoGamePlayer = new PuyoGame('player');
      window._game = window._puyoGamePlayer;
      window._game.rng = createSeededRandom(sharedSeed);
  } else {
      if (!window._tetGamePlayer) window._tetGamePlayer = new Game('player');
      window._game = window._tetGamePlayer;
  }

  // ─── CPU インスタンス生成 ───
  if (isCpuPuyo) {
      if (!window._puyoGameCpu) window._puyoGameCpu = new PuyoGame('cpu');
      window._cpuGame = window._puyoGameCpu;
      window._cpuGame.rng = createSeededRandom(sharedSeed);
  } else {
      if (!window._tetGameCpu) window._tetGameCpu = new Game('cpu');
      window._cpuGame = window._tetGameCpu;
  }

  // ─── 共通設定 ───
  window._game.currentMode = 'versus';
  window._game.marathonGoal = Infinity;
  window._game.isVersusMode = true;
  window._game.canvasPrefix = 'player';
  window._game.statsPrefix = 'player';
  window._game._labelsInitialized = false;
  window._game.isCpuControlled = false;

  window._cpuGame.currentMode = 'versus';
  window._cpuGame.marathonGoal = Infinity;
  window._cpuGame.isVersusMode = true;
  window._cpuGame.canvasPrefix = 'cpu';
  window._cpuGame.statsPrefix = 'cpu';
  window._cpuGame.isCpuControlled = true;
  window._cpuGame._labelsInitialized = false;

  // ─── Player 初期化 ───
  if (isPlayerPuyo) {
      await new Promise(resolve => window._game.initGame(resolve));
  } else {
      window._game.initMainCanvas();
      window._game.initNextCanvas();
      window._game.initHoldCanvas();
      window._game._initGameState();
      window._game.setKeyEvent();
      window._game.level = 2;
      window._game.updateStatsDisplay();
  }

  // ─── CPU 初期化 ───
  if (isCpuPuyo) {
      await new Promise(resolve => window._cpuGame.initGame(resolve));
  } else {
      window._cpuGame.initMainCanvas();
      window._cpuGame.initNextCanvas();
      window._cpuGame.initHoldCanvas();
      window._cpuGame._initGameState();
      window._cpuGame.level = 2;
      window._cpuGame.updateStatsDisplay();
  }

  // ─── カウントダウンとゲーム開始 ───
  
  // ★ 修正箇所：カウントダウン期間中はポーズを受け付けないよう、ぷよ側の状態を 'starting' に明示的に切り替える
  if (isPlayerPuyo && window._game) window._game.state = 'starting';
  if (isCpuPuyo && window._cpuGame) window._cpuGame.state = 'starting';
  // ★ 修正箇所 ここまで

  // ★ カウントダウンの開始と同時に非同期でCPUのスクリプト読み込みを開始する
  let cpuLoadPromise = loadCpuWithFallback(selectedCpuLevel, versusCpuRule).catch(e => {
    console.warn("CPUスクリプトの読み込みに失敗しました。自由落下になります。");
    return null;
  });

  runCountdown('player-countdown-overlay', 'player-countdown-text', () => {
    if (currentSessionId !== sessionId) return; // セッションが変わっていたら開始しない
    window._game._startGameplay();
  }, null);

  runCountdown('cpu-countdown-overlay', 'cpu-countdown-text', async () => {
    if (currentSessionId !== sessionId) return; // セッションが変わっていたら開始しない
    
    if (window._cpuController && typeof window._cpuController.stop === 'function') {
      window._cpuController.stop();
    }
    window._cpuGame._startGameplay();
    
    // ★ ロード完了を待ってからスタート操作を開始する
    const CPUClass = await cpuLoadPromise;
    if (CPUClass && currentSessionId === sessionId) { // 待機中にセッションが変わっていないか再確認
        window._cpuController = new CPUClass(window._cpuGame);
        if (typeof window._cpuController.start === 'function') {
            window._cpuController.start();
        }
    }
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
    // カウントダウン中はポーズを受け付けない（シングルモードと同じ挙動）
    // Tet(Game)は isCountingDown、PuyoGame は state === 'starting' でカウントダウン中を判定する
    const isGameCounting = (inst) => {
      if (!inst) return false;
      if (inst.isCountingDown) return true;           // Game (Tet)
      if (inst.state === 'starting') return true;     // PuyoGame
      return false;
    };
    // ★ _game/_cpuGame に加えて、ぷよ専用インスタンスも明示的にチェックする
    // ぷよ同士の対戦では _puyoGamePlayer/_puyoGameCpu がカウントダウン中の場合も含める
    if (isGameCounting(window._game) || isGameCounting(window._cpuGame)
        || isGameCounting(window._puyoGamePlayer) || isGameCounting(window._puyoGameCpu)) {
      return;
    }
    if (window._game && typeof window._game.pause === 'function') window._game.pause();
    if (window._cpuGame && typeof window._cpuGame.pause === 'function') window._cpuGame.pause();
    overlay.classList.add('active');
  }
}

function resumeVersus() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');
  if (window._game && typeof window._game.resume === 'function') window._game.resume();
  if (window._cpuGame && typeof window._cpuGame.resume === 'function') window._cpuGame.resume();
}

function restartVersus() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');
  startVersusGame();
}

function restartVersusFromResult() {
  startVersusGame();
}

function versusGameOver(loser) {
  // ★ 修正: ここでも Tet と Puyo を確実に区別する
  const stopGame = (gameInst) => {
      if (!gameInst) return;
      if (gameInst === window._puyoGame || gameInst === window._puyoGamePlayer || gameInst === window._puyoGameCpu) {
          if (typeof gameInst.stop === 'function') {
              gameInst.stop();
              gameInst.state = 'gameover';
          }
      } else {
          if (typeof gameInst.gameOver === 'function') { 
              // tet
              if (gameInst.timer) clearInterval(gameInst.timer);
              gameInst.timer = null;
              if (gameInst.lockTimer) clearTimeout(gameInst.lockTimer);
              gameInst.lockTimer = null;
              gameInst.isPaused = true;
              if (gameInst.isTimerRunning) {
                  gameInst.elapsedTime += performance.now() - gameInst.startTime;
                  gameInst.isTimerRunning = false;
                  if (gameInst.timerReqId) cancelAnimationFrame(gameInst.timerReqId);
              }
              if (gameInst._keyDownHandler) document.removeEventListener('keydown', gameInst._keyDownHandler);
              if (gameInst._keyUpHandler)   document.removeEventListener('keyup',   gameInst._keyUpHandler);
              if (gameInst._keyLoop)        clearInterval(gameInst._keyLoop);
          }
      }
  };

  stopGame(window._game);
  stopGame(window._cpuGame);
  
  if (window._cpuController && typeof window._cpuController.stop === 'function') {
      window._cpuController.stop();
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
    
    let pLines = 0;
    if (window._game) {
        pLines = window._game.lines !== undefined ? window._game.lines : window._game.chainMax;
    }
    document.getElementById('versus-result-player-lines').textContent = pLines;
    
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

  // メインメニューやタイトルに戻る際はゲーム情報を完全に破棄
  if (pageId === 'main-menu' || pageId === 'title') {
    stopAllGames();
    _switchToPuyoLayout(false);
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
  } else if (pageId === 'quiz-check') {
    // QUIZモード選択画面のレンダリング（quiz.js）
    if (typeof renderQuizCheck === 'function') renderQuizCheck();
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
          <div class="option-toggle" id="marathon-level-toggle"></div>
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
          <span class="option-label">RULE</span>
          <div class="option-toggle" id="test-rule-toggle">
            <button class="opt-btn ${testRule === 'tet' ? 'active' : ''}" onclick="setTestRule('tet')">TET</button>
            <button class="opt-btn ${testRule === 'puyo' ? 'active' : ''}" onclick="setTestRule('puyo')">PUYO</button>
          </div>
        </div>
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
    } else if (mode.id === 'puyo') {
      optionsEl.style.display = 'none';
      optionsEl.innerHTML = '';
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
  stopAllGames(); // 開始前に完全に状態をリセット
  const sessionId = currentSessionId;

  if (!window._game && !window._puyoGame) window._game = new Game();
  GameManager.setInstance('p1', window._game); // これを追加！
  const modeId = currentGameMode ? currentGameMode.id : 'marathon';
  console.log("Starting game with mode:", modeId);

  // ─── QUIZモード専用処理 ────────────────────────
  if (modeId === 'quiz') {
    // quiz-check画面へ遷移（レベル選択）
    switchPage('quiz-check');
    return;
  }

  // ─── PUYO(シングル)モード専用処理
  if (modeId === 'puyo') {
    _switchToPuyoLayout(true);
    
    if (window._puyoGame) {
        window._puyoGame.isCpuControlled = false;
        window._puyoGame.isVersusMode = false;
        window._puyoGame.currentMode = 'puyo';
    }

    switchPage('game');
    startPuyoGame();
    return;
  }

  // ─── TESTモード (PUYO) 処理
  if (modeId === 'test' && testRule === 'puyo') {
    _switchToPuyoLayout(true);

    if (!window._puyoGame) window._puyoGame = new PuyoGame();
    window._puyoGame.currentMode = 'test';
    window._puyoGame.isVersusMode = false;
    window._puyoGame.isCpuControlled = testCpuControl;

    const evalArea = document.getElementById('eval-area');
    if (evalArea) {
      evalArea.style.display = 'block';
    }

    switchPage('game');
    setupGlobalCpuPauseKey(); 
    
    // ★ カウントダウン(ある場合)と同時にバックグラウンドで読み込み
    let cpuLoadPromise = loadCpuWithFallback(selectedCpuLevel, 'puyo').catch(e => {
      alert("CPUスクリプトの読み込みに失敗しました。");
      return null;
    });

    window._puyoGame.start(); // ここでカウントダウン開始

    // ロード完了したらゲームにアタッチ（カウントダウン完了後に実行されるよう待機）
    cpuLoadPromise.then(CPUClass => {
        if (CPUClass && currentSessionId === sessionId) {
          window._cpuController = new CPUClass(window._puyoGame);
          window._cpuController.isAutoPlay = testCpuControl;
          if (typeof window._cpuController.start === 'function') {
            window._cpuController.start();
          }
        }
    });
    return;
  }

  // レイアウトをテト側に戻す
  _switchToPuyoLayout(false);

  // 未定義の場合はインスタンスを作成
  if (!window._game || typeof window._game.initMainCanvas !== 'function') {
      window._game = new Game();
  }

  window._game.currentMode = modeId;
  window._game.isVersusMode = false;
  window._game.canvasPrefix = null;
  window._game.statsPrefix = null;
  window._game._labelsInitialized = false;
  window._game.isCpuControlled = false;
  window._game.initMainCanvas();
  window._game.initNextCanvas();
  window._game.initHoldCanvas();

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
  setupGlobalCpuPauseKey(); 
  
  let cpuLoadPromise = null;
  if (modeId === 'test' && testRule === 'tet') {
    window._game.isCpuControlled = testCpuControl;
    cpuLoadPromise = loadCpuWithFallback(selectedCpuLevel, 'tet').catch(e => {
      alert("CPUスクリプトの読み込みに失敗しました。");
      return null;
    });
  }

  window._game.start();

  // ★ ロードが完了し次第アタッチして操作開始
  if (cpuLoadPromise) {
    cpuLoadPromise.then(CPUClass => {
      if (CPUClass && currentSessionId === sessionId) {
        window._cpuController = new CPUClass(window._game);
        window._cpuController.isAutoPlay = testCpuControl;
        if (typeof window._cpuController.start === 'function') {
            window._cpuController.start();
        }
      }
    });
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

function _switchToPuyoLayout(isPuyo) {
  const tetCanvases = ['main-canvas', 'next-canvas', 'hold-canvas'];
  const puyoCanvases   = ['puyo-main-canvas', 'puyo-next-canvas'];

  tetCanvases.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isPuyo ? 'none' : '';
  });

  puyoCanvases.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isPuyo ? '' : 'none';
  });

  const labelLevel = document.getElementById('label-level');
  const labelLines = document.getElementById('label-lines');
  const labelNext  = document.getElementById('label-next');
  const labelHold  = document.getElementById('label-hold');

  if (isPuyo) {
    if (labelLevel) labelLevel.textContent = 'MAX CHAIN';
    if (labelLines) labelLines.textContent = 'CHAIN';
    if (labelNext)  labelNext.style.display  = 'none'; 
    if (labelHold)  labelHold.style.display  = 'none'; 
  } else {
    if (labelLevel) labelLevel.textContent = 'LEVEL';
    if (labelLines) labelLines.textContent = 'LINES';
    if (labelNext)  labelNext.style.display  = '';
    if (labelHold)  labelHold.style.display  = '';
  }

  const resLevelLabel = document.getElementById('result-label-level');
  const resLinesLabel = document.getElementById('result-label-lines');
  if (isPuyo) {
    if (resLevelLabel) resLevelLabel.textContent = 'MAX CHAIN';
    if (resLinesLabel) resLinesLabel.textContent = 'CLEARED PUYOS';
  } else {
    if (resLevelLabel) resLevelLabel.textContent = 'LEVEL';
    if (resLinesLabel) resLinesLabel.textContent = 'LINES';
  }
}

// ─────────────────────────────────────────────
// ★ テストモード (CPU操作ON) 時にプレイヤーのポーズ操作を補完する機能
// ─────────────────────────────────────────────
function setupGlobalCpuPauseKey() {
  if (window._globalCpuPauseHandler) {
    document.removeEventListener('keydown', window._globalCpuPauseHandler);
  }
  const keys = (typeof loadKeys === 'function') ? loadKeys() : { pause: { code: 'Escape' } };
  
  window._globalCpuPauseHandler = function(e) {
    const gamePage = document.getElementById('game-page');
    // シングルプレイ画面以外なら何もしない
    if (!gamePage || !gamePage.classList.contains('active')) return;
    
    // ★ ぷよ側は p_game.js 自身がポーズを処理するので、テト側のみここで補完する
    if (currentGameMode && currentGameMode.id === 'test' && testRule === 'tet' && window._game && window._game.isCpuControlled) {
        if (e.code === keys.pause.code) {
            if (e.defaultPrevented) return;
            e.preventDefault();
            
            if (typeof togglePause === 'function') {
                togglePause();
            } else {
                const overlay = document.getElementById('pause-overlay');
                if (overlay) {
                    if (overlay.classList.contains('active')) {
                        overlay.classList.remove('active');
                        if (typeof window._game.resume === 'function') window._game.resume();
                    } else {
                        if (typeof window._game.pause === 'function') window._game.pause();
                        overlay.classList.add('active');
                    }
                }
            }
        }
    }
  };
  document.addEventListener('keydown', window._globalCpuPauseHandler);
}

// ─────────────────────────────────────────────
// ★ 追加: シングルプレイ全モード共通 ポーズ＆UI管理
// ─────────────────────────────────────────────
function toggleGamePause() {
  const overlay = document.getElementById('pause-overlay');
  if (!overlay) return;

  const gamePage = document.getElementById('game-page');
  if (!gamePage || !gamePage.classList.contains('active')) return;

  const isGameCounting = (inst) => {
      if (!inst) return false;
      if (inst.isCountingDown) return true;
      if (inst.state === 'starting') return true;
      return false;
  };

  // カウントダウン中ならポーズ無効
  if (isGameCounting(window._game) || isGameCounting(window._puyoGame)) {
      return;
  }

  const isPaused = overlay.classList.contains('active');
  if (isPaused) {
    handlePauseAction('resume');
  } else {
    // プレイ中のみポーズ発動
    const canPauseGame = window._game && (window._game.state === 'playing' || window._game.state === 'active');
    const canPausePuyo = window._puyoGame && (window._puyoGame.state === 'playing' || window._puyoGame.state === 'active');
    
    if (canPauseGame || canPausePuyo) {
      if (window._game && typeof window._game.pause === 'function') window._game.pause();
      if (window._puyoGame && typeof window._puyoGame.pause === 'function') window._puyoGame.pause();
      overlay.classList.add('active');
    }
  }
}

function handlePauseAction(action) {
  const overlay = document.getElementById('pause-overlay');
  if (overlay) overlay.classList.remove('active');

  switch (action) {
    case 'resume':
      if (window._game && typeof window._game.resume === 'function') window._game.resume();
      if (window._puyoGame && typeof window._puyoGame.resume === 'function') window._puyoGame.resume();
      break;
    case 'settings':
      switchPage('settings');
      break;
    case 'restart':
      if (currentGameMode && currentGameMode.id === 'puyo') {
          if (window._puyoGame && typeof window._puyoGame.start === 'function') window._puyoGame.start();
      } else {
          if (window._game && typeof window._game.start === 'function') window._game.start();
      }
      break;
    case 'mainmenu':
      stopAllGames();
      _switchToPuyoLayout(false);
      switchPage('main-menu');
      break;
  }
}