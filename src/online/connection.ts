// @ts-check
declare const APP_VERSION: string;

import { randomUUID } from "./uuid";
import {
  Payload,
  JSONPayload,
  type JSONGetRoomsResponse,
  Opcodes,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type LeaveRoomRequest,
  type LeaveRoomResponse,
  type UpdateRoomRequest,
  type UpdateRoomResponse,
  type RoomInfoNotification,
  type RoomInfoNotificationRequest,
  isRoomInfoNotification,
  type Uuid,
  type StartMatchRequest,
  type StartMatchResponse,
  type StartMatchNotification,
  isStartMatchNotification,
  type UpdateMatchSettingRequest,
  type UpdateMatchSettingResponse,
  type UpdateMatchSettingNotification,
  isUpdateMatchSettingNotification,
  type UpdatePlayerRuleRequest,
  type UpdatePlayerRuleResponse,
  type SetReadyRequest,
  type SetReadyResponse,
  type TimeSyncResponse,
  type JoinByCodeRequest,
  type JoinByCodeResponse,
  type JoinRandomMatchRequest,
  type JoinRandomMatchResponse,
  type CancelRandomMatchResponse,
  type PauseRequest,
  type PauseNotification,
  isPauseNotification,
  type ResumeNotification,
  isResumeNotification,
  type NotifyGameOverRequest,
  type NotifyGameOverResponse,
  type WinnerNotification,
  isWinnerNotification,
  type PostMatchActionRequest,
  type PostMatchActionNotification,
  isPostMatchActionNotification,
  type PlayerDisconnectedNotification,
  isPlayerDisconnectedNotification,
} from "./payload.js";
import { parseMatchFrame, type MatchFrame } from "./game_protocol.js";

import { Logger } from "./logger";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RELIABLE_CHANNEL_LABEL = "reliable-main";
const UNRELIABLE_CHANNEL_LABEL = "unreliable-main";

/**
 * ゲーム通信用コネクションクラス
 */
export class GameConnection {
  public userId: Uuid | null = null;

  // setupSignaling()/setupPeerConnection()（コンストラクタおよび再接続で呼ぶ）で代入される
  private ws!: WebSocket;
  private pc!: RTCPeerConnection;

  /**
   * 信頼性のあるデータチャンネル
   */
  private rdc!: RTCDataChannel;

  /**
   * 信頼性のないデータチャンネル
   */
  private urdc!: RTCDataChannel;

  private rdcFunctions: Map<Uuid, (event: MessageEvent) => void> = new Map();
  private urdcFunctions: Map<Uuid, (event: MessageEvent) => void> = new Map();
  private matchEventHandlers: Map<Uuid, (frame: MatchFrame) => void> =
    new Map();

  public dcReady: boolean = false;

  public closed: boolean = false;

  private keepaliveIntervalId: number | null = null;
  private pingReportIntervalId: number | null = null;

  // ── 再接続(新規接続 + PlayerID 再バインド) ──────────────────────────────
  /** 再接続用に保持するシグナリングURL */
  private serverUrl = "";
  /** 切断時の致命コールバック（再接続を試みて、それも尽きたときに呼ぶ） */
  private onCloseCb?: () => void;
  /** 再接続を開始した瞬間に1度呼ぶ（UI: 「再接続中…」表示用） */
  private onReconnecting?: () => void;
  /** 再接続に成功したとき呼ぶ（UI: 「再接続しました」表示用） */
  private onReconnected?: () => void;
  /** 再接続シーケンス進行中フラグ */
  private reconnecting = false;
  /** close() による意図的な切断か（true のときは再接続を起動しない） */
  private intentionalClose = false;
  /**
   * 再接続の最大試行回数と1回あたりのタイムアウト。
   * サーバー側のICEタイムアウト(disconnected+failed=30s、main.rs参照)より短いと、
   * 低品質な回線でICEチェックが完了する前にクライアントが毎回ゼロから
   * やり直してしまい、いつまでも接続が成立しない(大学WIFI等での接続断の主因だった)。
   */
  private static readonly RECONNECT_MAX_ATTEMPTS = 4;
  private static readonly RECONNECT_ATTEMPT_TIMEOUT_MS = 18000;

  /**
   * サーバー時刻 − ローカル時刻 のオフセット (ms)。syncClock() で確定する。
   * `Date.now() + serverClockOffset` ≒ サーバー現在時刻。
   */
  public serverClockOffset: number = 0;

  /** 直近の RTT 測定値 (ms) */
  public lastRttMs: number | null = null;

  private readonly logger = new Logger("ONLINE:Connection");

