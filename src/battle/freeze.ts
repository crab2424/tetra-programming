/**
 * 対戦（CPU戦・オンライン戦共通）のゲーム停止処理。
 *
 * ★ なぜ切り出すか（2026-07-25 の不具合の再発防止）:
 *   PuyoGame は `isPaused` を**停止条件として一切参照しない**（`_loop`/`_update` は
 *   `state` だけを見る。`public/game/puyo/engine.js:154`）。さらに `stop(keepCanvas=true)` は
 *   「勝者側の盤面・NEXTを残す」ため `state='idle'` の代入も `cancelAnimationFrame` も
 *   スキップする（`public/game/puyo/lifecycle.js:98-105`）。
 *   したがって「自分では死んでいない勝者の PuyoGame」を止めるには、
 *   **stop() の後に `state='gameover'` を明示代入する**必要がある。
 *   CPU戦(`public/app/versus.js` の stopGame)はこれを行っていたが、オンライン戦の
 *   `freezeGame()` は `isPaused=true` + `stop(true)` だけで、決着後もぷよが落ち続けていた。
 *
 *   同じ作法が2箇所に散っている限り再発するので、「対戦を止める」手順はこのファイルだけに置き、
 *   CPU戦(プレーンJS)からは window.BattleFreeze 経由で使う。
 */

type AnyGame = any;

export interface FreezeOptions {
  /**
   * true = キャンバス・描画ループを残したまま論理進行だけ止める（勝敗演出中に盤面を見せる）。
   * false = 完全停止（キャンバスもクリアされうる）。決着時は基本 true。
   */
  keepCanvas?: boolean;
  /** キー入力・パッド・DASループを解除するか（既定 true）。 */
  removeInput?: boolean;
}

/** おじゃま降下猶予タイマー（tet/puyo 共通の `_garbageTimers`）を全て止める。 */
function clearGarbageTimers(game: AnyGame): void {
  if (!game?._garbageTimers?.length) return;
  for (const t of game._garbageTimers) {
    if (t?.id) clearTimeout(t.id);
  }
  game._garbageTimers = [];
}

/**
 * TET(`Game`)を停止する。重力interval・ロック待ち・おじゃまタイマー・経過時間計測を止め、
 * `isPaused=true` で入力と rAF 更新を無効化する（tet は isPaused を実際に参照する）。
 */
export function freezeTetGame(game: AnyGame, options: FreezeOptions = {}): void {
  if (!game) return;
  const removeInput = options.removeInput ?? true;

  if (game.timer) {
    clearInterval(game.timer);
    game.timer = null;
  }
  if (game.lockTimer) {
    clearTimeout(game.lockTimer);
    game.lockTimer = null;
  }
  clearGarbageTimers(game);

  if (game.isTimerRunning) {
    game.elapsedTime += performance.now() - game.startTime;
    game.isTimerRunning = false;
    if (game.timerReqId) cancelAnimationFrame(game.timerReqId);
  }

  if (removeInput) {
    if (game._keyLoop) {
      clearInterval(game._keyLoop);
      game._keyLoop = null;
    }
    if (game._gamepadLoop) {
      clearInterval(game._gamepadLoop);
      game._gamepadLoop = null;
    }
    if (game._keyDownHandler) document.removeEventListener("keydown", game._keyDownHandler);
    if (game._keyUpHandler) document.removeEventListener("keyup", game._keyUpHandler);
  }

  // tet は input.js / rAFループが isPaused を参照するので、これが実質の停止スイッチ。
  game.isPaused = true;

  if (!options.keepCanvas) game.stopRenderLoop?.();
}

/**
 * PUYO(`PuyoGame`)を停止する。
 *
 * ★ 順序が重要: `_versusFinishing` を先に立ててから `stop()` し、**最後に `state='gameover'`**。
 *   - `_versusFinishing` を立てずに stop(false) するとキャンバスがクリアされ盤面が真っ暗になる。
 *   - `state='gameover'` を代入しないと `_loop()` の `state === 'playing'` 判定が真のままで
 *     `_update(dt)` が回り続ける＝止まらない（keepCanvas は loop を止めないため）。
 */
export function freezePuyoGame(game: AnyGame, options: FreezeOptions = {}): void {
  if (!game) return;
  const keepCanvas = options.keepCanvas ?? true;

  clearGarbageTimers(game);
  if (keepCanvas) game._versusFinishing = true;
  try {
    game.stop?.(keepCanvas);
  } catch {
    // stop() 内部の DOM 掃除で失敗しても、下の state 代入だけは必ず通す
  }
  // ここが停止の本体。stop() 後に代入しないと keepCanvas 経路で state が 'playing' のまま残る。
  game.state = "gameover";
  game._gs = "gameover";
  game.isPaused = true; // 参照はされないが、外から状態を見る箇所との互換のため揃える
  game._clearChainTextDOM?.();
}

/** ルール名で振り分ける薄いラッパ。 */
export function freezeGameByRule(
  game: AnyGame,
  rule: "tet" | "puyo",
  options: FreezeOptions = {},
): void {
  if (rule === "puyo") freezePuyoGame(game, options);
  else freezeTetGame(game, options);
}

export const BattleFreeze = {
  freezeTetGame,
  freezePuyoGame,
  freezeGameByRule,
};

// プレーンJS（public/app/versus.js）からの参照用
declare global {
  interface Window {
    BattleFreeze: typeof BattleFreeze;
  }
}
window.BattleFreeze = BattleFreeze;
