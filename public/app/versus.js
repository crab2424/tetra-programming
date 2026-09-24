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

// 1P 側を CPU にするとき（隠しコマンド: 準備画面の 0 キー）のレベル。
// selectedPlayerCpuLevel が null なら 2P と同じ。LV6 は tet のみなので puyo では 5 に丸める。
function _playerCpuLevel() {
  let lv = (selectedPlayerCpuLevel == null) ? selectedCpuLevel : selectedPlayerCpuLevel;
  if (versusPlayerRule !== 'tet' && lv > 5) lv = 5;
  return lv;
}

function _cpuLabel(lv) {
  return 'CPU ' + (CPU_LEVELS[lv] ? CPU_LEVELS[lv].label : ('LV ' + lv));
}

// 対戦中のCPUコントローラ（2P=_cpuController / 1P=_cpuControllerPlayer）を全て止める
function _stopVersusCpuControllers() {
  for (const key of ['_cpuController', '_cpuControllerPlayer']) {
    const ctrl = window[key];
    if (ctrl && typeof ctrl.stop === 'function') ctrl.stop();
  }
}

async function startVersusGame() {
  // 開始/再スタートの状態遷移（リトライはどこからでも idle を経由して開始できる）
  const lc = window.BattleVersusLifecycle;
  lc.transition('idle', 'startVersusGame');
  lc.transition('preparing', 'startVersusGame');
  stopAllGames(); // 開始前に完全に状態をリセット
  const sessionId = currentSessionId; // 非同期処理の後でセッションが有効か確認するために保持
  const isStale = () => currentSessionId !== sessionId;

  const isPlayerCpu = !!versusPlayerIsCpu;
  const cpuLevel = selectedCpuLevel;
  const playerCpuLevel = isPlayerCpu ? _playerCpuLevel() : null;
  const cpuConfig = CPU_LEVELS[cpuLevel];

  // ─── ロード（v2.2.3 H）───
  // 画像・SE・BGM・CPU（クラスJS＋思考 worker を ready まで）を揃えてから開始する。
  // 全部揃っていればロード画面は出ない（R リスタート等）。
  const cpuSpecs = [{ level: cpuLevel, rule: versusCpuRule, label: _cpuLabel(cpuLevel) + (isPlayerCpu ? ' (2P)' : '') }];
  if (isPlayerCpu) cpuSpecs.push({ level: playerCpuLevel, rule: versusPlayerRule, label: _cpuLabel(playerCpuLevel) + ' (1P)' });
  const prep = await window.BattleLocalLoading.prepare({
    rules: [versusPlayerRule, versusCpuRule],
    bgmKey: 'versus_bgm',
    cpus: cpuSpecs,
    isStale,
  });
  if (prep.cancelled) {
    if (isStale()) return; // 別の開始処理に追い越された
    lc.transition('idle', 'startVersusGame cancelled');
    if (prep.cpuFailed) alert('CPUの読み込みに失敗しました。通信状態を確認してもう一度お試しください。');
    switchPage('versus-check');
    return;
  }
  const CpuClass = prep.classes[0];
  const PlayerCpuClass = isPlayerCpu ? prep.classes[1] : null;

  lc.beginRound();
  lc.transition('countdown', 'startVersusGame');
  lc.transition('playing', 'startVersusGame'); // カウントダウンはエンジン内で行うため即 playing 扱い

  switchPage('versus');

  const cpuLevelDisp = document.getElementById('versus-cpu-level-display');
  if (cpuLevelDisp) cpuLevelDisp.textContent = 'CPU ' + cpuConfig.label;

  const cpuSideLabel = document.getElementById('versus-cpu-side-label');
  if (cpuSideLabel) cpuSideLabel.textContent = 'CPU ' + cpuConfig.label;
  const playerSideLabel = document.getElementById('versus-player-side-label');
  if (playerSideLabel) {
    if (playerSideLabel.dataset.defaultText === undefined) playerSideLabel.dataset.defaultText = playerSideLabel.textContent;
    playerSideLabel.textContent = isPlayerCpu ? _cpuLabel(playerCpuLevel) + ' (1P)' : playerSideLabel.dataset.defaultText;
  }

  // xorshift はシード0だと0を返し続けるため 1 以上にする
  const sharedSeed = Math.floor(Math.random() * 1000000) + 1;

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
      // ツモ順をCPUと共通にする（getNextType が tumoRng を使う。ONLINE と同じ仕組み）
      window._game.tumoRng = createSeededRandom(sharedSeed);
  }

  // ─── CPU インスタンス生成 ───
  if (isCpuPuyo) {
      if (!window._puyoGameCpu) window._puyoGameCpu = new PuyoGame('cpu');
      window._cpuGame = window._puyoGameCpu;
      window._cpuGame.rng = createSeededRandom(sharedSeed);
  } else {
      if (!window._tetGameCpu) window._tetGameCpu = new Game('cpu');
      window._cpuGame = window._tetGameCpu;
      window._cpuGame.tumoRng = createSeededRandom(sharedSeed);
  }

  // ─── 共通設定 ───
  window._game.currentMode = 'versus';
  window._game.marathonGoal = Infinity;
  window._game.isVersusMode = true;
  window._game.canvasPrefix = 'player';
  window._game.statsPrefix = 'player';
  window._game._labelsInitialized = false;
  // ★ CPU同士（J）では 1P もCPU操作。入力ハンドラは isCpuControlled で自分を無視する。
  window._game.isCpuControlled = isPlayerCpu;
  if (isPlayerPuyo) window._game.suppressBlink = isPlayerCpu;

  window._cpuGame.currentMode = 'versus';
  window._cpuGame.marathonGoal = Infinity;
  window._cpuGame.isVersusMode = true;
  window._cpuGame.canvasPrefix = 'cpu';
  window._cpuGame.statsPrefix = 'cpu';
  window._cpuGame.isCpuControlled = true;
  window._cpuGame._labelsInitialized = false;
  if (isCpuPuyo) window._cpuGame.suppressBlink = true; // ★ 操作不可のCPU側盤面はPUYO点滅を止める

  // ─── VS設定をエンジンへ注入 ───
  if (typeof applyVsSettings === 'function') {
      applyVsSettings(window._game, window._cpuGame, versusPlayerRule, versusCpuRule);
  }

  // ─── Player 初期化 ───
  if (isPlayerPuyo) {
      await new Promise(resolve => window._game.initGame(resolve));
      if (isStale()) return;
  } else {
      window._game.initMainCanvas();
      window._game.initNextCanvas();
      window._game.initHoldCanvas();
      window._game._initGameState();
      if (!isPlayerCpu) window._game.setKeyEvent();
      window._game.level = 2;
      window._game.updateStatsDisplay();
  }

  // ─── CPU 初期化 ───
  if (isCpuPuyo) {
      await new Promise(resolve => window._cpuGame.initGame(resolve));
      if (isStale()) return;
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

  // ★ CPUコントローラはロード済みクラスから生成する。思考 worker はロード画面で ready 済みの
  //   ものをプールから借りるので、生成直後から workerReady が立っている（v2.2.3 G/H）。
  if (CpuClass) window._cpuController = new CpuClass(window._cpuGame);
  if (PlayerCpuClass) window._cpuControllerPlayer = new PlayerCpuClass(window._game);

  await window.BattleLocalLoading.reveal();
  if (isStale()) return;

  runCountdown('player-countdown-overlay', 'player-countdown-text', () => {
    if (isStale()) return; // セッションが変わっていたら開始しない
    if (window.BgmManager) window.BgmManager.play('versus_bgm'); // ★ START! のタイミングでBGM開始
    window._game._startGameplay();
    const pc = window._cpuControllerPlayer;
    if (pc && typeof pc.start === 'function') pc.start();
  }, null);

  runCountdown('cpu-countdown-overlay', 'cpu-countdown-text', () => {
    if (isStale()) return; // セッションが変わっていたら開始しない
    window._cpuGame._startGameplay();
    const c = window._cpuController;
    if (c && typeof c.start === 'function') c.start();
  }, null, undefined, true); // silent: player側と同時に鳴るSEの二重再生を防ぐ

  setupVersusPauseKey();
  if (typeof startVersusCpuWatchdog === 'function') startVersusCpuWatchdog(sessionId);
}

