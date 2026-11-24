/**
 * ZONE BATTLE ONLINE の盤面まわり（設計 source_assets/memory/mode/tet_zone/tetlabo-zone-online-design.md §8・§9）。
 *
 * - 部屋設定（OnlineZoneMatchSetting）を自分の Game へ、ローカルの applyVsSettings と同じ名前で入れる
 *   （エンジン public/game/tet/zone.js・garbage.js・lifecycle.js はその名前を読む）。
 * - ONLINE の盤面（自分 ol-p・相手 ol-opp-0〜2）に ZONE の表示の DOM を作る。ローカル VERSUS の
 *   index.html の player-zone-* と同じ id の付け方（`${prefix}-zone-area` など）にして、zone.js の
 *   HUD・枠の上のキャンバス・終了の表示・PHASE の表示をそのまま使う。大きさは --ol-scale に乗せる（zone.css）。
 */
import type { OnlineZoneMatchSetting } from "../online/payload";

type AnyGame = any;

/** フェーズごとの「前のフェーズに足す」しきい値を試合の始まりからの値へ足し上げる（vs_settings.js _phaseAbs と同じ） */
function phaseAbs(table: OnlineZoneMatchSetting["phaseTable"]): { score: number; timeMs: number }[] {
  let score = 0, timeMs = 0;
  return table.map((r, i) => {
    if (i > 0) { score += r.scoreAdd; timeMs += r.timeAdd; }
    return { score, timeMs };
  });
}

/**
 * ZONE BATTLE の部屋の設定を自分の Game へ入れる（_initGameState より前に呼ぶ）。
 * ローカルの applyVsSettings（public/config/vs_settings.js）の ZONE BATTLE の分岐と同じ値・同じ名前。
 * GARBAGE × は ONLINE の送信（routeGarbage の Math.round）でかけるので、エンジンの vsAttackMultiplier は 1.0 のまま。
 */
export function applyZoneBattleToGame(game: AnyGame, s: OnlineZoneMatchSetting): void {
  game.vsZone = true;
  game.vsZoneQuarterLines = s.zoneQuarterLines;
  game.vsZoneQuarterMs = s.zoneQuarterMs;
  game.vsZoneSplit = s.zoneSplit;
  game.vsZonePhase = s.phase;
  const table = zonePhaseTableOf(s);
  if (table) game.vsZonePhaseTable = table;
  else delete game.vsZonePhaseTable;
  game.vsGarbageHoleRate = s.garbageHoleRate;
  game.vsGarbageHoleChunk = s.garbageHoleChunk;
  game.vsGarbageDamageOnClear = s.garbageDamageOnClear;
  game.vsB2bBonusEnabled = s.b2bBonus;
  game.vsZonePhaseTrigger = s.phaseTrigger === "time" ? "time" : "score";
  game.vsMarginTrigger = s.marginEnabled && s.marginTrigger === "score" ? "score" : "time";
  game.vsMarginScore = s.marginScore;
  // MARGIN OFF は null（ローカルの getMarginTimeMs と同じ。lifecycle.js は number のときだけ予約する）
  game.vsMarginTimeMs = s.marginEnabled ? s.marginTime * 1000 : null;
  game.vsAttackMultiplier = 1.0;
}

/** VERSUS の部屋の試合で、前の ZONE BATTLE の値が Game に残らないようにする（新しい Game なので念のため） */
export function clearZoneBattleFromGame(game: AnyGame): void {
  game.vsZone = false;
  for (const k of ["vsZonePhaseTable", "vsGarbageHoleChunk", "vsZonePhaseTrigger", "vsMarginTrigger", "vsMarginScore"]) {
    delete game[k];
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, id: string, cls: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.id = id;
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/**
 * ONLINE の tet 盤面（`${prefix}-tet-field`）に ZONE の DOM を作る（無ければ。何度呼んでもよい）。
 *  - `${prefix}-zone-area`        円形のメーター（盤面の左下。zone.js が中身を入れる）
 *  - `${prefix}-zone-top-canvas`  枠の上 20 段（盤面のキャンバスの上端に重ねる）
 *  - `${prefix}-zone-end-popup`   終了の「ZONE n LINES / ATTACK +n」
 *  - `${prefix}-zone-phase-popup` 切り替わりの「PHASE 02」
 * PHASE の数値の行（`${prefix}-phase-block`）は右の列（.ol-stats-right）にあるので online_game.ts が作る。
 */
export function ensureOnlineZoneEls(prefix: string): void {
  const field = document.getElementById(`${prefix}-tet-field`);
  const canvas = document.getElementById(`${prefix}-main-canvas`);
  const wrap = canvas?.parentElement;
  if (!field || !canvas || !wrap) return;
  if (!document.getElementById(`${prefix}-zone-area`)) {
    const area = el("div", `${prefix}-zone-area`, "versus-zone-area ol-zone-area");
    area.style.display = "none";
    field.appendChild(area);
  }
  if (!document.getElementById(`${prefix}-zone-top-canvas`)) {
    const top = el("canvas", `${prefix}-zone-top-canvas`, "ol-zone-top-canvas");
    canvas.insertAdjacentElement("afterend", top);
  }
  if (!document.getElementById(`${prefix}-zone-end-popup`)) {
    wrap.appendChild(el("div", `${prefix}-zone-end-popup`, "zone-end-popup ol-zone-popup",
      '<span class="zone-end-lines">ZONE 0 LINES</span><span class="zone-end-score">ATTACK +0</span>'));
  }
  if (!document.getElementById(`${prefix}-zone-phase-popup`)) {
    wrap.appendChild(el("div", `${prefix}-zone-phase-popup`, "zone-end-popup zone-phase-popup ol-zone-popup",
      '<span class="zone-end-lines">PHASE 02</span>'));
  }
}

/**
 * 試合の頭: 前の試合の ZONE の表示を消す（Game は試合ごとに作り直すので、前の Game が描いた
 * 枠の上・輪・枠の光・PHASE の表示が残らないように）。ZONE BATTLE の試合では zone.js が出し直す。
 */
export function resetOnlineZoneEls(prefix: string): void {
  const top = document.getElementById(`${prefix}-zone-top-canvas`) as HTMLCanvasElement | null;
  if (top) top.getContext("2d")?.clearRect(0, 0, top.width, top.height);
  const area = document.getElementById(`${prefix}-zone-area`);
  if (area) area.style.display = "none";
  for (const id of [`${prefix}-zone-end-popup`, `${prefix}-zone-phase-popup`]) {
    document.getElementById(id)?.classList.remove("show");
  }
  const block = document.getElementById(`${prefix}-phase-block`);
  if (block) block.style.display = "none";
  const wrap = document.getElementById(`${prefix}-main-canvas`)?.parentElement;
  wrap?.classList.remove("zone-on", "zone-active", "zone-hot", "zone-last");
}

/**
 * 試合のフェーズの表（エンジンの ZONE_PHASE_TABLE の形。穴は「変わる確率」・しきい値は試合の始まりから）。
 * PHASE OFF・形の違う表は null（エンジンはフェーズなし）
 */
export function zonePhaseTableOf(s: OnlineZoneMatchSetting): any[] | null {
  if (!s.phase || !Array.isArray(s.phaseTable) || s.phaseTable.length !== 3) return null;
  const abs = phaseAbs(s.phaseTable);
  return s.phaseTable.map((r, i) => ({
    quarterLines: r.zoneCharge, quarterMs: r.zoneTime,
    holeIn: 100 - r.holeRate, holeBetween: 100 - r.holeChunk,
    score: abs[i].score, timeMs: abs[i].timeMs,
  }));
}
