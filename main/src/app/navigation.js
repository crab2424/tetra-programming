// ─────────────────────────────────────────────
// navigation.js — 画面遷移(switchPage)・全停止・mode check・シングル開始・ポーズ
// （router.js から分割。読み込みは modes→cpu_loader→versus→navigation の順）
// ─────────────────────────────────────────────
// ─── ゲーム進行の中断・破棄機能 ──────────────
// 進行中の全てのゲーム（tet/PUYO、プレイヤー/CPU）を強制停止し、状態を破棄する
function stopAllGames() {
    currentSessionId++; // セッションを更新し、進行中の非同期処理やカウントダウンを無効化
    // ★ BGMの停止/継続は switchPage が遷移先ページに応じて判断する（ここでは止めない）。
    //   これにより RETRY / NEXT LEVEL のようにゲームを再開する経路では BGM を途切れさせず継続できる。
    //   ただしポーズ中のダッキングは解除する（継続するBGMが小音量のまま再開されるのを防ぐ）。
    window.BgmManager?.unduck();

    const stopGameInstance = (gameInst) => {
        if (!gameInst) return;
        // ★ 修正: PuyoGame と Tet (Game) インスタンスを確実に区別して停止処理を行う
        if (gameInst === window._puyoGame || gameInst === window._puyoGamePlayer || gameInst === window._puyoGameCpu) {
            // Puyo の停止処理
            if (typeof gameInst.stop === 'function') {
                gameInst.stop();
            }
            // ★ puyo ゲームの盤面もリセット
            if (typeof gameInst._resetState === 'function') {
                gameInst._resetState();
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

    // LINESゴール表示をリセット
    const linesGoalEl = document.getElementById('lines-goal');
    if (linesGoalEl) linesGoalEl.textContent = '';
}
// ─── LINESゴール表示の更新 ──────────────────────
// marathon(150ライン目標時)は "/150"、sprintは "/40"、それ以外は非表示
function updateLinesGoalDisplay(modeId) {
  const el = document.getElementById('lines-goal');
  if (!el) return;
  if (modeId === 'sprint') {
    el.textContent = '/40';
  } else if (modeId === 'marathon' && marathonSelectedGoal !== 'endless') {
    el.textContent = '/' + marathonSelectedGoal;
  } else {
    el.textContent = '';
  }
}

let marathonSelectedGoal = 150;

function setMarathonGoal(goal) {
  marathonSelectedGoal = goal;
  const btn150     = document.getElementById('opt-goal-150');
  const btnEndless = document.getElementById('opt-goal-endless');
  const color = currentGameMode ? currentGameMode.color : 'var(--accent)';

  // まず両方のインラインスタイルをリセット
  [btn150, btnEndless].forEach(btn => {
    if (!btn) return;
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.classList.remove('active');
  });

  // activeなボタンにだけ色を付ける
  const activeBtn = goal === 150 ? btn150 : btnEndless;
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.style.color = color;
    activeBtn.style.borderColor = color;
  }

  // ゲーム中にゴールを切り替えた場合の即時反映
  const linesGoalEl = document.getElementById('lines-goal');
  if (linesGoalEl && currentGameMode && currentGameMode.id === 'marathon') {
    linesGoalEl.textContent = goal === 'endless' ? '' : '/' + goal;
  }
}

function updateMarathonLevelDisplay() {
  const val = document.getElementById('marathon-level-slider').value;
  document.getElementById('marathon-level-val').textContent = val;
}

// ─── ページ遷移時のスクロールリセット ──────────────────────────
// overflow:hidden で進行中の慣性スクロールを中断 → scrollTop=0 → 強制 reflow
// → overflow を戻す。これによりペイントとヒットテストのスクロール状態を一致させる。
let _resetScrollRafId = null;
function resetPageScroll() {
  const se = document.scrollingElement || document.documentElement;

  const pin = () => {
    se.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
  };

  // 慣性スクロールを打ち切る（overflow:hidden の間はスクロール自体ができない）
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  pin();
  // 強制 reflow でレイアウトを確定
  void document.body.offsetHeight;

  // ★ overflow:hidden を「最低1フレーム」保持するのが肝。
  //   同一フレーム内で overflow を戻すと、コンポジタが scroll=0 のヒットテスト
  //   状態をコミットする前に macOS の慣性スクロールが復活し、
  //   「見た目は上・当たり判定は元の位置」のズレが残る。
  //   2フレーム後に再度 0 へ固定してから overflow を復元することで、
  //   慣性が消えた状態でペイントとヒットテストを一致させる。
  if (_resetScrollRafId) cancelAnimationFrame(_resetScrollRafId);
  _resetScrollRafId = requestAnimationFrame(() => {
    pin();
    _resetScrollRafId = requestAnimationFrame(() => {
      pin();
      void document.body.offsetHeight;
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      _resetScrollRafId = null;
    });
  });
}

function switchPage(pageId) {
  const currentActive = document.querySelector('.page.active');
  if (currentActive && currentActive.id !== 'settings-page') {
    window._prevPage = currentActive.id.replace('-page', '');
  }

  // ★ BGM 切り替え処理
  // メインメニューやタイトルに戻る際はゲーム情報を完全に破棄
  if (pageId === 'main-menu' || pageId === 'title') {
    stopAllGames();
    _switchToPuyoLayout(false);
    // ★ リザルト等から戻る際、流れていたBGMをぶつ切りにせず menu_bgm へクロスフェード
    //   （menu_bgm が既に流れていれば crossfadeTo は冪等に継続）
    if (window.BgmManager) window.BgmManager.crossfadeTo('menu_bgm');
  }

  // router.js の switchPage 関数内（既存の page 切り替え処理の後）に追記
  if (['title', 'main-menu', 'mode-check', 'versus-check', 'vs-settings', 'quiz-check', 'result', 'versus-result', 'quiz-result', 'settings', 'credits', 'changelog'].includes(pageId)) {
      if (typeof initMenuAnimations === 'function') initMenuAnimations(pageId);
  } else {
      if (typeof stopMenuAnimations === 'function') stopMenuAnimations();
  }

  // 準備画面（mode select 等）もメニューBGM。リザルトから戻った場合はクロスフェードで滑らかに切替。
  const menuPages = ['mode-check', 'versus-check', 'vs-settings', 'quiz-check'];
  if (menuPages.includes(pageId)) {
    if (window.BgmManager) window.BgmManager.crossfadeTo('menu_bgm');
  }

  // リザルト画面ではプレイ中のBGMをそのまま引き継ぐ（消さない）。
  // 停止は main-menu / mode select（mode-check・quiz-check・versus-check 等）へ戻った時のみ＝
  // それらのページが menu_bgm に切り替えることで実現する。
  // → quiz-result では quiz_bgm を継続させ、NEXT LEVEL / RETRY でも途切れさせない。

  // ゲーム画面に入るタイミングのBGM制御。
  // ・QUIZ：専用BGM(quiz_bgm)。既に流れていれば play() が冪等に継続（NEXT/RETRYで途切れない）。
  // ・それ以外：メニューBGM(menu_bgm)が流れていればカウントダウンの長さに合わせてフェードアウト。
  //   （versusは START! のタイミングで versus_bgm を鳴らす＝startVersusGame側。
  //    RESTARTでversus_bgm継続中の場合はそのまま流し続ける。）
  if (pageId === 'game' || pageId === 'versus') {
    if (window.BgmManager) {
      if (pageId === 'game' && currentGameMode && currentGameMode.id === 'quiz') {
        window.BgmManager.play('quiz_bgm');
      } else if (window.BgmManager.isCurrent?.('menu_bgm')) {
        // runCountdown は 3→2→1→START! を 700ms間隔で進め、START!（=ゲーム開始）まで約2100ms。
        // シングル/CPU TEST/versus はカウントダウン中に menu_bgm をフェードアウトし、
        // START! のタイミングで各BGMを鳴らす（再生は game.js / p_game.js / startVersusGame 側）。
        window.BgmManager.stop(false, COUNTDOWN_TO_START_MS);
      }
    }
  }

  // ★ 追加: 設定から game に戻る際、ポーズ画面を復元する
    if (pageId === 'game' && window._returnToPause) {
        window._returnToPause = false;
        // 次フレームで overlay を active に戻す（DOM更新後）
        requestAnimationFrame(() => {
            const overlay = document.getElementById('pause-overlay');
            if (overlay) overlay.classList.add('active');
        });
    }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  const target = document.getElementById(pageId + '-page');
  if (target) target.classList.add('active');

  // ★ スクロール位置をリセット（ページ遷移時）
  //   遷移元が縦に長くスクロールされた状態だと、display トグルだけでは
  //   古い scrollY が残り、game/versus の中央固定レイアウトでキャンバスが
  //   上部に切れて固まることがある。
  //   さらに「慣性スクロール(momentum)の最中」に遷移すると、scrollTo だけでは
  //   ペイントは上に戻るのにヒットテスト用のスクロール状態が古いまま残り、
  //   「見た目は上・ボタンの当たり判定は元の位置」というズレが発生する。
  //   そこで overflow を一瞬 hidden にして進行中の慣性スクロールを打ち切り、
  //   scrollTop=0 + 強制 reflow でレイアウト・ヒットテストを確定させてから戻す。
  resetPageScroll();

  const header = document.getElementById('header-area');
  if (header) header.style.display = (pageId === 'settings') ? 'flex' : 'none';

  if (pageId === 'game' || pageId === 'settings' || pageId === 'versus') {
    if (typeof stopListening === 'function') stopListening();
  }
  
  if (pageId === 'settings') {
    if (typeof renderKeyConfig === 'function') renderKeyConfig();
    if (typeof renderTuning    === 'function') renderTuning();
    if (typeof renderVolume    === 'function') renderVolume();
  } else if (pageId === 'versus-check') {
    renderVersusCheck();
    renderVsSettingsSummary();
  } else if (pageId === 'vs-settings') {
    _updateVsSettingsPage();
  } else if (pageId === 'mode-check') {
    renderModeCheck(); 
  } else if (pageId === 'quiz-check') {
    // QUIZモード選択画面のレンダリング（quiz.js）
    if (typeof renderQuizCheck === 'function') renderQuizCheck();
  }
}

function goToModeCheck(modeId) {
  currentGameMode = GAME_MODES[modeId] || GAME_MODES.marathon;
  
  if (modeId === 'quiz') {
    switchPage('quiz-check');
  } else {
    switchPage('mode-check');
  }
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
      optionsEl.querySelectorAll('.opt-btn').forEach(btn => {
          btn.style.color = '';
          btn.style.borderColor = '';
      });
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
          const t = document.getElementById('test-cpu-level-toggle');
          if (t) {
            t.querySelectorAll('.opt-btn').forEach((b, i) => {
              b.classList.toggle('active', i + 1 === lv);
            });
          }
        };
        toggle.appendChild(btn);
      }
    } else if (mode.id === 'puyo') {
      optionsEl.style.display = 'none';
      optionsEl.innerHTML = '';
    } else if (mode.id === 'quiz') {
      // 選択中のレベル情報を表示
      optionsEl.style.display = 'flex';
      const lv = typeof currentQuizLevel !== 'undefined' && currentQuizLevel;
      if (lv) {
        const ruleLabel = lv.rule === 'tet' ? 'TET' : 'PUYO';

        // QUIZ_LEVELSからレベル番号を算出
        if (typeof QUIZ_LEVELS !== 'undefined' && QUIZ_LEVELS[lv.rule]) {
          const idx = QUIZ_LEVELS[lv.rule].findIndex(l => l.id === lv.id);
          if (idx !== -1) levelNum = idx + 1;
        }
        // 難易度★の生成（_renderDiffStars は quiz.js で定義）
        const diffStarsHtml = (typeof _renderDiffStars === 'function') ? _renderDiffStars(lv.diff) : '';
        const levelTitle = `${ruleLabel} - ${levelNum}`;

        console.log("Current Quiz Level:", levelTitle);
        
        // ★追加: NEXT情報の動的生成
        let nextInfoText = '';
        if (lv.rule === 'tet' && lv.nextPieces) {
            const tetMap = {0: 'I', 1: 'O', 2: 'T', 3: 'J', 4: 'L', 5: 'S', 6: 'Z'};
            const nextArray = lv.nextPieces.map(p => tetMap[p] || '?');
            nextInfoText = `NEXT: ${nextArray.join(', ')}`;
        } else if (lv.rule === 'puyo' && lv.nextPuyoPairs) {
            const puyoMap = {1: '赤', 2: '青', 3: '紫', 4: '緑', 5: '黄'};
            const nextArray = lv.nextPuyoPairs.map(pair => `[${puyoMap[pair[0]] || '?'}, ${puyoMap[pair[1]] || '?'}]`);
            nextInfoText = `NEXT: ${nextArray.join(', ')}`;
        }

        optionsEl.innerHTML = `
        <div class="option-row" style="flex-direction:column; gap:6px; align-items:flex-start;">
          <span class="option-label" style="color:#f58542;">${levelTitle}${diffStarsHtml ? `&nbsp;<span style="font-size:0.8em;">${diffStarsHtml}</span>` : ''}</span>
            <span style="font-size:11px; color:var(--text-dim); letter-spacing:1px;">${lv.description}</span>
            <span style="font-size:11px; color:#f58542; letter-spacing:1px;">GOAL: ${lv.clearCondition.description}</span>
            ${nextInfoText ? `<span style="font-size:11px; color:var(--text-dim); letter-spacing:1px; word-break: break-all;">${nextInfoText}</span>` : ''}
          </div>
        `;
      } else {
        optionsEl.innerHTML = '';
        optionsEl.style.display = 'none';
      }
    } else {
      optionsEl.style.display = 'none';
      optionsEl.innerHTML = '';
    }
  }

  // QUIZモードの場合、BACKボタンの遷移先をquiz-checkに変更
  const backBtn = document.querySelector('#mode-check-buttons .btn-secondary');
  if (backBtn) {
    if (mode.id === 'quiz') {
      backBtn.setAttribute('onclick', "switchPage('quiz-check')");
    } else {
      backBtn.setAttribute('onclick', "switchPage('main-menu')");
    }
  }

  const startBtn = document.getElementById('mode-check-start-btn');
  if (startBtn) {
      if (mode.id === 'quiz') {
      startBtn.classList.remove('btn-primary');
      startBtn.classList.add('btn-quiz-primary');
      startBtn.style.background = '';
    } else {
      startBtn.classList.remove('btn-quiz-primary');
      startBtn.classList.add('btn-primary');
      if (mode.id === 'sprint') {
        startBtn.style.background = 'linear-gradient(135deg, var(--accent3) 0%, var(--accent) 100%)';
      } else if (mode.id === 'ultra') {
        startBtn.style.background = 'linear-gradient(135deg, var(--accent2) 0%, var(--accent) 100%)';
      } else {
        startBtn.style.background = 'linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%)';
      }
    }
  }

}