// ─── CPUコントローラの作り直し（v2.2.3）─────────────────────
// 同じクラスで stop() → new → start()。思考 worker は stop() でプールへ返り、新しい方が
// ready 済みのまま借りるので、作り直し直後の1手が即置きになることは無い（G）。
// stop() で isActive=false になるため、旧コントローラが予約していたアクション連鎖
// （setTimeout）は全て自滅する＝盤面入れ替え直後の二重実行（F）も起きない。
// key: '_cpuController'（2P, window._cpuGame）/ '_cpuControllerPlayer'（1P, window._game）
function recreateVersusCpuController(key) {
  const old = window[key];
  if (!old) return null;
  const game = (key === '_cpuControllerPlayer') ? window._game : window._cpuGame;
  const CPUClass = old.constructor;
  if (typeof old.stop === 'function') old.stop();
  const ctrl = new CPUClass(game);
  window[key] = ctrl;
  if (typeof ctrl.start === 'function') ctrl.start();
  return ctrl;
}

// ─── CPU停止のウォッチドッグ（v2.2.3 G-3）─────────────────────
// 1つのミノ／ぷよに対して CPU が STALL_MS 以上手を出さない（重力だけで落ちている）状態を検出し、
// コントローラの状態をログに出してから作り直す。通常 CPU は 1 秒未満で置くので、
// 重力任せで落ちきるより十分短い閾値にしている。
const CPU_STALL_MS = 6000;
let _cpuWatchdogTimer = null;

function stopVersusCpuWatchdog() {
  if (_cpuWatchdogTimer) { clearInterval(_cpuWatchdogTimer); _cpuWatchdogTimer = null; }
}

