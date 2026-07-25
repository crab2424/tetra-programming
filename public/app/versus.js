// ─────────────────────────────────────────────
// versus.js — VERSUSモード（準備画面〜対戦〜結果・ポーズ）
// （router.js から分割。stopAllGames/switchPage は navigation.js を実行時参照）
// ─────────────────────────────────────────────
// VS SETTINGSページへ遷移
function goToVsSettings() {
  renderVsSettingsPage();
  switchPage('vs-settings');
}

// VS SETTINGSページから戻る
function backFromVsSettings() {
  switchPage('versus-check');
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

// レイアウト切替の実体は src/battle/layout.ts（CPU戦・オンライン戦共通の唯一の編集場所）
function _switchToVersusMixedLayout(playerRule, cpuRule) {
    window.BattleLayout.applyVersusLayout(playerRule, cpuRule);
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

// 終了演出中（versusGameOver〜リザルト表示）か。旧 window._versusFinishing の置き換えで、
// 状態の実体は BattleLifecycle(src/battle/lifecycle.ts) が一元管理する
function _versusFinishingNow() {
  const p = window.BattleVersusLifecycle.phase;
  return p === 'roundResolving' || p === 'roundResult';
}

async function startVersusGame() {
  // 開始/再スタートの状態遷移（リトライはどこからでも idle を経由して開始できる）
  const lc = window.BattleVersusLifecycle;
  lc.transition('idle', 'startVersusGame');
  lc.transition('preparing', 'startVersusGame');
  lc.beginRound();
  lc.transition('countdown', 'startVersusGame');
  lc.transition('playing', 'startVersusGame'); // カウントダウンはエンジン内で行うため即 playing 扱い
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

  // ─── VS設定をエンジンへ注入 ───
  if (typeof applyVsSettings === 'function') {
      applyVsSettings(window._game, window._cpuGame, versusPlayerRule, versusCpuRule);
  }

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


  // ★ カウントダウンの開始と同時に非同期でCPUのスクリプト読み込みを開始し、インスタンス化まで済ませる
  // （実体は src/battle/driver.ts の loadLocalCpu。挙動は変えていない）
  let cpuLoadPromise = window.BattleDriver.loadLocalCpu(
    window._cpuGame, selectedCpuLevel, versusCpuRule, () => currentSessionId !== sessionId,
  );

  runCountdown('player-countdown-overlay', 'player-countdown-text', () => {
    if (currentSessionId !== sessionId) return; // セッションが変わっていたら開始しない
    if (window.BgmManager) window.BgmManager.play('versus_bgm'); // ★ START! のタイミングでBGM開始
    window._game._startGameplay();
  }, null);

  runCountdown('cpu-countdown-overlay', 'cpu-countdown-text', async () => {
    if (currentSessionId !== sessionId) return; // セッションが変わっていたら開始しない
    
    window._cpuGame._startGameplay();
    
    // ★ ロードとインスタンス化がまだ終わっていなければ待つ
    await cpuLoadPromise;
    
    if (window._cpuController && typeof window._cpuController.start === 'function' && currentSessionId === sessionId) {
        window._cpuController.start();
    }
  }, null);

  setupVersusPauseKey();
}

function setupVersusPauseKey() {
  if (window._versusPauseHandler) {
    document.removeEventListener('keydown', window._versusPauseHandler);
  }
  const keys = (typeof loadKeys === 'function') ? loadKeys() : { pause: { code: 'Escape' }, restart: { code: 'KeyR' } };
  window._versusPauseHandler = function(e) {
    const versusPage = document.getElementById('versus-page');
    if (!versusPage || !versusPage.classList.contains('active')) return;

    // ★ リスタートキー（versusモードではここで処理する）
    if (e.code === (keys.restart ? keys.restart.code : 'KeyR')) {
      if (e.repeat) return;
      e.preventDefault();
      // finish演出中はリスタートを受け付けない
      if (_versusFinishingNow()) return;
      restartVersus();
      return;
    }

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
    window.SeManager?.play('resume');
    resumeVersus();
  } else {
    // ★ finish演出中はポーズを受け付けない（startカウントダウン中と同じ扱い）
    if (_versusFinishingNow()) return;

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
    window.SeManager?.play('pause');
    if (window._game && typeof window._game.pause === 'function') window._game.pause();
    if (window._cpuGame && typeof window._cpuGame.pause === 'function') window._cpuGame.pause();
    // ③ ポーズ中はBGMを止めず小音量で流し続ける（ぷよ専用インスタンス時もここで確実にダッキング）
    window.BgmManager?.duck();
    overlay.classList.add('active');
  }
}

function resumeVersus() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');
  if (window._game && typeof window._game.resume === 'function') window._game.resume();
  if (window._cpuGame && typeof window._cpuGame.resume === 'function') window._cpuGame.resume();
  // ③ ポーズ解除でBGM音量を元に戻す
  window.BgmManager?.unduck();
}

function restartVersus() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');
  startVersusGame();
}