function _applyModePauseSelectStyle(btn) {
  if (!btn) btn = document.getElementById('pause-mode-select-btn');
  if (!btn) return;
  const mode = currentGameMode;
  if (!mode) return;
  btn.style.color = '#fff';
  btn.style.border = 'none';
  if (mode.id === 'sprint') {
    btn.style.background = 'linear-gradient(135deg, var(--accent3) 0%, var(--accent) 100%)';
  } else if (mode.id === 'ultra') {
    btn.style.background = 'linear-gradient(135deg, var(--accent2) 0%, var(--accent) 100%)';
  } else {
    btn.style.background = 'linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%)';
  }
}

async function startGameFromModeCheck() {
  stopAllGames(); // 開始前に完全に状態をリセット
  const sessionId = currentSessionId;

  //if (!window._game && !window._puyoGame) window._game = new Game();
  //GameManager.setInstance('p1', window._game); // これを追加！

  const modeId = currentGameMode ? currentGameMode.id : 'marathon';

  // ─── QUIZモード専用処理 ────────────────────────
  if (modeId === 'quiz') {
    // ★ cpu testモードで表示されたEVALエリアをquizモードでは非表示にする
    const evalArea = document.getElementById('eval-area');
    if (evalArea) evalArea.style.display = 'none';
    const garbageArea = document.getElementById('test-garbage-area');
    if (garbageArea) garbageArea.style.display = 'none';
    
    if (typeof startQuizLevel === 'function' && currentQuizLevel) {
      startQuizLevel(currentQuizLevel);
    }
    return;
  }

  // ─── PUYO(シングル)モード専用処理
  if (modeId === 'puyo') {
    window._game = null; // ★ tetインスタンスへの参照を切る

    // ★ cpu testモードで表示されたEVALエリアをぷよモードでは非表示にする
    const evalArea = document.getElementById('eval-area');
    if (evalArea) evalArea.style.display = 'none';
    const garbageArea = document.getElementById('test-garbage-area');
    if (garbageArea) garbageArea.style.display = 'none';
    
    // ★ 修正: puyoゲーム用キャンバスをクリア（古い盤面を削除）
    const puyoMainCanvas = document.getElementById('puyo-main-canvas');
    const puyoNextCanvas = document.getElementById('puyo-next-canvas');
    if (puyoMainCanvas) {
        const ctx = puyoMainCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, puyoMainCanvas.width, puyoMainCanvas.height);
    }
    if (puyoNextCanvas) {
        const ctx = puyoNextCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, puyoNextCanvas.width, puyoNextCanvas.height);
    }
    
    _switchToPuyoLayout(true);

    // ★ 修正: 前のゲーム状態を完全にクリアするため、新規インスタンスを常に作成
    window._puyoGame = new PuyoGame();
    GameManager.setInstance('p1', window._puyoGame);

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
    
    // ★ 追加: ここでも PuyoGame インスタンスを登録
    GameManager.setInstance('p1', window._puyoGame);

    if (!window._puyoGame) window._puyoGame = new PuyoGame();
    window._puyoGame.currentMode = 'test';
    window._puyoGame.isVersusMode = false;
    window._puyoGame.isCpuControlled = testCpuControl;

    const evalArea = document.getElementById('eval-area');
    if (evalArea) {
      evalArea.style.display = 'block';
    }
    const garbageAreaPuyo = document.getElementById('test-garbage-area');
    if (garbageAreaPuyo) garbageAreaPuyo.style.display = 'none';

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

  // ★ 追加: テトの場合はここで Game インスタンスを登録
  GameManager.setInstance('p1', window._game);

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
  const garbageAreaTet = document.getElementById('test-garbage-area');
  if (garbageAreaTet) {
    garbageAreaTet.style.display = (modeId === 'test') ? 'block' : 'none';
  }

  switchPage('game');
  updateLinesGoalDisplay(modeId);
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

