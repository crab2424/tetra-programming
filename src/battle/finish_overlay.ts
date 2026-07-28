/**
 * 対戦の終了演出（WIN! / LOSE... / GAME OVER）を出す唯一の入口。
 *
 * CPU戦(`public/app/versus.js`)とオンライン戦(`src/online/online_game.ts`)が
 * それぞれ別々に文言・CSSクラス・表示時間を持っていたため、両者の見た目がズレていた。
 * さらにオンラインは自分の TET フィールド内のオーバーレイ1枚しか叩いておらず、
 *  - 自分が PUYO のとき: そのオーバーレイは display:none の TET フィールド内 ＝ 何も出ない
 *  - 相手スロット: そもそもオーバーレイ要素が無い（CPU戦は両盤面に出す）
 * という状態だった。DOM を index.html 側に揃えたうえで、呼び出しをここへ集約する。
 *
 * アニメーション本体は `public/core/base.js` の showFinishOverlay（既に共有済み）。
 * このモジュールは「どの要素に・どの文言/クラスで・何ms出すか」だけを一元管理する。
 */

export type FinishKind = "win" | "lose" | "gameover" | "clear";

/** CPU戦の表示時間。オンラインもこれに合わせる（旧オンラインは 1600ms だった）。 */
export const FINISH_DURATION_MS = 1400;

interface FinishStyle {
  text: string;
  className: "finish-clear" | "finish-gameover";
}

const FINISH_STYLES: Record<FinishKind, FinishStyle> = {
  win: { text: "WIN!", className: "finish-clear" },
  lose: { text: "LOSE...", className: "finish-gameover" },
  gameover: { text: "GAME OVER", className: "finish-gameover" },
  clear: { text: "FINISH!", className: "finish-clear" },
};

/**
 * オンライン戦のフィールドプレフィックスを解決する。
 * countdown-overlay と同じ命名規則（`<prefix>finish-overlay` / `<prefix>finish-text`）。
 */
export function onlineFieldPrefix(slot: "self" | number, rule: "tet" | "puyo"): string {
  const base = slot === "self" ? "ol-p-" : `ol-opp-${slot}-`;
  return rule === "puyo" ? `${base}puyo-` : base;
}

/** オンライン戦で存在しうる全フィールドプレフィックス（クリア用）。 */
export function allOnlineFieldPrefixes(oppSlotCount = 3): string[] {
  const prefixes = [onlineFieldPrefix("self", "tet"), onlineFieldPrefix("self", "puyo")];
  for (let i = 0; i < oppSlotCount; i++) {
    prefixes.push(onlineFieldPrefix(i, "tet"), onlineFieldPrefix(i, "puyo"));
  }
  return prefixes;
}

/**
 * 指定フィールドに終了演出を出す。
 * @param prefix 'player-' | 'cpu-'（CPU戦） / 'ol-p-' | 'ol-opp-0-puyo-' 等（オンライン戦）
 */
export function showFieldFinish(
  prefix: string,
  kind: FinishKind,
  onComplete?: () => void,
  durationMs: number = FINISH_DURATION_MS,
): void {
  const style = FINISH_STYLES[kind];
  const show = (window as any).showFinishOverlay;
  if (typeof show !== "function") {
    // base.js 未ロード時のフォールバック（コールバックだけは必ず呼ぶ）
    if (onComplete) setTimeout(onComplete, durationMs);
    return;
  }
  show(
    `${prefix}finish-overlay`,
    `${prefix}finish-text`,
    style.text,
    style.className,
    durationMs,
    onComplete ?? null,
  );
}

/** 指定フィールドの終了演出を即座に消す（次ラウンド前のリセット用）。 */
export function clearFieldFinish(prefix: string): void {
  const overlay = document.getElementById(`${prefix}finish-overlay`);
  const text = document.getElementById(`${prefix}finish-text`);
  if (overlay) {
    const anyOverlay = overlay as any;
    if (anyOverlay.finishTimer1) clearTimeout(anyOverlay.finishTimer1);
    if (anyOverlay.finishTimer2) clearTimeout(anyOverlay.finishTimer2);
    anyOverlay.finishTimer1 = null;
    anyOverlay.finishTimer2 = null;
    overlay.classList.remove("active", "fadeout", "finish-gameover", "finish-clear");
  }
  if (text) {
    text.textContent = "";
    text.classList.remove("finish-gameover", "finish-clear");
  }
}

export const BattleFinish = {
  showFieldFinish,
  clearFieldFinish,
  onlineFieldPrefix,
  allOnlineFieldPrefixes,
  FINISH_DURATION_MS,
};

// プレーンJS（public/app/versus.js）からの参照用
declare global {
  interface Window {
    BattleFinish: typeof BattleFinish;
  }
}
window.BattleFinish = BattleFinish;
