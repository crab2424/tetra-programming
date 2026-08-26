// @ts-check
import { GameConnection } from "./connection";
import type {
  RoomInfoNotification,
  StartMatchNotification,
  Uuid,
  OnlineMatchSetting,
} from "./payload";
import { parseMatchSetting } from "./payload";
import { showToast, ToastColor } from "../components/toast";
import {
  encodePieceState,
  encodeLock,
  encodeSpawn,
  encodeGarbage,
  encodeGameOver,
  encodeClear,
  encodeSE,
  encodePendingUpdate,
  encodeHoldState,
  encodeStatsUpdate,
  type StatsUpdateData,
  encodePuyoPieceState,
  encodePuyoSpawn,
  encodePuyoLock,
  PuyoLockPhase,
  encodeGarbagePuyo,
  encodePuyoChain,
  encodeGarbageConfirm,
  decodeGarbage,
  decodePendingUpdate,
  fieldBlocksToArray,
  MatchOpcode,
  BOARD_COLS,
  SE_IDS,
  SE_NAMES,
  createSeededRng,
} from "./game_protocol";
import { Logger } from "./logger";
import { BattleLifecycle } from "../battle/lifecycle";
import {
  routeGarbage,
  deliverLocalWithReadyTimer,
  deliverLocalStaged,
  type GarbageSink,
} from "../battle/garbage_router";
import {
  setOnlineSelfRule,
  setOnlineOppRule,
  showOnlineOppSlot,
  hideOnlineOppSlots,
  setOnlinePlayerCount,
  applyOnlineSelfSide,
  ONLINE_OPP_SLOT_COUNT,
} from "../battle/layout";
import { NetworkDriver } from "../battle/driver";
import { freezeGameByRule } from "../battle/freeze";
import { renderOnlineResult, resetOnlineResult } from "../battle/online_result";
import {
  showFieldFinish,
  clearFieldFinish,
  onlineFieldPrefix,
  allOnlineFieldPrefixes,
} from "../battle/finish_overlay";
import {
  showDisconnectOverlay,
  type DisconnectOverlayHandle,
} from "../battle/disconnect_overlay";
import {
  runBattlePreload,
  hideLoadingOverlay,
  enterBlackout,
  revealBattle,
  setLoadingProgress,
  setLoadingCancel,
  LOADING_CLOSE_MS,
  COVER_MS,
} from "../battle/loading_screen";

type AnyFn = (...args: any[]) => any;

/**
 * 相手スコアの 60fps 表示。
 *
 * ネットワークの StatsUpdate は 100ms 間隔に間引いてあるため（通信量のため。
 * hookTetGameMethods / hookPuyoGameMethods 参照）、届いた値をそのまま書くと
 * 相手のスコアだけ 10fps のカクついた更新に見える。ここで「受信済みの最新値へ
 * 100ms かけて詰める」補間を rAF で回し、通信量を増やさずに表示だけ 60fps 化する。
 *
 * ★ CPU負荷: 差がある間だけ rAF が回り、1フレームあたり数個の textContent 更新のみ。
 *   全スロットが目標値に到達したらループ自体を止める（常駐しない）。
 */
const SCORE_TWEEN_MS = 100; // 送信スロットル間隔と同じ＝遅れは常に最大1間隔ぶん
interface ScoreTweenState { el: HTMLElement; shown: number; target: number; perMs: number }
const scoreTweens = new Map<string, ScoreTweenState>();
let scoreTweenFrame: number | null = null;
let scoreTweenLast = 0;

function stepScoreTweens(now: number): void {
  const dt = Math.min(100, now - scoreTweenLast);
  scoreTweenLast = now;
  for (const [key, st] of scoreTweens) {
    const diff = st.target - st.shown;
    if (Math.abs(diff) < 1) {
      st.shown = st.target;
      st.el.textContent = String(st.target);
      scoreTweens.delete(key);
      continue;
    }
    const step = st.perMs * dt;
    st.shown = Math.abs(step) >= Math.abs(diff) ? st.target : st.shown + step;
    st.el.textContent = String(Math.round(st.shown));
  }
  scoreTweenFrame = scoreTweens.size > 0
    ? requestAnimationFrame(stepScoreTweens)
    : null;
}

/** 相手スコアを 60fps で目標値へ補間表示する（同じ要素への再指定は目標だけ差し替え）。 */
function setScoreAnimated(key: string, el: HTMLElement, value: number): void {
  const prev = scoreTweens.get(key);
  const shown = prev ? prev.shown : Number(el.textContent) || 0;
  if (shown === value) {
    scoreTweens.delete(key);
    el.textContent = String(value);
    return;
  }
  scoreTweens.set(key, { el, shown, target: value, perMs: (value - shown) / SCORE_TWEEN_MS });
  if (scoreTweenFrame === null) {
    scoreTweenLast = performance.now();
    scoreTweenFrame = requestAnimationFrame(stepScoreTweens);
  }
}

/** 補間ループを止める。決着時は最終値へ即スナップ、cleanup時は表示に触れず破棄する。 */
function stopScoreTweens(snapToTarget: boolean): void {
  if (snapToTarget) {
    for (const st of scoreTweens.values()) st.el.textContent = String(st.target);
  }
  scoreTweens.clear();
  if (scoreTweenFrame !== null) {
    cancelAnimationFrame(scoreTweenFrame);
    scoreTweenFrame = null;
  }
}

/** 決着時: 補間の途中で止めず、受信済みの最終スコアを確定表示する。 */
function settleScoreTweens(): void { stopScoreTweens(true); }

/**
 * CPU戦(.versus-stats-left/-right > .versus-stat-block > .area-label + .versus-stat-value)と
 * 同じマークアップ・同じクラスを .ol-opp-field（CPU戦の .versus-container 相当。盤面サイズ
 * ちょうどの絶対配置アンカー）配下に複製する。位置は online-battle.css の .ol-stats-left/-right
 * が calc(px * --ol-scale) で CPU戦と同じ左右下オフセットを再現する。
 */