// ─── テストモード用: コンソールからおじゃまラインを送る ──────────────
// 使い方: testGarbage(5)  → 5ラインをキューに入れる（1500ms後にready）
window.testGarbage = function(lines) {
  lines = Math.max(1, Math.min(20, parseInt(lines) || 1));
  const game = window._game;
  if (!game || !Array.isArray(game.garbageQueue)) {
    console.warn('[testGarbage] アクティブなtetゲームが見つかりません');
    return;
  }
  const garbageObj = { amount: lines, holes: [], ready: false };
  game.garbageQueue.push(garbageObj);
  setTimeout(() => {
    if (game.garbageQueue.includes(garbageObj) && garbageObj.amount > 0) {
      garbageObj.ready = true;
    }
  }, 1500);
  console.log(`[testGarbage] ${lines}ライン投入（1500ms後に降下）`);
};

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

  // 初期ロード時（HTMLのactiveクラスで表示）もメニューと同じ登場演出を再生
  if (typeof initMenuAnimations === 'function') initMenuAnimations('title');
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
    window.SeManager?.play('resume');
    handlePauseAction('resume');
  } else {
    // プレイ中のみポーズ発動
    const canPauseGame = window._game && (window._game.state === 'playing' || window._game.state === 'active');
    const canPausePuyo = window._puyoGame && (window._puyoGame.state === 'playing' || window._puyoGame.state === 'active');

    // ぷよプレイ中（CPUテスト/QUIZぷよ）かどうかを判定（tetインスタンスへの操作を抑制するために使用）
    // ※ resume 側（handlePauseAction）の _suppressTet と対称にすること。
    const _isQuizPuyo2 = (currentGameMode && currentGameMode.id === 'quiz') &&
        typeof currentQuizLevel !== 'undefined' && currentQuizLevel &&
        currentQuizLevel.rule === 'puyo';
    const _isTestPuyo2 = (currentGameMode && currentGameMode.id === 'test') && testRule === 'puyo';
    const _suppressTet2 = _isQuizPuyo2 || _isTestPuyo2;

    if (canPauseGame || canPausePuyo) {
      window.SeManager?.play('pause');
      // ぷよプレイ中はtetインスタンスのpauseを呼ばない（resume時の暴発防止）
      if (window._game && typeof window._game.pause === 'function' && !_suppressTet2) window._game.pause();
      if (window._puyoGame && typeof window._puyoGame.pause === 'function') window._puyoGame.pause();

      const isQuiz = currentGameMode && currentGameMode.id === 'quiz';

      // QUIZモード時のみ LEVEL SELECT ボタンを表示
      const levelSelectBtn = document.getElementById('pause-quiz-level-select-btn');
      if (levelSelectBtn) levelSelectBtn.style.display = isQuiz ? '' : 'none';

      // QUIZモード時は MODE SELECT ボタンを非表示（LEVEL SELECT で代替）
      const modeSelectBtn = document.getElementById('pause-mode-select-btn');
      if (modeSelectBtn) {
        modeSelectBtn.style.display = isQuiz ? 'none' : '';
        if (!isQuiz) _applyModePauseSelectStyle(modeSelectBtn);
      }

      // QUIZモード時のみレベル情報ブロックを表示・更新
      const quizInfo = document.getElementById('pause-quiz-info');
      if (quizInfo) {
        if (isQuiz && typeof currentQuizLevel !== 'undefined' && currentQuizLevel) {
          const lv = currentQuizLevel;
          const ruleLabel = lv.rule === 'tet' ? 'TET' : 'PUYO';
          let levelNum = '';
          if (typeof QUIZ_LEVELS !== 'undefined' && QUIZ_LEVELS[lv.rule]) {
            const idx = QUIZ_LEVELS[lv.rule].findIndex(l => l.id === lv.id);
            if (idx !== -1) levelNum = idx + 1;
          }
          const ruleTitleEl = document.getElementById('pause-quiz-info-rule-title');
          const descEl      = document.getElementById('pause-quiz-info-desc');
          const goalEl      = document.getElementById('pause-quiz-info-goal');
          if (ruleTitleEl) ruleTitleEl.textContent = `${ruleLabel} - ${levelNum}`;
          if (descEl)      descEl.textContent      = lv.description;
          if (goalEl)      goalEl.textContent      = `GOAL: ${lv.clearCondition.description}`;
          quizInfo.style.display = '';
        } else {
          quizInfo.style.display = 'none';
        }
      }

      overlay.classList.add('active');
    }
  }
}

