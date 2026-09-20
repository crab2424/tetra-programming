// ─────────────────────────────────────────────
// board_swap.js — 【デバッグ用・隠し機能】VERSUS中に自分とCPUの盤面を入れ替える
//
// トリガー: Shift + Alt + S、または Digit9（テンキーではない「9」）
//   keydown を capture フェーズで受け、成立したら preventDefault +
//   stopImmediatePropagation する。エンジン側の入力ハンドラ（game/tet/input.js・
//   game/puyo/input.js）は bubble フェーズ登録なので、キーコンフィグで「9」等に
//   何を割り当てていてもゲーム操作としては発火しない。
//
// 方針: インスタンスそのものではなく「進行に影響する状態」だけを入れ替える。
//   _game / _cpuGame の対応（canvasPrefix・statsPrefix・キー入力の有無・
//   sendGarbage の相手解決）は触らないので、入れ替え後も
//   「左＝プレイヤー操作・右＝CPU操作」の関係はそのまま保たれる。
//
// 入れ替える  : 盤面 / NEXT（内部キュー・bag・ツモ乱数）/ HOLD / 操作中のミノ・ぷよ /
//               進行中の連鎖（puyo の _gs ステートマシンと演出タイマー一式）/
//               火力の端数・REN・B2B / 着弾待ちのおじゃま（garbageQueue・予告ゲージ）
// 入れ替えない: スコア・ライン数(最大連鎖)・時間・APM などのHUD値、マージンタイマー、
//               押しっぱなしのキー状態、連鎖文字などサイド固有のDOM
// リセットする: 操作中のミノ・ぷよの位置と向きだけ（開始位置へ戻す。NEXTは進めない）
//
// 制限: 同ルール同士（TET↔TET / PUYO↔PUYO）のみ。異種はキャンバス寸法・NEXT/HOLD
//       パネル・おじゃま予告DOM・BattleLayout を対戦中に作り直す必要があるため対象外。
// ─────────────────────────────────────────────
const BoardSwap = (() => {

  // ─── 入れ替え対象のフィールド ─────────────────────────
  // ここに無いものは「そのサイドに据え置き」になる。

  // tet（Game）。level/lines/score/attackSent/elapsedTime はHUD側なので入れない。
  const TET_SWAP_KEYS = [
    'field',                         // Field インスタンスごと入れ替える
    'mino',                          // 操作中のミノも持っていく（捨てない）
    'holdMino', 'canHold',
    'nextQueue', 'bag', 'tumoRng',   // ツモは乱数の続きごと持っていく
    'ren', 'backToBack',             // 火力計算に効くので盤面側の情報として扱う
    'pendingAttack', 'pendingInternalAttack',
    'garbageQueue', '_garbageTimers',
  ];

  // puyo（PuyoGame）。score/chainMax/clearedPuyos/attackSent は据え置き。
  // ★ 連鎖は「_gs ステートマシン＋演出タイマー」で進むので、その一式を丸ごと持っていく。
  //   途中で止めて捨てると、消えるはずのぷよが盤面に残り連鎖数も切れてしまう。
  const PUYO_SWAP_KEYS = [
    // 盤面・ツモ
    'field', 'nextQueue', 'activeColors', 'rng',
    // 火力・おじゃま
    'attackScore', 'generatedOjamaTotal', 'pendingFire',
    'tetAttackCarry', 'tetAttackLines', 'tetPendingFire', 'tetDropScore', 'hasTetZenkeshi',
    '_tetCalcAdd', '_tetCalcN',
    'garbageQueue', 'ojamaUpdateQueue', 'sentGarbageThisTurn', 'hasDroppedOjamaThisTurn',
    // 進行中の連鎖（ステートマシン本体と各フェーズのタイマー／対象セル）
    '_gs', 'chainCount', 'pendingChainGroups',
    '_erasingCells', '_eraseTimer', 'eraseWaitTimer', '_dropAnim',
    'activeAnims', 'fixAnimTimer', 'fixAnimDuration', 'fw5fTimer', 'spawnAnimTimer',
    'isAllClear', 'splitPuyo',
    // 操作中のぷよ
    'pivotX', 'pivotY', 'pivotColor', 'childColor',
    'targetRot', 'targetAnimRot', 'animRot',
    'fallTimer', 'lockTimer', 'scoreFloat', 'quickTurnCount',
    'lastRotationInfo', 'moveLockCount', '_priorityMove',
  ];
  // ※ _animMap / _erasingSet は _render が毎フレーム clear して作り直すだけの
  //   スクラッチバッファなので、サイドごとに持たせたままにする。

  function swapKeys(a, b, keys) {
    for (const k of keys) {
      const t = a[k];
      a[k] = b[k];
      b[k] = t;
    }
  }

  // ─── 実行可否 ─────────────────────────────────────
  // 「対戦がまさに進行中」でなければ何もしない（カウントダウン中・ポーズ中・
  //  決着演出中に状態を差し替えると、復帰処理と二重にタイマーを触ることになる）。
  function canSwap() {
    const page = document.getElementById('versus-page');
    if (!page || !page.classList.contains('active')) return false;

    const lc = window.BattleVersusLifecycle;
    if (!lc || lc.phase !== 'playing') return false;

    const p = window._game;
    const c = window._cpuGame;
    if (!p || !c) return false;

    // 同ルール同士のみ
    if (typeof versusPlayerRule === 'undefined' || typeof versusCpuRule === 'undefined') return false;
    if (versusPlayerRule !== versusCpuRule) return false;

    const pauseOverlay = document.getElementById('versus-pause-overlay');
    if (pauseOverlay && pauseOverlay.classList.contains('active')) return false;

    for (const g of [p, c]) {
      if (g.isPaused) return false;
      if (g.isCountingDown) return false;                 // tet
      if (g.state && g.state !== 'playing') return false; // puyo（'starting'/'gameover'等）
      if (g.isFinishing) return false;                    // tet の終了演出
    }
    return true;
  }

  // ─── tet: 入れ替え後の後始末 ───────────────────────────
  // 操作中のミノは捨てずに、そのまま開始位置へ戻す（NEXTは進めない・HOLD権も維持）。
  // initBlocks() を先に呼ぶのは、spawn() が x/y/rotation しか戻さず、回転で
  // 書き換えられた blocks の形が残ってしまうため。
  function finishTet(g) {
    if (g.lockTimer) { clearTimeout(g.lockTimer); g.lockTimer = null; }
    g._wasLockingWhenPaused = false;
    g.isGrounded = false;
    g.moveCount = 0;
    g.lastActionWasRotation = false;
    g.lastRotUsedPoint5 = false;
    g.field.markDirty();

    // おじゃま猶予タイマーのコールバックは生成時の受け手を掴んでいるため、
    // 配列ごと持ち主が変わったこのタイミングで新しい持ち主へ貼り直す。
    window.BattleGarbage.reseatLocalGarbageTimers(g);

    if (g.mino) {
      g.mino.initBlocks();
      g.mino.spawn();
      // popMino と同じ出現位置の致命判定
      if (!g.valid(0, 0)) {
        g.mino.y -= 1;
        if (!g.valid(0, 0)) { g.gameOver(); return; }
      }
      g.lowestY = g.mino.y;
      g.startGravity();
    } else {
      // ミノ未出現の一瞬（固定〜次の出現の間）で入れ替えた場合だけNEXTから出す
      g.popMino();
      if (g.isFinishing) return;
    }

    g.updateGarbageGauge();
    g.updateAttackGauge();
    g.drawAll();
  }

  // ─── puyo: 入れ替え前に「そのサイドに残す」ぶんを確定させる ──────────
  // 連鎖得点は eraseWait の終わりにまとめて score へ入るため、入れ替えを跨ぐと
  // 移った先のスコアに加算されてしまう。スコアはHUD＝据え置きなので、
  // 入れ替える前に今の持ち主へ確定させておく。
  function flushPuyoChainScore(g) {
    if (g.chainScoreAdd > 0) {
      g.score += g.chainScoreAdd;
      g.chainScoreAdd = 0;
    }
    g.chainScoreStr = '';
    // 連鎖文字DOMはサイド固有の要素を掴んでいるので、移動させずここで消す
    g._clearChainTextDOM();
  }

  // ─── puyo: 入れ替え後の後始末 ─────────────────────────
  // 連鎖の途中（erasing/eraseWait/dropping 等）ならステートごと移ってきているので
  // そのまま続行させる。操作可能な状態（falling）のときだけ開始位置へ戻す。
  function finishPuyo(g) {
    if (g._gs === 'falling') {
      g.pivotX = 2;
      g.pivotY = -0.5;
      g.targetRot = 0;
      g.targetAnimRot = 0;
      g.animRot = 0;
      g.fallTimer = 0;
      g.lockTimer = 0;
      g.scoreFloat = 0;
      g.quickTurnCount = 0;
      g.lastRotationInfo = null;
      g.moveLockCount = 0;
      g._priorityMove = false;
      // _spawnPuyo と同じ出現位置の致命判定
      if (!g._isCellEmpty(2, 0)) {
        g._gs = 'gameover';
        g._beginGameOver();
        return;
      }
    }

    g._lastYokokuAmount = -1;   // 予告の差分更新キャッシュを無効化して必ず描き直させる
    g.updateGarbageGauge();
    g._updateScoreDisplay();    // 連鎖中は scoreEl に連鎖式が出ているので数値へ戻す
    g._updateChainDisplay(g.chainCount);
    g._updateOjamaYokoku();
    g._render();
    g._renderNext();
  }

  // ─── CPUの読み直し ───────────────────────────────

  // puyo: コントローラごと作り直す。ぷよCPUは高速落下用に退避した重力や
  // hasCalculatedForCurrentPiece など「今の1手」の状態を広く抱えており、外から
  // 個別に戻すより stop()（worker を terminate し重力も復元する）→ 作り直しの方が
  // 確実。ぷよCPUは workerReady になるまで待つ作りなので、worker の作り直しで
  // 手が飛ぶこともない。クラスは cpu_loader が window に載せたままなので
  // スクリプトの再ロードは発生しない。
  function recreateCpuController(cpuGame) {
    const old = window._cpuController;
    if (!old) return;
    const CPUClass = old.constructor;
    if (typeof old.stop === 'function') old.stop();
    window._cpuController = new CPUClass(cpuGame);
    if (typeof window._cpuController.start === 'function') window._cpuController.start();
  }

  // tet: コントローラは使い回し、worker を生かしたまま同期し直す。
  // ★ ここで puyo と同じく stop()→作り直しにすると worker + wasm の初期化が
  //   間に合わず、onMinoSpawned() の時点で workerReady === false になる。
  //   tetCPUは全レベル共通で「workerReady でなければ 700ms 後に hardDrop()」という
  //   フォールバックを持つため、入れ替え直後の1手だけ即置きになる（実機で確認された挙動）。
  //   worker を作り直さなければ workerReady は true のままなので、これは起きない。
  const STALE_RESULT_TIMEOUT_MS = 2000;

  function resyncTetCpu() {
    const ctrl = window._cpuController;
    if (!ctrl) return;

    // 入れ替え前の盤面向けに積まれた操作列を捨てる。実行待ちの setTimeout は
    // processActionQueue の先頭で「キューが空」を見て自分で終わる。
    ctrl.actionQueue = [];
    ctrl.isExecutingAction = false;
    ctrl.bestMoveData = null;
    ctrl.lastGhostState = null;
    ctrl.pendingGhostState = null;
    ctrl.isCalculatingSingle = false;

    const wasCalculating = !!ctrl.isCalculating;
    const staleMino = ctrl.currentMino;

    // lv6 はPC探索という別系統の先読みを持つので専用のリセットに任せる
    // （pcSearchId を進めて進行中のPC結果を無効化し、gravityDisabled も戻す）。
    if (typeof ctrl.resetPCState === 'function') ctrl.resetPCState();

    if (wasCalculating && ctrl.worker) {
      // 飛んでいる計算結果は入れ替え前の盤面に対するもの。各レベルが持つ
      // 「game.mino === this.currentMino のときだけ実行」ガードに捨てさせるため、
      // currentMino は古いミノを指したまま残す（入れ替えで相手側へ移っているので
      // 必ず不一致になる）。古い結果が届いてから currentMino を null にして、
      // 次フレームの updateLoop に onMinoSpawned() を出し直させる。
      ctrl.currentMino = staleMino;
      const w = ctrl.worker;
      const orig = w.onmessage;
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        if (w.onmessage !== orig) w.onmessage = orig;
        ctrl.isCalculating = false;
        ctrl.currentMino = null;
      };
      w.onmessage = (e) => {
        orig.call(w, e);
        if (e.data && e.data.type === 'result') release();
      };
      // 古い結果が返らずCPUが止まったままにならないための保険
      setTimeout(release, STALE_RESULT_TIMEOUT_MS);
    } else {
      ctrl.isCalculating = false;
      ctrl.currentMino = null;
    }
  }

  // ─── 本体 ───────────────────────────────────────
  function swap() {
    if (!canSwap()) return false;

    const p = window._game;
    const c = window._cpuGame;
    const isPuyo = (versusPlayerRule === 'puyo');

    // 入れ替えから後始末・CPU同期までは同期的に走りきるので、途中でCPUが
    // 古い盤面へ入力を流し込む隙はない（ここで stop() する必要はない）。
    if (isPuyo) {
      flushPuyoChainScore(p);
      flushPuyoChainScore(c);
    }

    swapKeys(p, c, isPuyo ? PUYO_SWAP_KEYS : TET_SWAP_KEYS);

    if (isPuyo) {
      finishPuyo(p);
      finishPuyo(c);
    } else {
      finishTet(p);
      finishTet(c);
    }

    // 入れ替えた盤面が即詰みで決着した場合はコントローラを触らない
    if (window.BattleVersusLifecycle.phase !== 'playing') return true;

    if (isPuyo) recreateCpuController(c);
    else resyncTetCpu();
    return true;
  }

  // ─── キートリガー ─────────────────────────────────
  function isTriggerKey(e) {
    if (e.repeat) return false;
    if (e.code === 'Digit9' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return true;
    if (e.code === 'KeyS' && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey) return true;
    return false;
  }

  function install() {
    // capture フェーズ: エンジン/ポーズの keydown ハンドラより先に受け取り、
    // 成立時はそこへ伝播させない（キーコンフィグとの衝突をここで断つ）。
    document.addEventListener('keydown', function(e) {
      if (!isTriggerKey(e)) return;
      if (!canSwap()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      swap();
    }, true);
  }

  return { install, swap, canSwap };
})();

BoardSwap.install();
window.BoardSwap = BoardSwap;
