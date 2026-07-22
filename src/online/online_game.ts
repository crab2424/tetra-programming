// @ts-check
import { GameConnection } from "./connection";
import type {
  RoomInfoNotification,
  StartMatchNotification,
  Uuid,
  OnlineMatchSetting,
} from "./payload";
import { parseMatchSetting } from "./payload";
import { showToast, ToastColor } from "../toast";
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
  encodeGarbagePuyo,
  encodePuyoChain,
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
  type GarbageSink,
} from "../battle/garbage_router";
import {
  setOnlineSelfRule,
  setOnlineOppRule,
  showOnlineOppSlot,
  hideOnlineOppSlots,
  setOnlinePlayerCount,
  applyOnlineSelfSide,
} from "../battle/layout";
import { NetworkDriver } from "../battle/driver";
import { renderOnlineResult, resetOnlineResult } from "../battle/online_result";

type AnyFn = (...args: any[]) => any;

function updateOnlineStats(slot: "self" | number, stats: StatsUpdateData): void {
  const slotId = slot === "self" ? "ol-player-container" : `ol-opp-slot-${slot}`;
  const parent = document.getElementById(slotId);
  if (!parent) return;
  let statsEl = parent.querySelector<HTMLElement>(".ol-live-stats");
  if (!statsEl) {
    statsEl = document.createElement("div");
    statsEl.className = "ol-live-stats";
    statsEl.innerHTML =
      '<span class="ol-live-stat"><b>SCORE</b><strong data-stat="score">0</strong></span>' +
      '<span class="ol-live-stat"><b data-stat-label="primary">LINES</b><strong data-stat="primary">0</strong></span>';
    parent.appendChild(statsEl);
  }
  const score = statsEl.querySelector<HTMLElement>('[data-stat="score"]');
  const primary = statsEl.querySelector<HTMLElement>('[data-stat="primary"]');
  const label = statsEl.querySelector<HTMLElement>('[data-stat-label="primary"]');
  if (score) score.textContent = String(stats.score);
  if (primary) primary.textContent = String(stats.rule === "puyo" ? stats.chainMax : stats.lines);
  if (label) label.textContent = stats.rule === "puyo" ? "MAX CHAIN" : "LINES";
}

declare const Mino: new (type?: number | null) => any;
declare const Block: new (x: number, y: number, type: number) => any;
declare const Field: new () => any;
declare const Game: new (prefix?: string | null) => any;
declare const PuyoGame: new (prefix?: string | null) => any;