// ─── CPUテスト(ぷよ)のリスタート ───────────────────────────
//   盤面リセット（_puyoGame.start）に加えて CPUコントローラを完全に作り直す。
//   コントローラを stop しないと、旧 worker / soft-drop RAF / 着手予測オーバーレイ
//   （estimateContainer のゴーストぷよ）が残留して盤面が消えないため。
//   R キー（puyo/input.js）とポーズメニュー RESTART の両経路から呼ばれる。
function restartPuyoCpuTest() {
  if (!window._puyoGame || typeof window._puyoGame.start !== 'function') return;

  // クラスはロード済み（DEV_CPU はロード後 window に残る）なので再ロードせず再利用する。
  const CPUClass = (window._cpuController && window._cpuController.constructor) || window.PuyoCPU4;

  // 旧コントローラを停止：worker.terminate / RAF キャンセル / オーバーレイ innerHTML='' を行う
  if (window._cpuController && typeof window._cpuController.stop === 'function') {
    window._cpuController.stop();
  }
  window._cpuController = null;

  // 盤面リセット＆カウントダウン再開
  window._puyoGame.isCpuControlled = testCpuControl;
  window._puyoGame.start();

  // CPUコントローラを作り直してアタッチ（_updateLoop は state==='playing' まで待機するので即時生成でOK）
  if (typeof CPUClass === 'function') {
    window._cpuController = new CPUClass(window._puyoGame);
    window._cpuController.isAutoPlay = testCpuControl;
    if (typeof window._cpuController.start === 'function') {
      window._cpuController.start();
    }
  }
}

