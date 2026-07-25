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

export interface LoadingPlayerState {
  name: string;
  /** 準備完了（READY 済み＝素材ロード完了）か */
  ready: boolean;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function showLoadingOverlay(): void {
  const overlay = el(OVERLAY_ID);
  if (overlay) overlay.style.display = "flex";
  setLoadingProgress(0, "");
}

export function hideLoadingOverlay(): void {
  const overlay = el(OVERLAY_ID);
  if (overlay) overlay.style.display = "none";
  const players = el(PLAYERS_ID);
  if (players) players.innerHTML = "";
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
 * 切り替え、対戦開始通知(StartMatchNotification)のタイミングで hide する。
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