export type PostMatchCallbacks = {
  onRoom: () => void;
  onLeave: () => void;
  isRandomMatch?: boolean;
  onRandomRematch?: () => void;
};

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
    if (hidden && this.matchInProgress && this.myAlive && this.game) {
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
    if (!this.matchInProgress || !this.myAlive || !this.game) {
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

  /** 対戦画面上部の「残り生存者数」表示を更新する */
  private updateAliveDisplay(): void {
    let el = document.getElementById("ol-alive-count");
    if (!el) {
      el = document.createElement("div");
      el.id = "ol-alive-count";
      el.style.cssText =
        "position:absolute;top:8px;left:50%;transform:translateX(-50%);" +
        "font-family:'Orbitron',monospace;font-size:12px;letter-spacing:2px;" +
        "color:var(--text-dim);z-index:10;pointer-events:none;";
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
      sendTetLines: (lines, holes) => conn.sendMatchEvent(encodeGarbage(lines, holes)),
      sendOjama: (count) => conn.sendMatchEvent(encodeGarbagePuyo(count)),
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

  /** 自分の盤面の FINISH/GAME OVER オーバーレイを消す（次マッチ用にリセット） */
  private clearFinishOverlay(): void {
    const finOverlay = document.getElementById("ol-p-finish-overlay");
    const finText = document.getElementById("ol-p-finish-text");
    if (finOverlay) {
      finOverlay.classList.remove("active", "fadeout", "finish-gameover", "finish-clear");
    }
    if (finText) {
      finText.textContent = "";
      finText.classList.remove("finish-gameover", "finish-clear");
    }
  }

  /** ゲーム本体のタイマー類を止めて盤面を凍結する（送信は行わない） */
  private freezeGame(): void {
    const game = this.game;
    if (!game) return;
    if (game.timer) clearInterval(game.timer);
    if (game.lockTimer) clearTimeout(game.lockTimer);
    if (game._garbageTimers?.length) {
      for (const t of game._garbageTimers) if (t.id) clearTimeout(t.id);
      game._garbageTimers = [];
    }
    if (game._onlinePuyoGarbageBatch?.timer !== null) {
      clearTimeout(game._onlinePuyoGarbageBatch.timer);
      game._onlinePuyoGarbageBatch.timer = null;
      game._onlinePuyoGarbageBatch.entries = [];
    }
    if (game.isTimerRunning) {
      game.elapsedTime += performance.now() - game.startTime;
      game.isTimerRunning = false;
      cancelAnimationFrame(game.timerReqId);
    }
    game.isPaused = true;
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

  /** Transition to the battle page and begin the match */
  private startBattle(notif: StartMatchNotification): void {
    // 二重の開始通知・決着処理中の遅延通知はここで捨てる
    if (!this.lifecycle.transition("countdown", "StartMatchNotification")) return;
    this.myAlive = true;
    this.addVisibilityListener();
    this.aliveSet = new Set(this.roomInfo.players.map(([id]) => id));
    this.clearFinishOverlay();
    this.myRematchVoted = false;
    this.rematchVotes.clear();

    // Determine my rule from room info
    const myPlayer = this.roomInfo.players.find(([id]) => id === this.myUserId);
    this.myRule = myPlayer?.[2] === 'puyo' ? 'puyo' : 'tet';

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
      if (nameEl) nameEl.textContent = name;

      const oppRule: 'tet' | 'puyo' = rule === 'puyo' ? 'puyo' : 'tet';
      this.puppetRules.set(id, oppRule);
      setOnlineOppRule(index, oppRule);

      const driver = new NetworkDriver({
        id,
        index,
        rule: oppRule,
        onDead: (playerId) => this.markDead(playerId as Uuid),
        onNameDead: (deadIndex) => {
          const deadName = document.getElementById(`ol-opp-name-${deadIndex}`);
          if (deadName) deadName.textContent += " ☠";
        },
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
    const now = this.connection.serverNow();
    const delay = Math.max(0, notif.startTimeMs - now);
    if (this.myRule === 'puyo') {
      this.initPuyoBattle(notif, matchSetting, delay);
    } else {
      this.initTetBattle(notif, matchSetting, delay);
    }
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
    this.game.currentMode = "marathon";
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
    this.game.setKeyEvent();
    this.showCountdown(delay);

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
    this.game.currentMode = "marathon";
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
      this.showCountdown(remaining);
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
  }

  // ── Hook game engine methods ─────────────────────────────────────────────

  private hookTetGameMethods(matchSetting: OnlineMatchSetting): void {
    const game = this.game;
    const conn = this.connection;
    const roomId = this.roomInfo.roomId;
    const sendStats = () => {
      const stats = encodeStatsUpdate("tet", game.score ?? 0, game.lines ?? 0, 0);
      conn.sendMatchEvent(stats);
      updateOnlineStats("self", { rule: "tet", score: game.score ?? 0, lines: game.lines ?? 0, chainMax: 0 });
    };
    const sendHoldState = () => conn.sendMatchEvent(
      encodeHoldState(!!game.canHold && matchSetting.holdEnabled),
    );

    // popMino: origPopMino() でミノをフィールドに固定してから Lock を送信する
    const origPopMino: AnyFn = game.popMino.bind(game);
    game.popMino = () => {
      const hadMino = game.mino !== null;
      origPopMino();
      // origPopMino() 後にブロックが field.blocks に追加済みなのでスナップショットが正しい
      if (hadMino && this.myAlive) {
        const boardData = fieldBlocksToArray(game.field.blocks);
        conn.sendMatchEvent(encodeLock(boardData));
      }
      // Don't send Spawn if game just ended inside origPopMino
      if (game.mino && this.myAlive) {
        const holdType = game.holdMino ? game.holdMino.type : 0xff;
        const nextTypes = (game.nextQueue as any[])
          .slice(0, 5)
          .map((m) => m.type);
        conn.sendMatchEvent(
          encodeSpawn(game.mino.type, holdType, nextTypes),
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
            encodeSpawn(game.mino.type, holdType, nextTypes),
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
      this.myAlive = false;
      this.markDead(this.myUserId);
      this.stopPieceStateInterval();
      this.freezeGame();
      game.drawAll();

      this.logger.log("Local game over. Notifying server...");
      conn.sendMatchEvent(encodeGameOver());
      conn
        .notifyGameOver({ roomId })
        .then((res) => this.logger.log("NotifyGameOver response:", res));

      // Show game over on player's field
      const finOverlay = document.getElementById("ol-p-finish-overlay");
      const finText = document.getElementById("ol-p-finish-text");
      if (finOverlay && finText) {
        finText.textContent = "GAME OVER";
        finOverlay.classList.add("active", "finish-gameover");
      }
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
    const origPlaySe: AnyFn = game.playSe.bind(game);
    game.playSe = (key: string) => {
      origPlaySe(key);
      if (!this.myAlive) return;
      const id = SE_IDS[key];
      if (id !== undefined) {
        conn.sendMatchEvent(encodeSE(id));
      }
    };

    // updateGarbageGauge: 自分の予告ゲージ変化を相手へ送信 (PendingUpdate frame)
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
    const sendStats = () => {
      const stats = {
        rule: "puyo" as const,
        score: game.score ?? 0,
        lines: 0,
        chainMax: game.chainMax ?? 0,
      };
      conn.sendMatchEvent(encodeStatsUpdate("puyo", stats.score, 0, stats.chainMax));
      updateOnlineStats("self", stats);
    };

    // _beginGameOver がグローバルの versusGameOver() を呼ぶのを防ぐ
    // (versusGameOver はCPU対戦用でオンライン対戦では不要)
    game._beginGameOver = () => {
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
      this.markDead(this.myUserId);
      this.stopPieceStateInterval();
      this.freezeGame();
      game._render?.();

      this.logger.log("Local puyo game over. Notifying server...");
      conn.sendMatchEvent(encodeGameOver());
      conn.notifyGameOver({ roomId }).then((res) => this.logger.log("NotifyGameOver response:", res));

      const finOverlay = document.getElementById("ol-p-finish-overlay");
      const finText = document.getElementById("ol-p-finish-text");
      if (finOverlay && finText) {
        finText.textContent = "GAME OVER";
        finOverlay.classList.add("active", "finish-gameover");
      }
    };

    // _spawnPuyo: 新ペア出現後にフィールドスナップショット + スポーン情報を送信
    const origSpawnPuyo: AnyFn = game._spawnPuyo.bind(game);
    game._spawnPuyo = () => {
      const result = origSpawnPuyo();
      if (!this.myAlive || !result) return result;
      // フィールドスナップショット送信
      conn.sendMatchEvent(encodePuyoLock(game.field as number[][]));
      // ペア + NEXT 送信
      const nextPairs = (game.nextQueue as any[]).slice(0, 3).map((p: any): [number, number] => [p[0], p[1]]);
      conn.sendMatchEvent(encodePuyoSpawn(game.pivotColor, game.childColor, nextPairs));
      sendStats();
      return result;
    };

    // 連鎖中・着地時に盤面が変化するたびにスナップショットを送る。
    // これがないと、相手の盤面は新ペア出現（連鎖完了後）まで一切更新されない。
    const sendFieldSnapshot = () => {
      if (!this.myAlive) return;
      conn.sendMatchEvent(encodePuyoLock(game.field as number[][]));
    };
    for (const method of ['_beginFixAnimWait', '_applyErase', '_applyDropAnim'] as const) {
      if (typeof game[method] !== 'function') continue;
      const orig: AnyFn = game[method].bind(game);
      game[method] = (...args: any[]) => {
        const r = orig(...args);
        sendFieldSnapshot();
        return r;
      };
    }

    // _calcChainScore: 連鎖消去の開始時に点滅セルを相手へ送る（連鎖フラッシュ演出）
    if (typeof game._calcChainScore === 'function') {
      const origCalc: AnyFn = game._calcChainScore.bind(game);
      game._calcChainScore = (groups: any) => {
        const r = origCalc(groups);
        if (this.myAlive && Array.isArray(game._erasingCells) && game._erasingCells.length) {
          conn.sendMatchEvent(encodePuyoChain(game.chainCount ?? 1, game._erasingCells));
        }
        sendStats();
        return r;
      };
    }

    // playSe: 重要な SE を相手へ同期する（puyo_fix/連鎖/設置/gameover 等。move/rotate は除外）
    const origPlaySe: AnyFn = game.playSe.bind(game);
    game.playSe = (key: string) => {
      origPlaySe(key);
      if (!this.myAlive) return;
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

    const postMatchId = conn.onPostMatchAction((n) => {
      if (n.roomId !== this.roomInfo.roomId) return;
      this.rematchVotes.set(n.playerId as Uuid, n.action);
      this.handlePostMatchVote(n.playerId as Uuid, n.action);
    });

    this.subscriptionIds.push(pauseId, resumeId, winnerId, disconnId, postMatchId);
  }

  // ── Post-match vote handling ─────────────────────────────────────────────

  /** REMATCH ボタンを押したときのトグル投票 */
  private toggleRematchVote(): void {
    // 再戦準備(preparing)へ進んだ後の連打は無視。結果表示中のみ受け付ける
    if (this.lifecycle.phase !== "roundResult") return;
    const roomId = this.roomInfo.roomId;
    this.myRematchVoted = !this.myRematchVoted;

    if (this.myRematchVoted) {
      // READY を立ててからvote → サーバーは同一接続を順序処理するため、
      // オーナーが startMatch を送る時点で全員 READY 済みになる
      this.connection.setReady({ roomId, ready: true }).catch((e) =>
        this.logger.log("setReady(true) failed:", e),
      );
      this.connection.sendPostMatchAction({ roomId, action: 0 });
      this.rematchVotes.set(this.myUserId, 0);
    } else {
      this.connection.setReady({ roomId, ready: false }).catch((e) =>
        this.logger.log("setReady(false) failed:", e),
      );
      this.connection.sendPostMatchAction({ roomId, action: 3 }); // 3 = 投票取消
      this.rematchVotes.delete(this.myUserId);
    }
    this.updateRematchButton();
    this.maybeTriggerRematch();
  }

  /** REMATCH ボタンの見た目（投票状態・人数）を現在の状態に合わせて更新 */
  private updateRematchButton(): void {
    if (this.isRandomMatchRoom) return;
    const rematchBtn = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    if (!rematchBtn) return;
    const span = rematchBtn.querySelector('span:last-child');
    const total = this.roomInfo.players.length;
    const votes = this.roomInfo.players.filter(([id]) => this.rematchVotes.get(id) === 0).length;
    const isSet = this.lifecycle.snapshot().target > 1;
    const actionLabel = isSet ? "NEXT ROUND" : "REMATCH";

    if (this.myRematchVoted) {
      rematchBtn.classList.add("rematch-voted");
      if (span) span.textContent = `${actionLabel} ✓ (${votes}/${total})`;
    } else {
      rematchBtn.classList.remove("rematch-voted");
      if (span) span.textContent = votes > 0 ? `${actionLabel} (${votes}/${total})` : actionLabel;
    }
  }

  private handlePostMatchVote(playerId: Uuid, action: number): void {
    if (action === 1 || action === 2) {
      // 誰かがルームへ戻る / 退出 → 全員ルームへ戻る。
      // 遷移が成立しない場合（既に postMatch へ進んでいる・対戦中の迷い通知など）は無視。
      if (!this.lifecycle.transition("postMatch", "peer navigation")) return;
      const playerName = this.playerNames.get(playerId) || playerId;
      if (playerId !== this.myUserId) {
        const msg = action === 2
          ? `${playerName} がルームを退出しました`
          : `${playerName} がルームに戻りました`;
        showToast("ONLINE", msg, ToastColor["Info"]);
      }
      setTimeout(() => {
        this.cleanup();
        this.postMatchCallbacks?.onRoom();
      }, 600);
      return;
    }

    if (action === 0) {
      this.rematchVotes.set(playerId, 0);
    } else if (action === 3) {
      this.rematchVotes.delete(playerId);
    } else {
      return;
    }
    this.updateRematchButton();
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
            this.lifecycle.transition("roundResult", "rematch start failed");
          }
        })
        .catch((err) => {
          this.logger.log("Failed to start rematch:", err);
          showToast("ONLINE", "再戦の開始に失敗しました", ToastColor["Error"]);
          this.lifecycle.transition("roundResult", "rematch start failed");
        });
    }
  }

  // ── Re-listen for next StartMatchNotification (REMATCH) ─────────────────

  private relistenForStart(): void {
    // 次の開始通知待ちへ。以降のテアダウンは冪等なので遷移可否に関わらず実行する
    this.lifecycle.transition("preparing", "await next match");
    this.stopPieceStateInterval();

    // ゲームエンジン停止
    if (this.game) {
      if (this.myRule === 'puyo') {
        this.game.stop?.();
        this.game.rng = null;
        if (this.game._onlinePuyoGarbageBatch?.timer !== null) {
          clearTimeout(this.game._onlinePuyoGarbageBatch.timer);
          this.game._onlinePuyoGarbageBatch.timer = null;
          this.game._onlinePuyoGarbageBatch.entries = [];
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

    if (this.matchHandlerId) {
      this.connection.removeMatchEventHandler(this.matchHandlerId);
      this.matchHandlerId = null;
    }

    this.stopPuppetTimers();

    this.puppets.clear();
    this.puppetRules.clear();
    this.puppetIndices.clear();

    // 勝者オーバーレイを隠す
    const winOverlay = document.getElementById("ol-winner-overlay");
    if (winOverlay) winOverlay.style.display = "none";
    document.getElementById("ol-alive-count")?.remove();

    // GAME OVER 表示を消す
    this.clearFinishOverlay();

    // ぷよ予告おじゃまアイコン・攻撃ゲージ・TET横ガベージ予告ゲージを次マッチに残さないようクリア
    document.querySelectorAll('[id$="-ojama-yokoku"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    document.querySelectorAll('[id$="-garbage-gauge"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    const atkGauge = document.getElementById("ol-p-attack-gauge");
    if (atkGauge) { atkGauge.innerHTML = ''; atkGauge.style.display = 'none'; }

    // 投票状態をリセット（次マッチで使えるように）
    this.myRematchVoted = false;
    document.getElementById("ol-rematch-status")?.remove();
    const rematchBtnRL = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    if (rematchBtnRL) rematchBtnRL.disabled = false;
    const roomBtnRL = document.getElementById("ol-btn-room") as HTMLButtonElement | null;
    const leaveBtnRL = document.getElementById("ol-btn-leave") as HTMLButtonElement | null;
    if (roomBtnRL) roomBtnRL.disabled = false;
    if (leaveBtnRL) leaveBtnRL.disabled = false;

    // フィールド表示を tet 既定に戻す（次マッチ開始時に再設定される）
    this.setSelfFieldVisibility('tet');

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

  // ── Binary match frame dispatch ──────────────────────────────────────────

  /** ぷよ相手の予告おじゃまを、相手フィールド上部にアイコンで表示する（_updateOjamaYokoku を再利用） */
  private updateOpponentPuyoYokoku(senderId: Uuid, totalOjama: number): void {
    const driver = this.puppets.get(senderId);
    if (!driver) return;
    const puppet = driver.puppet;
    puppet.garbageQueue = totalOjama > 0
      ? [{ amount: totalOjama, ready: false, internal: false }]
      : [];
    puppet._lastYokokuAmount = undefined; // dedup を無効化して必ず再描画させる
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

  private handleMatchFrame(frame: { opcode: number; senderId: Uuid; payload: Uint8Array }): void {
    // ── ローカルプレイヤーへのルーティング（送信元に関係なく自分に届く） ──
    // ★ Garbage(0x24) は受信側ルールに応じて穴/列配列の意味だけが変わる。
    //   サーバーはゲームルールを再計算せず、クライアントが自分のルールに適用する。
    if (frame.opcode === MatchOpcode.Garbage) {
      try {
        const g = decodeGarbage(frame.payload);
        if (this.myRule === 'puyo') this.deliverOjamaToPlayer(g.amount, g.holes);
        else this.deliverGarbageToPlayer(g.amount, g.holes);
      } catch (e) {
        this.logger.warn("Invalid Garbage frame:", e);
      }
      return;
    }
    // SE: 相手の音を低音量で再生
    if (frame.opcode === MatchOpcode.SE) {
      const seName = SE_NAMES[frame.payload[0]];
      if (seName) (window as any).SeManager?.playWithGain(seName, 0.4);
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

  /** tet受け手: 猶予1500ms・ポーズ対応（実体は battle/garbage_router.ts、CPU戦と共通） */
  private deliverGarbageToPlayer(amount: number, holes: number[] = []): void {
    if (amount <= 0 || !this.game || !this.myAlive) return;
    deliverLocalWithReadyTimer(this.game, { amount, holes, ready: false }, 1500);
  }

  // ── Ojama delivery (puyo受け手) ─────────────────────────────────────────

  /**
   * puyo受け手: 予告はパケットごとに分けて表示するが、同一猶予窓に届いた
   * 予告は同じready遷移で解放する。これにより連鎖中の複数攻撃が落下トリガー
   * を分割してしまうことを防ぐ。
   */
  private deliverOjamaToPlayer(amount: number, columns: number[] = []): void {
    if (amount <= 0 || !this.game || !this.myAlive) return;
    const game = this.game as any;
    game.garbageQueue ??= [];
    const entry = { amount, holes: [...columns], ready: false, internal: false };
    game.garbageQueue.push(entry);
    game.updateGarbageGauge?.();
    const batch = game._onlinePuyoGarbageBatch ??= { entries: [], timer: null as number | null };
    batch.entries.push(entry);
    if (batch.timer === null) {
      batch.timer = window.setTimeout(() => {
        for (const queued of batch.entries) {
          if (game.garbageQueue?.includes(queued)) queued.ready = true;
        }
        game.updateGarbageGauge?.();
        batch.entries = [];
        batch.timer = null;
      }, 800);
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
        encodePuyoPieceState(g.pivotColor, g.childColor, g.pivotX, g.pivotY, g.targetRot),
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
      run(`${prefix}countdown-overlay`, `${prefix}countdown-text`, () => {}, null, startDelayMs);
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
    this.stopPieceStateInterval();
    // 勝敗確定: 生存中でもゲームを停止する
    this.freezeGame();
    if (this.myRule === 'puyo') {
      // ★ stop(true)=keepCanvas で盤面・NEXTを残す（VERSUS同様）。keepCanvas省略だと
      //   _clearCanvases() でキャンバスが消され、勝敗確定時に自分の盤面が真っ暗になる。
      this.game?.stop?.(true);
      this.game?._clearChainTextDOM?.();
    }
    this.game?.drawAll?.();

    // 前マッチのボタン状態・投票UIをリセット
    this.rematchVotes.clear();
    const prevRematchBtn = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    if (prevRematchBtn) {
      prevRematchBtn.disabled = false;
      prevRematchBtn.classList.remove("rematch-voted");
      const spanText = prevRematchBtn.querySelector('span:last-child');
      if (spanText && !this.isRandomMatchRoom) spanText.textContent = 'REMATCH';
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

    // ★ VERSUSモード同様、まず自分のフィールドに WIN!/LOSE... の大きな演出を出し、
    //   それが終わってから結果オーバーレイ（ボタンUI）を表示する。
    this.clearFinishOverlay(); // 敗者の「GAME OVER」バナーを消してから WIN/LOSE を出す
    if (buttonsEl) buttonsEl.style.opacity = "0";

    const revealResult = () => {
      overlay.style.display = "flex";
      if (buttonsEl) {
        buttonsEl.style.transition = "opacity 0.5s ease";
        requestAnimationFrame(() => { if (buttonsEl) buttonsEl.style.opacity = "1"; });
      }
    };

    const finishFn = (window as any).showFinishOverlay;
    if (winnerId !== null && typeof finishFn === "function") {
      const text = iWin ? "WIN!" : "LOSE...";
      const cls = iWin ? "finish-clear" : "finish-gameover";
      finishFn("ol-p-finish-overlay", "ol-p-finish-text", text, cls, 1600, revealResult);
    } else {
      revealResult(); // DRAW（通常発生しない）やフォールバック
    }

    const roomId = this.roomInfo.roomId;
    const rematchBtn = document.getElementById("ol-btn-rematch") as HTMLButtonElement | null;
    const roomBtn = document.getElementById("ol-btn-room") as HTMLButtonElement | null;
    const leaveBtn = document.getElementById("ol-btn-leave") as HTMLButtonElement | null;

    // 結果表示状態へ（以後 REMATCH/ROOM/LEAVE の操作を受け付ける）
    this.lifecycle.transition("roundResult", "result shown");
    this.myRematchVoted = false;

    if (rematchBtn) {
      const setDecided = this.lifecycle.isSetDecided() && this.lifecycle.snapshot().target > 1;
      rematchBtn.style.display = setDecided ? "none" : "";
      // ランダムマッチは再マッチメイキングボタンに変える
      if (this.isRandomMatchRoom && !setDecided) {
        const span = rematchBtn.querySelector('span:last-child');
        if (span) span.textContent = '再マッチメイキング';
        rematchBtn.onclick = () => {
          rematchBtn.disabled = true;
          this.cleanup();
          this.postMatchCallbacks?.onRandomRematch?.();
        };
      } else {
        // REMATCH はトグル投票: 押すと READY+投票、もう一度押すと取消。
        // 全員が投票したらオーナーが startMatch を送る。
        rematchBtn.onclick = () => {
          this.toggleRematchVote();
        };
        this.updateRematchButton();
      }
    }

    if (roomBtn) {
      if (this.isRandomMatchRoom) {
        // ランダムマッチでは「ルームに戻る」は無意味（謎のランダム用ルーム設定画面が出てしまう）。
        // 仕様上ルームを使ってはいるが、ユーザーには見せない。
        roomBtn.style.display = "none";
      } else {
        roomBtn.style.display = "";
        // ルームに戻る: 自分の送信 → サーバーが全員に broadcast → handlePostMatchVote で遷移
        roomBtn.onclick = () => {
          roomBtn.disabled = true;
          this.connection.sendPostMatchAction({ roomId, action: 1 });
        };
      }
    }

    if (leaveBtn) {
      // 退出: 自分は onLeave で退出、他プレイヤーは handlePostMatchVote → onRoom
      leaveBtn.onclick = () => {
        if (leaveBtn.disabled) return;
        leaveBtn.disabled = true;
        this.lifecycle.transition("postMatch", "leave button");
        this.connection.sendPostMatchAction({ roomId, action: 2 });
        this.cleanup();
        this.postMatchCallbacks?.onLeave();
      };
    }
  }

  // ── Disconnect handling ──────────────────────────────────────────────────

  private handleOpponentDisconnect(playerId: Uuid): void {
    this.markDead(playerId);
    const driver = this.puppets.get(playerId);
    driver?.setDisconnected();
    const idx = this.puppetIndices.get(playerId);
    if (idx !== undefined) {
      const nameEl = document.getElementById(`ol-opp-name-${idx}`);
      if (nameEl) nameEl.textContent += " (DC)";
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  cleanup(): void {
    // どの状態からでも idle へ戻せる。テアダウン本体は冪等なので遷移可否に関わらず実行
    this.lifecycle.transition("idle", "cleanup");
    this.setConfigured = false;
    this.removeVisibilityListener();
    this.teardownBackgroundClock();
    this.controlEventsSubscribed = false;
    this.rematchVotes.clear();
    this.myRematchVoted = false;
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
    document.querySelectorAll('[id$="-ojama-yokoku"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    document.querySelectorAll('[id$="-garbage-gauge"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    const atkGaugeC = document.getElementById("ol-p-attack-gauge");
    if (atkGaugeC) { atkGaugeC.innerHTML = ''; atkGaugeC.style.display = 'none'; }

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
    }
  }
}