function handlePauseAction(action) {
  const overlay = document.getElementById('pause-overlay');
  if (overlay) overlay.classList.remove('active');

  switch (action) {
    case 'resume': {
      // PUYOプレイ中（単体/CPUテスト/QUIZぷよ）は休眠中の tet インスタンスの resume を呼ばない。
      // ※ ぷよTESTモードでは window._game が base.js の未起動 tet のまま残るため、ここで
      //   resume してしまうと mino 不在のまま startGravity が回りエラーを吐き続ける。
      const _modeId = currentGameMode && currentGameMode.id;
      const _isQuizPuyo = _modeId === 'quiz' &&
          typeof currentQuizLevel !== 'undefined' && currentQuizLevel &&
          currentQuizLevel.rule === 'puyo';
      const _isTestPuyo = _modeId === 'test' && testRule === 'puyo';
      const _suppressTet = _modeId === 'puyo' || _isTestPuyo || _isQuizPuyo;
      if (window._game && typeof window._game.resume === 'function' && !_suppressTet) {
        window._game.resume();
      }
      if (window._puyoGame && typeof window._puyoGame.resume === 'function') window._puyoGame.resume();
      break;
    }
    case 'settings':
      // pause-overlay を閉じる前に「設定から戻ったらポーズ画面を再表示する」フラグを立てる
      window._returnToPause = true;
      overlay.classList.remove('active'); // ← これを追加
      switchPage('settings');
      break;
    case 'restart':
      // ─── QUIZモード専用リスタート（quiz.js の startQuizLevel を使用） ───
      if (currentGameMode && currentGameMode.id === 'quiz') {
          if (typeof startQuizLevel === 'function' && typeof currentQuizLevel !== 'undefined' && currentQuizLevel) {
              startQuizLevel(currentQuizLevel);
          }
      } else if (currentGameMode && currentGameMode.id === 'test' && testRule === 'puyo') {
          // ★ CPUテスト(ぷよ): 盤面リセットに加えてCPUコントローラも作り直す（pause/resume と対称）
          restartPuyoCpuTest();
      } else if (currentGameMode && currentGameMode.id === 'puyo') {
          if (window._puyoGame && typeof window._puyoGame.start === 'function') window._puyoGame.start();
      } else {
          if (window._game && typeof window._game.start === 'function') window._game.start();
      }
      break;
    case 'quiz-levelselect':
      stopAllGames();
      switchPage('quiz-check');
      break;
    case 'mode-select':
      stopAllGames();
      _switchToPuyoLayout(false);
      switchPage('mode-check');
      break;
    case 'mainmenu':
      stopAllGames();
      _switchToPuyoLayout(false);
      switchPage('main-menu');
      break;
  }
}