function startVersusCpuWatchdog(sessionId) {
  stopVersusCpuWatchdog();
  const tracks = {}; // key -> { token, since }
  _cpuWatchdogTimer = setInterval(() => {
    if (currentSessionId !== sessionId) { stopVersusCpuWatchdog(); return; }
    if (window.BattleVersusLifecycle.phase !== 'playing') return;
    const pauseOverlay = document.getElementById('versus-pause-overlay');
    const paused = pauseOverlay && pauseOverlay.classList.contains('active');
    const now = performance.now();

    for (const key of ['_cpuController', '_cpuControllerPlayer']) {
      const ctrl = window[key];
      if (!ctrl || !ctrl.isActive || !ctrl.isAutoPlay) { delete tracks[key]; continue; }
      const game = ctrl.game;
      // 監視対象外の時間帯（ポーズ・カウントダウン・終了演出・ぷよの連鎖中など）は計測し直す
      const idle = paused || !game || game.isPaused || game.isCountingDown || game.isFinishing
        || (game.state && game.state !== 'playing');
      let token = null;
      if (!idle) {
        if (game instanceof PuyoGame) token = (game._gs === 'falling') ? (tracks[key] && tracks[key].token) || ('p' + now) : null;
        else token = game.mino || null;
      }
      if (!token) { delete tracks[key]; continue; }
      const t = tracks[key];
      if (!t || t.token !== token) { tracks[key] = { token, since: now }; continue; }
      if (now - t.since < CPU_STALL_MS) continue;

      console.warn(`[cpu-watchdog] ${key} が ${CPU_STALL_MS}ms 無操作のため作り直します`, {
        className: ctrl.constructor && ctrl.constructor.name,
        workerReady: ctrl.workerReady,
        isCalculating: ctrl.isCalculating,
        isExecutingAction: ctrl.isExecutingAction,
        actionQueue: ctrl.actionQueue ? ctrl.actionQueue.length : undefined,
        hasBestMove: !!ctrl.bestMoveData,
        currentMinoMatches: ctrl.currentMino === game.mino,
        gs: game._gs,
      });
      delete tracks[key];
      recreateVersusCpuController(key);
    }
  }, 1000);
}

function setupVersusPauseKey() {
  if (window._versusPauseHandler) {
    document.removeEventListener('keydown', window._versusPauseHandler);
  }
  const keys = (typeof loadKeys === 'function') ? loadKeys() : { pause: { codes: ['Escape'] }, restart: { codes: ['KeyR'] } };
  const restartCodes = (keys.restart && keys.restart.codes && keys.restart.codes.length) ? keys.restart.codes : ['KeyR'];
  const pauseCodes = (keys.pause && keys.pause.codes && keys.pause.codes.length) ? keys.pause.codes : ['Escape'];
  window._versusPauseHandler = function(e) {
    const versusPage = document.getElementById('versus-page');
    if (!versusPage || !versusPage.classList.contains('active')) return;

    // ★ リスタートキー（versusモードではここで処理する）
    if (restartCodes.includes(e.code)) {
      if (e.repeat) return;
      e.preventDefault();
      // finish演出中はリスタートを受け付けない
      if (_versusFinishingNow()) return;
      restartVersus();
      return;
    }

    if (pauseCodes.includes(e.code)) {
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
  
  _stopVersusCpuControllers();

  const overlay = document.getElementById('versus-pause-overlay');
  if (overlay) overlay.classList.remove('active');

  // ★ 文言・クラス・表示時間は src/battle/finish_overlay.ts（window.BattleFinish）に一本化。
  //   オンライン戦も同じ関数を使うので、ここで文字列を書かない。
  window.BattleFinish.showFieldFinish('player-', loser === 'player' ? 'lose' : 'win');
  window.BattleFinish.showFieldFinish('cpu-', loser === 'cpu' ? 'lose' : 'win', () => {
    // ★ リザルトでも versus_bgm を引き継ぐ（停止は main-menu / versus-check へ戻った時のみ）
    const isCpuVsCpu = !!versusPlayerIsCpu;
    let winner = (loser === 'player') ? 'CPU' : 'YOU';
    if (isCpuVsCpu) {
      // ★ CPU同士の対戦（v2.2.3 J）: 勝った側を「1P/2P ＋ レベル」で表示
      winner = (loser === 'player')
        ? _cpuLabel(selectedCpuLevel) + ' (2P)'
        : _cpuLabel(_playerCpuLevel()) + ' (1P)';
    }
    const titleEl = document.getElementById('versus-result-title');
    const winnerEl = document.getElementById('versus-result-winner');
    if (titleEl && isCpuVsCpu) {
      titleEl.textContent = (loser === 'player') ? '2P WIN!' : '1P WIN!';
      titleEl.style.color = 'var(--success)';
      titleEl.style.webkitTextFillColor = 'var(--success)';
    } else if (titleEl) {
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
      const who = isCpuVsCpu ? '1P' : 'YOUR';
      playerLinesLabelEl.textContent = isPlayerPuyo ? `${who} MAX CHAINS` : `${who} LINES`;
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
