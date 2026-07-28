/**
 * 対戦画面レイアウトの一本化（CPU戦 #versus-page / オンライン戦 #online-battle-page）。
 *
 * 「UIを変えるのに2ファイル編集」を無くすため、スロット→要素IDの対応と
 * ルール(tet/puyo)による表示切替はすべてこのファイルだけが知る。
 * versus.js の _switchToVersusMixedLayout と online_game.ts の表示切替は
 * ここへの delegate になっている。
 *
 * プレーンJS（public/app/versus.js）からは window.BattleLayout 経由で参照する
 * （main.ts で登録）。
 */

type Rule = "tet" | "puyo";

/** 1スロット分の切替対象。tet/puyo それぞれのルールで表示する要素の集合 */
interface SlotElements {
  /** tet ルール時に表示する要素ID */
  tetIds: string[];
  /** puyo ルール時に表示する要素ID */
  puyoIds: string[];
  /** tet のみで表示するラベルのCSSセレクタ（HOLDラベルなど） */
  tetOnlySelectors?: string[];
}

/** #versus-page（CPU戦）のスロット→要素ID対応 */
const VERSUS_SLOTS: Record<"player" | "cpu", SlotElements> = {
  player: {
    tetIds: ["player-main-canvas", "player-next-canvas", "player-hold-canvas"],
    puyoIds: ["player-puyo-main-canvas", "player-puyo-next-canvas"],
    tetOnlySelectors: [".versus-label-hold"],
  },
  cpu: {
    tetIds: ["cpu-main-canvas", "cpu-next-canvas", "cpu-hold-canvas"],
    puyoIds: ["cpu-puyo-main-canvas", "cpu-puyo-next-canvas"],
    tetOnlySelectors: [".versus-label-hold-cpu"],
  },
};

/** #online-battle-page の自分スロット */
const ONLINE_SELF: SlotElements = {
  tetIds: ["ol-p-tet-field"],
  puyoIds: ["ol-p-puyo-field"],
};

/** #online-battle-page の相手スロット（index 0..2） */
function onlineOppSlot(index: number): SlotElements {
  return {
    tetIds: [`ol-opp-${index}-tet-field`],
    puyoIds: [`ol-opp-${index}-puyo-field`],
  };
}

/** オンライン相手スロット数（index.html の ol-opp-slot-* と一致させる） */
export const ONLINE_OPP_SLOT_COUNT = 3;

/** オンライン対戦での自分側表示位置。相手へは送信しないローカル設定。 */
export type OnlineSelfSide = "left" | "right";
const ONLINE_SELF_SIDE_KEY = "tetlaboOnlineSelfSide";

export function getOnlineSelfSide(): OnlineSelfSide {
  if (typeof localStorage === "undefined") return "left";
  return localStorage.getItem(ONLINE_SELF_SIDE_KEY) === "right" ? "right" : "left";
}

/**
 * 自分の表示位置を、現在のオンライン対戦DOMへ適用する。
 * player/opponent の順序は参加順ではなく、この端末の自分視点だけで決める。
 */
export function applyOnlineSelfSide(): void {
  const side = getOnlineSelfSide();
  const layout = document.getElementById("ol-battle-layout");
  const playerArea = document.getElementById("ol-player-area");
  if (layout) layout.dataset.selfSide = side;
  if (playerArea) playerArea.style.order = side === "left" ? "0" : "999";

  for (let i = 0; i < ONLINE_OPP_SLOT_COUNT; i++) {
    const slot = document.getElementById(`ol-opp-slot-${i}`);
    if (slot) slot.style.order = side === "left" ? String(i + 1) : String(i);
  }
}

export function setOnlineSelfSide(side: OnlineSelfSide): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(ONLINE_SELF_SIDE_KEY, side);
  }
  applyOnlineSelfSide();
}

/** スロット内の要素表示をルールに合わせて切り替える共通処理 */
function applySlotRule(slot: SlotElements, rule: Rule): void {
  const isPuyo = rule === "puyo";
  for (const id of slot.tetIds) {
    const el = document.getElementById(id);
    if (el) el.style.display = isPuyo ? "none" : "";
  }
  for (const id of slot.puyoIds) {
    const el = document.getElementById(id);
    if (el) el.style.display = isPuyo ? "" : "none";
  }
  for (const sel of slot.tetOnlySelectors ?? []) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.style.display = isPuyo ? "none" : "";
    });
  }
}

// ── CPU戦 (#versus-page) ─────────────────────────────────────────────────────

/** プレイヤー/CPU 両スロットのルールを適用する（旧 versus.js _switchToVersusMixedLayout） */
export function applyVersusLayout(playerRule: Rule, cpuRule: Rule): void {
  applySlotRule(VERSUS_SLOTS.player, playerRule);
  applySlotRule(VERSUS_SLOTS.cpu, cpuRule);
}

// ── オンライン戦 (#online-battle-page) ───────────────────────────────────────

/** 自分の盤面の tet/puyo フィールド表示を切り替える */
export function setOnlineSelfRule(rule: Rule): void {
  applySlotRule(ONLINE_SELF, rule);
}

/** 相手スロット index の tet/puyo フィールド表示を切り替える */
export function setOnlineOppRule(index: number, rule: Rule): void {
  applySlotRule(onlineOppSlot(index), rule);
}

/** 相手スロットを表示し、参加順に基づく CSS order を設定する */
export function showOnlineOppSlot(index: number, order?: number): void {
  const slot = document.getElementById(`ol-opp-slot-${index}`);
  if (slot) {
    slot.style.display = "";
    slot.style.order = order === undefined
      ? (getOnlineSelfSide() === "left" ? String(index + 1) : String(index))
      : String(order);
  }
}

/** 全相手スロットを非表示に戻す（cleanup 用） */
export function hideOnlineOppSlots(): void {
  for (let i = 0; i < ONLINE_OPP_SLOT_COUNT; i++) {
    const slot = document.getElementById(`ol-opp-slot-${i}`);
    if (slot) {
      slot.style.display = "none";
      slot.style.order = "";
    }
  }
}

/**
 * 人数に応じてバトル画面レイアウトを調整する（CSS は data-player-count を参照）。
 * null でリセット。5人以上は全員5扱い（HTMLスロットは3つまでだが将来拡張に備えてクランプ）。
 */
export function setOnlinePlayerCount(playerCount: number | null): void {
  const layout = document.getElementById("ol-battle-layout");
  if (!layout) return;
  if (playerCount === null) {
    layout.removeAttribute("data-player-count");
  } else {
    layout.setAttribute("data-player-count", String(Math.min(playerCount, 5)));
  }
}

export const BattleLayout = {
  applyVersusLayout,
  setOnlineSelfRule,
  setOnlineOppRule,
  showOnlineOppSlot,
  hideOnlineOppSlots,
  setOnlinePlayerCount,
  getOnlineSelfSide,
  setOnlineSelfSide,
  applyOnlineSelfSide,
  ONLINE_OPP_SLOT_COUNT,
};

// プレーンJS（public/app/versus.js）からの参照用
declare global {
  interface Window {
    BattleLayout: typeof BattleLayout;
  }
}
window.BattleLayout = BattleLayout;
