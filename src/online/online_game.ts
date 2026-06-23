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
  encodePuyoPieceState,
  encodePuyoSpawn,
  encodePuyoLock,
  encodeGarbagePuyo,
  encodePuyoChain,
  decodePuyoChain,
  decodePieceState,
  decodeLock,
  decodeSpawn,
  decodeGarbage,
  decodeClear,
  decodePendingUpdate,
  decodePuyoPieceState,
  decodePuyoSpawn,
  decodePuyoLock,
  fieldBlocksToArray,
  MatchOpcode,
  BOARD_ROWS,
  BOARD_COLS,
  SE_IDS,
  SE_NAMES,
  createSeededRng,
} from "./game_protocol";
import { Logger } from "./logger";

type AnyFn = (...args: any[]) => any;

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
  private puppets: Map<Uuid, any> = new Map();
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
  private postMatchNavigating = false;
  private isRandomMatchRoom = false;
  private countdownOverlay: HTMLElement | null = null;
  private myRematchVoted = false;
  private rematchStarting = false;

  /** 対戦本編（カウントダウン明け〜決着前）が進行中か。バックグラウンド駆動の対象判定に使う。 */
  private matchInProgress = false;
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

  private markDead(playerId: Uuid): void {
    this.aliveSet.delete(playerId);
    this.updateAliveDisplay();
  }

  /** パペットに紐づく一時タイマー（連鎖点滅など）を停止する */
  private stopPuppetTimers(): void {
    for (const puppet of this.puppets.values()) {
      if (puppet && puppet._netChainBlink) {
        clearInterval(puppet._netChainBlink);
        puppet._netChainBlink = null;
      }
    }
  }

  /** 自分の盤面の tet/puyo フィールド表示を切り替える */
  private setSelfFieldVisibility(rule: 'tet' | 'puyo'): void {
    const tetField = document.getElementById("ol-p-tet-field");
    const puyoField = document.getElementById("ol-p-puyo-field");
    if (tetField) tetField.style.display = rule === 'tet' ? '' : 'none';
    if (puyoField) puyoField.style.display = rule === 'puyo' ? '' : 'none';
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
    this.myAlive = true;
    this.matchInProgress = false; // 本編開始（カウントダウン明け）でtrueにする
    this.addVisibilityListener();
    this.aliveSet = new Set(this.roomInfo.players.map(([id]) => id));
    this.clearFinishOverlay();
    this.rematchStarting = false;
    this.myRematchVoted = false;
    this.rematchVotes.clear();

    // Determine my rule from room info
    const myPlayer = this.roomInfo.players.find(([id]) => id === this.myUserId);
    this.myRule = myPlayer?.[2] === 'puyo' ? 'puyo' : 'tet';

    // Switch page first so canvas elements are in the DOM
    this.switchToBattlePage();
    this.applyBattleLayout(this.roomInfo.players.length);
    this.updateAliveDisplay();

    // 自分のプレイヤー名を盤面下ラベルに表示
    const selfLabel = document.getElementById("ol-p-name");
    if (selfLabel) {
      const me = this.roomInfo.players.find(([id]) => id === this.myUserId);
      if (me) selfLabel.textContent = me[1];
    }

    // プレイヤー参加順に基づいて CSS order を設定（全プレイヤーで一貫した配置になる）
    const myJoinIndex = this.roomInfo.players.findIndex(([id]) => id === this.myUserId);
    const playerArea = document.getElementById('ol-player-area');
    if (playerArea) playerArea.style.order = String(myJoinIndex);

    // Build opponent puppets based on each player's rule
    const opponents = this.roomInfo.players.filter(([id]) => id !== this.myUserId);
    opponents.forEach(([id, name, rule], index) => {
      const globalIndex = this.roomInfo.players.findIndex(([pid]) => pid === id);
      const slot = document.getElementById(`ol-opp-slot-${index}`);
      const nameEl = document.getElementById(`ol-opp-name-${index}`);
      if (slot) {
        slot.style.display = "";
        slot.style.order = String(globalIndex);
      }
      if (nameEl) nameEl.textContent = name;

      const oppRule: 'tet' | 'puyo' = rule === 'puyo' ? 'puyo' : 'tet';
      this.puppetRules.set(id, oppRule);

      const tetField = document.getElementById(`ol-opp-${index}-tet-field`);
      const puyoField = document.getElementById(`ol-opp-${index}-puyo-field`);

      if (oppRule === 'puyo') {
        if (tetField) tetField.style.display = 'none';
        if (puyoField) puyoField.style.display = '';
        const puppet = new PuyoGame(`ol-opp-${index}`);
        puppet._setupCanvas();
        puppet._initField?.();  // field が undefined だと _render() でクラッシュするため初期化
        puppet.nextQueue = [];
        puppet.rng = null;
        puppet._loadImages(() => { puppet._render?.(); });
        this.puppets.set(id, puppet);
      } else {
        if (tetField) tetField.style.display = '';
        if (puyoField) puyoField.style.display = 'none';
        const puppet = new Game(`ol-opp-${index}`);
        puppet.field = new Field();
        puppet.field.blocks = [];
        puppet.mino = null;
        puppet.nextQueue = [];
        puppet.holdMino = null;
        puppet.isVersusMode = true;
        puppet.drawAll();
        this.puppets.set(id, puppet);
      }
      this.puppetIndices.set(id, index);
    });

    // 相手ルールを確定（複数戦でぷよが混在する場合はぷよ優先＝蓄積方式を採る）
    const oppRules = opponents.map(([id]) => this.puppetRules.get(id));
    this.matchOpponentRule = oppRules.includes('puyo') ? 'puyo' : 'tet';
    this.matchHasTetOpp = oppRules.includes('tet');
    this.matchHasPuyoOpp = oppRules.includes('puyo');

    const matchSetting = parseMatchSetting(notif.matchSetting);
    const now = this.connection.serverNow();
    const delay = Math.max(0, notif.startTimeMs - now);
    this.showCountdown(Math.max(3000, delay), delay);

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

    const versusPage = document.getElementById("versus-page");
    if (versusPage) {
      versusPage.classList.add("active");
      versusPage.style.display = "none";
    }

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
      this.game._startGameplay();
      this.startPieceStateInterval();
      this.matchInProgress = true;
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

      // PuyoGame._setKeyHandlers checks 'versus-page'.active for key input registration
      const versusPage = document.getElementById("versus-page");
      if (versusPage) {
        versusPage.classList.add("active");
        versusPage.style.display = "none";
      }

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
      setTimeout(() => {
        this.game._startGameplay();
        this.startPieceStateInterval();
        this.matchInProgress = true;
        // カウントダウン中にタブを隠したまま開始した場合の取りこぼし防止
        this.syncBackgroundClock();
      }, remaining);
    });
  }

  private switchToBattlePage(): void {
    document.querySelectorAll<HTMLElement>(".page").forEach((p) => {
      p.classList.remove("active");
      p.style.display = "";
    });
    const battlePage = document.getElementById("online-battle-page");
    if (battlePage) battlePage.classList.add("active");
  }

  // ── Hook game engine methods ─────────────────────────────────────────────

  private hookTetGameMethods(matchSetting: OnlineMatchSetting): void {
    const game = this.game;
    const conn = this.connection;
    const roomId = this.roomInfo.roomId;

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
        }
      };
    }

    // sendGarbage: route over network with multiplier
    // ★ 異種戦(対ぷよ): secureMino から渡る amount は「おじゃま個数」（VERSUS同様、消去なし設置時に
    //    溜めた pendingAttack をまとめて放出）。GarbagePuyo として送る（受信ぷよはそのまま受ける）。
    // ★ 同種戦(対テト): amount は tet ライン数。即時に Garbage(穴同梱)として送る。
    game.sendGarbage = (amount: number) => {
      if (amount <= 0) return;
      const adjusted = Math.round(amount * matchSetting.garbageMultiplier);
      if (adjusted <= 0) return;
      if (game.opponentRule === 'puyo') {
        conn.sendMatchEvent(encodeGarbagePuyo(Math.min(adjusted, 255)));
      } else {
        const holes = this.buildGarbageHoles(Math.min(adjusted, 255), matchSetting.garbageHoleRate);
        conn.sendMatchEvent(encodeGarbage(Math.min(adjusted, 255), holes));
      }
    };

    // sendGarbageCrossTet: 混在多人数戦で、主送信(対ぷよ=GarbagePuyo)とは別に
    // テト相手へ tet ライン火力を Garbage(穴同梱)で送る。テト相手が居ない場合は呼ばれない。
    // 受信側は自分のルールのフレームだけを直接適用する（変換しない）ため、ぷよ相手はこのフレームを無視する。
    game.sendGarbageCrossTet = (lines: number) => {
      if (lines <= 0 || !this.matchHasTetOpp) return;
      const adjusted = Math.round(lines * matchSetting.garbageMultiplier);
      if (adjusted <= 0) return;
      const holes = this.buildGarbageHoles(Math.min(adjusted, 255), matchSetting.garbageHoleRate);
      conn.sendMatchEvent(encodeGarbage(Math.min(adjusted, 255), holes));
    };

    // gameOver: stop game and notify server
    game.gameOver = (_isClear = false) => {
      if (!this.myAlive) return;
      this.myAlive = false;
      this.matchInProgress = false;
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

    // sendGarbage: ぷよ→ネットワーク送信
    // ★ 同種戦(対ぷよ): amount は「おじゃま個数」（_applyOjamaOffset で確定）→ GarbagePuyo。
    // ★ 異種戦(対テト): amount は「tet ライン数」（_resolveTetAttack のスコアベース算出を
    //    _applyOjamaOffset が送る）→ Garbage(穴同梱)。これで ojamaToTetLines 逆変換による過少を回避。
    game.sendGarbage = (amount: number) => {
      if (amount <= 0) return;
      const adjusted = Math.round(amount * matchSetting.garbageMultiplier);
      if (adjusted <= 0) return;
      if (game.opponentRule === 'tet') {
        const holes = this.buildGarbageHoles(Math.min(adjusted, 255), matchSetting.garbageHoleRate);
        conn.sendMatchEvent(encodeGarbage(Math.min(adjusted, 255), holes));
      } else {
        conn.sendMatchEvent(encodeGarbagePuyo(Math.min(adjusted, 255)));
      }
    };

    // sendGarbageCrossTet: 混在多人数戦で、主送信(対ぷよ=GarbagePuyo)とは別に
    // テト相手へ tet ライン火力（_applyOjamaOffset がスコアベースで算出）を Garbage で送る。
    game.sendGarbageCrossTet = (lines: number) => {
      if (lines <= 0 || !this.matchHasTetOpp) return;
      const adjusted = Math.round(lines * matchSetting.garbageMultiplier);
      if (adjusted <= 0) return;
      const holes = this.buildGarbageHoles(Math.min(adjusted, 255), matchSetting.garbageHoleRate);
      conn.sendMatchEvent(encodeGarbage(Math.min(adjusted, 255), holes));
    };

    // gameOver
    game.gameOver = (_isClear = false) => {
      if (!this.myAlive) return;
      this.myAlive = false;
      this.matchInProgress = false;
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
    if (this.rematchStarting) return;
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

    if (this.myRematchVoted) {
      rematchBtn.classList.add("rematch-voted");
      if (span) span.textContent = `REMATCH ✓ (${votes}/${total})`;
    } else {
      rematchBtn.classList.remove("rematch-voted");
      if (span) span.textContent = votes > 0 ? `REMATCH (${votes}/${total})` : "REMATCH";
    }
  }

  private handlePostMatchVote(playerId: Uuid, action: number): void {
    if (this.postMatchNavigating) return;

    if (action === 1 || action === 2) {
      // 誰かがルームへ戻る / 退出 → 全員ルームへ戻る
      this.postMatchNavigating = true;
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
    if (this.rematchStarting) return;
    const allVoted = this.roomInfo.players.every(([id]) => this.rematchVotes.get(id) === 0);
    if (allVoted) this.triggerRematch();
  }

  // ── Rematch trigger ──────────────────────────────────────────────────────

  private triggerRematch(): void {
    if (this.rematchStarting) return;
    this.rematchStarting = true;
    const roomId = this.roomInfo.roomId;
    this.rematchVotes.clear();

    // 全員のリスナーを再登録してから、オーナーが startMatch を送る
    this.relistenForStart();

    const isOwner = this.roomInfo.ownerId === this.myUserId;
    if (isOwner) {
      this.connection.startMatch({ roomId })
        .then((res) => {
          if (!res?.success) {
            this.logger.log("startMatch rejected:", res?.message);
            showToast("ONLINE", `再戦の開始に失敗: ${res?.message ?? "unknown"}`, ToastColor["Error"]);
            this.rematchStarting = false;
          }
        })
        .catch((err) => {
          this.logger.log("Failed to start rematch:", err);
          showToast("ONLINE", "再戦の開始に失敗しました", ToastColor["Error"]);
          this.rematchStarting = false;
        });
    }
  }

  // ── Re-listen for next StartMatchNotification (REMATCH) ─────────────────

  private relistenForStart(): void {
    this.matchInProgress = false;
    this.stopPieceStateInterval();

    // ゲームエンジン停止
    if (this.game) {
      if (this.myRule === 'puyo') {
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

  /** tetガベージの穴パターンを送信側で確定する（受信側で再計算しない＝全員の盤面表示が一致） */
  private buildGarbageHoles(n: number, holeRatePercent: number): number[] {
    const holes: number[] = [];
    const rate = holeRatePercent / 100;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      let h: number;
      if (prev < 0) {
        h = Math.floor(Math.random() * BOARD_COLS);
      } else if (Math.random() < rate) {
        h = prev;
      } else {
        const offset = Math.floor(Math.random() * (BOARD_COLS - 1)) + 1;
        h = (prev + offset) % BOARD_COLS;
      }
      holes.push(h);
      prev = h;
    }
    return holes;
  }

  /** ぷよ相手の予告おじゃまを、相手フィールド上部にアイコンで表示する（_updateOjamaYokoku を再利用） */
  private updateOpponentPuyoYokoku(senderId: Uuid, totalOjama: number): void {
    const puppet = this.puppets.get(senderId);
    if (!puppet) return;
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
    // ★ ガベージは「受信ルール別フレーム」を自分のルールに一致するものだけ直接適用する（変換しない）。
    //   送信側が相手ルールに合わせて Garbage(tetライン) / GarbagePuyo(おじゃま) を作り分け、混在多人数では
    //   両方を送る。これにより ojamaToTetLines/tetLinesToOjama の逆変換による過少を完全に排除する。
    if (frame.opcode === MatchOpcode.Garbage) {
      // tet 形式フレーム: テトプレイヤーのみが直接ラインとして受ける。ぷよ宛ではないので無視。
      if (this.myRule === 'puyo') return;
      const g = decodeGarbage(frame.payload);
      this.deliverGarbageToPlayer(g.amount, g.holes ?? []);
      return;
    }
    if (frame.opcode === MatchOpcode.GarbagePuyo) {
      // ぷよ形式フレーム: ぷよプレイヤーのみが直接おじゃまとして受ける。テト宛ではないので無視。
      if (this.myRule !== 'puyo') return;
      const ojama = frame.payload[0] ?? 0;
      this.deliverOjamaToPlayer(ojama);
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

    const puppet = this.puppets.get(frame.senderId);
    if (!puppet) return;
    const senderRule = this.puppetRules.get(frame.senderId) ?? 'tet';

    switch (frame.opcode) {
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
        for (let i = 0; i < BOARD_ROWS * BOARD_COLS; i++) {
          const v = boardArr[i];
          // wireは「0=空, 1〜7=type 0〜6」。Iミノ(type0)を空と区別するため -1 で復元。
          if (v !== 0) {
            blocks.push(new Block(i % BOARD_COLS, Math.floor(i / BOARD_COLS), v - 1));
          }
        }
        puppet.field.blocks = blocks;
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
  }

  // ── Garbage delivery ─────────────────────────────────────────────────────

  private deliverGarbageToPlayer(amount: number, holes: number[] = []): void {
    if (amount <= 0 || !this.game || !this.myAlive) return;
    const game = this.game;
    const garbageObj: any = { amount, holes, ready: false };
    if (!game.garbageQueue) game.garbageQueue = [];
    game.garbageQueue.push(garbageObj);
    game.updateGarbageGauge?.();

    const delay = 1500;
    const timerEntry: any = {
      obj: garbageObj,
      duration: delay,
      remaining: null,
      id: null,
      start: 0,
    };
    timerEntry.cb = () => {
      timerEntry.id = null;
      if (game.garbageQueue.includes(garbageObj) && garbageObj.amount > 0) {
        garbageObj.ready = true;
        game.updateGarbageGauge?.();
      }
      const idx = (game._garbageTimers as any[] | undefined)?.indexOf(timerEntry) ?? -1;
      if (idx !== -1) game._garbageTimers.splice(idx, 1);
    };
    if (!game._garbageTimers) game._garbageTimers = [];
    game._garbageTimers.push(timerEntry);
    if (game.isPaused) {
      timerEntry.remaining = delay;
    } else {
      timerEntry.start = performance.now();
      timerEntry.id = setTimeout(timerEntry.cb, delay);
    }
  }

  // ── Ojama delivery (puyo受け手) ─────────────────────────────────────────

  private deliverOjamaToPlayer(amount: number): void {
    if (amount <= 0 || !this.game || !this.myAlive) return;
    const game = this.game;
    const garbageObj: any = { amount, ready: false, internal: false };
    if (!game.garbageQueue) game.garbageQueue = [];
    game.garbageQueue.push(garbageObj);
    game.updateGarbageGauge?.();
    setTimeout(() => {
      if (game.garbageQueue?.includes(garbageObj) && garbageObj.amount > 0) {
        garbageObj.ready = true;
        game.updateGarbageGauge?.();
      }
    }, 800);
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

  private showCountdown(totalDisplayMs: number, startDelayMs: number): void {
    // transform: scale() の stacking context に影響されないよう body に直接追加する
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
      'display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.45);z-index:9999;pointer-events:none;';
    const textEl = document.createElement('span');
    textEl.style.cssText =
      "font-family:'Orbitron',monospace;font-size:120px;font-weight:900;" +
      'color:#fff;text-shadow:0 0 60px rgba(196,113,245,0.9),0 0 20px rgba(196,113,245,0.6);' +
      'letter-spacing:8px;';
    overlay.appendChild(textEl);
    document.body.appendChild(overlay);
    this.countdownOverlay = overlay;

    const setWithAnim = (text: string) => {
      textEl.textContent = text;
      textEl.style.animation = 'none';
      void textEl.offsetWidth;
      textEl.style.animation = 'countdown-pop-anim 0.45s cubic-bezier(0.34,1.56,0.64,1) both';
    };

    const steps = Math.ceil(totalDisplayMs / 1000);
    for (let i = 0; i < steps; i++) {
      const remaining = steps - i;
      setTimeout(() => setWithAnim(String(remaining)), totalDisplayMs - remaining * 1000);
    }

    setTimeout(() => setWithAnim('START!'), startDelayMs);

    setTimeout(() => {
      overlay.remove();
      if (this.countdownOverlay === overlay) this.countdownOverlay = null;
    }, startDelayMs + 800);
  }

  // ── Battle layout ────────────────────────────────────────────────────────

  /** 人数に応じてバトル画面レイアウトを調整する */
  private applyBattleLayout(playerCount: number): void {
    const layout = document.getElementById("ol-battle-layout");
    if (!layout) return;
    // 5人以上は全員5扱い（HTMLスロットは3つまでだが、将来の拡張に備えてクランプ）
    layout.setAttribute("data-player-count", String(Math.min(playerCount, 5)));
  }

  // ── Winner display ───────────────────────────────────────────────────────

  private showWinner(winnerId: Uuid | null): void {
    this.logger.log("WinnerNotification received. winner:", winnerId);
    this.matchInProgress = false;
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

    // Result text
    if (winnerId === null) {
      titleEl.textContent = "DRAW";
      nameEl.textContent = "";
    } else if (iWin) {
      titleEl.textContent = "YOU WIN!";
      nameEl.textContent = "";
    } else {
      titleEl.textContent = "YOU LOSE";
      const winnerName = this.playerNames.get(winnerId) || winnerId;
      nameEl.textContent = `WINNER: ${winnerName}`;
    }

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

    this.postMatchNavigating = false;
    this.myRematchVoted = false;
    this.rematchStarting = false;

    if (rematchBtn) {
      // ランダムマッチは再マッチメイキングボタンに変える
      if (this.isRandomMatchRoom) {
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
        leaveBtn.disabled = true;
        this.postMatchNavigating = true;
        this.connection.sendPostMatchAction({ roomId, action: 2 });
        setTimeout(() => {
          this.cleanup();
          this.postMatchCallbacks?.onLeave();
        }, 100);
      };
    }
  }

  // ── Disconnect handling ──────────────────────────────────────────────────

  private handleOpponentDisconnect(playerId: Uuid): void {
    this.markDead(playerId);
    const puppet = this.puppets.get(playerId);
    const rule = this.puppetRules.get(playerId) ?? 'tet';
    if (puppet) {
      if (rule === 'puyo') {
        puppet.isPaused = true;
        puppet._render?.();
      } else {
        puppet.mino = null;
        puppet.drawAll?.();
      }
    }
    const idx = this.puppetIndices.get(playerId);
    if (idx !== undefined) {
      const nameEl = document.getElementById(`ol-opp-name-${idx}`);
      if (nameEl) nameEl.textContent += " (DC)";
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  cleanup(): void {
    this.matchInProgress = false;
    this.removeVisibilityListener();
    this.teardownBackgroundClock();
    this.controlEventsSubscribed = false;
    this.postMatchNavigating = false;
    this.rematchVotes.clear();
    this.myRematchVoted = false;
    this.rematchStarting = false;
    this.clearFinishOverlay();
    if (this.countdownOverlay) {
      this.countdownOverlay.remove();
      this.countdownOverlay = null;
    }
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

    this.puppets.clear();
    this.puppetRules.clear();
    this.puppetIndices.clear();

    // Restore versus-page state (used as hidden key-event anchor when isVersusMode=true)
    const versusPage = document.getElementById("versus-page");
    if (versusPage) {
      versusPage.classList.remove("active");
      versusPage.style.display = "";
    }

    // Reset battle layout state
    const layout = document.getElementById("ol-battle-layout");
    if (layout) layout.removeAttribute("data-player-count");

    // Restore self-player name label
    const selfLabel = document.getElementById("ol-p-name");
    if (selfLabel) selfLabel.textContent = "YOU";

    // Hide opponent slots and reset order
    const playerArea = document.getElementById('ol-player-area');
    if (playerArea) playerArea.style.order = '';
    for (let i = 0; i < 3; i++) {
      const slot = document.getElementById(`ol-opp-slot-${i}`);
      if (slot) { slot.style.display = "none"; slot.style.order = ''; }
    }

    // ぷよ予告おじゃまアイコン（自分・相手とも）・攻撃ゲージ・TET横ガベージ予告ゲージをクリア
    document.querySelectorAll('[id$="-ojama-yokoku"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    document.querySelectorAll('[id$="-garbage-gauge"]').forEach((el) => { (el as HTMLElement).innerHTML = ''; });
    const atkGaugeC = document.getElementById("ol-p-attack-gauge");
    if (atkGaugeC) { atkGaugeC.innerHTML = ''; atkGaugeC.style.display = 'none'; }

    // Hide overlays
    const winOverlay = document.getElementById("ol-winner-overlay");
    if (winOverlay) winOverlay.style.display = "none";
    const pauseOverlay = document.getElementById("ol-pause-overlay");
    if (pauseOverlay) pauseOverlay.style.display = "none";

    // Remove alive-count display
    document.getElementById("ol-alive-count")?.remove();

    // Switch back to online-top-page if battle page is still visible
    const battlePage = document.getElementById("online-battle-page");
    if (battlePage?.classList.contains("active")) {
      document.querySelectorAll<HTMLElement>(".page").forEach((p) => {
        p.classList.remove("active");
        p.style.display = "";
      });
      const onlinePage = document.getElementById("online-top-page");
      if (onlinePage) onlinePage.classList.add("active");
    }
  }
}
