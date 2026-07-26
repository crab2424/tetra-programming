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

// ★ ロードが速すぎて画面がほぼ一瞬で切り替わる（体感上の「唐突さ」）のを防ぐための
//   最低表示時間と、閉じる演出の各段階。開始タイミング(startTimeMs)自体は動かさない。
//
// 閉じる流れ（ユーザー指定）:
//   1. DARKEN  : ロードUIはそのまま、背景だけを「完全に暗く」する
//   2. CARD_OUT: ロードUI（カード）だけを消す（画面は真っ暗のまま）
//   3. FADE_IN : 真っ暗を晴らして対戦画面をフェードインで見せる
//   → これが終わってから READY カウントダウンを開始する（online_game.ts）
const MIN_VISIBLE_MS = 900;
const DARKEN_MS = 320;
const CARD_OUT_MS = 220;
const FADE_IN_MS = 420;

/** 閉じる演出（暗転→UI消し→フェードイン）の総所要時間。カウントダウンの尺取りに使う。 */
export const LOADING_CLOSE_MS = DARKEN_MS + CARD_OUT_MS + FADE_IN_MS;

export interface LoadingPlayerState {
  name: string;
  /** 準備完了（READY 済み＝素材ロード完了）か */
  ready: boolean;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

let shownAt: number | null = null;
// hideLoadingOverlay() が非同期で進行中のときに、show→hide が交錯しても
// 古い hide が新しい show を巻き込んで消さないようにする世代カウンタ。
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
 * 対戦開始の正規ルートでは closeLoadingScreen() を使うこと。
 */
export function hideLoadingOverlay(_immediate = true): void {
  generation++; // 進行中の closeLoadingScreen を無効化する
  const overlay = el(OVERLAY_ID);
  if (!overlay || overlay.style.display === "none") {
    shownAt = null;
    return;
  }
  teardownOverlay(overlay);
}

/**
 * ロード画面を「暗転 → ロードUIを消す → フェードインで対戦画面を出す」の順で閉じる。
 * 解決した時点で画面は完全に対戦画面（オーバーレイなし）になっているので、
 * 呼び出し側はそのあとで READY カウントダウンを始める。
 *
 * 最低表示時間(MIN_VISIBLE_MS)に満たない場合はその分だけ待ってから演出を始める
 * （素材が全てキャッシュ済みだと数十msで完了してしまい、画面変化が唐突になるため）。
 */
export function closeLoadingScreen(): Promise<void> {
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
    // 1. 背景を完全な暗転へ（ロードUIはそのまま）
    overlay.classList.add(DARKENING_CLASS);
    await wait(DARKEN_MS);
    if (!alive()) return;
    // 2. ロードUIだけを消す（画面は真っ暗のまま）
    el(CARD_ID)?.classList.add("is-hidden");
    await wait(CARD_OUT_MS);
    if (!alive()) return;
    // 3. 真っ暗を晴らして対戦画面をフェードインで見せる
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
