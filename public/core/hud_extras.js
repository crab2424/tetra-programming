// ─────────────────────────────────────────────
// hud_extras.js — APM/LPM/TIME（上級者向けHUD）の描画ループ
//
// tet/puyoエンジン内部を変更せず、window._game/_cpuGameを外側から100ms間隔で
// ポーリングして描画する。SETTINGS > DISPLAY がOFFの間は計算・DOM書き込みを
// 完全にスキップする（非表示なら計算しない、という既存の負荷対策方針に合わせる）。
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

  function tick() {
    if (typeof currentDisplay === 'undefined') return;
    const wantApm = !!currentDisplay.apm;
    const wantTime = !!currentDisplay.versusTime;
    if (!wantApm && !wantTime) return;

    const gamePage = document.getElementById('game-page');
    const versusPage = document.getElementById('versus-page');
    if (wantApm && gamePage && gamePage.classList.contains('active')) {
      updateSingle(window._game);
    }
    if (versusPage && versusPage.classList.contains('active')) {
      // TIME: player/cpu どちらも同時にスタートする前提で片方（player相当=window._game）の
      // 経過時間を共有表示に使う（ルール混在でも tet/puyo 両方に getActiveMs() を実装済み）。
      if (wantTime) setText('versus-time-value', fmtTime((window._game && typeof window._game.getActiveMs === 'function') ? window._game.getActiveMs() : 0));
      if (wantApm) {
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
  }

  // rAFはタブ非表示中に停止/大幅間引きされ得るため、独立したタイマーで駆動する
  // （100msごとの表示更新なので60fps精度は不要）。
  setInterval(tick, 100);
})();