  /**
   * ゲーム通信用コネクションクラス
   * @param {string} url WebSocket URL
   * @param {(() => void)?} onClose WebSocketやDataChannelが閉じたときのコールバック関数
   */
  constructor(
    url: string,
    onClose?: () => void,
    callbacks?: { onReconnecting?: () => void; onReconnected?: () => void },
  ) {
    this.serverUrl = url;
    this.onCloseCb = onClose;
    this.onReconnecting = callbacks?.onReconnecting;
    this.onReconnected = callbacks?.onReconnected;
    this.setupSignaling();
  }

  /** シグナリング用WebSocketを生成しハンドラを張る（初回・再接続の両方で使う） */
  private setupSignaling(): void {
    this.ws = new WebSocket(this.serverUrl);
    this.ws.onerror = (event) => {
      this.logger.error("WebSocket error:", event);
    };
    this.ws.onclose = () => {
      this.logger.log("WebSocket connection closed");
      // WebSocketはシグナリング専用で確立後は閉じてよい。
      // データチャネルが一度も開いていない初回ハンドシェイク失敗時のみ致命扱い。
      if (this.onCloseCb && !this.closed && !this.dcReady) this.onCloseCb();
    };
  }

  /**
   * シグナリングサーバーから受け取った RTC 設定を `RTCPeerConnection` が受理できる形へ正規化する。
   *
   * ★ Cloudflare の `generate-ice-servers` は `iceServers` を「単一オブジェクト」で返す:
   *     { "iceServers": { "urls": [...], "username": "...", "credential": "..." } }
   *   一方 WebRTC 仕様の `RTCConfiguration.iceServers` は `sequence<RTCIceServer>`（＝配列）。
   *   オブジェクトのまま `new RTCPeerConnection()` に渡すと、ブラウザによっては TypeError で
   *   即失敗、あるいは黙って無視され TURN(relay) 候補が一切収集されない。
   *   後者の場合、relay が必須な一部ネットワークでは脆弱な reflexive ペアで一瞬 `connected` に
   *   なった後 consent freshness が落ちて `failed` に転落する（＝報告された不具合）。
   *   ここで必ず配列へ正規化し、TURN が確実に効くようにする。
   */
  private static normalizeRtcConfig(raw: any): RTCConfiguration {
    if (!raw || typeof raw !== "object") return {};
    const cfg: RTCConfiguration = { ...raw };
    const servers = (raw as any).iceServers;
    if (Array.isArray(servers)) {
      cfg.iceServers = servers;
    } else if (servers && typeof servers === "object") {
      // Cloudflare 形式（単一オブジェクト）→ 配列へラップ
      cfg.iceServers = [servers];
    } else if (servers == null) {
      delete (cfg as any).iceServers;
    }
    return cfg;
  }

  /** PeerConnection と Reliable/Unreliable DataChannel を生成しハンドラを張る（初回・再接続で使う） */
  private setupPeerConnection(config: RTCConfiguration = {}): void {
    this.pc = new RTCPeerConnection(config);

    this.rdc = this.pc.createDataChannel(RELIABLE_CHANNEL_LABEL);
    this.urdc = this.pc.createDataChannel(UNRELIABLE_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
    });

    this.rdc.onopen = () => {
      this.logger.log("Data channel opened");
      this.dcReady = true;
      this.startKeepalive();
      // シグナリングWSは確立後は不要なので少し待ってから閉じる（帯域・サーバー資源の節約）。
      // 切断時は「新しいWSを開き、保持中の userId を offer に載せて」サーバーの既存プレイヤーへ
      // 再バインドするため、WSを開いたまま保持する必要はない。
      setTimeout(() => {
        if (this.ws.readyState === WebSocket.OPEN && !this.reconnecting) {
          this.logger.log("Closing signaling WebSocket (no longer needed)");
          this.ws.close(1000, "signaling complete");
        }
      }, 2000);
    };
    this.urdc.onopen = () => {
      this.logger.log("Unreliable data channel opened");
    };

    this.rdc.onmessage = (event) => {
      (async () => {
        const buf = await this.eventToBuffer(event);
        if (buf && buf[0] >= 0x20 && buf[0] <= 0x3f) {
          const frame = parseMatchFrame(buf);
          if (frame) this.matchEventHandlers.forEach((h) => h(frame));
          return;
        }
        try {
          await this.handleInbound(event);
        } catch {}
        this.rdcFunctions.forEach((func) => func(event));
      })();
    };
    this.urdc.onmessage = (event) => {
      (async () => {
        const buf = await this.eventToBuffer(event);
        if (buf && buf[0] >= 0x20 && buf[0] <= 0x3f) {
          const frame = parseMatchFrame(buf);
          if (frame) this.matchEventHandlers.forEach((h) => h(frame));
          return;
        }
        this.urdcFunctions.forEach((func) => func(event));
      })();
    };