function versusGoToModeSelect() {
  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');
  window.BattleVersusLifecycle.transition('idle', 'mode select');
  stopAllGames();
  switchPage('versus-check');
}

function restartVersusFromResult() {
  startVersusGame();
}

function versusGameOver(loser) {
  // ★ 二重呼び出し（同時KO等で2回呼ばれると登場アニメが飛ぶ）は遷移不成立で弾く。
  //   roundResolving 中はポーズ/リスタートキーも _versusFinishingNow() で無効になる。
  if (!window.BattleVersusLifecycle.transition('roundResolving', `versusGameOver(${loser})`)) return;
  window.BattleVersusLifecycle.recordWinner(loser === 'player' ? 'cpu' : 'player');

  // ★ 停止処理の実体は src/battle/freeze.ts（window.BattleFreeze）に一本化してある。
  //   オンライン戦も同じ関数を使う。ぷよは isPaused を停止条件に使わず、stop() の後に
  //   state='gameover' を代入しないと _loop() が回り続ける、という作法をここで二重管理しない。
  const stopGame = (gameInst) => {
      if (!gameInst) return;
      const isPuyo = gameInst === window._puyoGame
          || gameInst === window._puyoGamePlayer
          || gameInst === window._puyoGameCpu;
      // 演出中は勝者/敗者とも盤面・NEXTを残す（keepCanvas）
      window.BattleFreeze.freezeGameByRule(gameInst, isPuyo ? 'puyo' : 'tet', { keepCanvas: true });
  };

  // 勝者・敗者とも同じ手順で止める（旧実装は勝者だけ _versusFinishing を立てていたが、
  // 敗者側も _beginGameOver で既に立っているため実質同じ。keepCanvas に統一した）
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
    // ★ リザルトでも versus_bgm を引き継ぐ（停止は main-menu / versus-check へ戻った時のみ）
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

    // ★ プレイヤーのスコアと固有スタット（ルールに応じてラベルと値を切り替え）
    const isPlayerPuyo = versusPlayerRule === 'puyo';
    const isCpuPuyo    = versusCpuRule    === 'puyo';

    document.getElementById('versus-result-player-score').textContent = window._game ? window._game.score : 0;
    document.getElementById('versus-result-cpu-score').textContent    = window._cpuGame ? window._cpuGame.score : 0;

    // YOUR LINES ラベルをルールに応じて切り替え
    const playerLinesLabelEl = document.getElementById('versus-result-player-lines-label');
    if (playerLinesLabelEl) {
      playerLinesLabelEl.textContent = isPlayerPuyo ? 'YOUR MAX CHAINS' : 'YOUR LINES';
    }

    // YOUR LINES 値をルールに応じて取得
    let pStat = 0;
    if (window._game) {
      if (isPlayerPuyo) {
        // ぷよ：最大連鎖数
        pStat = window._game.chainMax !== undefined ? window._game.chainMax : 0;
      } else {
        // テト：消したライン数
        pStat = window._game.lines !== undefined ? window._game.lines : 0;
      }
    }
    document.getElementById('versus-result-player-lines').textContent = pStat;

    // CPU LINES ラベルと値も同様に切り替え
    const cpuLinesLabelEl = document.getElementById('versus-result-cpu-lines-label');
    const cpuLinesValEl   = document.getElementById('versus-result-cpu-lines');
    if (cpuLinesLabelEl && cpuLinesValEl) {
      cpuLinesLabelEl.textContent = isCpuPuyo ? 'CPU MAX CHAINS' : 'CPU LINES';
      let cStat = 0;
      if (window._cpuGame) {
        if (isCpuPuyo) {
          cStat = window._cpuGame.chainMax !== undefined ? window._cpuGame.chainMax : 0;
        } else {
          cStat = window._cpuGame.lines !== undefined ? window._cpuGame.lines : 0;
        }
      }
      cpuLinesValEl.textContent = cStat;
    }

    window.BattleVersusLifecycle.transition('roundResult', 'result shown');
    switchPage('versus-result');
  });
}
