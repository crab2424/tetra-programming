/**
 * オンライン対戦のロード画面。素材のプリロード（battle/preload.ts）と
 * 「相手の準備を待っています」表示をまとめる。
 *
 * 使い方は「対戦開始を承認したら showLoadingScreen() を await し、
 * 解決してから READY / startMatch を送る」。READY = ロード完了の意味になるので、
 * サーバー側の「オーナー以外の全員 READY で開始」判定がそのまま
 * 「全員のロードが終わるまで開始しない」として機能する（サーバー無改造）。
 */

import { preloadBattleAssets, type PreloadOptions } from "./preload";

const OVERLAY_ID = "ol-loading-overlay";
const LABEL_ID = "ol-loading-label";
const BAR_ID = "ol-loading-bar-fill";
const PLAYERS_ID = "ol-loading-players";
const CARD_ID = "ol-loading-card";
const DARKENING_CLASS = "ol-loading-overlay--darkening";
const CLOSING_CLASS = "ol-loading-overlay--closing";

// ★ 演出の全体像（ユーザー指定の流れ）:
//
//   [承認] ── 明るめのblur背景・ロードUI表示 ──────────────┐
//            プリロード / READY送信 / 相手を待つ              │ フェーズA（見せてよい段階）
//            （StartMatchNotification 受信まで、ここに留まる）│
//   ────────────────────────────────────────────────┘
//   [StartMatchNotification受信] → enterBlackout()
//            背景を完全な黒へ（320ms）＋ロードUIをフェードアウト（220ms、並走）
//   ────────────────────────────────────────────────
//   ★ ここから真っ暗（=ロードUIも背面も一切見えない）の下で、
//      盤面切り替え・エンジン初期化・相手パペットの初回データ待ち（実質的な「ロード」）
//      を行う（online_game.ts の startBattle 側の責務）。ここでは何もCSS変化を起こさない。
//   ────────────────────────────────────────────────
//   [相手パペットの同期完了 or タイムアウト] → revealBattle()
//            真っ暗から対戦画面へフェードイン（420ms）
//   → その後 READY カウントダウン開始（online_game.ts）
//
// 開始時刻(startTimeMs)はサーバー権威のまま動かさない。ここで動かすのは
// 「画面のどこで何を見せるか」だけで、遅くなった分はカウントダウンの残り時間が縮む
// （runCountdown が startDelayMs を3等分する性質を利用）。
const MIN_VISIBLE_MS = 900;   // フェーズA最低表示時間（速すぎる切替の唐突さを防ぐ）
const BLACKOUT_MS = 320;      // enterBlackout: 背景の暗転
const CARD_OUT_MS = 220;      // enterBlackout: ロードUIのフェードアウト（暗転と並走）
const FADE_IN_MS = 420;       // revealBattle: 真っ暗→対戦画面のフェードイン

/**
 * 相手との同期待ち後に残る「必ず消費する」閉じ演出の所要時間（revealBattle 分のみ）。
 * enterBlackout の分はサーバー権威の開始時刻カウントに対してすでに経過済み時間として
 * 自然に反映されるため、ここには含めない。
 */
export const LOADING_CLOSE_MS = FADE_IN_MS;