    this.rdc.onerror = (event) => {
      this.logger.error(`Data channel ${RELIABLE_CHANNEL_LABEL} error:`, event);
    };
    this.urdc.onerror = (event) => {
      this.logger.error(
        `Data channel ${UNRELIABLE_CHANNEL_LABEL} error:`,
        event,
      );
    };

    this.rdc.onclose = () => {
      this.logger.log("Data channel closed");
      this.dcReady = false;
      this.stopKeepalive();
      if (this.intentionalClose || this.closed) return;
      // ★ いきなり致命扱いにせず、まず再接続を試みる。尽きたら finishReconnect(false) が onCloseCb。
      this.tryReconnect();
    };
    this.urdc.onclose = () => {
      this.logger.log("Unreliable data channel closed");
    };

    // ★ PeerConnection の接続状態を監視し、failed(確定的失敗)で再接続を起動する。
    //   disconnected は一過性(ICE瞬断で自己回復しうる)なので即座には起動しない。
    //   悪化して failed になるか、DataChannelが閉じれば(rdc.onclose) 再接続へ。
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.logger.log("PeerConnection state:", st);
      if (st === "failed") {
        if (!this.intentionalClose && !this.closed) this.tryReconnect();
      }
    };

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) {
        this.logger.log("ICE candidate gathering finished (null candidate)");
        return;
      }
      // ★ candidate 文字列から type(host/srflx/relay)・protocol・ip:port を
      //   ログしておく。relay 候補が全く出てこない/relay だけ失敗する、といった
      //   ネットワーク固有の不具合（例: 特定Wi-Fiでのみ TURN が通らない）を
      //   再現時に切り分けるための手がかり。
      this.logger.log("Local ICE candidate:", event.candidate.candidate);
      const msg = {
        type: "candidate",
        candidate: event.candidate.candidate,
        sdp_mid: event.candidate.sdpMid,
        sdp_m_line_index: event.candidate.sdpMLineIndex,
        user_id: this.userId,
      };
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    };

    // ★ STUN/TURN サーバーへの疎通・割り当て失敗を直接報告するイベント。
    //   onconnectionstatechange の failed だけでは「どの ICE サーバーが」
    //   「どのエラーコードで」失敗したか分からない。ここで url/errorCode/errorText
    //   をログしておけば、次に大学Wi-Fi等で再現した際にコンソールから
    //   一目で原因（例: 401=認証不可、TCP接続不可 等）を特定できる。
    this.pc.onicecandidateerror = (event) => {
      const e = event as RTCPeerConnectionIceErrorEvent;
      this.logger.error("ICE candidate error:", {
        url: e.url,
        errorCode: e.errorCode,
        errorText: e.errorText,
        address: e.address,
        port: e.port,
      });
    };

    this.pc.oniceconnectionstatechange = () => {
      this.logger.log("ICE connection state:", this.pc.iceConnectionState);
    };

    this.pc.onicegatheringstatechange = () => {
      this.logger.log("ICE gathering state:", this.pc.iceGatheringState);
    };
  }

  /**
   * WebSocketコネクションを準備して，WebRTCのOfferを送信する。
   * @param reconnectId 再接続時に既存の player_id を載せて同一プレイヤーへ再バインドする。
   */
  ready(reconnectId?: Uuid | null) {
    return new Promise<void>(async (resolve, reject) => {
      while (
        this.ws.readyState !== WebSocket.OPEN &&
        this.ws.readyState !== WebSocket.CLOSED
      ) {
        await sleep(10);
      }

      if (this.ws.readyState === WebSocket.CLOSED) {
        reject(new Error("WebSocket connection failed"));
        return;
      }

      let rtcConfig: RTCConfiguration | null = null;

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "authresult") {
          if (!message.success) {
            reject(new Error("Authentication failed: " + message.message));
            return;
          }
          this.logger.log("Authentication successful");
          let config: string =
            message.rtcPeerIceConfig ?? message.rtc_peer_ice_config ?? "{}";
          rtcConfig = GameConnection.normalizeRtcConfig(JSON.parse(config));
        }
      };

      this.ws.send(
        JSON.stringify({
          type: "auth",
          version: APP_VERSION,
        }),
      );

      while (rtcConfig === null) {
        await sleep(10);
      }

      this.setupPeerConnection(rtcConfig);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      this.ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "answer") {
          await this.pc.setRemoteDescription(
            new RTCSessionDescription(message),
          );
          this.logger.log("Received answer and set remote description");

          while (this.dcReady === false) {
            await sleep(10);
          }
          resolve();
        } else if (message.type === "candidate") {
          const sdpMid = message.sdpMid ?? message.sdp_mid ?? null;
          const sdpMLineIndex =
            message.sdpMLineIndex ?? message.sdp_m_line_index ?? null;
          const userId: Uuid | null = message.userId ?? message.user_id ?? null;
          if (sdpMid == null && sdpMLineIndex == null) {
            this.logger.warn(
              "Ignoring ICE candidate without sdpMid/sdpMLineIndex",
            );
            return;
          }
          try {
            await this.pc.addIceCandidate(
              new RTCIceCandidate({
                candidate: message.candidate,
                sdpMid,
                sdpMLineIndex,
              }),
            );
            this.userId = userId;
          } catch (e) {
            this.logger.warn("Failed to add ICE candidate", e);
          }
        }
      };

      const offerMsg: { type: string; sdp?: string; player_id?: Uuid } = {
        type: "offer",
        sdp: offer.sdp,
      };
      if (reconnectId) offerMsg.player_id = reconnectId; // 再接続: 同一プレイヤーへ再バインド要求
      this.ws.send(JSON.stringify(offerMsg));
    });
  }

  private startKeepalive(): void {
    this.keepaliveIntervalId = window.setInterval(() => {
      if (!this.dcReady || this.closed) return;
      try {
        const id = randomUUID();
        this.sendRDC(Payload.binaryPing(id));
      } catch {
        // ignore; if the channel is truly dead, rdc.onclose will fire
      }
    }, 25000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveIntervalId !== null) {
      clearInterval(this.keepaliveIntervalId);
      this.keepaliveIntervalId = null;
    }
  }

  // ── 再接続 (新規接続 + PlayerID 再バインド) ─────────────────────────────
  /**
   * 切断検知時に再接続シーケンスを開始する。多重起動はしない。
   * 新しいWS+PC+DataChannelを作り直し、保持中の userId を offer に載せて送ることで、
   * サーバー側の「同一プレイヤースロット」へ再バインドする（猶予 RECONNECT_GRACE_SECS 内）。
   * ハンドラ登録（matchEventHandlers 等）はインスタンスに残るので、新チャネルへ自動的に再配線される。
   */
  private tryReconnect(): void {
    if (this.reconnecting || this.closed || this.intentionalClose) return;
    this.reconnecting = true;
    this.logger.warn(
      "Connection lost. Attempting reconnect (rebind by player_id)...",
    );
    this.onReconnecting?.();
    this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    const targetId = this.userId; // 再バインド先（初回接続でサーバーから受領済みのID）
    for (
      let attempt = 1;
      attempt <= GameConnection.RECONNECT_MAX_ATTEMPTS;
      attempt++
    ) {
      if (this.closed || this.intentionalClose) {
        this.reconnecting = false;
        return;
      }
      this.logger.log(
        `Reconnect attempt ${attempt}/${GameConnection.RECONNECT_MAX_ATTEMPTS} (id=${targetId})`,
      );
      try {
        this.teardownTransport(); // 旧PC/WS/チャネルを後始末（ハンドラは無効化済み）
        this.dcReady = false;
        this.setupSignaling();
        this.setupPeerConnection();
        await this.withTimeout(
          this.ready(targetId),
          GameConnection.RECONNECT_ATTEMPT_TIMEOUT_MS,
        );
        // ready() は DataChannel が開く（dcReady=true）と解決する＝接続確立。
        // サーバーが再バインドに成功していれば userId は変わらない。新規IDを振られていたら再バインド失敗。
        if (targetId && this.userId !== targetId) {
          this.logger.warn(
            `Rebind failed: server issued a new id (${this.userId} != ${targetId}).`,
          );
          this.finishReconnect(false);
          return;
        }
        this.finishReconnect(true);
        return;
      } catch (e) {
        this.logger.warn(`Reconnect attempt ${attempt} failed:`, e);
      }
    }
    this.finishReconnect(false);
  }

  /** Promise に時間制限をかける（再接続1回あたりのタイムアウト） */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("reconnect attempt timed out")),
        ms,
      );
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  /** 旧トランスポートを後始末する。再接続のたびに呼ぶ（致命扱いやtryReconnectを誘発しないようハンドラを外す） */
  private teardownTransport(): void {
    try {
      this.rdc.onclose = null;
      this.rdc.onmessage = null;
      this.rdc.close();
    } catch {}
    try {
      this.urdc.onclose = null;
      this.urdc.onmessage = null;
      this.urdc.close();
    } catch {}
    try {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.close();
    } catch {}
    try {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
    } catch {}
    this.stopKeepalive();
  }

  /** 再接続シーケンスを終了する。success=true なら復旧、false なら致命へ。 */
  private finishReconnect(success: boolean): void {
    if (!this.reconnecting) return;
    this.reconnecting = false;
    if (success) {
      this.dcReady = this.rdc.readyState === "open";
      this.logger.log("Reconnected (rebind succeeded).");
      this.onReconnected?.();
    } else {
      this.logger.warn("Reconnect failed. Giving up.");
      this.teardownTransport();
      if (!this.closed) {
        this.closed = true;
        this.onCloseCb?.();
      }
    }
  }

  /** テスト専用: トランスポートを強制切断して再接続フローを駆動し、復帰可否を返す。 */
  async debugSimulateDropAndReconnect(): Promise<boolean> {
    const targetId = this.userId;
    this.tryReconnect();
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (!this.reconnecting) {
        // 復旧していれば dcReady かつ userId 維持
        return (
          this.dcReady &&
          (!targetId || this.userId === targetId) &&
          !this.closed
        );
      }
    }
    return false;
  }

  /**
   * サーバーとの時刻オフセットを確定する。複数回サンプリングし、
   * 最小RTTのサンプルを採用する（経路遅延の揺らぎの影響を最小化）。
   */
  async syncClock(samples: number = 4): Promise<number> {
    let bestRtt = Infinity;
    let bestOffset = 0;
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now();
      const sent = Date.now();
      const res = await this.timeSync();
      const rtt = performance.now() - t0;
      if (rtt < bestRtt) {
        bestRtt = rtt;
        bestOffset = res.serverTimeMs + rtt / 2 - (sent + rtt);
      }
    }
    this.serverClockOffset = Math.round(bestOffset);
    this.lastRttMs = Math.round(bestRtt);
    this.logger.log(
      `Clock synced. offset=${this.serverClockOffset}ms rtt=${this.lastRttMs}ms`,
    );
    return this.serverClockOffset;
  }

  /** サーバー基準の現在時刻 (ms) */
  serverNow(): number {
    return Date.now() + this.serverClockOffset;
  }

  /**
   * ルーム在室中のRTT定期報告を開始する（5秒ごと）。
   * 測定値はサーバーに送られ RoomInfoNotification で全員に配られる。
   */
  startPingReporting(roomId: Uuid): void {
    this.stopPingReporting();
    const report = async () => {
      if (!this.dcReady || this.closed) return;
      try {
        const t0 = performance.now();
        await this.sendBinaryPing();
        const rtt = Math.round(performance.now() - t0);
        this.lastRttMs = rtt;
        this.sendRDC(
          Payload.jsonRequest(
            Opcodes.JSONRequest,
            JSON.stringify({
              type: "JSONUpdatePlayerPingRequest",
              id: randomUUID(),
              roomId,
              pingMs: rtt,
            }),
          ),
        );
      } catch {
        // 接続断時は keepalive/onclose 側で処理される
      }
    };
    report();
    this.pingReportIntervalId = window.setInterval(report, 5000);
  }

  stopPingReporting(): void {
    if (this.pingReportIntervalId !== null) {
      clearInterval(this.pingReportIntervalId);
      this.pingReportIntervalId = null;
    }
  }

  /**
   * 各種コネクションを閉じる
   */
  async close() {
    this.logger.log("Closing connection...");
    this.intentionalClose = true; // 意図的な切断 → 再接続を起動しない
    this.closed = true;
    this.reconnecting = false;
    this.stopKeepalive();
    this.stopPingReporting();
    this.dcReady = false;
    this.sendRDC(Payload.close());

    try {
      this.rdc.close();
    } catch (e) {}
    try {
      this.urdc.close();
    } catch (e) {}

    this.pc.close();
    this.ws.close();
    this.logger.log("Connection closed");
  }

  addReaderFunction(func: (event: MessageEvent) => void): Uuid {
    const id = randomUUID();
    this.rdcFunctions.set(id, func);
    return id;
  }

  removeReaderFunction(id: Uuid) {
    this.rdcFunctions.delete(id);
  }

  private addJsonReaderFunction(
    func: (event: { [key: string]: any }) => void,
  ): Uuid {
    const id = randomUUID();
    this.rdcFunctions.set(id, async (event) => {
      try {
        const data = event.data;
        let buf: Uint8Array;
        if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
        else if (data instanceof Blob) {
          const ab = await data.arrayBuffer();
          buf = new Uint8Array(ab);
        } else if (data instanceof Uint8Array) {
          buf = data;
        } else if (data.buffer instanceof ArrayBuffer) {
          buf = new Uint8Array(data.buffer);
        } else {
          return;
        }
        const decoded = JSONPayload.fromPayload(buf);
        func(decoded);
      } catch (e) {
        // ignore parse errors
      }
    });
    return id;
  }

  private async handleInbound(event: MessageEvent) {
    const data = event.data;
    let buf: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
    else if (data instanceof Blob) {
      const ab = await data.arrayBuffer();
      buf = new Uint8Array(ab);
    } else if (data instanceof Uint8Array) buf = data;
    else if (data?.buffer instanceof ArrayBuffer)
      buf = new Uint8Array(data.buffer);

    if (!buf) return;

    try {
      const decoded = Payload.decode(buf);
      if (decoded.op === Opcodes.Ping) {
        const id = Payload.bytesToUuid(decoded.idBytes);
        this.sendRDC(Payload.binaryPong(id));
        return;
      }

      if (decoded.op === Opcodes.JSONRequest) {
        const parsed = JSON.parse(decoded.data);
        if (parsed?.type === "JSONPing" && typeof parsed.id === "string") {
          const resp = { type: "JSONPong", id: parsed.id };
          this.sendRDC(
            Payload.jsonResponse(Opcodes.JSONResponse, JSON.stringify(resp)),
          );
        }
      }
    } catch (e) {
      // ignore decode errors
    }
  }

  /**
   * Send binary data over the data channel
   * @param data Uint8Array
   */
  sendRDC(data: Uint8Array) {
    if (!this.dcReady) throw new Error("Data channel is not ready");
    // RTCDataChannel in browsers accepts ArrayBuffer or BufferSource
    this.rdc.send(data.buffer as unknown as ArrayBuffer);
  }

  /**
   * Send binary data over the data channel
   * @param data Uint8Array
   */
  sendURDC(data: Uint8Array) {
    if (!this.dcReady) throw new Error("Data channel is not ready");
    // RTCDataChannel in browsers accepts ArrayBuffer or BufferSource
    this.urdc.send(data.buffer as unknown as ArrayBuffer);
  }

  sendWS(message: string) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.ws.send(message);
  }

  async waitResponseRDC<T>(op: Opcodes, data: Object): Promise<T> {
    if (!this.dcReady) {
      throw new Error("Data channel is not ready");
    }

    const sendData = {
      id: randomUUID(),
      ...data,
    } as const;

    // send binary payload
    this.sendRDC(Payload.jsonRequest(op, JSON.stringify(sendData)));

    return new Promise((resolve) => {
      let responseReceived = false;
      let handlerId: Uuid | null = null;
      const handler = (event: MessageEvent) => {
        if (responseReceived) return;
        try {
          const data = event.data;
          // normalize to Uint8Array
          let buf: Uint8Array;
          if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
          else if (data instanceof Blob) {
            // Blob: convert to ArrayBuffer asynchronously
            const reader = new FileReader();
            reader.onload = () => {
              const ab = reader.result as ArrayBuffer;
              const b = new Uint8Array(ab);
              const decoded = JSONPayload.fromPayload(b);
              if ("id" in decoded && decoded.id === sendData.id) {
                responseReceived = true;
                this.rdcFunctions.delete(handlerId!);
                resolve(decoded as T);
              }
            };
            reader.readAsArrayBuffer(data);
            return;
          } else if (data instanceof Uint8Array) {
            buf = data;
          } else if (data.buffer instanceof ArrayBuffer) {
            buf = new Uint8Array(data.buffer);
          } else {
            return;
          }

          const decoded = JSONPayload.fromPayload(buf);
          if ("id" in decoded && decoded.id === sendData.id) {
            responseReceived = true;
            this.rdcFunctions.delete(handlerId!);
            resolve(decoded as T);
          }
        } catch (e) {
          // ignore parse errors
        }
      };

      handlerId = this.addReaderFunction(handler);
    });
  }

  async waitResponseRDCBinary<T>(id: string): Promise<T> {
    if (!this.dcReady) {
      throw new Error("Data channel is not ready");
    }

    return new Promise((resolve) => {
      let responseReceived = false;
      let handlerId: Uuid | null = null;
      const handler = (event: MessageEvent) => {
        if (responseReceived) return;
        try {
          const data = event.data;
          let buf: Uint8Array;
          if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
          else if (data instanceof Blob) {
            const reader = new FileReader();
            reader.onload = () => {
              const ab = reader.result as ArrayBuffer;
              const b = new Uint8Array(ab);
              const decoded = Payload.decode(b);
              if (decoded.op === Opcodes.Pong) {
                const recvId = Payload.bytesToUuid(decoded.idBytes);
                if (recvId === id) {
                  responseReceived = true;
                  this.rdcFunctions.delete(handlerId!);
                  resolve(recvId as unknown as T);
                }
              }
            };
            reader.readAsArrayBuffer(data);
            return;
          } else if (data instanceof Uint8Array) {
            buf = data;
          } else if (data.buffer instanceof ArrayBuffer) {
            buf = new Uint8Array(data.buffer);
          } else {
            return;
          }
          const decoded = Payload.decode(buf);
          if (decoded.op === Opcodes.Pong) {
            const recvId = Payload.bytesToUuid(decoded.idBytes);
            if (recvId === id) {
              responseReceived = true;
              this.rdcFunctions.delete(handlerId!);
              resolve(recvId as unknown as T);
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      };

      handlerId = this.addReaderFunction(handler);
    });
  }

  async sendBinaryPing(): Promise<string> {
    const id = randomUUID();
    await this.sendRDC(Payload.binaryPing(id));
    return this.waitBinaryPong(id);
  }

  async waitBinaryPong(id: string): Promise<string> {
    return this.waitResponseRDCBinary(id);
  }

  async eventToBuffer(event: MessageEvent): Promise<Uint8Array | null> {
    const data = event.data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof Uint8Array) return data;
    if (data?.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
    return null;
  }

  onGetRoomInfoNotifications(
    callback: (data: RoomInfoNotification) => void,
  ): Uuid {
    return this.addJsonReaderFunction((event) => {
      if (isRoomInfoNotification(event)) {
        callback(event);
      }
    });
  }

  // ── Match event relay (0x2N binary frames) ─────────────────────────

  onMatchEvent(handler: (frame: MatchFrame) => void): Uuid {
    const id = randomUUID();
    this.matchEventHandlers.set(id, handler);
    return id;
  }

  removeMatchEventHandler(id: Uuid): void {
    this.matchEventHandlers.delete(id);
  }

  sendMatchEvent(data: Uint8Array): void {
    this.sendRDC(data);
  }

  sendPieceState(data: Uint8Array): void {
    this.sendURDC(data);
  }

  // ── Match control (JSON layer) ─────────────────────────────────────

  startMatch(data: Omit<StartMatchRequest, "id">): Promise<StartMatchResponse> {
    return this.waitResponseRDC<StartMatchResponse>(Opcodes.JSONRequest, {
      type: "JSONStartMatchRequest",
      ...data,
    });
  }

  updateMatchSetting(
    data: Omit<UpdateMatchSettingRequest, "id">,
  ): Promise<UpdateMatchSettingResponse> {
    return this.waitResponseRDC<UpdateMatchSettingResponse>(
      Opcodes.JSONRequest,
      {
        type: "JSONUpdateMatchSettingRequest",
        ...data,
      },
    );
  }

  updatePlayerRule(
    data: Omit<UpdatePlayerRuleRequest, "id">,
  ): Promise<UpdatePlayerRuleResponse> {
    return this.waitResponseRDC<UpdatePlayerRuleResponse>(Opcodes.JSONRequest, {
      type: "JSONUpdatePlayerRuleRequest",
      ...data,
    });
  }

  setReady(data: Omit<SetReadyRequest, "id">): Promise<SetReadyResponse> {
    return this.waitResponseRDC<SetReadyResponse>(Opcodes.JSONRequest, {
      type: "JSONSetReadyRequest",
      ...data,
    });
  }

  timeSync(): Promise<TimeSyncResponse> {
    return this.waitResponseRDC<TimeSyncResponse>(Opcodes.JSONRequest, {
      type: "JSONTimeSyncRequest",
    });
  }

  joinByCode(data: Omit<JoinByCodeRequest, "id">): Promise<JoinByCodeResponse> {
    return this.waitResponseRDC<JoinByCodeResponse>(Opcodes.JSONRequest, {
      type: "JSONJoinByCodeRequest",
      ...data,
    });
  }

  joinRandomMatch(
    data: Omit<JoinRandomMatchRequest, "id">,
  ): Promise<JoinRandomMatchResponse> {
    return this.waitResponseRDC<JoinRandomMatchResponse>(Opcodes.JSONRequest, {
      type: "JSONJoinRandomMatchRequest",
      ...data,
    });
  }

  cancelRandomMatch(): Promise<CancelRandomMatchResponse> {
    return this.waitResponseRDC<CancelRandomMatchResponse>(
      Opcodes.JSONRequest,
      {
        type: "JSONCancelRandomMatchRequest",
      },
    );
  }

  sendPause(data: Omit<PauseRequest, "id">): void {
    this.sendRDC(
      Payload.jsonRequest(
        Opcodes.JSONRequest,
        JSON.stringify({
          type: "JSONPauseRequest",
          id: randomUUID(),
          ...data,
        }),
      ),
    );
  }

  sendResume(data: { roomId: Uuid }): void {
    this.sendRDC(
      Payload.jsonRequest(
        Opcodes.JSONRequest,
        JSON.stringify({
          type: "JSONResumeRequest",
          id: randomUUID(),
          ...data,
        }),
      ),
    );
  }

  notifyGameOver(
    data: Omit<NotifyGameOverRequest, "id">,
  ): Promise<NotifyGameOverResponse> {
    return this.waitResponseRDC<NotifyGameOverResponse>(Opcodes.JSONRequest, {
      type: "JSONNotifyGameOverRequest",
      ...data,
    });
  }

  sendPostMatchAction(data: Omit<PostMatchActionRequest, "id">): void {
    this.sendRDC(
      Payload.jsonRequest(
        Opcodes.JSONRequest,
        JSON.stringify({
          type: "JSONPostMatchActionRequest",
          id: randomUUID(),
          ...data,
        }),
      ),
    );
  }

  // ── Match notification subscriptions ──────────────────────────────

  onStartMatchNotification(cb: (n: StartMatchNotification) => void): Uuid {
    return this.addJsonReaderFunction((e) => {
      if (isStartMatchNotification(e)) cb(e as any);
    });
  }

  onUpdateMatchSetting(cb: (n: UpdateMatchSettingNotification) => void): Uuid {
    return this.addJsonReaderFunction((e) => {
      if (isUpdateMatchSettingNotification(e)) cb(e as any);
    });
  }

  onPauseNotification(cb: (n: PauseNotification) => void): Uuid {
    return this.addJsonReaderFunction((e) => {
      if (isPauseNotification(e)) cb(e as any);
    });
  }

  onResumeNotification(cb: (n: ResumeNotification) => void): Uuid {
    return this.addJsonReaderFunction((e) => {
      if (isResumeNotification(e)) cb(e as any);
    });
  }

  onWinnerNotification(cb: (n: WinnerNotification) => void): Uuid {
    return this.addJsonReaderFunction((e) => {
      if (isWinnerNotification(e)) cb(e as any);
    });
  }

  onPostMatchAction(cb: (n: PostMatchActionNotification) => void): Uuid {
    return this.addJsonReaderFunction((e) => {
      if (isPostMatchActionNotification(e)) cb(e as any);
    });
  }

  onPlayerDisconnected(cb: (n: PlayerDisconnectedNotification) => void): Uuid {
    return this.addJsonReaderFunction((e) => {
      if (isPlayerDisconnectedNotification(e)) cb(e as any);
    });
  }

  sendJsonPing(): Promise<{ id: string }> {
    return this.waitResponseRDC<{ id: string }>(Opcodes.JSONRequest, {
      type: "JSONPing",
    });
  }

  getRooms(): Promise<JSONGetRoomsResponse> {
    return this.waitResponseRDC<JSONGetRoomsResponse>(Opcodes.JSONRequest, {
      type: "JSONGetRoomsRequest",
    });
  }

  createRoom(data: Omit<CreateRoomRequest, "id">): Promise<CreateRoomResponse> {
    return this.waitResponseRDC<CreateRoomResponse>(Opcodes.JSONRequest, {
      type: "JSONCreateRoomRequest",
      ...data,
    });
  }

  joinRoom(data: Omit<JoinRoomRequest, "id">): Promise<JoinRoomResponse> {
    return this.waitResponseRDC<JoinRoomResponse>(Opcodes.JSONRequest, {
      type: "JSONJoinRoomRequest",
      ...data,
    });
  }

  leaveRoom(data: Omit<LeaveRoomRequest, "id">): Promise<LeaveRoomResponse> {
    return this.waitResponseRDC<LeaveRoomResponse>(Opcodes.JSONRequest, {
      type: "JSONLeaveRoomRequest",
      ...data,
    });
  }

  updateRoom(data: Omit<UpdateRoomRequest, "id">): Promise<UpdateRoomResponse> {
    return this.waitResponseRDC<UpdateRoomResponse>(Opcodes.JSONRequest, {
      type: "JSONUpdateRoomRequest",
      ...data,
    });
  }

  roomInfoNotificationRequest(
    data: Omit<RoomInfoNotificationRequest, "id">,
  ): Promise<void> {
    return this.waitResponseRDC<void>(Opcodes.JSONRequest, {
      type: "JSONRoomInfoNotificationRequest",
      ...data,
    });
  }
}
