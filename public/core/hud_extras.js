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
    if (!(activeMs >= 3000)) return '--';
    const perMin = (count || 0) / (activeMs / 60000);
    return perMin.toFixed(1);
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function updateSingle(game) {
    if (!game || typeof game.getActiveMs !== 'function') return;
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
        if (window._game && typeof window._game.lines === 'number') {
          setText('player-apm-value', fmtRate(window._game.attackSent, window._game.getActiveMs()));
          setText('player-lpm-value', fmtRate(window._game.lines, window._game.getActiveMs()));
        }
        if (window._cpuGame && typeof window._cpuGame.lines === 'number') {
          setText('cpu-apm-value', fmtRate(window._cpuGame.attackSent, window._cpuGame.getActiveMs()));
          setText('cpu-lpm-value', fmtRate(window._cpuGame.lines, window._cpuGame.getActiveMs()));
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

  // rAFループの起動有無だけを監視する軽量タイマー（実際の描画はrAFが担う）。
  // SETTINGS > DISPLAY のON切替やページ遷移から最大500ms遅れて再開する。
  setInterval(ensureRunning, 500);
  ensureRunning();
})();
