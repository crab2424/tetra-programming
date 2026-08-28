// ─────────────────────────────────────────────
// hud_extras.js — APM/LPM/TIME（上級者向けHUD）の描画ループ
//
// tet/puyoエンジン内部を変更せず、window._game/_cpuGameを外側からrAFで
// ポーリングして描画する。TIME（センチ秒表示）は毎フレーム更新して滑らかに、
// APM/LPMは値の暴れと無駄なDOM書き込みを避けるため100ms間隔に間引く。
// SETTINGS > DISPLAY がOFFの間・対象ページが非アクティブな間はrAFループ自体を
// 止め、計算・DOM書き込みを完全にスキップする（非表示なら計算しない、という
// 既存の負荷対策方針に合わせる）。
// ─────────────────────────────────────────────

(function () {
  function fmtTime(ms) {
    if (!(ms >= 0)) ms = 0;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
  }

  function fmtRate(count, activeMs) {
    if (!(activeMs > 0)) return '--';
    const perMin = (count || 0) / (activeMs / 60000);
    return perMin.toFixed(1);
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  // 前局の値が画面に残らないよう、HUD拡張の表示を一括で初期値へ戻す。
  // ゲーム開始（READY表示）より前に呼ぶこと。
  const RATE_IDS = [
    'apm-value', 'lpm-value',
    'player-apm-value', 'player-lpm-value',
    'cpu-apm-value', 'cpu-lpm-value',
  ];
  function blank() {
    RATE_IDS.forEach((id) => setText(id, '--'));
    setText('versus-time-value', fmtTime(0));
  }

  function updateSingle(game) {
    // ゲーム未生成（モード切替直後など）の間に前局の数値を残さない。
    if (!game || typeof game.getActiveMs !== 'function') {
      setText('apm-value', '--');
      setText('lpm-value', '--');
      return;
    }
    const activeMs = game.getActiveMs();
    setText('apm-value', fmtRate(game.attackSent, activeMs));
    setText('lpm-value', fmtRate(game.lines, activeMs));
  }

  let rafId = null;
  let lastApmTs = 0;

  function shouldRun() {
    if (typeof currentDisplay === 'undefined') return false;
    const wantApm = !!currentDisplay.apm;
    const wantTime = !!currentDisplay.versusTime;
    if (!wantApm && !wantTime) return false;

    const gamePage = document.getElementById('game-page');
    const versusPage = document.getElementById('versus-page');
    const gameActive = !!(gamePage && gamePage.classList.contains('active'));
    const versusActive = !!(versusPage && versusPage.classList.contains('active'));
    return (wantApm && gameActive) || versusActive;
  }

  function tick(ts) {
    if (!shouldRun()) { rafId = null; return; }

    const wantApm = !!currentDisplay.apm;
    const wantTime = !!currentDisplay.versusTime;
    const doApm = wantApm && (ts - lastApmTs >= 100);
    if (doApm) lastApmTs = ts;

    const gamePage = document.getElementById('game-page');
    const versusPage = document.getElementById('versus-page');
    if (doApm && gamePage && gamePage.classList.contains('active')) {
      updateSingle(window._game);
    }
    if (versusPage && versusPage.classList.contains('active')) {
      // TIME: player/cpu どちらも同時にスタートする前提で片方（player相当=window._game）の
      // 経過時間を共有表示に使う（ルール混在でも tet/puyo 両方に getActiveMs() を実装済み）。
      if (wantTime) setText('versus-time-value', fmtTime((window._game && typeof window._game.getActiveMs === 'function') ? window._game.getActiveMs() : 0));
      if (doApm) {
        // ゲーム未生成の間に前局の数値を残さない（'--'へ戻す）。
        if (window._game && typeof window._game.lines === 'number') {
          setText('player-apm-value', fmtRate(window._game.attackSent, window._game.getActiveMs()));
          setText('player-lpm-value', fmtRate(window._game.lines, window._game.getActiveMs()));
        } else {
          setText('player-apm-value', '--');
          setText('player-lpm-value', '--');
        }
        if (window._cpuGame && typeof window._cpuGame.lines === 'number') {
          setText('cpu-apm-value', fmtRate(window._cpuGame.attackSent, window._cpuGame.getActiveMs()));
          setText('cpu-lpm-value', fmtRate(window._cpuGame.lines, window._cpuGame.getActiveMs()));
        } else {
          setText('cpu-apm-value', '--');
          setText('cpu-lpm-value', '--');
        }
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  function ensureRunning() {
    if (rafId === null && shouldRun()) {
      lastApmTs = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  // rAFループの起動有無を監視する保険のタイマー（実際の描画はrAFが担う）。
  // ページ遷移時は switchPage() が HudExtras.reset()/refresh() を即時に呼ぶため、
  // このタイマーは SETTINGS > DISPLAY のON切替など経路外の変化を拾うだけ。
  setInterval(ensureRunning, 500);
  ensureRunning();

  // switchPage() から呼ぶ。reset() で前局の値を即座に'--'へ戻し（READY表示より前）、
  // refresh() で500ms待たずにrAFループを起動する。
  window.HudExtras = { reset: blank, refresh: ensureRunning };
})();