// ─── pause-overlay が active になった瞬間に QUIZ レベル情報を更新 ───
// game.js の togglePause() 経由など toggleGamePause() を通らない経路にも対応
(function setupPauseQuizInfoObserver() {
  const overlay = document.getElementById('pause-overlay');
  if (!overlay) return;

  const observer = new MutationObserver(() => {
    const isQuiz = currentGameMode && currentGameMode.id === 'quiz';
    const quizInfo = document.getElementById('pause-quiz-info');
    if (!quizInfo) return;

    if (overlay.classList.contains('active') && isQuiz &&
        typeof currentQuizLevel !== 'undefined' && currentQuizLevel) {
      const lv = currentQuizLevel;
      const ruleLabel = lv.rule === 'tet' ? 'TET' : 'PUYO';
      
      // ─── 修正箇所: lv.title を廃止し、QUIZ_LEVELSからレベル値を算出 ───
      let levelNum = '';
      if (typeof QUIZ_LEVELS !== 'undefined' && QUIZ_LEVELS[lv.rule]) {
          const idx = QUIZ_LEVELS[lv.rule].findIndex(l => l.id === lv.id);
          if (idx !== -1) {
              levelNum = idx + 1;
          }
      }

      const ruleTitleEl = document.getElementById('pause-quiz-info-rule-title');
      const descEl      = document.getElementById('pause-quiz-info-desc');
      const goalEl      = document.getElementById('pause-quiz-info-goal');
      
      // 算出した levelNum を使ってタイトルを表示
      if (ruleTitleEl) ruleTitleEl.textContent = `${ruleLabel} - ${levelNum}`;
      // ──────────────────────────────────────────────────────────

      if (descEl)      descEl.textContent      = lv.description;
      if (goalEl)      goalEl.textContent      = `GOAL: ${lv.clearCondition.description}`;
      quizInfo.style.display = '';

      // LEVEL SELECT ボタンも同じタイミングで確実に表示
      const levelSelectBtn = document.getElementById('pause-quiz-level-select-btn');
      if (levelSelectBtn) levelSelectBtn.style.display = '';

      // QUIZモード中は MODE SELECT を非表示
      const modeSelectBtn = document.getElementById('pause-mode-select-btn');
      if (modeSelectBtn) modeSelectBtn.style.display = 'none';
    } else if (!overlay.classList.contains('active') || !isQuiz) {
      quizInfo.style.display = 'none';
      const levelSelectBtn = document.getElementById('pause-quiz-level-select-btn');
      if (levelSelectBtn) levelSelectBtn.style.display = 'none';
      // 非Quizモードでは MODE SELECT を表示（ポーズ画面が開いているときのみ）
      const modeSelectBtn2 = document.getElementById('pause-mode-select-btn');
      if (modeSelectBtn2 && overlay.classList.contains('active')) {
        modeSelectBtn2.style.display = '';
        _applyModePauseSelectStyle(modeSelectBtn2);
      }
    }
  });

  observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
})();