export interface LoadingPlayerState {
  name: string;
  /** 準備完了（READY 済み＝素材ロード完了）か */
  ready: boolean;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

let shownAt: number | null = null;
// 進行中の enterBlackout/revealBattle が、その後の show/hide と交錯しても
// 古い方が新しい状態を巻き込んで動かさないようにする世代カウンタ。
let generation = 0;

export function showLoadingOverlay(): void {
  generation++;
  const overlay = el(OVERLAY_ID);
  if (overlay) {
    overlay.classList.remove(DARKENING_CLASS, CLOSING_CLASS);
    overlay.style.display = "flex";
  }
  const card = el(CARD_ID);
  if (card) card.classList.remove("is-hidden");
  shownAt = performance.now();
  setLoadingProgress(0, "");
}

/** 実際にオーバーレイを消す（DOM状態を初期化して次回の show に備える）。 */
function teardownOverlay(overlay: HTMLElement): void {
  overlay.style.display = "none";
  overlay.classList.remove(DARKENING_CLASS, CLOSING_CLASS);
  const card = el(CARD_ID);
  if (card) card.classList.remove("is-hidden");
  const players = el(PLAYERS_ID);
  if (players) players.innerHTML = "";
  shownAt = null;
}

/**
 * ロード画面を即座に閉じる（エラー・辞退・離脱などの中断経路用）。
 * 対戦開始の正規ルートでは enterBlackout() / revealBattle() を使うこと。
 */
export function hideLoadingOverlay(_immediate = true): void {
  generation++; // 進行中の enterBlackout/revealBattle を無効化する
  const overlay = el(OVERLAY_ID);
  if (!overlay || overlay.style.display === "none") {
    shownAt = null;
    return;
  }
  teardownOverlay(overlay);
}

/**
 * StartMatchNotification 受信直後に呼ぶ。背景を完全な黒にし、ロードUI(カード)を
 * フェードアウトさせてから解決する。呼び出し側（online_game.ts）はこれが解決してから
 * 盤面切り替え・エンジン初期化・相手パペットの同期待ちを行う（＝すべて真っ暗の下で進む）。
 *
 * フェーズA表示が最低表示時間(MIN_VISIBLE_MS)に満たない場合はその分だけ待つ
 * （素材が全てキャッシュ済みだと数十msで完了してしまい、画面変化が唐突になるため）。
 */
export function enterBlackout(): Promise<void> {
  const overlay = el(OVERLAY_ID);
  if (!overlay || overlay.style.display === "none") {
    shownAt = null;
    return Promise.resolve();
  }
  const myGeneration = generation;
  const alive = () => myGeneration === generation;
  const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

  const elapsed = shownAt !== null ? performance.now() - shownAt : MIN_VISIBLE_MS;

  return (async () => {
    await wait(Math.max(0, MIN_VISIBLE_MS - elapsed));
    if (!alive()) return;
    overlay.classList.add(DARKENING_CLASS);
    el(CARD_ID)?.classList.add("is-hidden");
    await wait(Math.max(BLACKOUT_MS, CARD_OUT_MS));
  })();
}

/**
 * 相手パペットの同期が終わった（or タイムアウトした）後に呼ぶ。真っ暗な画面から
 * 対戦画面へフェードインし、完了したらオーバーレイを完全に閉じてから解決する。
 * 呼び出し側はこれが解決してから READY カウントダウンを始める。
 */
export function revealBattle(): Promise<void> {
  const overlay = el(OVERLAY_ID);
  if (!overlay || overlay.style.display === "none") {
    shownAt = null;
    return Promise.resolve();
  }
  const myGeneration = generation;
  const alive = () => myGeneration === generation;
  const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

  return (async () => {
    overlay.classList.add(CLOSING_CLASS);
    await wait(FADE_IN_MS);
    if (!alive()) return;
    teardownOverlay(overlay);
  })();
}

export function isLoadingOverlayVisible(): boolean {
  const overlay = el(OVERLAY_ID);
  return !!overlay && overlay.style.display !== "none";
}

/** 進捗バー（0..1）とラベルを更新する。 */
export function setLoadingProgress(ratio: number, label: string): void {
  const bar = el(BAR_ID);
  if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
  const labelEl = el(LABEL_ID);
  if (labelEl) labelEl.textContent = label;
}

/**
 * 各プレイヤーの準備状況を表示する。
 * ready は RoomInfoNotification.readyPlayers から作れるので追加の通信は不要。
 */
export function setLoadingPlayers(players: LoadingPlayerState[]): void {
  const container = el(PLAYERS_ID);
  if (!container) return;
  container.innerHTML = "";
  for (const p of players) {
    const row = document.createElement("div");
    row.className = `ol-loading-player${p.ready ? " is-ready" : ""}`;
    const name = document.createElement("span");
    name.className = "ol-loading-player-name";
    name.textContent = p.name;
    const state = document.createElement("span");
    state.textContent = p.ready ? "READY ✓" : "準備中…";
    row.appendChild(name);
    row.appendChild(state);
    container.appendChild(row);
  }
}

/**
 * ロード画面を出して素材を読み込み、完了したら解決する。**必ず解決する**
 * （失敗・タイムアウトでも reject しない。相手を待たせ続けないため）。
 * オーバーレイは閉じない: 呼び出し側が READY を送ったあと「相手の準備待ち」表示へ
 * 切り替え、対戦開始通知(StartMatchNotification)のタイミングで enterBlackout() へ進む。
 */
export async function runBattlePreload(options: PreloadOptions = {}): Promise<void> {
  showLoadingOverlay();
  await preloadBattleAssets({
    ...options,
    onProgress: (done, total, label) => {
      setLoadingProgress(total === 0 ? 1 : done / total, label ? `${label} を読み込みました` : "読み込み中…");
      options.onProgress?.(done, total, label);
    },
  });
  setLoadingProgress(1, "相手の準備を待っています…");
}