/** APM/LPM/TIME（上級者向けHUD）の表示整形。tet/puyo/hud_extras.jsと同じ書式に揃える */
function fmtHudTime(ms: number): string {
  const clamped = ms >= 0 ? ms : 0;
  const m = Math.floor(clamped / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const cs = Math.floor((clamped % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function fmtHudRate(count: number, activeMs: number): string {
  if (!(activeMs >= 3000)) return "--";
  return ((count || 0) / (activeMs / 60000)).toFixed(1);
}

function updateOnlineStats(slot: "self" | number, stats: StatsUpdateData): void {
  const fieldPrefix = slot === "self" ? "ol-p" : `ol-opp-${slot}`;
  const fieldEl = document.getElementById(`${fieldPrefix}-${stats.rule}-field`);
  if (!fieldEl) return;
  let leftEl = fieldEl.querySelector<HTMLElement>(".ol-stats-left");
  let rightEl = fieldEl.querySelector<HTMLElement>(".ol-stats-right");
  if (!leftEl || !rightEl) {
    leftEl = document.createElement("div");
    leftEl.className = "ol-stats-left";
    leftEl.innerHTML =
      '<div class="versus-stat-block">' +
      '<span class="area-label" data-stat-label="primary">LINES</span>' +
      '<span class="versus-stat-value" data-stat="primary">0</span>' +
      "</div>" +
      // APM/LPMはtet専用（v2.1.1追加）。puyoスロットでは.ol-tetonlyをinline styleで隠す。
      '<div class="versus-stat-block hud-apm-block ol-tetonly">' +
      '<span class="area-label">LPM</span>' +
      '<span class="versus-stat-value" data-stat="lpm">--</span>' +
      "</div>";
    rightEl = document.createElement("div");
    rightEl.className = "ol-stats-right";
    rightEl.innerHTML =
      '<div class="versus-stat-block">' +
      '<span class="area-label">SCORE</span>' +
      '<span class="versus-stat-value" data-stat="score">0</span>' +
      "</div>" +
      '<div class="versus-stat-block hud-apm-block ol-tetonly">' +
      '<span class="area-label">APM</span>' +
      '<span class="versus-stat-value" data-stat="apm">--</span>' +
      "</div>" +
      '<div class="versus-stat-block hud-time-block">' +
      '<span class="area-label">TIME</span>' +
      '<span class="versus-stat-value versus-time-value" data-stat="time">00:00.00</span>' +
      "</div>";
    fieldEl.appendChild(leftEl);
    fieldEl.appendChild(rightEl);
  }
  const score = rightEl.querySelector<HTMLElement>('[data-stat="score"]');
  const primary = leftEl.querySelector<HTMLElement>('[data-stat="primary"]');
  const label = leftEl.querySelector<HTMLElement>('[data-stat-label="primary"]');
  if (score) {
    // 自分は毎回の実値変化でここへ来る（＝すでに実時間）ので即時反映。
    // 相手は100ms間隔の受信なので、60fpsで目標値へ詰める補間表示にする。
    if (slot === "self") score.textContent = String(stats.score);
    else setScoreAnimated(`${fieldPrefix}-${stats.rule}`, score, stats.score);
  }
  if (primary) primary.textContent = String(stats.rule === "puyo" ? stats.chainMax : stats.lines);
  if (label) label.textContent = stats.rule === "puyo" ? "MAX CHAIN" : "LINES";

  // APM/LPM（tetのみ。旧バージョンの相手からはattackSent/activeMsが常に0で届く＝"--"表示になる）
  fieldEl.querySelectorAll<HTMLElement>(".ol-tetonly").forEach((el) => {
    el.style.display = stats.rule === "tet" ? "" : "none";
  });
  if (stats.rule === "tet") {
    const apmEl = rightEl.querySelector<HTMLElement>('[data-stat="apm"]');
    const lpmEl = leftEl.querySelector<HTMLElement>('[data-stat="lpm"]');
    if (apmEl) apmEl.textContent = fmtHudRate(stats.attackSent, stats.activeMs);
    if (lpmEl) lpmEl.textContent = fmtHudRate(stats.lines, stats.activeMs);
  }
  const timeEl = rightEl.querySelector<HTMLElement>('[data-stat="time"]');
  if (timeEl) timeEl.textContent = fmtHudTime(stats.activeMs);
}

declare const Mino: new (type?: number | null) => any;
declare const Block: new (x: number, y: number, type: number) => any;
declare const Field: new () => any;
declare const Game: new (prefix?: string | null) => any;
declare const PuyoGame: new (prefix?: string | null) => any;
declare const PConfig: any;

export type PostMatchCallbacks = {
  /** 部屋（ルーム設定画面）へ戻る。ランダムマッチでは使わない。 */
  onRoom: () => void;
  /** ルームを退出してロビー（ルーム一覧）へ戻る。 */
  onLeave: () => void;
  /**
   * S4: 切断猶予（grace_ms + 5000ms）を過ぎても決着通知が届かない、または自分の再接続が
   * 尽きたときの強制終了。メッセージをユーザーへ提示したうえでロビー等へ戻す。
   */
  onForceLeave?: (message: string) => void;
  isRandomMatch?: boolean;
};

/** リザルト画面から他プレイヤーへ通知する行動。PostMatchAction のワイヤー値と一致させる。 */
const PostMatchAction = {
  Retry: 0,   // 再戦申請
  Room: 1,    // 部屋へ戻る
  Leave: 2,   // 退出（ロビーへ）
  Cancel: 3,  // 再戦申請の取消
} as const;

export class OnlineGameController {
  private connection: GameConnection;
  private roomInfo: RoomInfoNotification;
  private myUserId: Uuid;

  private game: any = null;
  private myRule: 'tet' | 'puyo' = 'tet';
  /** 自分の相手のルール（異種戦判定用）。1v1なら相手のルール、複数戦でぷよが混在すればpuyo優先。
   *  board.js / ojama.js は window._cpuGame/versus* が無いオンラインではこの値で異種戦を判定する。 */
  private matchOpponentRule: 'tet' | 'puyo' = 'tet';
  /** 相手集団にテト/ぷよがそれぞれ含まれるか。混在多人数戦で「受信ルール別に火力を送る」ために使う。 */
  private matchHasTetOpp = false;
  private matchHasPuyoOpp = false;
  private puppets: Map<Uuid, NetworkDriver> = new Map();
  private puppetRules: Map<Uuid, 'tet' | 'puyo'> = new Map();
  private puppetIndices: Map<Uuid, number> = new Map();
  private playerNames: Map<Uuid, string> = new Map();

  private pieceStateIntervalId: number | null = null;
  private matchHandlerId: Uuid | null = null;
  private startNotifHandlerId: Uuid | null = null;
  private subscriptionIds: Uuid[] = [];

  private myAlive = true;
  private postMatchCallbacks: PostMatchCallbacks | null = null;
  private aliveSet: Set<Uuid> = new Set();
  private rematchVotes = new Map<Uuid, number>();
  private controlEventsSubscribed = false;
  private isRandomMatchRoom = false;
  private myRematchVoted = false;
  /** 現在のセットに設定を適用済みか。cleanup後の再入室では再初期化する。 */
  private setConfigured = false;
  /** haltMatch 済みか（進行停止の冪等ガード）。 */
  private matchHalted = false;
  /**
   * リザルト画面で「この対戦から離脱した」プレイヤー（値は PostMatchAction.Room/Leave、
   * 切断は Leave 扱い）。★ 相手の離脱で自分の画面を勝手に遷移させないための状態。
   * 自分がボタンを押したときに初めて参照し、通知してから遷移する。
   */
  private departed = new Map<Uuid, number>();
  /** ローカルで残り1人を検知してから WinnerNotification を待つタイマー。 */
  private winnerFallbackTimer: number | null = null;
  /** サーバーの WinnerNotification を待つ猶予。超えたらローカル判定で結果を出す。 */
  private static readonly WINNER_FALLBACK_MS = 2000;
  /**
   * startBattle（＝本編開始までの delay の起点）を通過した時刻。
   * ロード画面を閉じ終えたあとのカウントダウン残り時間を出すのに使う。
   */
  private battleStartedAtMs: number | null = null;
  /** ロード画面を閉じ始めるデッドラインで最低限確保するカウントダウン時間。 */
  private static readonly MIN_COUNTDOWN_MS = 900;
  /** カウントダウンの尺（CPU戦のrunCountdown既定値=2100msと同じ、700ms間隔）。 */
  private static readonly COUNTDOWN_MS = 2100;
  /** 相手SEの音量倍率。自分と同じ音量にする（以前は 0.4 で小さく鳴らしていた）。 */
  private static readonly OPPONENT_SE_GAIN = 1.0;
  /** 相手PUYOの puyo_fix/puyo_drop 受信を送信元ごとに間引くための直近再生時刻。 */
  private lastOpponentFixSeTime = new Map<Uuid, number>();

  // ── S4: 途中切断UI ──────────────────────────────────────────────────────
  /** PlayerConnectionLostNotification受信で表示中の切断オーバーレイ（相手ごと）。 */
  private disconnectOverlays = new Map<Uuid, DisconnectOverlayHandle>();
  /** grace_ms + 5000ms 経っても決着通知が来ない場合の強制LEAVE安全網タイマー。 */
  private disconnectWatchdogs = new Map<Uuid, number>();
  /** 自分自身の切断中に表示するオーバーレイ（onReconnecting〜onReconnected/onClose間）。 */
  private selfDisconnectOverlay: DisconnectOverlayHandle | null = null;
  /** 相手切断からの強制LEAVE安全網の猶予（サーバーのgrace_msに追加する余裕）。 */
  private static readonly DISCONNECT_WATCHDOG_MARGIN_MS = 5000;

  /**
   * 終了処理の状態機械。開始/決着/再戦/退出の排他はすべてここを通す。
   * 旧 matchInProgress / rematchStarting / postMatchNavigating フラグ群の置き換え。
   */
  private lifecycle = new BattleLifecycle({ log: (m) => this.logger.log(m) });

  /** 対戦本編（カウントダウン明け〜決着前）が進行中か。バックグラウンド駆動の対象判定に使う。 */
  private get matchInProgress(): boolean {
    return this.lifecycle.phase === "playing";
  }
  /** visibilitychange リスナーを登録済みか（多重登録防止）。 */
  private visibilityListenerActive = false;
  /** バックグラウンドでゲームを進めるためのクロックWorker（rAFの代替）。 */
  private bgClockWorker: Worker | null = null;
  /** Worker生成に使った Blob URL（破棄用に保持）。 */
  private bgClockUrl: string | null = null;
  /** バックグラウンドクロックが現在動作中か。 */
  private bgClockRunning = false;

  private readonly logger = new Logger("ONLINE:Game");

  // ── バックグラウンド進行（タブ非表示でも対戦を止めない） ─────────────────────
  //
  // ★ 背景: 重力・描画・状態遷移は requestAnimationFrame 駆動で、ブラウザはタブ非表示中
  //   rAF を完全に停止する。一方データチャネルの keepalive(25秒) は動き続けるため接続は切れない。
  //   結果、相手から見ると「ミノが落ちず・ツモも進まず・絶対に死なない不死身の相手」になる（報告の不具合）。
  //   そこで、タブが hidden の間は「スロットリングされない Web Worker のタイマー」でゲームの
  //   1フレーム更新（tet=_applyGravityTick / puyo=_update(dt)）を駆動し続け、ミノ/ぷよが落ち続け・
  //   接地で固定され・最終的に決着するようにする。入力は非表示中に発生しないので、操作なしの
  //   「自然落下のみ」で進む（放置すれば自滅）＝公平。表示に戻れば rAF が自動的に再開する。

  private readonly handleVisibilityChange = (): void => {
    this.syncBackgroundClock();
  };

  /** 表示状態に応じてバックグラウンドクロックを開始/停止する（hidden 検知時・対戦開始時に呼ぶ）。 */
  private syncBackgroundClock(): void {
    const hidden = typeof document !== "undefined" && document.hidden;
    if (hidden && this.matchInProgress && !this.matchHalted && this.myAlive && this.game) {
      this.startBackgroundClock();
    } else {
      this.stopBackgroundClock();
    }
  }

  /** Worker（停止しないクロック）を必要に応じて生成する。 */
  private ensureBgWorker(): void {
    if (this.bgClockWorker || typeof Worker === "undefined") return;
    // 非表示タブでもスロットリングされにくい Worker 内 setInterval で tick を送る。
    const code =
      "let t=null;self.onmessage=function(e){" +
      "if(e.data==='start'){if(t===null)t=setInterval(function(){self.postMessage(0);},16);}" +
      "else if(e.data==='stop'){if(t!==null){clearInterval(t);t=null;}}};";
    try {
      const blob = new Blob([code], { type: "application/javascript" });
      this.bgClockUrl = URL.createObjectURL(blob);
      this.bgClockWorker = new Worker(this.bgClockUrl);
      this.bgClockWorker.onmessage = () => this.backgroundTick();
    } catch (e) {
      this.logger.error("Failed to create background clock worker:", e);
      this.bgClockWorker = null;
    }
  }

  private startBackgroundClock(): void {
    if (this.bgClockRunning) return;
    this.ensureBgWorker();
    if (!this.bgClockWorker) return;
    this.bgClockRunning = true;
    // tet: rAFが止まる直前の経過時間で多重落下しないよう基準時刻をリセット
    if (this.game && this.myRule !== "puyo") {
      this.game._gravityLastTime = performance.now();
    }
    if (this.game && this.myRule === "puyo") {
      this.game.lastTime = performance.now();
    }
    this.bgClockWorker.postMessage("start");
    this.logger.log("Background clock started (tab hidden).");
  }

  private stopBackgroundClock(): void {
    if (!this.bgClockRunning) return;
    this.bgClockRunning = false;
    this.bgClockWorker?.postMessage("stop");
    // 表示に戻った直後の大ジャンプを避けるため基準時刻を現在に合わせる
    if (this.game && this.myRule !== "puyo") {
      this.game._gravityLastTime = performance.now();
    }
    if (this.game && this.myRule === "puyo") {
      this.game.lastTime = performance.now();
    }
    this.logger.log("Background clock stopped (tab visible).");
  }

  private teardownBackgroundClock(): void {
    this.stopBackgroundClock();
    if (this.bgClockWorker) {
      try {
        this.bgClockWorker.terminate();
      } catch {}
      this.bgClockWorker = null;
    }
    if (this.bgClockUrl) {
      try {
        URL.revokeObjectURL(this.bgClockUrl);
      } catch {}
      this.bgClockUrl = null;
    }
  }

  /** Worker tick ごとに呼ばれ、非表示中のみゲームを1フレーム進める。 */
  private backgroundTick(): void {
    // 表示中は rAF が駆動するので二重進行を避ける
    if (typeof document !== "undefined" && !document.hidden) return;
    if (!this.matchInProgress || this.matchHalted || !this.myAlive || !this.game) {
      this.stopBackgroundClock();
      return;
    }
    const g = this.game;
    if (g.isPaused) return; // ネットワークポーズ中は進めない
    try {
      if (this.myRule === "puyo") {
        // ぷよ: _loop() の更新部分を再現（描画は非表示中なので省略）
        const now = performance.now();
        let dt = now - g.lastTime;
        if (dt > 100) dt = 100;
        if (dt < 0) dt = 0;
        g.lastTime = now;
        if (g.state === "playing") g._update(dt);
      } else {
        // tet: rAFループ相当の重力tickを進める
        g._applyGravityTick();
        // 接地後の固定は lockTimer(setTimeout) 依存で、非表示中はthrottleされ ~1s 遅れる。
        // 猶予を過ぎていれば手動で固定し、相手への Lock/Spawn 送信が滞らないようにする。
        if (g.isGrounded && g.lockTimer && typeof g.lockStartTime === "number") {
          const due =
            typeof g.lockRemaining === "number" ? g.lockRemaining : (g.lockDelay ?? 0);
          if (performance.now() - g.lockStartTime >= due) {
            clearTimeout(g.lockTimer);
            g.lockTimer = null;
            g.secureMino();
            g.requestRedraw?.();
          }
        }
      }
      // 相手の盤面に落下中ミノ/ぷよの動きを反映させる（throttleされた interval の代替）
      this.sendPieceStateNow();
    } catch (e) {
      this.logger.error("backgroundTick failed:", e);
    }
  }

  /** visibilitychange リスナーを登録する（対戦開始時）。 */
  private addVisibilityListener(): void {
    if (this.visibilityListenerActive || typeof document === "undefined") return;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityListenerActive = true;
  }

  /** visibilitychange リスナーを解除する（cleanup 時）。 */
  private removeVisibilityListener(): void {
    if (!this.visibilityListenerActive || typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityListenerActive = false;
  }

  /** 対戦画面上部の「残り生存者数」表示を更新する。
   *  2人戦は 2/2→1/2 にしかならず情報量が無いため3人戦以上でのみ表示する。 */
  private updateAliveDisplay(): void {
    if (this.roomInfo.players.length <= 2) {
      document.getElementById("ol-alive-count")?.remove();
      return;
    }
    let el = document.getElementById("ol-alive-count");
    if (!el) {
      el = document.createElement("div");
      el.id = "ol-alive-count";
      const battlePage = document.getElementById("online-battle-page");
      battlePage?.appendChild(el);
    }
    el.textContent = `ALIVE: ${this.aliveSet.size} / ${this.roomInfo.players.length}`;
  }

  /** ラウンド番号と先取スコアを結果インタースティシャルへ反映する。 */
  private updateSetScore(): void {
    const snapshot = this.lifecycle.snapshot();
    const score = this.roomInfo.players
      .map(([id, name]) => `${name} ${"★".repeat(snapshot.wins.get(id) ?? 0)}${"☆".repeat(Math.max(0, snapshot.target - (snapshot.wins.get(id) ?? 0)))}`)
      .join("  ·  ");
    const round = document.getElementById("ol-result-round");
    const setScore = document.getElementById("ol-result-set-score");
    if (round) round.textContent = `ROUND ${snapshot.round} / FIRST TO ${snapshot.target}`;
    if (setScore) setScore.textContent = score;
  }

  private markDead(playerId: Uuid): void {
    this.aliveSet.delete(playerId);
    this.updateAliveDisplay();
    this.checkLocalMatchEnd();
  }

  /**
   * ローカルの生存者集合だけで決着を検知する（サーバー通知に依存しないフェイルセーフ）。
   *
   * aliveSet は「自分の gameOver」「相手の GameOver(0x26)」「PlayerDisconnected」の
   * すべてで減るので、全端末がほぼ同時に残り1人を検知できる。ここでは**進行を止めるだけ**で
   * 勝敗表示は行わず、正式な WinnerNotification を待つ（勝敗はサーバー権威のまま）。
   * 通知が落ちた/遅れた場合のみ、猶予後にローカル判定で結果を出す。
   */
  private checkLocalMatchEnd(): void {
    if (this.lifecycle.phase !== "playing" && this.lifecycle.phase !== "countdown") return;
    if (this.aliveSet.size > 1) return;
    this.haltMatch(`local alive=${this.aliveSet.size}`);
    if (this.winnerFallbackTimer !== null) return;
    this.winnerFallbackTimer = window.setTimeout(() => {
      this.winnerFallbackTimer = null;
      if (this.lifecycle.phase !== "playing" && this.lifecycle.phase !== "countdown") return;
      const survivor = this.aliveSet.size === 1 ? [...this.aliveSet][0] : null;
      this.logger.warn(
        "WinnerNotification did not arrive in time. Falling back to local result.",
      );
      this.showWinner(survivor);
    }, OnlineGameController.WINNER_FALLBACK_MS);
  }

  private clearWinnerFallback(): void {
    if (this.winnerFallbackTimer !== null) {
      clearTimeout(this.winnerFallbackTimer);
      this.winnerFallbackTimer = null;
    }
  }

  /** パペットに紐づく一時タイマー（連鎖点滅など）を停止する */
  private stopPuppetTimers(): void {
    for (const driver of this.puppets.values()) driver.stop();
  }

  /** 自分の盤面の tet/puyo フィールド表示を切り替える（実体は battle/layout.ts） */
  private setSelfFieldVisibility(rule: 'tet' | 'puyo'): void {
    setOnlineSelfRule(rule);
  }

  /**
   * ネットワーク配送 sink とルーティング設定を作り、game.sendGarbage /
   * sendGarbageCrossTet として注入する（tet/puyo 送り手共通。実体は battle/garbage_router.ts）。
   *
   * ★ 同種戦: amount はそのまま相手ルールのフレームで送る（tet=ライン+穴 / puyo=おじゃま個数）。
   * ★ 異種戦: TETのゲージ値は相手PUYO向けのおじゃま個数へここで変換する。
   *    PUYO側はエンジンが相殺後のPUYO個数を渡すため、PUYO→TETでは再変換しない。
   * ★ 混在多人数戦: 主送信とは別に sendGarbageCrossTet がテト相手へ tet ライン火力を送る。
   */
  private hookGarbageSending(matchSetting: OnlineMatchSetting): void {
    const game = this.game;
    const conn = this.connection;
    const sink: GarbageSink = {
      sendTetLines: (lines, holes) => {
        conn.sendMatchEvent(encodeGarbage(lines, holes));
        game._olGarbageSentThisChain = true;
      },
      sendOjama: (count) => {
        conn.sendMatchEvent(encodeGarbagePuyo(count));
        game._olGarbageSentThisChain = true;
      },
    };
    const routeOpts = {
      cols: BOARD_COLS,
      holeRatePercent: matchSetting.garbageHoleRate,
      multiplier: matchSetting.garbageMultiplier,
      maxAmount: 255,
    };

    game.sendGarbage = (amount: number) => {
      const targetRule = game.opponentRule === 'puyo' ? 'puyo' : 'tet';
      routeGarbage(
        {
          ...routeOpts,
          amount,
          targetRule,
          gaugeToOjama: this.myRule === 'tet' && targetRule === 'puyo',
        },
        sink,
      );
    };

    game.sendGarbageCrossTet = (lines: number) => {
      if (!this.matchHasTetOpp) return;
      routeGarbage({ ...routeOpts, amount: lines, targetRule: 'tet' }, sink);
    };
  }

  /**
   * 全スロット（自分・相手 × tet/puyo）の FINISH/GAME OVER オーバーレイを消す。
   * ★ 旧実装は自分の TET 用1枚しか消しておらず、自分が PUYO のときや相手スロットの
   *   演出が次マッチへ持ち越されていた。
   */
  private clearFinishOverlay(): void {
    for (const prefix of allOnlineFieldPrefixes(ONLINE_OPP_SLOT_COUNT)) {
      clearFieldFinish(prefix);
    }
  }

  /** 自分の盤面に終了演出を出す（ルールに応じて tet/puyo の正しいオーバーレイを選ぶ） */
  private showSelfFinish(kind: "win" | "lose" | "gameover", onComplete?: () => void): void {
    showFieldFinish(onlineFieldPrefix("self", this.myRule), kind, onComplete);
  }

  /**
   * 自分のゲーム本体だけを凍結する（盤面・NEXTは残す。送信は行わない）。
   * 実体は battle/freeze.ts。★ PuyoGame は isPaused を見ないため、旧実装のように
   * isPaused を立てるだけでは止まらない（決着後もぷよが落ち続ける）。
   */
  private freezeSelfGame(): void {
    if (!this.game) return;
    freezeGameByRule(this.game, this.myRule, { keepCanvas: true });
  }

  /**
   * 対戦の進行を全て止める単一の入口。決着（WinnerNotification / ローカルの残り1人検知）で呼ぶ。
   * 冪等。ここでは lifecycle の状態遷移も勝敗表示も行わない（表示は showWinner の責務）。
   *
   * 「生存者が1人になった時点で全端末の進行を止める」という要件は、
   *  - 自分のエンジン（freezeSelfGame）
   *  - 相手パペット全員（driver.freeze: 連鎖リプレイ rAF を含む）
   *  - 送信 interval / バックグラウンドクロック
   *  - 以後の受信フレーム（matchHalted で破棄）
   * の4つを同時に止めて初めて満たされる。
   */
  private haltMatch(reason: string): void {
    if (this.matchHalted) return;
    this.matchHalted = true;
    this.logger.log(`Halting match progress (${reason}).`);
    this.stopPieceStateInterval();
    this.stopBackgroundClock();
    this.freezeSelfGame();
    for (const driver of this.puppets.values()) driver.freeze();
    // 決着時は相手スコアを補間の途中で止めず、受信済みの最終値を即座に確定表示する。
    settleScoreTweens();
  }

  constructor(
    connection: GameConnection,
    roomInfo: RoomInfoNotification,
    myUserId: Uuid,
  ) {
    this.connection = connection;
    this.roomInfo = roomInfo;
    this.myUserId = myUserId;
    for (const [id, name] of roomInfo.players) {
      this.playerNames.set(id, name);
    }
  }

  /**
   * 対戦画面（カウントダウン〜リザルト〜遷移処理）が出ている最中か。
   * online.tsx がルーム通知でロビー/確認パネルを描き直してよいかの判定に使う。
   * ★ これが無いと、対戦後に相手が抜けた RoomInfoNotification で
   *   ランダムマッチ確認パネルが再描画され、自動再マッチング（「マッチング中…」）へ飛ぶ。
   */
  get isBattleActive(): boolean {
    const phase = this.lifecycle.phase;
    return phase !== "idle" && phase !== "preparing";
  }

  /** Called from online.tsx when the room state changes mid-match */
  updateRoomInfo(info: RoomInfoNotification): void {
    this.roomInfo = info;
    for (const [id, name] of info.players) {
      this.playerNames.set(id, name);
    }
  }

  /**
   * Register to receive StartMatchNotification.
   * online.tsx calls this after joining a room.
   */
  listenForStart(callbacks: PostMatchCallbacks): void {
    this.postMatchCallbacks = callbacks;
    this.isRandomMatchRoom = callbacks.isRandomMatch ?? false;
    this.lifecycle.transition("preparing", "listenForStart");
    this.startNotifHandlerId = this.connection.onStartMatchNotification(
      (notif) => {
        if (notif.roomId === this.roomInfo.roomId) {
          // Remove the listener - it fires once per match
          if (this.startNotifHandlerId) {
            this.connection.removeReaderFunction(this.startNotifHandlerId);
            this.startNotifHandlerId = null;
          }
          this.startBattle(notif);
        }
      },
    );
  }

  /**
   * StartMatchNotification 受信。まず暗転させ、その後（真っ暗の下で）実際の
   * 盤面切り替え・エンジン初期化・相手パペットの同期待ちを行う（setupBattleUnderCover）。
   *
   * ★ ユーザー指定の演出順: プリロード/READY送信/相手待ち（フェーズA）は明るめのblurの
   *   まま進める。盤面の切り替えが透けて見えるのを防ぐため、暗転が完了してからのみ
   *   DOM切り替え・エンジン初期化を行う。
   *
   * ★ startTimeMs の意味を「本編開始時刻」ではなく「カウントダウン開始時刻」と読み替える
   *   （第9ラウンド設計）。本編開始 = startTimeMs + COUNTDOWN_MS の絶対時刻とし、
   *   カウントダウン開始・本編開始とも同じサーバー権威時刻(startTimeMs)から導出するので
   *   サーバー・プロトコルとも無改造のまま全端末の同期は維持される。
   *   （旧実装は startTimeMs を本編開始時刻のまま扱い、ロード演出で消費した時間の残りを
   *   そのままカウントダウン尺にしていたため、CPU戦の固定2100msより速く刻まれていた）。
   *
   * ★ 暗転を開始する「タイミング」自体もここで遅らせる（第11ラウンド設計）。
   *   サーバーの StartMatchNotification〜カウントダウン開始(既定3000ms)を全部暗転で
   *   覆うと「完全な黒」が2秒以上になり無駄に長い。カウントダウン開始時刻から
   *   COVER_MS だけ手前で暗転を始めれば、切替・初期化・同期待ちを隠すには十分。
   *   delay/startedAt は絶対時刻起点のまま渡すので、setupBattleUnderCover /
   *   revealBattleAfterSync 側の式は無変更で正しいまま機能する。
   */
  private startBattle(notif: StartMatchNotification): void {
    // 二重の開始通知・決着処理中の遅延通知はここで捨てる
    if (!this.lifecycle.transition("countdown", "StartMatchNotification")) return;
    this.myAlive = true;
    this.matchHalted = false;
    this.clearWinnerFallback();
    this.addVisibilityListener();
    this.aliveSet = new Set(this.roomInfo.players.map(([id]) => id));
    // ★ WIN/LOSE・GAME OVER 表示のクリアはここでは行わない（前ラウンドの見た目なので
    //   teardownFinishedRound で暗転後にまとめて消す）。ここで消すと「まもなく対戦開始…」の
    //   ロード表示中に決着画面だけが先に欠ける。
    this.myRematchVoted = false;
    this.rematchVotes.clear();
    this.departed.clear();

    // Determine my rule from room info
    const myPlayer = this.roomInfo.players.find(([id]) => id === this.myUserId);
    this.myRule = myPlayer?.[2] === 'puyo' ? 'puyo' : 'tet';

    const now = this.connection.serverNow();
    // delay = 「カウントダウンを開始すべき時刻」までの残り時間（本編開始ではない）。
    const delay = Math.max(0, notif.startTimeMs - now);
    const startedAt = performance.now();
    this.battleStartedAtMs = startedAt; // カウントダウン開始残り時間の起点（暗転前のこの時点で固定）

    const coverWait = Math.max(0, delay - COVER_MS);
    if (coverWait > 0) {
      // 全員READY済みで開始が確定しているので、待たせている間は文言を更新する
      // （旧「相手の準備を待っています…」のままだと開始が確定した後も嘘になる）。
      setLoadingProgress(1, "まもなく対戦開始…");
    }
    window.setTimeout(() => {
      // 待機中に決着・cleanup（相手切断等）が起きていたら何もしない
      if (this.lifecycle.phase !== "countdown") return;
      enterBlackout().then(() => this.setupBattleUnderCover(notif, delay, startedAt));
    }, coverWait);
  }

  /**
   * enterBlackout() が解決した後（＝画面が完全に不可視）に呼ばれる。盤面切り替え・
   * エンジン初期化・相手パペットの同期待ちをすべてここで行う。
   */
  private setupBattleUnderCover(
    notif: StartMatchNotification,
    delay: number,
    startedAt: number,
  ): void {
    // 暗転中に決着・cleanup（相手切断等）が起きていたら何もしない
    if (this.lifecycle.phase !== "countdown") return;

    // ★ 前ラウンドの後片付け（リザルト画面・盤面・ゲージの破棄）は必ずここで行う。
    //   画面が完全に不可視になってから消し、次の盤面を作る前に旧エンジン/パペットを
    //   破棄する順序を保証する（再戦時に見えている画面が欠けないようにするため）。
    this.teardownFinishedRound();

    // 暗転待ちで消費した時間ぶんを差し引いた、この時点から「カウントダウン開始」までの残り時間。
    // setTimeout(...) はここから数えるので、開始時刻(startTimeMs)自体は変えず
    // スケジュールだけ補正する（両者を組み合わせれば元の絶対時刻と一致する）。
    const adjustedDelay = Math.max(0, delay - (performance.now() - startedAt));
    // 本編開始までの残り時間 = カウントダウン開始までの残り時間 + カウントダウン尺(固定)。
    const adjustedDelayToBattleStart = adjustedDelay + OnlineGameController.COUNTDOWN_MS;

    // Switch page first so canvas elements are in the DOM
    this.switchToBattlePage();
    this.applyBattleLayout(this.roomInfo.players.length);
    applyOnlineSelfSide();
    // オンライン専用BGM。音源パスは public/core/base.js の登録だけ差し替えればよい。
    (window as any).BgmManager?.play("online_bgm");
    this.updateAliveDisplay();

    // 自分のプレイヤー名を盤面下ラベルに表示
    const selfLabel = document.getElementById("ol-p-name");
    if (selfLabel) {
      const me = this.roomInfo.players.find(([id]) => id === this.myUserId);
      if (me) selfLabel.textContent = me[1];
    }

    // 自分の表示位置は各クライアントのローカル設定で決める。
    // 相手の画面配置や参加順を同期しない。

    // Build opponent puppets based on each player's rule
    const opponents = this.roomInfo.players.filter(([id]) => id !== this.myUserId);
    opponents.forEach(([id, name, rule], index) => {
      showOnlineOppSlot(index);
      const nameEl = document.getElementById(`ol-opp-name-${index}`);
      if (nameEl) {
        nameEl.textContent = name;
        nameEl.classList.remove("is-dead", "is-disconnected");
      }

      const oppRule: 'tet' | 'puyo' = rule === 'puyo' ? 'puyo' : 'tet';
      this.puppetRules.set(id, oppRule);
      setOnlineOppRule(index, oppRule);

      const driver = new NetworkDriver({
        id,
        index,
        rule: oppRule,
        onDead: (playerId) => this.markDead(playerId as Uuid),
        onStats: (statsIndex, stats) => updateOnlineStats(statsIndex, stats),
      });
      driver.start();
      this.puppets.set(id, driver);
      this.puppetIndices.set(id, index);
    });

    // 相手ルールを確定（複数戦でぷよが混在する場合はぷよ優先＝蓄積方式を採る）
    const oppRules = opponents.map(([id]) => this.puppetRules.get(id));
    this.matchOpponentRule = oppRules.includes('puyo') ? 'puyo' : 'tet';
    this.matchHasTetOpp = oppRules.includes('tet');
    this.matchHasPuyoOpp = oppRules.includes('puyo');

    const matchSetting = parseMatchSetting(notif.matchSetting);
    if (!this.setConfigured) {
      this.lifecycle.configureSet(matchSetting.setTarget);
      this.setConfigured = true;
    }
    this.lifecycle.beginRound();
    // ★ ここで自分のエンジン初期化を始める（＝相手への sentinel 送信も始まる）。
    //   ロード画面を閉じるタイミングだけを別途 revealBattleAfterSync で遅らせる設計にしないと、
    //   全員が「相手のデータを待ってから自分のデータを送る」ことになりデッドロックする。
    if (this.myRule === 'puyo') {
      this.initPuyoBattle(notif, matchSetting, adjustedDelayToBattleStart);
    } else {
      this.initTetBattle(notif, matchSetting, adjustedDelayToBattleStart);
    }
    this.revealBattleAfterSync(delay);
  }

  /**
   * 相手パペットの初回データ（NEXT/盤面）が揃うまで真っ暗を維持しつつ、フェードイン
   * (revealBattle)の完了が「カウントダウン開始時刻」ちょうどになるようタイミングを合わせる。
   *
   * ★ 背景: 自分の盤面はローカルの initGame 完了ですぐ描画されるが、相手パペットは
   *   生成直後は完全に空（driver.ts）で、相手からの sentinel Spawn/PuyoSpawn フレームが
   *   ネットワーク越しに届くまで NEXT/HOLD が空のまま描画される。ここで待ってから
   *   フェードインすることで、対戦画面が見えた瞬間には相手盤面も埋まっている
   *   （2026-07-26 不具合の対策を維持）。
   *
   * ★ カウントダウンは runCountdown 内で開始から固定 COUNTDOWN_MS(2100ms、CPU戦と同じ
   *   700ms間隔)かけて進む。本編開始の setTimeout は setupBattleUnderCover 側で既に
   *   「battleStartedAtMs + delay + COUNTDOWN_MS」の絶対時刻に固定済みなので、
   *   カウントダウンが「ちょうど battleStartedAtMs + delay に開始する」ことさえ保証すれば、
   *   カウントダウン終了(=STARTの表示)と本編開始が自然に一致する。そのため
   *   revealBattle() の呼び出しを、相手パペットが揃っていても
   *   「battleStartedAtMs + delay - LOADING_CLOSE_MS(フェードイン尺)」の時刻まで遅らせる
   *   （早くフェードインを終えてしまうとカウントダウンも早く終わり、本編開始との間に
   *   ギャップが空いてしまう）。
   *
   * ★ 相手パペットの同期が間に合わない場合だけ、上記の時刻に達した時点で強制的に
   *   reveal を進める（それ以上待たない）。この場合カウントダウンの尺を
   *   「本編開始の絶対時刻までの残り時間」へ短縮する（下限 MIN_COUNTDOWN_MS）。
   *   本編開始の絶対時刻自体は変えないので、同期が崩れるのはカウントダウンの見た目の
   *   長さだけ（旧実装からの縮退動作を維持）。
   */
  private revealBattleAfterSync(delay: number): void {
    const startedAt = this.battleStartedAtMs ?? performance.now();
    const countdownStartAbs = startedAt + delay;
    const revealTriggerAbs = countdownStartAbs - LOADING_CLOSE_MS;

    const waits = [...this.puppets.values()].map((d) => d.waitForFirstData());
    const dataReady: Promise<void> = waits.length === 0 ? Promise.resolve() : Promise.all(waits).then(() => {});
    const fallbackDeadline = new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, revealTriggerAbs - performance.now()));
    });

    Promise.race([dataReady, fallbackDeadline]).then(() => {
      if (this.lifecycle.phase !== "countdown") return; // 待機中に決着/cleanupが起きていたら何もしない
      // 相手が早く揃っても revealTriggerAbs より前には進めない（カウントダウン開始を早めない）。
      const waitBeforeReveal = Math.max(0, revealTriggerAbs - performance.now());
      setTimeout(() => {
        if (this.lifecycle.phase !== "countdown") return;
        revealBattle().then(() => {
          if (this.lifecycle.phase !== "countdown") return;
          const battleStartAbs = startedAt + delay + OnlineGameController.COUNTDOWN_MS;
          const remaining = battleStartAbs - performance.now();
          const countdownMs = Math.max(
            OnlineGameController.MIN_COUNTDOWN_MS,
            Math.min(OnlineGameController.COUNTDOWN_MS, remaining),
          );
          this.showCountdown(countdownMs);
        });
      }, waitBeforeReveal);
    });
  }

  private initTetBattle(
    notif: StartMatchNotification,
    matchSetting: OnlineMatchSetting,
    delay: number,
  ): void {
    // 自分のフィールドを tet 表示に切り替え
    this.setSelfFieldVisibility('tet');

    this.game = new Game("ol-p");
    (window as any)._olGame = this.game; // E2Eテスト用フック
    this.game.isVersusMode = true;
    // ★ CPU戦(versus.js)と同じ 'versus' モード。'marathon' のままだと10ライン毎に
    //   レベルが上昇し(scoring.js)、150ライン到達で誤ってクリア扱いにもなる(board.js)。
    this.game.currentMode = "versus";
    this.game.isOnline = true;
    this.game.opponentRule = this.matchOpponentRule; // 異種戦判定をエンジンへ注入
    this.game._hasTetOpp = this.matchHasTetOpp;   // 混在多人数: テト相手が居るか
    this.game._hasPuyoOpp = this.matchHasPuyoOpp; // 混在多人数: ぷよ相手が居るか

    this.hookTetGameMethods(matchSetting);

    this.game.vsMarginTimeMs = matchSetting.marginTime * 1000;
    this.game.vsGarbageHoleRate = matchSetting.garbageHoleRate;
    this.game.vsGarbageDamageOnClear = matchSetting.garbageDamageOnClear;
    this.game.vsB2bBonusEnabled = matchSetting.b2bBonus;

    this.subscribeToControlEvents();

    this.game.tumoRng = createSeededRng(notif.seed);
    this.game._initGameState();
    this.game.level = 2; // CPU戦(versus.js)と同じ固定レベル
    this.game.setKeyEvent();
    // ★ カウントダウンの見た目はロード画面を閉じ終えてから開始する（revealBattleAfterSync）。
    //   本編開始そのものは下の setTimeout(delay) 固定＝サーバー権威の startTimeMs +
    //   COUNTDOWN_MS（絶対時刻）から算出済み。

    this.matchHandlerId = this.connection.onMatchEvent((frame) => this.handleMatchFrame(frame));

    const sentinelDelays = [120, 280, 500, 900, 1500, 2200];
    for (const d of sentinelDelays) {
      setTimeout(() => {
        const g = this.game;
        if (!g || !this.myAlive) return;
        const holdType = g.holdMino ? g.holdMino.type : 0xff;
        const nextTypes = (g.nextQueue as any[]).slice(0, 5).map((m: any) => m.type);
        this.connection.sendMatchEvent(encodeSpawn(0xff, holdType, nextTypes));
      }, d);
    }

    setTimeout(() => {
      // カウントダウン中に決着（相手切断）やcleanupが起きていたら本編を開始しない
      if (!this.game || !this.lifecycle.transition("playing", "countdown finished"))
        return;
      this.game._startGameplay();
      this.startPieceStateInterval();
      // カウントダウン中にタブを隠したまま開始した場合、visibilitychange は発火しないので
      // ここで明示的にバックグラウンドクロックを同期する。
      this.syncBackgroundClock();
    }, delay);
  }

  private initPuyoBattle(
    notif: StartMatchNotification,
    matchSetting: OnlineMatchSetting,
    delay: number,
  ): void {
    // 自分のフィールドを puyo 表示に切り替え
    this.setSelfFieldVisibility('puyo');

    this.game = new PuyoGame("ol-p");
    (window as any)._olGame = this.game; // E2Eテスト用フック
    this.game.isVersusMode = true;
    this.game.currentMode = "versus"; // CPU戦(versus.js)と揃える
    this.game.isOnline = true;
    this.game.opponentRule = this.matchOpponentRule; // 異種戦判定をエンジンへ注入
    this.game._hasTetOpp = this.matchHasTetOpp;   // 混在多人数: テト相手が居るか
    this.game._hasPuyoOpp = this.matchHasPuyoOpp; // 混在多人数: ぷよ相手が居るか
    this.game.vsMarginTimeMs = matchSetting.marginTime * 1000;
    this.game.vsOjamaRate = matchSetting.ojamaRate;

    // RNGを initGame (内部の _resetState → _initNextQueue) より前に注入
    this.game.rng = createSeededRng(notif.seed);

    const initStart = performance.now();
    this.game.initGame(() => {
      this.hookPuyoGameMethods(matchSetting);

      this.subscribeToControlEvents();

      this.matchHandlerId = this.connection.onMatchEvent((frame) => this.handleMatchFrame(frame));

      // Puyo sentinel: カウントダウン中に nextQueue を相手へ通知
      const sentinelDelays = [120, 280, 500, 900, 1500];
      for (const d of sentinelDelays) {
        setTimeout(() => {
          const g = this.game;
          if (!g || !this.myAlive) return;
          const nextPairs = (g.nextQueue as any[]).slice(0, 3).map((p: any): [number, number] => [p[0], p[1]]);
          // pivotColor=0, childColor=0 をsentinelとして使用 (受信側はnextQueueのみ更新)
          this.connection.sendMatchEvent(encodePuyoSpawn(0, 0, nextPairs));
        }, d);
      }

      const elapsed = performance.now() - initStart;
      const remaining = Math.max(0, delay - elapsed);
      // ★ カウントダウンの見た目はロード画面を閉じ終えてから開始する（revealBattleAfterSync）。
      //   本編開始そのものは下の setTimeout(remaining) 固定＝サーバー権威の startTimeMs +
      //   COUNTDOWN_MS（絶対時刻）から算出済み。
      setTimeout(() => {
        // カウントダウン中に決着（相手切断）やcleanupが起きていたら本編を開始しない
        if (!this.game || !this.lifecycle.transition("playing", "countdown finished"))
          return;
        this.game._startGameplay();
        this.startPieceStateInterval();
        // カウントダウン中にタブを隠したまま開始した場合の取りこぼし防止
        this.syncBackgroundClock();
      }, remaining);
    });
  }

  private switchToBattlePage(): void {
    // CPU戦とオンライン戦は同じ対戦ページを共有する。オンライン用の盤面パネルは
    // 初回利用時にCPUページへ移動し、以後は同じ .page の配下だけを切り替える。
    const versusPage = document.getElementById("versus-page");
    const onlinePanel = document.getElementById("online-battle-page");
    if (versusPage && onlinePanel && onlinePanel.parentElement !== versusPage) {
      onlinePanel.classList.remove("page");
      onlinePanel.classList.add("battle-panel");
      versusPage.appendChild(onlinePanel);
    }
    document.querySelectorAll<HTMLElement>(".page").forEach((p) => {
      p.classList.remove("active");
      p.style.display = "";
    });
    if (versusPage) versusPage.classList.add("active", "online-battle-active");
    // online-top-page が'active'を失う（＝FocusNavのrootIsActive判定が false になる）ので、
    // 明示的にdeactivateしないとキー入力が対戦画面に届かないまま無反応の登録が残り続ける。
    (window as any).FocusNav?.deactivate();
  }

  // ── Hook game engine methods ─────────────────────────────────────────────

  private hookTetGameMethods(matchSetting: OnlineMatchSetting): void {
    const game = this.game;
    const conn = this.connection;
    const roomId = this.roomInfo.roomId;
    // ★ ソフトドロップは1マス毎にスコア+1され updateStatsDisplay() が呼ばれる（input.js）。
    //   これを毎回そのまま送信すると高速落下時に通信が過多になるため、100ms間隔で間引く
    //   （末尾の変化は setTimeout で必ず送る＝取りこぼさない）。自分の画面表示だけは
    //   間引かず毎回即時更新する（updateStatsRealtime参照）。
    const STATS_THROTTLE_MS = 100;
    let lastStatsSentAt = 0;
    let statsThrottleTimer: number | null = null;
    const sendStats = () => {
      lastStatsSentAt = performance.now();
      if (statsThrottleTimer !== null) {
        clearTimeout(statsThrottleTimer);
        statsThrottleTimer = null;
      }
      const attackSent = game.attackSent ?? 0;
      const activeMs = (typeof game.getActiveMs === 'function') ? game.getActiveMs() : 0;
      const stats = encodeStatsUpdate("tet", game.score ?? 0, game.lines ?? 0, 0, attackSent, activeMs);
      conn.sendMatchEvent(stats);
      updateOnlineStats("self", { rule: "tet", score: game.score ?? 0, lines: game.lines ?? 0, chainMax: 0, attackSent, activeMs });
    };
    // 自分の表示は即時、相手への送信だけスロットルする（ソフトドロップ連打用）。
    const updateStatsRealtime = () => {
      const attackSent = game.attackSent ?? 0;
      const activeMs = (typeof game.getActiveMs === 'function') ? game.getActiveMs() : 0;
      updateOnlineStats("self", { rule: "tet", score: game.score ?? 0, lines: game.lines ?? 0, chainMax: 0, attackSent, activeMs });
      const elapsed = performance.now() - lastStatsSentAt;
      if (elapsed >= STATS_THROTTLE_MS) {
        sendStats();
      } else if (statsThrottleTimer === null) {
        statsThrottleTimer = window.setTimeout(() => {
          statsThrottleTimer = null;
          sendStats();
        }, STATS_THROTTLE_MS - elapsed);
      }
    };
    const sendHoldState = () => conn.sendMatchEvent(
      encodeHoldState(!!game.canHold && matchSetting.holdEnabled),
    );

    // updateStatsDisplay: スコア変化のたび（ソフトドロップ含む）に自分の画面へ即時反映する。
    // ★ statsPrefix が online では未設定のため、元の実装は単発プレイ用の #score-value 等
    //   （画面に存在しない）へ書き込むだけで何も見えていなかった。ここで online 表示
    //   （updateOnlineStats）へ橋渡しする。
    if (typeof game.updateStatsDisplay === 'function') {
      const origUpdateStatsDisplay: AnyFn = game.updateStatsDisplay.bind(game);
      game.updateStatsDisplay = (...args: any[]) => {
        origUpdateStatsDisplay(...args);
        if (!this.myAlive) return;
        updateStatsRealtime();
      };
    }

    // popMino: origPopMino() でミノをフィールドに固定してから Lock を送信する
    const origPopMino: AnyFn = game.popMino.bind(game);
    game.popMino = () => {
      const hadMino = game.mino !== null;
      // ★ block-out（出現位置での致命判定）は origPopMino() の内部で gameOver() まで
      //   呼び切ってしまい、その中で this.myAlive が false へ落ちる。呼び出し後の
      //   this.myAlive で判定すると、直前に確定した設置(致命の原因となった盤面)が
      //   一生相手に送られなくなる。呼び出し時点の生存状態で判定する。
      const wasAlive = this.myAlive;
      origPopMino();
      // ★ block-out: この呼び出しの中で致命した場合、衝突したミノは game.mino に
      //   残ったまま field には固定されない（board.js popMino）。その衝突ミノを
      //   最終盤面の Lock に同梱して送り、「本人が見ていた死亡直前の画面」を
      //   受信側が盤面とミノまとめて1フレームで再現できるようにする。
      //   ★ PieceState(0x20) では送れない: サーバーが reliable チャネルでの PieceState を
      //     明示的に拒否する（tetra-server の connection/reliable.rs）ため、送っても
      //     相手に一切届かない（送信側からは成功に見える罠）。
      const diedHere = wasAlive && !this.myAlive;
      const dyingMino = diedHere && game.mino
        ? { type: game.mino.type, x: game.mino.x, y: game.mino.y, rotation: game.mino.rotation }
        : undefined;
      // origPopMino() 後にブロックが field.blocks に追加済みなのでスナップショットが正しい
      if ((hadMino || diedHere) && wasAlive) {
        const boardData = fieldBlocksToArray(game.field.blocks);
        conn.sendMatchEvent(encodeLock(boardData, dyingMino));
      }
      // Don't send Spawn if game just ended inside origPopMino
      if (game.mino && this.myAlive) {
        const holdType = game.holdMino ? game.holdMino.type : 0xff;
        const nextTypes = (game.nextQueue as any[])
          .slice(0, 5)
          .map((m) => m.type);
        conn.sendMatchEvent(
          encodeSpawn(game.mino.type, holdType, nextTypes, {
            type: game.mino.type, x: game.mino.x, y: game.mino.y, rotation: game.mino.rotation,
          }),
        );
        sendHoldState();
        sendStats();
      }
    };

    // holdCurrentMino: disabled if holdEnabled=false, otherwise send Spawn after swap
    if (!matchSetting.holdEnabled) {
      game.holdCurrentMino = () => {};
    } else {
      const origHold: AnyFn = game.holdCurrentMino.bind(game);
      game.holdCurrentMino = () => {
        const isFirstHold = game.holdMino === null;
        origHold();
        // First hold: popMino was called internally → Spawn already sent. Skip.
        // Swap hold: popMino NOT called → send Spawn here.
        if (!isFirstHold && game.mino && this.myAlive) {
          const holdType = game.holdMino ? game.holdMino.type : 0xff;
          const nextTypes = (game.nextQueue as any[])
            .slice(0, 5)
            .map((m) => m.type);
          conn.sendMatchEvent(
            encodeSpawn(game.mino.type, holdType, nextTypes, {
              type: game.mino.type, x: game.mino.x, y: game.mino.y, rotation: game.mino.rotation,
            }),
          );
          sendHoldState();
          sendStats();
        }
      };
    }

    // sendGarbage / sendGarbageCrossTet: ネットワーク送信へルーティング（battle/garbage_router.ts）。
    // ★ 異種戦(対ぷよ): secureMino から渡る amount は「おじゃま個数」（VERSUS同様、消去なし設置時に
    //    溜めた pendingAttack をまとめて放出）。GarbagePuyo として送る（受信ぷよはそのまま受ける）。
    // ★ 同種戦(対テト): amount は tet ライン数。即時に Garbage(穴同梱)として送る。
    this.hookGarbageSending(matchSetting);

    // gameOver: stop game and notify server
    // ※ ラウンド自体(lifecycle: playing)は WinnerNotification まで続く（観戦状態）。
    //   myAlive=false でバックグラウンド駆動・送信系は止まる。
    game.gameOver = (_isClear = false) => {
      if (!this.myAlive) return;
      // ★ 実エンジン(tet/lifecycle.js gameOver)は先頭で playSe('gameover') を鳴らすが、
      //   このオーバーライドは元実装を呼ばない全面置き換えなので明示的に鳴らす。
      //   myAlive を false にする前に鳴らすこと＝playSe フックの送信条件を満たす。
      if (!_isClear) game.playSe?.('gameover');
      // ★ block-out（出現位置での致命判定）は popMino が衝突ミノを game.mino に
      //   残したまま gameOver() を呼ぶ（board.js）。ここでまだ null 化されていないので、
      //   死亡直前の自分の画面と同じ絵を GameOver フレームに同梱して相手へ送る。
      const dyingMino = game.mino
        ? { type: game.mino.type, x: game.mino.x, y: game.mino.y, rotation: game.mino.rotation }
        : undefined;
      this.myAlive = false;
      this.stopPieceStateInterval();
      this.freezeSelfGame();
      // ★ markDead は「残り1人ならローカルでも全進行を止める」判定を含むので、
      //   自分の停止を済ませてから呼ぶ。
      this.markDead(this.myUserId);
      game.drawAll();

      this.logger.log("Local game over. Notifying server...");
      conn.sendMatchEvent(encodeGameOver(dyingMino));
      conn
        .notifyGameOver({ roomId })
        .then((res) => this.logger.log("NotifyGameOver response:", res));

      // 自分の盤面に GAME OVER を出す。★ ルールに応じたオーバーレイを選ぶ
      //   （旧実装は常に tet 用の ol-p-finish-overlay を叩いていたため、
      //     自分が PUYO のときは display:none の要素に書いていて何も見えなかった）
      this.showSelfFinish("gameover");
    };

    // Pause: send network pause/resume instead of local toggle
    game.togglePause = () => {
      if (!game.isPaused) {
        conn.sendPause({ roomId });
      } else {
        conn.sendResume({ roomId });
      }
    };

    // Prevent single-player restart
    game.start = () => {};

    // showActionLabels: ライン消去演出を相手へ送信 (Clear frame)
    // flags: bit0=T-spin, bit1=B2B, bit2=PC
    const origShowActionLabels: AnyFn = game.showActionLabels.bind(game);
    game.showActionLabels = (
      tSpinType: string | null,
      linesCleared: number,
      isB2B: boolean,
      renCount: number,
      isPerfectClear: boolean,
      is4Lines: boolean,
    ) => {
      origShowActionLabels(tSpinType, linesCleared, isB2B, renCount, isPerfectClear, is4Lines);
      if (!this.myAlive) return;
      let flags = 0;
      if (tSpinType === 'tspin') flags |= 1;
      if (isB2B) flags |= 2;
      if (isPerfectClear) flags |= 4;
      conn.sendMatchEvent(encodeClear(linesCleared, flags, renCount));
      sendStats();
    };

    // playSe: 重要な SE を相手へ同期する
    // ★ playSe の戻り値（実際に鳴らしたか）を見てから送る。チャタリング防止で間引かれた
    //   呼び出しまで送ると、送り手には鳴らなかった音が受け手にだけ二重に鳴る。
    const origPlaySe: AnyFn = game.playSe.bind(game);
    game.playSe = (key: string) => {
      const played = origPlaySe(key);
      if (!this.myAlive || played === false) return;
      const id = SE_IDS[key];
      if (id !== undefined) {
        conn.sendMatchEvent(encodeSE(id));
      }
    };

    // 予告ゲージ(ready/unready)とアタックゲージ(pendingAttack/表示可否)をまとめて
    // 1つの PendingUpdate frame で送る（4値の組でdedup）。相手スロットのアタックゲージ
    // 同期のため updateGarbageGauge・updateAttackGauge の両方をフックする。
    let lastPendingReady = -1, lastPendingUnready = -1, lastPendingAttack = -1, lastPendingAttackVisible = false;
    const sendGaugeState = () => {
      let ready = 0, unready = 0;
      for (const g of (game.garbageQueue ?? [])) {
        if (g.internal) continue;
        if (g.ready) ready += g.amount;
        else unready += g.amount;
      }
      const attack = game.pendingAttack ?? 0;
      // ★ 表示可否は送信者(=このgame)が実際に判定した結果をそのまま送る。受信側で
      //   相手ルールを再判定すると多人数混在戦で送信者の見え方とズレる恐れがある。
      const attackGaugeEl = document.getElementById(`${game.canvasPrefix}-attack-gauge`);
      const attackVisible = !!attackGaugeEl && attackGaugeEl.style.display !== "none";
      if (ready !== lastPendingReady || unready !== lastPendingUnready
        || attack !== lastPendingAttack || attackVisible !== lastPendingAttackVisible) {
        lastPendingReady = ready;
        lastPendingUnready = unready;
        lastPendingAttack = attack;
        lastPendingAttackVisible = attackVisible;
        conn.sendMatchEvent(encodePendingUpdate(Math.min(ready, 255), Math.min(unready, 255), attack, attackVisible));
      }
    };

    // updateGarbageGauge: 自分の予告ゲージ変化を相手へ送信 (PendingUpdate frame)
    const origUpdateGarbageGauge: AnyFn = game.updateGarbageGauge.bind(game);
    game.updateGarbageGauge = () => {
      origUpdateGarbageGauge();
      sendGaugeState();
    };

    // updateAttackGauge: 自分のアタックゲージ(対ぷよ戦の送信用火力)変化を相手へ送信
    const origUpdateAttackGauge: AnyFn = game.updateAttackGauge.bind(game);
    game.updateAttackGauge = () => {
      origUpdateAttackGauge();
      sendGaugeState();
    };

    // Pause overlays: use the online overlays
    game.showPauseOverlay = () => {
      const ol = document.getElementById("ol-pause-overlay");
      if (ol) ol.style.display = "flex";
    };
    game.hidePauseOverlay = () => {
      const ol = document.getElementById("ol-pause-overlay");
      if (ol) ol.style.display = "none";
    };
  }

  private hookPuyoGameMethods(matchSetting: OnlineMatchSetting): void {
    const game = this.game;
    const conn = this.connection;
    const roomId = this.roomInfo.roomId;
    // ★ 高速落下は _update 内でフレーム毎に加算(scoreFloat)され、1点貯まるたび
    //   _updateScoreDisplay() が呼ばれる（engine.js）。TET同様に相手への送信だけ
    //   100msへ間引き、自分の画面は毎回即時更新する。
    const STATS_THROTTLE_MS = 100;
    let lastStatsSentAt = 0;
    let statsThrottleTimer: number | null = null;
    const sendStats = () => {
      lastStatsSentAt = performance.now();
      if (statsThrottleTimer !== null) {
        clearTimeout(statsThrottleTimer);
        statsThrottleTimer = null;
      }
      const activeMs = (typeof game.getActiveMs === 'function') ? game.getActiveMs() : 0;
      const stats = {
        rule: "puyo" as const,
        score: game.score ?? 0,
        lines: 0,
        chainMax: game.chainMax ?? 0,
        attackSent: 0, // puyoはAPM/LPM非表示（design参照）。フィールドのみ揃える
        activeMs,
      };
      conn.sendMatchEvent(encodeStatsUpdate("puyo", stats.score, 0, stats.chainMax, 0, activeMs));
      updateOnlineStats("self", stats);
    };
    const updateStatsRealtime = () => {
      const activeMs = (typeof game.getActiveMs === 'function') ? game.getActiveMs() : 0;
      updateOnlineStats("self", { rule: "puyo", score: game.score ?? 0, lines: 0, chainMax: game.chainMax ?? 0, attackSent: 0, activeMs });
      const elapsed = performance.now() - lastStatsSentAt;
      if (elapsed >= STATS_THROTTLE_MS) {
        sendStats();
      } else if (statsThrottleTimer === null) {
        statsThrottleTimer = window.setTimeout(() => {
          statsThrottleTimer = null;
          sendStats();
        }, STATS_THROTTLE_MS - elapsed);
      }
    };

    // _updateScoreDisplay: online では scoreEl(#ol-p-score-value) が存在しない
    // （online のスコア表示は updateOnlineStats が動的生成するため）ので何も
    //   見えていなかった。ここで online 表示・相手への間引き送信へ橋渡しする。
    if (typeof game._updateScoreDisplay === 'function') {
      const origUpdateScoreDisplay: AnyFn = game._updateScoreDisplay.bind(game);
      game._updateScoreDisplay = (...args: any[]) => {
        origUpdateScoreDisplay(...args);
        if (!this.myAlive) return;
        updateStatsRealtime();
      };
    }

    // _beginGameOver がグローバルの versusGameOver() を呼ぶのを防ぐ
    // (versusGameOver はCPU対戦用でオンライン対戦では不要)
    // ★ 実エンジン(engine.js _beginGameOver)は先頭で playSe('gameover') を鳴らすが、
    //   このオーバーライドは元実装を呼ばない全面置き換えなので、明示的に鳴らす必要がある
    //   （鳴らさないと自分にも相手にもゲームオーバー音が出ない）。myAlive がまだ true の
    //   この時点で鳴らすこと＝playSe フックの送信条件を満たす（gameOver() 後だと送られない）。
    game._beginGameOver = () => {
      game.playSe?.('gameover');
      game._stopTimer?.();
      game._removeKeyHandlers?.();
      game._clearChainTextDOM?.();
      game.isAllClear = false;
      game.state = 'gameover';
      game._gs = 'gameover';
      game.gameOver?.();
    };

    // sendGarbage / sendGarbageCrossTet: ネットワーク送信へルーティング（battle/garbage_router.ts）。
    // ★ 同種戦(対ぷよ): amount は「おじゃま個数」（_applyOjamaOffset で確定）→ GarbagePuyo。
    // ★ 異種戦(対テト): amount は「tet ライン数」（_resolveTetAttack のスコアベース算出を
    //    _applyOjamaOffset が送る）→ Garbage(穴同梱)。これで ojamaToTetLines 逆変換による過少を回避。
    this.hookGarbageSending(matchSetting);

    // gameOver
    // ※ ラウンド自体(lifecycle: playing)は WinnerNotification まで続く（観戦状態）。
    game.gameOver = (_isClear = false) => {
      if (!this.myAlive) return;
      this.myAlive = false;
      this.stopPieceStateInterval();
      this.freezeSelfGame();
      this.markDead(this.myUserId);
      game._render?.();

      this.logger.log("Local puyo game over. Notifying server...");
      conn.sendMatchEvent(encodeGameOver());
      conn.notifyGameOver({ roomId }).then((res) => this.logger.log("NotifyGameOver response:", res));

      // 自分の盤面に GAME OVER を出す（ルールに応じたオーバーレイ）
      this.showSelfFinish("gameover");
    };

    // _beginSpawnAnim: NEXT遷移(spawnAnim)の開始時点でフィールド+次ペア情報を先行送信する。
    // ★ 従来は _spawnPuyo（＝62msのspawnAnimが完了した後）で送っていたため、相手のNEXT遷移が
    //   自分より62ms＋通信遅延ぶん遅れて始まって見えていた。この時点ではまだ _dequeueNext
    //   していないので、nextQueue[0] がこれから falling になるペア（= 従来 pivotColor/childColor
    //   として送っていた値）、nextQueue.slice(1,4) がその次のNEXT3枚（= 従来 nextPairs として
    //   送っていた値）に一致する。_dequeueNext は shift() のみで、この62msの間にQUIZモード以外は
    //   キューへ触らないため、この先読みは確定的（第9ラウンド設計参照）。
    const origBeginSpawnAnim: AnyFn = game._beginSpawnAnim.bind(game);
    game._beginSpawnAnim = () => {
      const result = origBeginSpawnAnim();
      if (this.myAlive) {
        conn.sendMatchEvent(encodePuyoLock(game.field as number[][]));
        const nq = game.nextQueue as any[];
        const nextPair = nq[0] ?? [0, 0];
        const followingPairs = nq.slice(1, 4).map((p: any): [number, number] => [p[0], p[1]]);
        conn.sendMatchEvent(encodePuyoSpawn(nextPair[0], nextPair[1], followingPairs));
        sendStats();
        game._olSpawnSentEarly = true;
      }
      return result;
    };

    // _spawnPuyo: 新ペア出現時にフィールドスナップショット + スポーン情報を送信。
    // ★ 通常は上の _beginSpawnAnim フックで既に先行送信済み（_olSpawnSentEarly）なので
    //   ここでは重複送信を抑止するだけ。初手（_gs の初期値 'spawn' で spawnAnim を経由せず
    //   直接 _spawnPuyo が呼ばれる）だけは _beginSpawnAnim を通らないため、従来どおりここで送る。
    const origSpawnPuyo: AnyFn = game._spawnPuyo.bind(game);
    game._spawnPuyo = () => {
      const result = origSpawnPuyo();
      if (!this.myAlive || !result) return result;
      if (game._olSpawnSentEarly) {
        game._olSpawnSentEarly = false;
        return result;
      }
      // フィールドスナップショット送信
      conn.sendMatchEvent(encodePuyoLock(game.field as number[][]));
      // ペア + NEXT 送信
      const nextPairs = (game.nextQueue as any[]).slice(0, 3).map((p: any): [number, number] => [p[0], p[1]]);
      conn.sendMatchEvent(encodePuyoSpawn(game.pivotColor, game.childColor, nextPairs));
      sendStats();
      return result;
    };

    // 連鎖中・着地時に盤面が変化するたびに、段階(phase)付きスナップショットを送る。
    // 受信側(driver.ts の連鎖リプレイ)がこの phase を使って点滅→消去→落下を実タイミングで再生する。
    // これがないと、相手の盤面は新ペア出現（連鎖完了後）まで一切更新されない。
    const sendFieldSnapshot = (phase: number, field?: number[][]) => {
      if (!this.myAlive) return;
      conn.sendMatchEvent(encodePuyoLock((field ?? game.field) as number[][], phase));
    };
    // _applyErase は毎回そのまま送る（連鎖中も含む）。
    const snapshotHooks: Array<[string, number, boolean]> = [
      ['_applyErase', PuyoLockPhase.Erase, false],
    ];
    for (const [method, phase, onlyOutsideChain] of snapshotHooks) {
      if (typeof game[method] !== 'function') continue;
      const orig: AnyFn = game[method].bind(game);
      game[method] = (...args: any[]) => {
        const r = orig(...args);
        if (!onlyOutsideChain || (game.chainCount ?? 0) === 0) sendFieldSnapshot(phase);
        return r;
      };
    }

    // _fixPuyo: ちぎり（片方だけ先に固定＝別列/別行の設置）を検出したその場で、
    // 両方確定した最終盤面を先読み送信する。
    // ★ 従来は _beginFixAnimWait（= splitting 状態が splitDropSpeed で着地しきった後）
    //   でしか送っておらず、片割れが落ちきるまでの間（最大 500ms/6 ≈ 83ms×落下距離）
    //   相手の盤面が一切更新されなかった。ここで開始時点に最終形を送ることで、
    //   受信側の driver.ts（beginPuyoFix）が実タイミングでちぎり落下を再生できる。
    if (typeof game._fixPuyo === 'function') {
      const origFixPuyo: AnyFn = game._fixPuyo.bind(game);
      game._fixPuyo = (...args: any[]) => {
        const r = origFixPuyo(...args);
        if (game._gs === 'splitting' && game.splitPuyo && this.myAlive) {
          const finalField = (game.field as number[][]).map((row: number[]) => [...row]);
          const fr = Math.round(game._calcLimitY_Single(game.splitPuyo.col, game.splitPuyo.y)) + PConfig.hiddenRows;
          if (finalField[fr]) finalField[fr][game.splitPuyo.col] = game.splitPuyo.color;
          sendFieldSnapshot(PuyoLockPhase.Fix, finalField);
          game._chigiriFixSnapshotSent = true;
        }
        return r;
      };
    }
    // _beginFixAnimWait は「初手着地(chainCount===0)」と「連鎖リンクの落下後(chainCount>0)」の
    // 両方で発火する。後者は直前の _applyDropAnim(Drop) と同一盤面の重複なので送らない。
    // ちぎりで既に _fixPuyo フックが最終盤面を送信済みのときも重複送信を抑止する。
    if (typeof game._beginFixAnimWait === 'function') {
      const origBeginFixAnimWait: AnyFn = game._beginFixAnimWait.bind(game);
      game._beginFixAnimWait = (...args: any[]) => {
        const r = origBeginFixAnimWait(...args);
        if ((game.chainCount ?? 0) === 0) {
          if (game._chigiriFixSnapshotSent) {
            game._chigiriFixSnapshotSent = false;
          } else {
            sendFieldSnapshot(PuyoLockPhase.Fix);
          }
        }
        return r;
      };
    }

    // _generateOjama: おじゃま降下の「開始時点」で、落下先が確定した最終盤面を Drop
    // スナップショットとして即送信する。従来は _applyDropAnim（落下し終わった後）でしか
    // Drop を送っておらず、相手盤面での降下開始が実際より遅れて見えていた。
    // ここで _dropAnim（_buildDropAnim 済み＝fromR→toR が確定済み）を先読みして最終盤面を
    // 組み立て、_applyDropAnim 側の重複送信はフラグで抑止する。
    //
    // ★ さらに「降下前（隠し行に段積みされた状態）」の盤面も Fix として先に送る。
    //   これが無いと受信側の setupPuyoDrop は落下元(fromR)の情報を一切持たず、
    //   全セルが同じ既定値(row0付近)から降り始めてしまい「複数段のおじゃまが同じ高さから
    //   落ちてくる」ように見えていた（2026-07-26 不具合）。_generateOjama は内部で
    //   _buildDropAnim を呼ぶ直前まで「隠し行に積んだ状態」を this.field に保持しているので、
    //   その瞬間だけ _buildDropAnim を横取りしてスナップショットを取る。
    if (typeof game._generateOjama === 'function') {
      const origGenerateOjama: AnyFn = game._generateOjama.bind(game);
      const realBuildDropAnim: AnyFn = game._buildDropAnim.bind(game);
      game._generateOjama = (...args: any[]) => {
        let preFallField: number[][] | null = null;
        game._buildDropAnim = (...bArgs: any[]) => {
          preFallField = (game.field as number[][]).map((row: number[]) => [...row]);
          return realBuildDropAnim(...bArgs);
        };
        const r = origGenerateOjama(...args);
        game._buildDropAnim = realBuildDropAnim; // 通常の連鎖落下用に元へ戻す
        if (r && preFallField && Array.isArray(game._dropAnim)) {
          const preFall: number[][] = preFallField;
          sendFieldSnapshot(PuyoLockPhase.Fix, preFall);
          const finalField = preFall.map((row: number[]) => [...row]);
          for (const col of game._dropAnim) {
            for (const cell of col.cells) finalField[cell.toR][col.c] = cell.color;
          }
          sendFieldSnapshot(PuyoLockPhase.Drop, finalField);
          game._ojamaDropSnapshotSent = true;
        }
        return r;
      };
    }
    // _applyDropAnim: 通常の連鎖落下は確定後に Drop を送る。おじゃま落下は上の
    // _generateOjama フックで開始時に既に送信済みのため、その場合だけ重複送信を防ぐ。
    if (typeof game._applyDropAnim === 'function') {
      const origApplyDropAnim: AnyFn = game._applyDropAnim.bind(game);
      game._applyDropAnim = (...args: any[]) => {
        const r = origApplyDropAnim(...args);
        if (game._ojamaDropSnapshotSent) {
          game._ojamaDropSnapshotSent = false;
        } else {
          sendFieldSnapshot(PuyoLockPhase.Drop);
        }
        return r;
      };
    }

    // _confirmSentGarbage: このターンに送信したおじゃまを連鎖終了時に確定(ready)させる
    // トリガー。CPU戦は送信元/着弾先が同一メモリ空間のためオブジェクト参照で ready 化
    // できるが、online は別プロセスなので GarbageConfirm フレームで明示的に伝える。
    // ★ game.sendGarbage はネットワーク送信版で完全に上書きされており（hookGarbageSending）、
    //   ojama.js 本来の sendGarbage（sentGarbageThisTurn.push を含む）は実行されない。
    //   そのため hadSent 判定は sentGarbageThisTurn ではなく、sink 側で実際に送信した
    //   ときだけ立つ _olGarbageSentThisChain フラグを見る。
    if (typeof game._confirmSentGarbage === 'function') {
      const origConfirmSentGarbage: AnyFn = game._confirmSentGarbage.bind(game);
      game._confirmSentGarbage = (...args: any[]) => {
        const hadSent = game._olGarbageSentThisChain === true;
        const r = origConfirmSentGarbage(...args);
        if (hadSent && this.myAlive) conn.sendMatchEvent(encodeGarbageConfirm());
        game._olGarbageSentThisChain = false;
        return r;
      };
    }

    // _calcChainScore: 連鎖消去の開始時に点滅セルを相手へ送る（連鎖フラッシュ演出）。
    // ★ グループ境界(groups)を保ったまま送る。受信側の _prepareChainTextDOM（実エンジンと
    //   同じ関数）が「最下段・最左のグループ」選択にグループ単位の構造を要求するため、
    //   game._erasingCells（groups.flat()+ojamaToErase を平坦化した配列）では境界情報が失われる。
    //   おじゃまセルは _erasingCells の groups.flat() 分より後ろ（checkErase の代入順）。
    if (typeof game._calcChainScore === 'function') {
      const origCalc: AnyFn = game._calcChainScore.bind(game);
      game._calcChainScore = (groups: any) => {
        const r = origCalc(groups);
        if (this.myAlive && Array.isArray(game._erasingCells) && game._erasingCells.length) {
          const groupCellCount = Array.isArray(groups) ? groups.reduce((n: number, g: any[]) => n + g.length, 0) : 0;
          const ojamaCells = (game._erasingCells as any[]).slice(groupCellCount);
          conn.sendMatchEvent(encodePuyoChain(game.chainCount ?? 1, groups ?? [], ojamaCells));
        }
        sendStats();
        return r;
      };
    }

    // playSe: 重要な SE を相手へ同期する（puyo_fix/連鎖/設置/gameover 等。move/rotate は除外）
    // ★ playSe の戻り値（実際に鳴らしたか）を見てから送る。puyo_fix/puyo_drop は
    //   1インスタンス50msのチャタリング防止(puyo/input.js)があるが、間引かれた呼び出しまで
    //   送っていたため、送り手には1回しか鳴らない設置音が受け手には二重に鳴っていた。
    const origPlaySe: AnyFn = game.playSe.bind(game);
    game.playSe = (key: string) => {
      const played = origPlaySe(key);
      if (!this.myAlive || played === false) return;
      const id = SE_IDS[key];
      if (id !== undefined) conn.sendMatchEvent(encodeSE(id));
    };

    // updateGarbageGauge: 予告ゲージ変化を PendingUpdate で相手に通知
    let lastPendingReady = -1, lastPendingUnready = -1;
    const origUpdateGarbageGauge: AnyFn = game.updateGarbageGauge.bind(game);
    game.updateGarbageGauge = () => {
      origUpdateGarbageGauge();
      let ready = 0, unready = 0;
      for (const g of (game.garbageQueue ?? [])) {
        if (g.internal) continue;
        if (g.ready) ready += g.amount;
        else unready += g.amount;
      }
      if (ready !== lastPendingReady || unready !== lastPendingUnready) {
        lastPendingReady = ready;
        lastPendingUnready = unready;
        conn.sendMatchEvent(encodePendingUpdate(Math.min(ready, 255), Math.min(unready, 255)));
      }
    };

    // togglePause / showPauseOverlay / hidePauseOverlay / start
    game.togglePause = () => {
      if (!game.isPaused) conn.sendPause({ roomId });
      else conn.sendResume({ roomId });
    };
    game.start = () => {};
    game.showPauseOverlay = () => {
      const ol = document.getElementById("ol-pause-overlay");
      if (ol) ol.style.display = "flex";
    };
    game.hidePauseOverlay = () => {
      const ol = document.getElementById("ol-pause-overlay");
      if (ol) ol.style.display = "none";
    };
  }

  // ── Subscribe to JSON control notifications ──────────────────────────────

  private subscribeToControlEvents(): void {
    if (this.controlEventsSubscribed) return;
    this.controlEventsSubscribed = true;

    const conn = this.connection;

    const pauseId = conn.onPauseNotification((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      this.game?.pause?.();
      const byEl = document.getElementById("ol-paused-by");
      if (byEl) {
        const name = this.playerNames.get(n.pausedBy) || n.pausedBy;
        byEl.textContent = `Paused by ${name}`;
      }
      const overlay = document.getElementById("ol-pause-overlay");
      if (overlay) overlay.style.display = "flex";
    });

    const resumeId = conn.onResumeNotification((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      const overlay = document.getElementById("ol-pause-overlay");
      if (overlay) overlay.style.display = "none";
      this.game?.resume?.();
    });

    const winnerId = conn.onWinnerNotification((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      this.showWinner(n.winner as Uuid | null);
    });

    const disconnId = conn.onPlayerDisconnected((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      this.handleOpponentDisconnect(n.playerId as Uuid);
    });

    // S4: 即時通知(猶予に入った瞬間)。最終確定は従来どおり onPlayerDisconnected が担う。
    const connLostId = conn.onPlayerConnectionLost((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      this.handleOpponentConnectionLost(n.playerId as Uuid, n.graceMs);
    });

    const reconnectedId = conn.onPlayerReconnected((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      this.handleOpponentReconnected(n.playerId as Uuid);
    });

    const postMatchId = conn.onPostMatchAction((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      this.rematchVotes.set(n.playerId as Uuid, n.action);
      this.handlePostMatchVote(n.playerId as Uuid, n.action);
    });

    this.subscriptionIds.push(
      pauseId, resumeId, winnerId, disconnId, connLostId, reconnectedId, postMatchId,
    );
  }

  // ── Post-match vote handling ─────────────────────────────────────────────

  /** 自分以外のプレイヤーID一覧 */
  private opponentIds(): Uuid[] {
    return this.roomInfo.players.filter(([id]) => id !== this.myUserId).map(([id]) => id);
  }

  /** 対戦相手が全員この対戦から離脱済みか（再戦が成立しえない状態か） */
  private allOpponentsDeparted(): boolean {
    const opponents = this.opponentIds();
    return opponents.length === 0 || opponents.every((id) => this.departed.has(id));
  }

  /** RETRY ボタンを押したときのトグル投票（部屋モード・ランダムマッチ共通） */
  private async toggleRematchVote(): Promise<void> {
    // 再戦準備(preparing)へ進んだ後の連打は無視。結果表示中のみ受け付ける
    if (this.lifecycle.phase !== "roundResult") return;

    // ★ 相手が既に離脱していれば再戦は成立しない。ここで初めて通知し、遷移させる
    //   （相手の離脱時点では遷移させない＝自分のペースで選べるようにするため）。
    if (this.allOpponentsDeparted()) {
      this.navigateAfterMatch(this.isRandomMatchRoom ? "leave" : "room", {
        notice: "相手が退出したため再戦できません",
      });
      return;
    }

    const roomId = this.roomInfo.roomId;
    this.myRematchVoted = !this.myRematchVoted;

    if (this.myRematchVoted) {
      // ★ 再戦でも READY = 「素材ロード完了」の意味を保つ。2戦目以降はキャッシュ済みで即完了する。
      await runBattlePreload({
        rules: [...new Set(this.roomInfo.players.map(([, , r]) => (r === "puyo" ? "puyo" : "tet") as "tet" | "puyo"))],
      });
      // ロード中に結果画面を離れていたら送らない
      if (this.lifecycle.phase !== "roundResult" || !this.myRematchVoted) {
        hideLoadingOverlay(true);
        return;
      }
      // ★ 承認後もキャンセルできるようにする（S3⑤）。既存のトグルを呼び直すだけで
      //   READY解除+Cancel投票が走る。
      setLoadingCancel({ label: "キャンセル", onCancel: () => { this.toggleRematchVote(); } });
      // READY を立ててからvote → サーバーは同一接続を順序処理するため、
      // オーナーが startMatch を送る時点で全員 READY 済みになる
      this.connection.setReady({ roomId, ready: true }).catch((e) =>
        this.logger.log("setReady(true) failed:", e),
      );
      this.connection.sendPostMatchAction({ roomId, action: PostMatchAction.Retry });
      this.rematchVotes.set(this.myUserId, PostMatchAction.Retry);
    } else {
      // ★ ここはロード画面表示中（承認後キャンセルボタン、S3⑤）からも呼ばれるようになったため、
      //   素通しで残ると「Cancel投票は届くのにロード画面だけ消えない」状態になる。必ず閉じる。
      hideLoadingOverlay(true);
      this.connection.setReady({ roomId, ready: false }).catch((e) =>
        this.logger.log("setReady(false) failed:", e),
      );
      this.connection.sendPostMatchAction({ roomId, action: PostMatchAction.Cancel });
      this.rematchVotes.delete(this.myUserId);
    }
    this.updateRematchButton();
    this.renderPostMatchStatus();
    this.maybeTriggerRematch();
  }

  /** RETRY ボタンの見た目（投票状態・人数）を現在の状態に合わせて更新 */
  private updateRematchButton(): void {
    const rematchBtn = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    if (!rematchBtn) return;
    const span = rematchBtn.querySelector('span:last-child');
    const total = this.roomInfo.players.length;
    const votes = this.roomInfo.players.filter(
      ([id]) => this.rematchVotes.get(id) === PostMatchAction.Retry,
    ).length;
    const isSet = this.lifecycle.snapshot().target > 1;
    const actionLabel = isSet ? "NEXT ROUND" : "RETRY";

    if (this.myRematchVoted) {
      rematchBtn.classList.add("rematch-voted");
      if (span) span.textContent = `${actionLabel} ✓ (${votes}/${total})`;
    } else {
      rematchBtn.classList.remove("rematch-voted");
      if (span) span.textContent = votes > 0 ? `${actionLabel} (${votes}/${total})` : actionLabel;
    }
  }

  /**
   * リザルト画面に各プレイヤーの選択状態を表示する。
   * 「先に申請した側が、相手の応答を待っていると分かる」ためのUI。
   */
  private renderPostMatchStatus(): void {
    const el = document.getElementById("ol-post-match-status");
    if (!el) return;
    el.innerHTML = "";
    for (const [id, name] of this.roomInfo.players) {
      const isMe = id === this.myUserId;
      const gone = this.departed.get(id);
      let state: string;
      let cls: string;
      if (gone !== undefined) {
        state = gone === PostMatchAction.Room ? "部屋に戻りました" : "退出しました";
        cls = "ol-pm-left";
      } else if (this.rematchVotes.get(id) === PostMatchAction.Retry) {
        state = "RETRY 申請中 ✓";
        cls = "ol-pm-ready";
      } else {
        state = "選択中…";
        cls = "ol-pm-waiting";
      }
      const row = document.createElement("div");
      row.className = `ol-pm-row ${cls}`;
      const nameEl = document.createElement("span");
      nameEl.className = "ol-pm-name";
      nameEl.textContent = isMe ? `${name}（あなた）` : name;
      const stateEl = document.createElement("span");
      stateEl.className = "ol-pm-state";
      stateEl.textContent = state;
      row.appendChild(nameEl);
      row.appendChild(stateEl);
      el.appendChild(row);
    }
    // ★ 待機メッセージ("相手の応答を待っています…")はここでは出さない。
    //   この行の有無でリザルトカードの高さが変わり、scale()追従サイズがガクッと
    //   ずれて見える（S1で見切れを直した副作用）。ロード画面（runBattlePreload）側で
    //   既に同じ意味のメッセージを表示しているので、ここでは各行の「選択中…」表示のみで足りる。
  }

  /**
   * リザルト画面から画面遷移する（**自分がボタンを押したときだけ**呼ばれる）。
   *
   * ★ 旧実装は「誰かが ROOM/LEAVE を送ったら全員が強制遷移」だったため、
   *   相手が抜けた瞬間に自分の意思と無関係に画面が飛んでいた（ランダムマッチでは
   *   さらに自動再マッチングまで走っていた）。相手の離脱は状態として持つだけにして、
   *   遷移は必ず自分の操作起点にする。
   *
   * ★ 1.2秒の遅延は `forced: true`（＝ markDeparted からの強制切り上げ。RETRY待ち中に
   *   相手が抜けたので "押していないのに" 遷移させられるケース）のときだけ入れる。
   *   自分でボタンを押した場合は、相手が既に退出済みでもトーストは出しつつ即座に遷移する
   *   （2026-07-26 不具合: 後から LEAVE を押した側だけ遅延が乗って反応が遅く感じられていた）。
   */
  private navigateAfterMatch(
    target: "room" | "leave",
    options: { notice?: string; forced?: boolean } = {},
  ): void {
    if (!this.lifecycle.transition("postMatch", `navigate:${target}`)) return;
    // ★ RETRY投票中に出したロード画面(runBattlePreload)は、forcedの1.2秒待ちの間も
    //   ここで消しておく（cleanup()は遷移直前まで走らないため）。S2⑦。
    hideLoadingOverlay(true);
    this.setPostMatchButtonsEnabled(false);

    const roomId = this.roomInfo.roomId;
    this.connection.sendPostMatchAction({
      roomId,
      action: target === "room" ? PostMatchAction.Room : PostMatchAction.Leave,
    });

    // 相手が先に抜けていた場合は、その事実を知らせる
    const notice = options.notice
      ?? (this.allOpponentsDeparted() ? "相手はすでに退出しています" : undefined);
    if (notice) showToast("ONLINE", notice, ToastColor["Info"]);

    const go = () => {
      this.cleanup();
      if (target === "room") this.postMatchCallbacks?.onRoom();
      else this.postMatchCallbacks?.onLeave();
    };
    // 強制切り上げのときだけ、通知を読む時間を取ってから遷移する
    if (options.forced && notice) setTimeout(go, 1200);
    else go();
  }

  private setPostMatchButtonsEnabled(enabled: boolean): void {
    for (const id of ["ol-btn-rematch", "ol-btn-room", "ol-btn-leave"]) {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = !enabled;
    }
  }

  /** 相手の離脱（PostMatchAction Room/Leave・切断）を記録し、UIへ反映する */
  private markDeparted(playerId: Uuid, action: number): void {
    if (playerId === this.myUserId) return;
    if (this.departed.has(playerId)) return;
    this.departed.set(playerId, action);
    this.renderPostMatchStatus();

    const playerName = this.playerNames.get(playerId) || playerId;
    showToast(
      "ONLINE",
      action === PostMatchAction.Room
        ? `${playerName} がルームに戻りました`
        : `${playerName} がルームを退出しました`,
      ToastColor["Info"],
    );

    // ★ 自分が既に RETRY を申請して待っている場合だけは強制的に切り上げる
    //   （待ち続けても成立しないため）。まだ何も押していない場合は据え置き。
    if (this.lifecycle.phase === "roundResult" && this.myRematchVoted && this.allOpponentsDeparted()) {
      this.navigateAfterMatch(this.isRandomMatchRoom ? "leave" : "room", {
        notice: "相手が退出したため再戦できません",
        forced: true,
      });
    }
  }

  private handlePostMatchVote(playerId: Uuid, action: number): void {
    if (action === PostMatchAction.Room) {
      // ★ ユーザー決定（S2⑦）: 「ルームに戻る」は "全員で集合する" の語義に合わせ、
      //   自分がまだ何も選んでいない（＝roundResultに留まっている）なら一緒にルームへ戻る。
      //   LEAVE(退出)は引き続き他人を巻き込まない（下のLeave分岐で現状維持）。
      this.markDeparted(playerId, action);
      if (this.lifecycle.phase === "roundResult" && !this.isRandomMatchRoom) {
        const playerName = this.playerNames.get(playerId) || playerId;
        this.navigateAfterMatch("room", {
          notice: `${playerName} がルームに戻りました`,
          forced: true,
        });
      }
      return;
    }
    if (action === PostMatchAction.Leave) {
      // ★ 自分の画面は遷移させない。相手の離脱は状態として持つだけにする。
      this.markDeparted(playerId, action);
      return;
    }

    if (action === PostMatchAction.Retry) {
      this.rematchVotes.set(playerId, PostMatchAction.Retry);
    } else if (action === PostMatchAction.Cancel) {
      this.rematchVotes.delete(playerId);
    } else {
      return;
    }
    this.updateRematchButton();
    this.renderPostMatchStatus();
    this.maybeTriggerRematch();
  }

  /** 全員が REMATCH に投票していたら（オーナーが）開始する */
  private maybeTriggerRematch(): void {
    if (this.lifecycle.phase !== "roundResult") return;
    const allVoted = this.roomInfo.players.every(([id]) => this.rematchVotes.get(id) === 0);
    if (allVoted) this.triggerRematch();
  }

  // ── Rematch trigger ──────────────────────────────────────────────────────

  private triggerRematch(): void {
    // roundResult → preparing の遷移が再戦開始の排他を兼ねる（二重呼び出しは弾かれる）
    if (this.lifecycle.phase !== "roundResult") return;
    const roomId = this.roomInfo.roomId;
    this.rematchVotes.clear();

    // 全員のリスナーを再登録してから、オーナーが startMatch を送る
    // （relistenForStart 内で preparing へ遷移する）
    this.relistenForStart();

    const isOwner = this.roomInfo.ownerId === this.myUserId;
    if (isOwner) {
      this.connection.startMatch({ roomId })
        .then((res) => {
          if (!res?.success) {
            this.logger.log("startMatch rejected:", res?.message);
            showToast("ONLINE", `再戦の開始に失敗: ${res?.message ?? "unknown"}`, ToastColor["Error"]);
            this.abortRematch();
          }
        })
        .catch((err) => {
          this.logger.log("Failed to start rematch:", err);
          showToast("ONLINE", "再戦の開始に失敗しました", ToastColor["Error"]);
          this.abortRematch();
        });
    }
  }

  /**
   * 再戦の開始要求が失敗したときにリザルト画面へ戻す。
   *
   * ★ 前ラウンドの後片付け（teardownFinishedRound）は暗転後まで遅らせてあるので、
   *   この経路ではまだ何も消えていない＝リザルト画面も盤面もそのまま残っている。
   *   投票UIだけ現在の状態（relistenForStart で投票フラグは解除済み）から描き直せば、
   *   そのまま RETRY をやり直せる状態に戻る。
   */
  private abortRematch(): void {
    // 再戦開始要求の失敗も、開始前のRETRY待ちロード画面が残る同型のバグを踏むため閉じる。S2⑦。
    hideLoadingOverlay(true);
    this.lifecycle.transition("roundResult", "rematch start failed");
    this.updateRematchButton();
    this.renderPostMatchStatus();
  }

  // ── Re-listen for next StartMatchNotification (REMATCH) ─────────────────

  /**
   * 再戦（RETRY）が確定した時点で呼ぶ。次の StartMatchNotification を待てる状態に戻すが、
   * **前ラウンドの見た目（リザルト画面・自分/相手の盤面・ゲージ類）はここでは消さない**。
   *
   * ★ 見た目の後片付けは teardownFinishedRound() へ分離し、暗転が完了してから実行する。
   *   ここで消してしまうと「まもなく対戦開始…」のロード表示中（＝まだ画面が見えている間）に
   *   リザルトとぷよ盤面だけが先に消え、真っ暗な待ち時間が始まる前に画面が空になる
   *   （暗転開始を後ろへずらした第11ラウンド①以降、この空白が約1.7秒に伸びて顕在化した）。
   *   ロード中は決着時の画面をそのまま残し、暗転の下で一気に片付ける。
   */
  private relistenForStart(): void {
    // 次の開始通知待ちへ。以降のテアダウンは冪等なので遷移可否に関わらず実行する
    this.lifecycle.transition("preparing", "await next match");
    this.stopPieceStateInterval();
    this.clearWinnerFallback();
    this.matchHalted = false;

    // ★ 受信ハンドラだけは即座に外す。次マッチのフレームが旧パペットへ流れ込むのを防ぐため、
    //   これは見た目ではなく結線の問題なので遅延させない（実際の破棄は暗転後）。
    if (this.matchHandlerId) {
      this.connection.removeMatchEventHandler(this.matchHandlerId);
      this.matchHandlerId = null;
    }

    // 投票状態（フラグ）は次マッチ用に即リセットする。対応するボタン/ステータスの
    // DOM書き換えはリザルト画面の見た目なので teardownFinishedRound 側で行う。
    this.myRematchVoted = false;
    this.departed.clear();

    // StartMatchNotification を再登録（1回限り）
    this.startNotifHandlerId = this.connection.onStartMatchNotification((notif) => {
      if (notif.roomId === this.roomInfo.roomId) {
        if (this.startNotifHandlerId) {
          this.connection.removeReaderFunction(this.startNotifHandlerId);
          this.startNotifHandlerId = null;
        }
        this.startBattle(notif);
      }
    });
  }

  /**
   * 前ラウンドの後片付け（エンジン破棄・パペット破棄・リザルト画面/盤面/ゲージのクリア）。
   * **必ず暗転が完了してから**（setupBattleUnderCover の先頭で）呼ぶこと。
   *
   * ★ 盤面は「非表示」ではなく破棄している: PuyoGame/Game は毎ラウンド new し直す実装
   *   （initPuyoBattle / initTetBattle）で、ここで stop()（_clearCanvases でピクセル消去）
   *   したうえで this.game = null と参照を切るため、旧ラウンドの field は次の initGame を
   *   待たずに解放される。相手パペットも driver.stop() → puppets.clear() で同様に破棄する。
   *   唯一の外部参照 window._olGame も次ラウンドの init で上書きされる。
   *
   * 冪等。初回マッチ（前ラウンドが無い）で呼んでも何も起きない。
   */
  private teardownFinishedRound(): void {
    // ゲームエンジン停止
    if (this.game) {
      if (this.myRule === 'puyo') {
        // ★ 決着時に freezePuyoGame が立てた _versusFinishing を先に下ろす。
        //   立ったままだと stop() がキャンバスクリア/rAF停止(cancelAnimationFrame)を
        //   スキップし(lifecycle.js)、旧ゲームの _loop が生き残ったまま毎フレーム描画を続け、
        //   次マッチの READY 中に旧盤面が残って見える（2026-07-26 不具合）。
        this.game._versusFinishing = false;
        this.game.stop?.();
        this.game.rng = null;
        // 対テト送り手からの攻撃は _garbageTimers(setTimeout) 経由で ready 化されるため、
        // 次戦開始前に古いタイマーが残らないよう止める（puyo同士の internalTimer は
        // dt駆動で _update 停止と共に自動停止するのでここでは不要）。
        if (this.game._garbageTimers?.length) {
          for (const t of this.game._garbageTimers) if (t.id) clearTimeout(t.id);
        }
      } else {
        if (this.game.timer) clearInterval(this.game.timer);
        if (this.game.lockTimer) clearTimeout(this.game.lockTimer);
        if (this.game._garbageTimers?.length) {
          for (const t of this.game._garbageTimers) if (t.id) clearTimeout(t.id);
        }
        if (this.game._keyLoop) clearInterval(this.game._keyLoop);
        if (this.game._gamepadLoop) clearInterval(this.game._gamepadLoop);
        if (this.game._keyDownHandler) document.removeEventListener("keydown", this.game._keyDownHandler);
        if (this.game._keyUpHandler) document.removeEventListener("keyup", this.game._keyUpHandler);
        this.game.tumoRng = null;
      }
      this.game = null;
    }

    // 相手パペットの破棄（driver.stop() が相手キャンバスもクリアする）
    this.stopPuppetTimers();

    this.puppets.clear();
    this.puppetRules.clear();
    this.puppetIndices.clear();
    this.lastOpponentFixSeTime.clear();

    // 勝者オーバーレイ（リザルト画面）を隠す
    const winOverlay = document.getElementById("ol-winner-overlay");
    if (winOverlay) winOverlay.style.display = "none";
    document.getElementById("ol-alive-count")?.remove();

    // GAME OVER 表示を消す
    this.clearFinishOverlay();

    // ぷよ予告おじゃまアイコン・攻撃ゲージ・TET横ガベージ予告ゲージを次マッチに残さないようクリア
    // ★ #ol-battle-layout配下に必ずスコープする。無条件の [id$="..."] だとCPU戦の
    //   player-attack-gauge/cpu-attack-gauge等まで巻き込んで消してしまう。
    const battleLayout = document.getElementById("ol-battle-layout");
    battleLayout?.querySelectorAll('[id$="-ojama-yokoku"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    battleLayout?.querySelectorAll('[id$="-garbage-gauge"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    battleLayout?.querySelectorAll('[id$="-attack-gauge"]').forEach((el) => {
      (el as HTMLElement).innerHTML = '';
      (el as HTMLElement).style.display = 'none';
    });

    // リザルト画面の投票UI（ボタン・ステータス）を次マッチ用に戻す
    const statusRL = document.getElementById("ol-post-match-status");
    if (statusRL) statusRL.innerHTML = "";
    document.getElementById("ol-rematch-status")?.remove();
    const rematchBtnRL = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    if (rematchBtnRL) rematchBtnRL.disabled = false;
    const roomBtnRL = document.getElementById("ol-btn-room") as HTMLButtonElement | null;
    const leaveBtnRL = document.getElementById("ol-btn-leave") as HTMLButtonElement | null;
    if (roomBtnRL) roomBtnRL.disabled = false;
    if (leaveBtnRL) leaveBtnRL.disabled = false;

    // フィールド表示を tet 既定に戻す（次マッチ開始時に再設定される）
    this.setSelfFieldVisibility('tet');
  }

  // ── Binary match frame dispatch ──────────────────────────────────────────

  /** ぷよ相手の予告おじゃまを、相手フィールド上部にアイコンで表示する（_updateOjamaYokoku を再利用） */
  private updateOpponentPuyoYokoku(senderId: Uuid, totalOjama: number): void {
    const driver = this.puppets.get(senderId);
    if (!driver) return;
    const puppet = driver.puppet;
    puppet.garbageQueue = totalOjama > 0
      ? [{ amount: totalOjama, ready: false, internal: false }]
      : [];
    // ★ _lastYokokuAmount のdedupは無効化しない。displayAmount(=totalOjama)が前回と
    //   同じなら再構築不要なのは自明で、無効化すると毎回フル再構築させてしまい
    //   ちらつきの原因になる（[[project_ojama_yokoku_diff]]のノード再利用対応と対）。
    if (typeof puppet.updateGarbageGauge === 'function') puppet.updateGarbageGauge();
  }

  private updateOpponentGauge(idx: number, ready: number, unready: number): void {
    for (const gaugeId of [`ol-opp-${idx}-garbage-gauge`, `ol-opp-${idx}-puyo-garbage-gauge`]) {
      const gaugeEl = document.getElementById(gaugeId);
      if (!gaugeEl) continue;
      gaugeEl.innerHTML = '';
      for (let i = 0; i < ready; i++) {
        const b = document.createElement('div');
        b.className = 'gauge-block ready';
        gaugeEl.appendChild(b);
      }
      for (let i = 0; i < unready; i++) {
        const b = document.createElement('div');
        b.className = 'gauge-block unready';
        gaugeEl.appendChild(b);
      }
    }
  }

  /** 相手TETの送信用火力(pendingAttack)ゲージを、実エンジンの描画(updateAttackGauge)に
   *  そのまま委譲して更新する。色サイクル・20個で1周・下から積む挙動をCPU戦と一致させるため、
   *  描画ロジックをここで複製しない（パペットへ値を注入して既存メソッドを呼ぶだけ）。 */
  private updateOpponentAttackGauge(senderId: Uuid, attack: number, visible: boolean): void {
    const driver = this.puppets.get(senderId);
    if (!driver) return;
    const puppet = driver.puppet as any;
    if (typeof puppet.updateAttackGauge !== 'function') return;
    puppet.isVersusMode = true;
    puppet.opponentRule = visible ? 'puyo' : 'tet';
    puppet.pendingAttack = attack;
    puppet.updateAttackGauge();
  }

  private handleMatchFrame(frame: { opcode: number; senderId: Uuid; payload: Uint8Array }): void {
    // 決着後に届いた遅延フレーム（おじゃま・連鎖演出など）で盤面が動かないよう全て捨てる。
    // GameOver だけは生存者集合の整合のため反映する（パペットは凍結済みなので表示は変えない）。
    if (this.matchHalted) {
      if (frame.opcode === MatchOpcode.GameOver) {
        this.markDead(frame.senderId);
        return;
      }
      // ★ TETのblock-out時、GameOverの直後に届く Lock(最終盤面＋衝突ミノ同梱) だけは
      //   例外的にドライバへ渡す。実際に通すかどうかは driver 側の猶予窓
      //   (acceptFinalSnapshotUntil) が判定する（上の popMino フック参照）。
      if (frame.opcode === MatchOpcode.Lock) {
        this.puppets.get(frame.senderId)?.applyFrame(frame.opcode, frame.payload);
      }
      return;
    }
    // ── ローカルプレイヤーへのルーティング（送信元に関係なく自分に届く） ──
    // ★ Garbage(0x24) は受信側ルールに応じて穴/列配列の意味だけが変わる。
    //   サーバーはゲームルールを再計算せず、クライアントが自分のルールに適用する。
    if (frame.opcode === MatchOpcode.Garbage) {
      try {
        const g = decodeGarbage(frame.payload);
        if (this.myRule === 'puyo') this.deliverOjamaToPlayer(g.amount, g.holes, frame.senderId);
        else this.deliverGarbageToPlayer(g.amount, g.holes, frame.senderId);
      } catch (e) {
        this.logger.warn("Invalid Garbage frame:", e);
      }
      return;
    }
    // GarbageConfirm: puyo送り手の連鎖終了トリガー。この送信者からの未確定(ready:false)分を
    // 全て確定させる（CPU戦の _confirmSentGarbage 相当。送り手がpuyoのときのみ発火する）。
    if (frame.opcode === MatchOpcode.GarbageConfirm) {
      const game = this.game as any;
      if (!game?.garbageQueue?.length) return;
      let changed = false;
      for (const g of game.garbageQueue) {
        if (!g.ready && g._srcSender === frame.senderId) {
          g.ready = true;
          changed = true;
        }
      }
      if (changed) game.updateGarbageGauge?.();
      return;
    }
    // SE: 相手の音を再生
    // ★ puyo_fix/puyo_drop は保険として送信元(senderId)ごとに50ms間引く。送信側
    //   (playSe フック)で既にチャタリング抑制済みだが、再送や複数相手の混在に備えて
    //   受信側にも同じ間隔ガードを置く。senderIdごとに独立させ、他の相手の音を
    //   誤って消さないようにする。
    if (frame.opcode === MatchOpcode.SE) {
      const seName = SE_NAMES[frame.payload[0]];
      if (!seName) return;
      if (seName === 'puyo_fix' || seName === 'puyo_drop') {
        const now = performance.now();
        const last = this.lastOpponentFixSeTime.get(frame.senderId);
        if (last !== undefined && now - last < 50) return;
        this.lastOpponentFixSeTime.set(frame.senderId, now);
      }
      (window as any).SeManager?.playWithGain(seName, OnlineGameController.OPPONENT_SE_GAIN);
      return;
    }
    // PendingUpdate: 送信者の予告ゲージを更新
    // ★ ぷよ相手は「上におじゃまぷよ」で表示（VERSUS同様）。テト相手は従来の横ラインゲージ。
    if (frame.opcode === MatchOpcode.PendingUpdate) {
      const idx = this.puppetIndices.get(frame.senderId);
      if (idx !== undefined) {
        const d = decodePendingUpdate(frame.payload);
        const rule = this.puppetRules.get(frame.senderId) ?? 'tet';
        if (rule === 'puyo') {
          this.updateOpponentPuyoYokoku(frame.senderId, d.ready + d.unready);
        } else {
          this.updateOpponentGauge(idx, d.ready, d.unready);
          this.updateOpponentAttackGauge(frame.senderId, d.attack, d.attackVisible);
        }
      }
      return;
    }

    const driver = this.puppets.get(frame.senderId);
    if (!driver) return;
    driver.applyFrame(frame.opcode, frame.payload);
    return;
    /*
      // ── テト系フレーム ──────────────────────────────────────────────────
      case MatchOpcode.PieceState: {
        if (senderRule !== 'tet') break;
        const ps = decodePieceState(frame.payload);
        const mino = new Mino(ps.type);
        for (let r = 0; r < ps.rotation; r++) mino.rotate();
        mino.x = ps.x;
        mino.y = ps.y;
        puppet.mino = mino;
        requestAnimationFrame(() => puppet.drawAll());
        break;
      }
      case MatchOpcode.Lock: {
        if (senderRule !== 'tet') break;
        const boardArr = decodeLock(frame.payload);
        const blocks: any[] = [];
        for (let i = 0; i < boardArr.length; i++) {
          const v = boardArr[i];
          // wireは「0=空, 1〜8=type 0〜7」。Iミノ(type0)を空と区別するため -1 で復元。
          // row 0 = y=-BOARD_BUFFER_ROWS（せり上がりで上端からはみ出した地形も再現する）
          if (v !== 0) {
            blocks.push(new Block(
              i % BOARD_COLS,
              Math.floor(i / BOARD_COLS) - BOARD_BUFFER_ROWS,
              v - 1,
            ));
          }
        }
        puppet.field.blocks = blocks;
        // Field は固定ブロックの描画・占有キャッシュを持つため、blocks を
        // 直接差し替えたときは必ず無効化する。これを行わないと Lock は
        // 受信できても、初期化時の空盤面キャッシュが描画され続ける。
        puppet.field.markDirty?.();
        puppet.mino = null;
        puppet.drawAll();
        break;
      }
      case MatchOpcode.Spawn: {
        if (senderRule !== 'tet') break;
        const sp = decodeSpawn(frame.payload);
        if (sp.type === 0xff) {
          puppet.nextQueue = sp.nextTypes
            .filter((t: number) => t !== 0xff)
            .map((t: number) => new Mino(t));
          puppet.holdMino = sp.holdType !== 0xff ? new Mino(sp.holdType) : null;
          puppet.drawAll();
          break;
        }
        const mino = new Mino(sp.type);
        mino.spawn();
        puppet.mino = mino;
        puppet.nextQueue = sp.nextTypes
          .filter((t: number) => t !== 0xff)
          .map((t: number) => new Mino(t));
        puppet.holdMino = sp.holdType !== 0xff ? new Mino(sp.holdType) : null;
        puppet.drawAll();
        break;
      }
      case MatchOpcode.Clear: {
        const c = decodeClear(frame.payload);
        const tSpinType = (c.flags & 1) ? 'tspin' : null;
        const isB2B = !!(c.flags & 2);
        const isPerfectClear = !!(c.flags & 4);
        const is4Lines = c.lines === 4 && tSpinType === null;
        if (typeof puppet.showActionLabels === 'function') {
          puppet.showActionLabels(tSpinType, c.lines, isB2B, c.combo, isPerfectClear, is4Lines);
        }
        break;
      }
      case MatchOpcode.GameOver: {
        this.markDead(frame.senderId);
        const idx = this.puppetIndices.get(frame.senderId);
        if (senderRule === 'puyo') {
          puppet.isPaused = true;
          puppet._render?.();
        } else {
          puppet.mino = null;
          puppet.isPaused = true;
          puppet.drawAll?.();
        }
        if (idx !== undefined) {
          const nameEl = document.getElementById(`ol-opp-name-${idx}`);
          if (nameEl) nameEl.textContent += " ☠";
        }
        break;
      }
      // ── ぷよ系フレーム ──────────────────────────────────────────────────
      case MatchOpcode.PuyoPieceState: {
        if (senderRule !== 'puyo') break;
        if (!puppet._imagesLoaded) break; // PieceState は高頻度なので画像未ロード中はスキップ
        const ps = decodePuyoPieceState(frame.payload);
        puppet.pivotColor = ps.pivotColor;
        puppet.childColor = ps.childColor;
        puppet.pivotX = ps.pivotX;
        puppet.pivotY = ps.pivotY;
        puppet.targetRot = ps.rotation;
        // animRot を targetRot に合わせて子ぷよを正しい位置に描画する
        puppet.animRot = ps.rotation;
        puppet.targetAnimRot = ps.rotation;
        // _gs='falling' にすると _render が落下ぷよ＋ゴーストを描画する（TET同様の操作ぷよ表示）
        puppet._gs = 'falling';
        requestAnimationFrame(() => { if (puppet._imagesLoaded) puppet._render?.(); });
        break;
      }
      case MatchOpcode.PuyoSpawn: {
        if (senderRule !== 'puyo') break;
        const sp = decodePuyoSpawn(frame.payload);
        puppet.nextQueue = puppet.nextQueue ?? [];
        if (sp.nextPairs.length > 0) {
          puppet.nextQueue = sp.nextPairs.map((p: [number, number]) => [p[0], p[1]]);
        }
        // pivotColor=0, childColor=0 はsentinel（カウントダウン中のNEXT先送り）
        if (sp.pivotColor !== 0 || sp.childColor !== 0) {
          puppet.pivotColor = sp.pivotColor;
          puppet.childColor = sp.childColor;
          puppet.pivotX = 2;
          puppet.pivotY = -0.5;
          puppet.targetRot = 0;
          puppet.animRot = 0;
          puppet.targetAnimRot = 0;
          // 新ペア出現 → 落下ぷよを即描画
          puppet._gs = 'falling';
        }
        if (puppet._imagesLoaded) puppet._render?.();
        break;
      }
      case MatchOpcode.PuyoLock: {
        if (senderRule !== 'puyo') break;
        // 連鎖点滅の手動駆動が走っていれば止める
        if (puppet._netChainBlink) { clearInterval(puppet._netChainBlink); puppet._netChainBlink = null; }
        puppet._erasingCells = null;
        puppet.field = decodePuyoLock(frame.payload);
        // 着地・連鎖スナップショット中は落下ぷよ/ゴーストを描かない（盤面のみ表示）
        puppet._gs = 'idle';
        if (puppet._imagesLoaded) puppet._render?.();
        break;
      }
      case MatchOpcode.PuyoChain: {
        if (senderRule !== 'puyo') break;
        const ch = decodePuyoChain(frame.payload);
        // 連鎖消去フラッシュ: パペットはループを持たないので短時間だけ手動で点滅描画する
        puppet._erasingCells = ch.cells;
        puppet._eraseTimer = 0;
        puppet._gs = 'erasing';
        if (puppet._netChainBlink) clearInterval(puppet._netChainBlink);
        const startT = performance.now();
        puppet._netChainBlink = setInterval(() => {
          puppet._eraseTimer = performance.now() - startT;
          if (puppet._imagesLoaded) puppet._render?.();
          if (puppet._eraseTimer > 320) {
            clearInterval(puppet._netChainBlink);
            puppet._netChainBlink = null;
          }
        }, 50);
        break;
      }
    }
    */
  }

  // ── Garbage delivery ─────────────────────────────────────────────────────

  /**
   * tet受け手。送り手のルールでCPU戦と同じ配送方式に分岐する（battle/garbage_router.ts）:
   *  - 送り手がpuyo: stage1(internal 500ms)→stage2(pending)→stage3(ready)。ready化は送り手の
   *    連鎖終了(GarbageConfirm)を待つ（固定タイマーでは連鎖終了より早く/遅く落ちてしまうため）。
   *  - 送り手がtet: 従来どおり固定1500ms（tetの攻撃はチェイン終了という概念を持たない）。
   */
  private deliverGarbageToPlayer(amount: number, holes: number[] = [], senderId?: Uuid): void {
    if (amount <= 0 || !this.game || !this.myAlive) return;
    const senderRule = senderId !== undefined ? this.puppetRules.get(senderId) : undefined;
    if (senderRule === 'puyo') {
      const entry: any = { amount, holes: [...holes], ready: false };
      entry._srcSender = senderId;
      deliverLocalStaged(this.game, entry, 500, false);
    } else {
      deliverLocalWithReadyTimer(this.game, { amount, holes, ready: false }, 1500);
    }
  }

  // ── Ojama delivery (puyo受け手) ─────────────────────────────────────────

  /**
   * puyo受け手。送り手のルールでCPU戦と同じ配送方式に分岐する:
   *  - 送り手がpuyo: stage1(internal 500ms)→stage2(pending)→stage3(ready)。ready化は送り手の
   *    連鎖終了(GarbageConfirm)を待つ。
   *  - 送り手がtet: 従来どおり固定1000ms（tetの攻撃はチェイン終了という概念を持たない）。
   */
  private deliverOjamaToPlayer(amount: number, columns: number[] = [], senderId?: Uuid): void {
    if (amount <= 0 || !this.game || !this.myAlive) return;
    const senderRule = senderId !== undefined ? this.puppetRules.get(senderId) : undefined;
    const entry: any = { amount, holes: [...columns], ready: false };
    entry._srcSender = senderId;
    if (senderRule === 'puyo') {
      deliverLocalStaged(this.game, entry, 500, true);
    } else {
      deliverLocalWithReadyTimer(this.game, entry, 1000);
    }
  }

  // ── PieceState broadcast ─────────────────────────────────────────────────

  /** 現在の操作中ミノ/ぷよの位置を1回送信する（interval と backgroundTick の両方から呼ぶ）。 */
  private sendPieceStateNow(): void {
    const g = this.game;
    if (!g || g.isPaused) return;
    if (this.myRule === 'puyo') {
      // ぷよ: _gs が 'falling' または関連フェーズのときだけ送信
      if (g._gs !== 'falling' && g._gs !== 'fixing') return;
      this.connection.sendPieceState(
        encodePuyoPieceState(g.pivotColor, g.childColor, g.pivotX, g.pivotY, g.targetRot, g.targetAnimRot),
      );
    } else {
      if (!g.mino) return;
      this.connection.sendPieceState(
        encodePieceState(g.mino.type, g.mino.x, g.mino.y, g.mino.rotation),
      );
    }
  }

  private startPieceStateInterval(): void {
    this.pieceStateIntervalId = window.setInterval(() => this.sendPieceStateNow(), 16);
  }

  private stopPieceStateInterval(): void {
    if (this.pieceStateIntervalId !== null) {
      clearInterval(this.pieceStateIntervalId);
      this.pieceStateIntervalId = null;
    }
  }

  // ── Countdown display ────────────────────────────────────────────────────

  private showCountdown(startDelayMs: number): void {
    // CPU戦と同じ盤面内の透明オーバーレイを、自分と全相手へ同時に表示する。
    const run = (window as any).runCountdown;
    if (typeof run !== 'function') return;
    const selfPrefix = this.myRule === 'puyo' ? 'ol-p-puyo-' : 'ol-p-';
    run(`${selfPrefix}countdown-overlay`, `${selfPrefix}countdown-text`, () => {}, null, startDelayMs);
    for (const [id, driver] of this.puppets) {
      const index = this.puppetIndices.get(id);
      if (index === undefined) continue;
      const prefix = driver.rule === 'puyo' ? `ol-opp-${index}-puyo-` : `ol-opp-${index}-`;
      // silent: 自分側で既にカウントダウンSEを鳴らしているため、相手全員ぶんの
      // オーバーレイでは鳴らさない（人数分の多重再生を防ぐ）。
      run(`${prefix}countdown-overlay`, `${prefix}countdown-text`, () => {}, null, startDelayMs, true);
    }
  }

  // ── Battle layout ────────────────────────────────────────────────────────

  /** 人数に応じてバトル画面レイアウトを調整する（実体は battle/layout.ts） */
  private applyBattleLayout(playerCount: number): void {
    setOnlinePlayerCount(playerCount);
  }

  // ── Winner display ───────────────────────────────────────────────────────

  private showWinner(winnerId: Uuid | null): void {
    this.logger.log("WinnerNotification received. winner:", winnerId);
    // 二重通知・決着後の遅延通知はここで捨てる（カウントダウン中の相手切断勝ちも受理する）
    if (!this.lifecycle.transition("roundResolving", "WinnerNotification")) return;
    this.lifecycle.recordWinner(winnerId);
    this.updateSetScore();
    this.clearWinnerFallback();
    // 勝敗確定: 生存中でもゲームを停止する（自分・相手パペット・送信・受信すべて）。
    // ★ 旧実装は freezeGame(=isPaused) + stop(true) だったが、PuyoGame は isPaused を見ず、
    //   stop(true) は state='idle' も cancelAnimationFrame もスキップするため、勝者側の
    //   ぷよが決着後も落ち続けていた。停止の作法は battle/freeze.ts に一本化した。
    this.haltMatch("WinnerNotification");
    this.game?.drawAll?.();

    // 前マッチのボタン状態・投票UIをリセット
    this.rematchVotes.clear();
    this.setPostMatchButtonsEnabled(true);
    const prevRematchBtn = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    if (prevRematchBtn) {
      prevRematchBtn.classList.remove("rematch-voted");
      const spanText = prevRematchBtn.querySelector('span:last-child');
      if (spanText) spanText.textContent = 'RETRY';
    }
    document.getElementById("ol-rematch-status")?.remove();

    const overlay = document.getElementById("ol-winner-overlay");
    const titleEl = document.getElementById("ol-winner-title");
    const nameEl = document.getElementById("ol-winner-name");
    const buttonsEl = document.getElementById("ol-post-match-buttons");
    if (!overlay || !titleEl || !nameEl) return;

    const iWin = winnerId !== null && winnerId === this.myUserId;

    const winnerName = winnerId === null
      ? null
      : this.playerNames.get(winnerId) || winnerId;
    renderOnlineResult({
      outcome: winnerId === null ? "draw" : iWin ? "win" : "lose",
      winnerName,
      selfScore: typeof this.game?.score === "number" ? this.game.score : null,
      selfPrimaryLabel: this.myRule === "puyo" ? "MAX CHAIN" : "LINES",
      selfPrimaryValue: this.myRule === "puyo"
        ? (typeof this.game?.chainMax === "number" ? this.game.chainMax : null)
        : (typeof this.game?.lines === "number" ? this.game.lines : null),
      round: this.lifecycle.snapshot().round,
      target: this.lifecycle.snapshot().target,
      score: this.roomInfo.players.map(([id, name]) =>
        `${name} ${"★".repeat(this.lifecycle.winsOf(id))}${"☆".repeat(Math.max(0, this.lifecycle.snapshot().target - this.lifecycle.winsOf(id)))}`
      ).join("  ·  "),
    });

    // ★ CPU戦(versus.js)と同様、まず**全ての盤面**に WIN!/LOSE... の大きな演出を出し、
    //   それが終わってから結果オーバーレイ（ボタンUI）を表示する。
    //   文言・クラス・表示時間は battle/finish_overlay.ts に一本化してある。
    this.clearFinishOverlay(); // 敗者の「GAME OVER」バナーを消してから WIN/LOSE を出す
    if (buttonsEl) buttonsEl.style.opacity = "0";

    const revealResult = () => {
      overlay.style.display = "flex";
      if (buttonsEl) {
        buttonsEl.style.transition = "opacity 0.5s ease";
        requestAnimationFrame(() => { if (buttonsEl) buttonsEl.style.opacity = "1"; });
      }
    };

    if (winnerId !== null) {
      // 完了コールバック（結果カード表示）は自分の1枚だけに付ける（多重発火防止）
      this.showSelfFinish(iWin ? "win" : "lose", revealResult);
      for (const [id, driver] of this.puppets) {
        const index = this.puppetIndices.get(id);
        if (index === undefined) continue;
        showFieldFinish(
          onlineFieldPrefix(index, driver.rule),
          winnerId === id ? "win" : "lose",
        );
      }
    } else {
      revealResult(); // DRAW（通常発生しない）やフォールバック
    }

    const rematchBtn = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    const roomBtn = document.getElementById("ol-btn-room") as HTMLButtonElement | null;
    const leaveBtn = document.getElementById("ol-btn-leave") as HTMLButtonElement | null;

    // 結果表示状態へ（以後 REMATCH/ROOM/LEAVE の操作を受け付ける）
    this.lifecycle.transition("roundResult", "result shown");
    this.myRematchVoted = false;

    if (rematchBtn) {
      const setDecided = this.lifecycle.isSetDecided() && this.lifecycle.snapshot().target > 1;
      rematchBtn.style.display = setDecided ? "none" : "";
      // ★ RETRY は部屋モード・ランダムマッチとも同じ「現在の相手への再戦申請」。
      //   （旧: ランダムマッチだけ「再マッチメイキング」= 別の相手を探し直す挙動だった）
      //   トグル投票: 押すと READY+申請、もう一度押すと取消。全員申請でオーナーが startMatch。
      rematchBtn.onclick = () => {
        this.toggleRematchVote();
      };
      this.updateRematchButton();
    }

    if (roomBtn) {
      if (this.isRandomMatchRoom) {
        // ランダムマッチでは「ルームに戻る」は無意味（謎のランダム用ルーム設定画面が出てしまう）。
        // 仕様上ルームを使ってはいるが、ユーザーには見せない。
        roomBtn.style.display = "none";
      } else {
        roomBtn.style.display = "";
        roomBtn.onclick = () => this.navigateAfterMatch("room");
      }
    }

    if (leaveBtn) {
      // 退出: 押した本人だけがロビー（ルーム一覧）へ。残った側はこの画面に留まる。
      leaveBtn.onclick = () => this.navigateAfterMatch("leave");
    }

    this.renderPostMatchStatus();
  }

  // ── Disconnect handling ──────────────────────────────────────────────────

  private handleOpponentDisconnect(playerId: Uuid): void {
    // S4: 最終確定なので猶予UI・安全網は不要になる。
    this.clearDisconnectWatch(playerId);
    this.markDead(playerId);
    const driver = this.puppets.get(playerId);
    driver?.setDisconnected();
    const idx = this.puppetIndices.get(playerId);
    if (idx !== undefined) {
      // ★ 名前テキストは書き換えない（S1②: レイアウトが動くバグの再発防止）。色クラスだけ付ける。
      document.getElementById(`ol-opp-name-${idx}`)?.classList.add("is-disconnected");
    }
    // 切断は「退出」と同じ扱い（再戦は成立しない）。ただし遷移は自分の操作起点のまま。
    this.markDeparted(playerId, PostMatchAction.Leave);
  }

  /**
   * S4①: サーバーが切断猶予に入った瞬間に届く即時通知。
   * 「無表示の8秒」を無くすため、相手スロットへ切断UI＋残り秒数カウントダウンを出す。
   * 猶予後もまだ決着していなければ強制LEAVEする安全網もここで張る。
   */
  private handleOpponentConnectionLost(playerId: Uuid, graceMs: number): void {
    if (playerId === this.myUserId) return;
    if (this.lifecycle.phase !== "playing" && this.lifecycle.phase !== "countdown") return;
    if (!this.aliveSet.has(playerId)) return; // 既に決着/離脱済みなら何もしない
    const rule = this.puppetRules.get(playerId);
    const idx = this.puppetIndices.get(playerId);
    if (rule === undefined || idx === undefined) return;

    this.puppets.get(playerId)?.setDisconnected();
    document.getElementById(`ol-opp-name-${idx}`)?.classList.add("is-disconnected");

    this.disconnectOverlays.get(playerId)?.stop();
    this.disconnectOverlays.set(playerId, showDisconnectOverlay(onlineFieldPrefix(idx, rule), graceMs));

    const prevWatchdog = this.disconnectWatchdogs.get(playerId);
    if (prevWatchdog !== undefined) window.clearTimeout(prevWatchdog);
    this.disconnectWatchdogs.set(
      playerId,
      window.setTimeout(() => {
        this.disconnectWatchdogs.delete(playerId);
        if (this.lifecycle.phase !== "playing" && this.lifecycle.phase !== "countdown") return;
        if (!this.aliveSet.has(playerId)) return; // 通常経路で既に決着済み
        this.forceLeaveAfterConnectionLoss();
      }, graceMs + OnlineGameController.DISCONNECT_WATCHDOG_MARGIN_MS),
    );
  }

  /** S4①: 猶予中に相手が復帰したときの通知。切断UIを消してパペットを再開する。 */
  private handleOpponentReconnected(playerId: Uuid): void {
    if (playerId === this.myUserId) return;
    this.clearDisconnectWatch(playerId);
    const idx = this.puppetIndices.get(playerId);
    if (idx !== undefined) {
      document.getElementById(`ol-opp-name-${idx}`)?.classList.remove("is-disconnected");
    }
    this.puppets.get(playerId)?.resumeFromDisconnect();
  }

  /** 指定プレイヤーの切断UI・安全網タイマーを後始末する（復帰・最終切断・cleanup 共通）。 */
  private clearDisconnectWatch(playerId: Uuid): void {
    const watchdog = this.disconnectWatchdogs.get(playerId);
    if (watchdog !== undefined) {
      window.clearTimeout(watchdog);
      this.disconnectWatchdogs.delete(playerId);
    }
    this.disconnectOverlays.get(playerId)?.stop();
    this.disconnectOverlays.delete(playerId);
  }

  /**
   * S4①安全網: 切断猶予＋余裕を過ぎても WinnerNotification も PlayerDisconnected も
   * 届かない場合の強制終了（要望どおりの「強制LEAVE」）。
   */
  private forceLeaveAfterConnectionLoss(): void {
    this.haltMatch("connection lost watchdog timeout");
    this.cleanup();
    this.postMatchCallbacks?.onForceLeave?.(
      "相手との接続が失われたため対戦を終了します",
    );
  }

  /** S4③: 自分自身が瞬断〜再接続中のあいだ、自分の盤面にも切断UIを出す。 */
  showSelfDisconnected(): void {
    if (!this.isBattleActive || this.selfDisconnectOverlay) return;
    this.selfDisconnectOverlay = showDisconnectOverlay(onlineFieldPrefix("self", this.myRule));
  }

  /** S4③: 自分の再接続成功時、自分の切断UIを消す。 */
  hideSelfDisconnected(): void {
    this.selfDisconnectOverlay?.stop();
    this.selfDisconnectOverlay = null;
  }

  /** S4③: 自分の再接続が尽きた（GameConnectionのonCloseCb）ときの強制終了。 */
  forceLeaveDueToSelfDisconnect(): void {
    if (!this.isBattleActive) return;
    this.haltMatch("self connection lost, giving up reconnect");
    this.cleanup();
    this.postMatchCallbacks?.onForceLeave?.(
      "通信が回復しなかったため対戦を終了しました",
    );
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  cleanup(): void {
    // どの状態からでも idle へ戻せる。テアダウン本体は冪等なので遷移可否に関わらず実行
    this.lifecycle.transition("idle", "cleanup");
    // ★ RETRY待機中に相手がROOM/LEAVEを押してルームへ遷移した場合、toggleRematchVote()の
    //   runBattlePreload()で出したロード画面(z-index:1100)を誰も閉じていなかった＝
    //   遷移後もルーム画面の上に残り続けるバグの後始末（S2⑦）。
    hideLoadingOverlay(true);
    this.setConfigured = false;
    this.clearWinnerFallback();
    this.matchHalted = false;
    stopScoreTweens(false); // 次戦へ古い目標値・rAFを持ち越さない
    this.removeVisibilityListener();
    this.teardownBackgroundClock();
    this.controlEventsSubscribed = false;
    this.rematchVotes.clear();
    this.myRematchVoted = false;
    this.departed.clear();
    // S4: 切断UI・安全網タイマーを持ち越さない
    this.disconnectWatchdogs.forEach((id) => window.clearTimeout(id));
    this.disconnectWatchdogs.clear();
    this.disconnectOverlays.forEach((h) => h.stop());
    this.disconnectOverlays.clear();
    this.selfDisconnectOverlay?.stop();
    this.selfDisconnectOverlay = null;
    const pmStatus = document.getElementById("ol-post-match-status");
    if (pmStatus) pmStatus.innerHTML = "";
    this.clearFinishOverlay();
    const countdownOverlay = document.getElementById("ol-p-countdown-overlay");
    const countdownText = document.getElementById("ol-p-countdown-text");
    if (countdownOverlay) {
      if ((countdownOverlay as any).countdownTimer) {
        clearTimeout((countdownOverlay as any).countdownTimer);
      }
      (countdownOverlay as any).countdownTimer = null;
      countdownOverlay.classList.remove("active");
    }
    if (countdownText) countdownText.textContent = "";
    this.stopPieceStateInterval();

    if (this.matchHandlerId) {
      this.connection.removeMatchEventHandler(this.matchHandlerId);
      this.matchHandlerId = null;
    }
    if (this.startNotifHandlerId) {
      this.connection.removeReaderFunction(this.startNotifHandlerId);
      this.startNotifHandlerId = null;
    }
    this.subscriptionIds.forEach((id) => this.connection.removeReaderFunction(id));
    this.subscriptionIds = [];

    if (this.game) {
      if (this.myRule === 'puyo') {
        // PuyoGame のタイマー/ループを停止、連鎖演出DOMを除去
        this.game._clearChainTextDOM?.();
        // ★ relistenForStart と同じ理由: _versusFinishing を下ろしてから stop() する。
        this.game._versusFinishing = false;
        this.game.stop?.();
        this.game.rng = null;
      } else {
        if (this.game.timer) clearInterval(this.game.timer);
        if (this.game.lockTimer) clearTimeout(this.game.lockTimer);
        if (this.game._garbageTimers?.length) {
          for (const t of this.game._garbageTimers) if (t.id) clearTimeout(t.id);
        }
        if (this.game._keyLoop) clearInterval(this.game._keyLoop);
        if (this.game._gamepadLoop) clearInterval(this.game._gamepadLoop);
        if (this.game._keyDownHandler) {
          document.removeEventListener("keydown", this.game._keyDownHandler);
        }
        if (this.game._keyUpHandler) {
          document.removeEventListener("keyup", this.game._keyUpHandler);
        }
        this.game.tumoRng = null;
      }
      this.game = null;
    }

    // 自分のフィールド表示を tet 既定に戻す（次の対戦でも使えるように）
    this.setSelfFieldVisibility('tet');

    this.stopPuppetTimers();

    this.puppets.forEach((driver) => driver.stop());
    this.puppets.clear();
    this.puppetRules.clear();
    this.puppetIndices.clear();
    this.lastOpponentFixSeTime.clear();

    // Reset battle layout state
    setOnlinePlayerCount(null);

    // Restore self-player name label
    const selfLabel = document.getElementById("ol-p-name");
    if (selfLabel) selfLabel.textContent = "YOU";

    // Hide opponent slots and reset order
    const playerArea = document.getElementById('ol-player-area');
    if (playerArea) playerArea.style.order = '';
    hideOnlineOppSlots();

    // ぷよ予告おじゃまアイコン（自分・相手とも）・攻撃ゲージ・TET横ガベージ予告ゲージをクリア
    // ★ #ol-battle-layout配下に必ずスコープする（理由は上の同種クリア処理と同じ）。
    const battleLayoutC = document.getElementById("ol-battle-layout");
    battleLayoutC?.querySelectorAll('[id$="-ojama-yokoku"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    battleLayoutC?.querySelectorAll('[id$="-garbage-gauge"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    battleLayoutC?.querySelectorAll('[id$="-attack-gauge"]').forEach((el) => {
      (el as HTMLElement).innerHTML = '';
      (el as HTMLElement).style.display = 'none';
    });

    // Hide overlays
    const winOverlay = document.getElementById("ol-winner-overlay");
    if (winOverlay) winOverlay.style.display = "none";
    resetOnlineResult();
    const pauseOverlay = document.getElementById("ol-pause-overlay");
    if (pauseOverlay) pauseOverlay.style.display = "none";

    // Remove alive-count display
    document.getElementById("ol-alive-count")?.remove();

    // Switch back to online-top-page if battle page is still visible
    const battlePage = document.getElementById("versus-page");
    if (battlePage?.classList.contains("active")) {
      battlePage.classList.remove("online-battle-active");
      document.querySelectorAll<HTMLElement>(".page").forEach((p) => {
        p.classList.remove("active");
        p.style.display = "";
      });
      const onlinePage = document.getElementById("online-top-page");
      if (onlinePage) onlinePage.classList.add("active");
      // 直後に postMatchCallbacks(onRoom/onLeave)がロビー/ルーム詳細を再描画し、
      // その中で改めてFocusNavを同期する。ここでの再activateは念のための保険。
      (window as any).FocusNav?.activate("online-top");
    }
  }
}