// ─────────────────────────────────────────────
// ★ 隠し要素: CPU LV6 ショートカット
// versus-check または mode-check(testモード) の準備画面で
// 「6」キー（numキーではない）を押すと、
// tetルールが選択されている場合のみ LV6 を呼び出してゲームを即スタートする
//   ・「6」 → PC（パーフェクトクリア）探索あり（従来どおり）
//   ・「7」 → PC探索なし（cpu6.js shouldSearchPC を window.__cpu6DisablePC で抑止）
// ─────────────────────────────────────────────
(function setupHiddenLv6Key() {
  document.addEventListener('keydown', function(e) {
    // Digit6 / Digit7（テンキーではない「6」「7」）のみ対象
    if (e.code !== 'Digit6' && e.code !== 'Digit7') return;
    const disablePC = (e.code === 'Digit7');

    const versusCheckPage = document.getElementById('versus-check-page');
    const modeCheckPage   = document.getElementById('mode-check-page');

    const isVersusCheck = versusCheckPage && versusCheckPage.classList.contains('active');
    const isTestCheck   = modeCheckPage   && modeCheckPage.classList.contains('active')
                          && currentGameMode && currentGameMode.id === 'test';

    // どちらの準備画面でもない場合は何もしない
    if (!isVersusCheck && !isTestCheck) return;

    // ─── versus-check 画面: CPU RULE が tet の場合のみ有効 ───
    if (isVersusCheck) {
      if (versusCpuRule !== 'tet') return;
      e.preventDefault();

      // PC探索の有無を起動前にフラグでセット（cpu6.js が参照）
      window.__cpu6DisablePC = disablePC;
      // LV6 を強制設定してからゲームを開始
      selectedCpuLevel = 6;
      startVersusGame();
      return;
    }

    // ─── mode-check(test) 画面: RULE が tet の場合のみ有効 ───
    if (isTestCheck) {
      if (testRule !== 'tet') return;
      e.preventDefault();

      // PC探索の有無を起動前にフラグでセット（cpu6.js が参照）
      window.__cpu6DisablePC = disablePC;
      // LV6 を強制設定してからゲームを開始
      selectedCpuLevel = 6;
      startGameFromModeCheck();
      return;
    }
  });
})();
