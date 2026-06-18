// @ts-check
import { jsx, Fragment } from "../jsx-runtime";

import { GameConnection } from "./connection";
import { Logger } from "./logger";
import {
  type Uuid,
  type RoomInfoNotification,
  Games,
  type UpdateRoomRequest,
  parseMatchSetting,
  type OnlineMatchSetting,
} from "./payload";
import { showToast, ToastColor } from "../toast";
import { AllTags, getTagName } from "./room";
import { OnlineGameController } from "./online_game";

enum OnlineModeState {
  Disconnected,
  Connecting,
  RoomList,
  InRoom,
}

class Modal {
  static showModal(content: HTMLElement) {
    const modalContainer = document.getElementById("online-modal-container");
    if (!modalContainer) {
      throw new Error("Failed to find modal container element");
    }
    modalContainer.replaceChildren(content);
    modalContainer.classList.add("online-modal-active");
  }

  static hideModal() {
    const modalContainer = document.getElementById("online-modal-container");
    if (!modalContainer) {
      throw new Error("Failed to find modal container element");
    }
    modalContainer.classList.remove("online-modal-active");
    modalContainer.replaceChildren();
  }

  static async alert(
    message: string,
    title?: string,
    okMessage: string = "OK",
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const modalContent = (
        <div
          style={{
            backgroundColor: "#000",
            padding: "20px",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            minWidth: "300px",
            color: "#fff",
          }}
        >
          {title && <h2>{title}</h2>}
          <div>{message}</div>
          <div>
            <button
              class="btn btn-save"
              onclick={() => {
                Modal.hideModal();
                resolve();
              }}
            >
              {okMessage}
            </button>
          </div>
        </div>
      );
      Modal.showModal(modalContent);
    });
  }

  static async confirm(
    message: string,
    title?: string,
    okMessage: string = "OK",
    cancelMessage: string = "Cancel",
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modalContent = (
        <div
          style={{
            backgroundColor: "#000",
            padding: "20px",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            minWidth: "300px",
            color: "#fff",
          }}
        >
          {title && <h2>{title}</h2>}
          <div>{message}</div>
          <div
            style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}
          >
            <button
              class="btn btn-secondary"
              onclick={() => {
                Modal.hideModal();
                resolve(false);
              }}
            >
              {cancelMessage}
            </button>
            <button
              class="btn btn-primary"
              onclick={() => {
                Modal.hideModal();
                resolve(true);
              }}
            >
              {okMessage}
            </button>
          </div>
        </div>
      );
      Modal.showModal(modalContent);
    });
  }

  static async prompt(
    message: string,
    title?: string,
    defaultValue: string = "",
    okMessage: string = "OK",
    cancelMessage?: string,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const modalContent = (
        <div
          style={{
            backgroundColor: "#000",
            padding: "20px",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            minWidth: "300px",
            color: "#fff",
          }}
        >
          {title && <h2>{title}</h2>}
          <div>{message}</div>
          <input
            id="online-prompt-input"
            type="text"
            value={defaultValue}
            style={{
              padding: "8px",
              borderRadius: "4px",
              border: "1px solid #555",
              backgroundColor: "#222",
              color: "#fff",
            }}
          />
          <div
            style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}
          >
            {cancelMessage && (
              <button
                class="btn btn-secondary"
                onclick={() => {
                  Modal.hideModal();
                  resolve(null);
                }}
              >
                {cancelMessage}
              </button>
            )}
            <button
              class="btn btn-primary"
              onclick={() => {
                const input = document.getElementById(
                  "online-prompt-input",
                ) as HTMLInputElement | null;
                if (!input) {
                  alert("Failed to find prompt input element.");
                  return;
                } else {
                  Modal.hideModal();
                  resolve(input.value);
                }
              }}
            >
              {okMessage}
            </button>
          </div>
        </div>
      );
      Modal.showModal(modalContent);
    });
  }
}

/**
 * ルールアイコンを <img> ではなく背景画像の <span> として描画する。
 * RoomInfoNotification 受信のたびに画面を作り直すと <img> は要素ごと再生成され、
 * キャッシュ済みでも再デコードで「ちらつき」が出る。背景画像なら即描画されちらつかない。
 */
function gameIcon(game: Games, size: number) {
  return (
    <span
      style={{
        display: "inline-block",
        width: `${size}px`,
        height: `${size}px`,
        backgroundImage: `url(${Games.toIcon(game)})`,
        backgroundSize: "contain",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        verticalAlign: "middle",
        flexShrink: "0",
      }}
    />
  );
}

class OnlineMode {
  private readonly logger = new Logger("ONLINE:Loader");
  private userName: string = "さすらいの研究者";
  private connection: GameConnection | null = null;

  private discordUserId: number | null = null;

  private _state: OnlineModeState = OnlineModeState.Disconnected;
  public get state(): OnlineModeState {
    return this._state;
  }
  public set state(value: OnlineModeState) {
    if (
      this._state === OnlineModeState.InRoom &&
      value !== OnlineModeState.InRoom
    ) {
      if (this.roomEventHandlerId) {
        this.connection!.removeReaderFunction(this.roomEventHandlerId);
        this.roomEventHandlerId = null;
      }
      if (this.gameController) {
        this.gameController.cleanup();
        this.gameController = null;
      }
      this.connection?.stopPingReporting();
      this.isRandomMatchRoom = false;
    }
    if (value !== OnlineModeState.RoomList) {
      this.stopRoomListAutoRefresh();
    }
    this._state = value;
  }

  public currentRoom: Omit<UpdateRoomRequest, "id"> | null = null;
  public roomEventHandlerId: Uuid | null = null;
  private gameController: OnlineGameController | null = null;
  private roomListRefreshId: number | null = null;
  /** ルーム画面の「ping以外の状態」シグネチャ。pingだけの更新で全再構築しないための差分判定用 */
  private lastRoomSig: string | null = null;
  /** ランダムマッチで入室したルームは自動READY→オーナーが全員READY確認次第自動START */
  private isRandomMatchRoom = false;

  /** 最後に選択したルール（TET/PUYO）を記憶・取得する */
  private getPreferredRule(): Games {
    const v = localStorage.getItem("tetlaboPreferredRule");
    return v === "puyo" ? "puyo" : "tet";
  }
  private setPreferredRule(rule: Games): void {
    localStorage.setItem("tetlaboPreferredRule", rule);
  }

  private stopRoomListAutoRefresh(): void {
    if (this.roomListRefreshId !== null) {
      clearInterval(this.roomListRefreshId);
      this.roomListRefreshId = null;
    }
  }

  /** success:false 応答をトーストで通知する共通ヘルパー */
  private notifyIfFailed(
    res: { success: boolean; message?: string },
    action: string,
  ): void {
    if (!res.success) {
      showToast(
        "ONLINE",
        `${action}に失敗しました: ${res.message ?? "不明なエラー"}`,
        ToastColor["Error"],
      );
    }
  }

  constructor() {
    this.userName = this.getUserName();
    this.logger.log("OnlineMode instance created. (Not online connected yet)");
  }

  private backToMainMenu() {
    try {
      if (this.connection) {
        this.connection.close();
        this.connection = null;
      }
    } catch (e) { }
    this.state = OnlineModeState.Disconnected;

    /// TODO: onlineの部分だけmodule化しているため，その他のファイルの関数を直で呼び出せない．
    /// 将来的にはすべてのファイルをモジュール化して、必要な関数をインポートして呼び出せるようにするべき．
    if ("switchPage" in window && typeof window.switchPage === "function") {
      window.switchPage("main-menu");
    } else {
      // フォールバック処理
      location.reload();
    }
  }

  /**
   * ユーザー名をローカルストレージから取得する。存在しない場合はnullを返す。
   * @returns {string | null} ユーザー名またはnull
   */
  private getUserNameNullable(): string | null {
    return localStorage.getItem("tetlaboUserName");
  }

  private getUserName(): string {
    const storedName = this.getUserNameNullable();
    if (storedName) {
      return storedName;
    }
    let name = prompt("ユーザー名を入力してください。", "さすらいの研究者");
    if (!name) {
      name = "Player";
    }
    localStorage.setItem("tetlaboUserName", name);
    return name;
  }

  /**
   * 現在参加中のルームのページ
   * 可能なら，RoomInfoNotificationを受け取るたびにうまいこと更新する
   * @param roomData
   */
  private async roomDetailsPage(roomData: RoomInfoNotification) {
    // ルームに居ないときの通知では描画しない（遅延通知でルーム一覧の上に被さるのを防ぐ）
    if (this.state !== OnlineModeState.InRoom) return;

    this.currentRoom = {
      roomId: roomData.roomId,
      roomName: roomData.roomName,
      maxPlayers: roomData.maxPlayers,
      tags: roomData.tags,
      isPublic: roomData.isPublic ?? false,
    };

    // Initialize game controller once per room session
    const myUserId = this.connection!.userId!;
    if (!this.gameController) {
      this.gameController = new OnlineGameController(
        this.connection!,
        roomData,
        myUserId,
      );
      this.gameController.listenForStart({
        onRoom: () => {
          // Come back to room page after match
          if (this.connection && this.gameController) {
            this.gameController = null;
            this.state = OnlineModeState.InRoom;
            this.joinRoom(roomData.roomId, false);
          }
        },
        onLeave: async () => {
          // Leave room
          if (this.connection) {
            try {
              await this.connection.leaveRoom({ roomId: roomData.roomId });
            } catch { }
            this.currentRoom = null;
            this.gameController = null;
            this.onlineTopPage();
          }
        },
        isRandomMatch: this.isRandomMatchRoom,
        onRandomRematch: async () => {
          // ランダムマッチ終了後: 現在のルームを退出して新たなランダムマッチを開始する
          if (this.connection) {
            try {
              await this.connection.leaveRoom({ roomId: roomData.roomId });
            } catch { }
            this.currentRoom = null;
            this.gameController = null;
            this.isRandomMatchRoom = false;
            await this.startRandomMatch();
          }
        },
      });
    } else {
      this.gameController.updateRoomInfo(roomData);
    }

    const isOwner = roomData.ownerId === myUserId;
    const ms = parseMatchSetting(roomData.matchSetting);
    const readySet = new Set(roomData.readyPlayers ?? []);
    const pingMap = new Map<Uuid, number>(roomData.pings ?? []);
    const nonOwners = roomData.players.filter(
      ([id]) => id !== roomData.ownerId,
    );
    const allReady = nonOwners.every(([id]) => readySet.has(id));
    const iAmReady = readySet.has(myUserId);

    // ── ランダムマッチ: ルーム設定画面は一切出さず「対戦準備中」だけ表示する ──
    //    （ROOMボタンや一覧戻りで「謎のランダム用ルーム設定画面」が露出するのを防ぐ）
    //    gameController の初期化は上で完了済みなので、ここで設定UIを作らず即returnしてよい。
    if (this.isRandomMatchRoom) {
      const rmContainer = document.getElementById("online-top-container");
      if (rmContainer && !document.getElementById("ol-rm-waiting")) {
        rmContainer.replaceChildren(
          <>
            <div class="online-header">
              <button class="btn btn-secondary" disabled>
                ◀ BACK
              </button>
              <h1>🌐 ONLINE</h1>
              <button class="btn btn-settings" disabled>
                ⚙ SETTINGS
              </button>
            </div>
            <div
              class="online-top-content"
              id="ol-rm-waiting"
              style={{ textAlign: "center" }}
            >
              <h2>🔍 対戦準備中…</h2>
              <div style={{ color: "var(--text-dim)" }}>
                まもなく対戦が始まります
              </div>
            </div>
          </>,
        );
      }
      // 非オーナーは自動READY、オーナーは全員READY次第自動START
      if (!isOwner && !iAmReady) {
        setTimeout(() => {
          this.connection!.setReady({
            roomId: roomData.roomId,
            ready: true,
          }).catch(() => { });
        }, 100);
      }
      if (isOwner && allReady && roomData.players.length >= 2) {
        setTimeout(() => {
          this.connection!.startMatch({ roomId: roomData.roomId }).catch(
            () => { },
          );
        }, 300);
      }
      return;
    }

    // ── ping 以外の状態が変わっていなければ DOM を作り直さず ping 表示だけ更新する ──
    // pingReport(5秒毎)で RoomInfoNotification が頻繁に来るため、毎回全再構築すると
    // アイコンのちらつきや入力・スクロール状態のリセットが起きる。差分でそれを防ぐ。
    const sig = JSON.stringify({
      players: roomData.players,
      owner: roomData.ownerId,
      ready: [...readySet].sort(),
      setting: roomData.matchSetting,
      tags: roomData.tags,
      name: roomData.roomName,
      code: roomData.code,
      max: roomData.maxPlayers,
      pub: roomData.isPublic ?? false,
    });
    const alreadyRendered = !!document.querySelector(".ms-grid");
    if (alreadyRendered && sig === this.lastRoomSig) {
      for (const [id, msVal] of pingMap) {
        const el = document.getElementById(`ol-ping-${id}`);
        if (el) el.textContent = `📶${msVal}ms`;
      }
      return; // 全再構築をスキップ
    }
    this.lastRoomSig = sig;
    // （ランダムマッチの自動READY/STARTは上の早期returnブロックで処理済み）

    /** マッチ設定の部分更新を送信する（失敗時はトースト） */
    const sendSetting = (patch: Partial<OnlineMatchSetting>) => {
      this.connection!.updateMatchSetting({
        roomId: roomData.roomId,
        setting: JSON.stringify({ ...ms, ...patch }),
      }).then((r) => this.notifyIfFailed(r, "設定変更"));
    };

    /** ON/OFF トグル設定行（横並びセグメント） */
    const toggleRow = (
      label: string,
      key: keyof OnlineMatchSetting,
      value: boolean,
    ) => (
      <div class="ms-row">
        <span class="ms-label">{label}</span>
        {isOwner ? (
          <div class="ms-segment">
            {[true, false].map((v) => (
              <button
                class={"ms-seg-btn" + (value === v ? " active" : "")}
                onclick={() =>
                  sendSetting({ [key]: v } as Partial<OnlineMatchSetting>)
                }
              >
                {v ? "ON" : "OFF"}
              </button>
            ))}
          </div>
        ) : (
          <span class="ms-readonly">{value ? "ON" : "OFF"}</span>
        )}
      </div>
    );

    /** スライダー + カスタム数値入力の設定行 */
    const sliderRow = (
      label: string,
      key: keyof OnlineMatchSetting,
      value: number,
      min: number,
      max: number,
      step: number,
      unit: string,
    ) => {
      const commit = (raw: string) => {
        let n = Number(raw);
        if (!Number.isFinite(n)) return;
        n = Math.max(min, Math.min(max, n));
        if (step >= 1) n = Math.round(n);
        else n = Math.round(n / step) * step;
        sendSetting({ [key]: n } as Partial<OnlineMatchSetting>);
      };
      return (
        <div class="ms-row ms-row-slider">
          <span class="ms-label">{label}</span>
          {isOwner ? (
            <div class="ms-slider-wrap">
              <input
                class="ms-slider"
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onchange={(e) => commit((e.target as HTMLInputElement).value)}
              />
              <input
                class="ms-number"
                type="number"
                min={min}
                max={max}
                step={step}
                value={value}
                onchange={(e) => commit((e.target as HTMLInputElement).value)}
              />
              <span class="ms-unit">{unit}</span>
            </div>
          ) : (
            <span class="ms-readonly">
              {value}
              {unit}
            </span>
          )}
        </div>
      );
    };

    const onlineTopContainer = document.getElementById(
      "online-top-container",
    ) as HTMLDivElement | null;
    if (!onlineTopContainer) {
      throw new Error("Failed to find online top container element");
    }
    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button
            class="btn btn-secondary"
            onclick={async () => {
              const isOnlyPlayer = roomData.players.length === 1;

              const confirmLeave = await Modal.confirm(
                isOnlyPlayer
                  ? "ルームから退出しますか？　退出するとこのルームは解散されます。"
                  : isOwner
                    ? "ルームから退出しますか？　ルームのオーナー権は別のプレイヤーに渡ります。"
                    : "ルームから退出しますか？",
                "ルーム退出の確認",
                "退出",
                "キャンセル",
              );
              if (confirmLeave) {
                await this.connection!.leaveRoom({ roomId: roomData.roomId });
                this.currentRoom = null;
                showToast(
                  "ONLINE",
                  "ルームから退出しました。",
                  ToastColor["Info"],
                );
                this.onlineTopPage();
              } else {
                this.logger.info("User canceled leaving the room.");
              }
            }}
          >
            ◀ LEAVE
          </button>
          <h1>🌐 ONLINE</h1>
          <button
            class="btn btn-settings"
            onclick={this.settingsModal.bind(this)}
          >
            ⚙ SETTINGS
          </button>
        </div>
        <div class="online-top-content">
          <div class="width-full">
            <div class="flex width-full flex-row space-between">
              <h2>
                <>{roomData.roomName}</>
                &nbsp;
                <>{!(roomData.isPublic ?? false) ? "🔒" : "🌍"}</>
              </h2>
              <div
                style={{ display: "flex", alignItems: "center", gap: "12px" }}
              >
                {isOwner && (
                  <button
                    class={
                      "online-room-tag" +
                      (!(roomData.isPublic ?? false)
                        ? " online-room-tag-enabled"
                        : "")
                    }
                    style={{ fontSize: "11px" }}
                    onclick={() => {
                      this.connection!.updateRoom({
                        roomId: roomData.roomId,
                        roomName: roomData.roomName,
                        maxPlayers: roomData.maxPlayers,
                        tags: roomData.tags,
                        isPublic: !(roomData.isPublic ?? false),
                      }).then((r) => this.notifyIfFailed(r, "公開設定変更"));
                    }}
                  >
                    {(roomData.isPublic ?? false)
                      ? "🌍 PUBLIC → 🔒 PRIVATE"
                      : "🔒 PRIVATE → 🌍 PUBLIC"}
                  </button>
                )}
                <div>
                  👤 {roomData.players.length} / {roomData.maxPlayers}
                </div>
              </div>
            </div>

            {roomData.code && (
              <div class="online-code-row">
                <span class="online-code-label">CODE</span>
                <button
                  class="online-code-value"
                  title="クリックでコピー"
                  onclick={() => {
                    navigator.clipboard
                      ?.writeText(roomData.code)
                      .then(() => {
                        showToast(
                          "ONLINE",
                          `ルームコード ${roomData.code} をコピーしました。`,
                          ToastColor["Success"],
                        );
                      })
                      .catch(() => {
                        showToast(
                          "ONLINE",
                          "コピーに失敗しました。",
                          ToastColor["Error"],
                        );
                      });
                  }}
                >
                  {roomData.code}
                </button>
              </div>
            )}

            <div>
              🏷️{" "}
              <>
                {AllTags.map((tag) => (
                  <span
                    onclick={() => {
                      if (isOwner) {
                        const hasTag = roomData.tags.includes(tag);
                        const newTags = hasTag
                          ? roomData.tags.filter((t) => t !== tag)
                          : [...roomData.tags, tag];
                        this.connection!.updateRoom({
                          roomId: roomData.roomId,
                          roomName: roomData.roomName,
                          maxPlayers: roomData.maxPlayers,
                          tags: newTags,
                          isPublic: roomData.isPublic ?? false,
                        });
                      }
                    }}
                    class={
                      "online-room-tag" +
                      (roomData.tags.includes(tag)
                        ? " online-room-tag-enabled"
                        : "")
                    }
                  >
                    {getTagName(tag)}
                  </span>
                ))}
              </>
            </div>

            <spaceRow space={12} />

            {/* ── プレイヤー一覧 + ルール選択 ── */}
            <div
              style={{ display: "flex", flexDirection: "column", gap: "6px" }}
            >
              {roomData.players.map(([id, name, game]) => (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 0",
                  }}
                >
                  <span
                    style={{
                      fontSize: "14px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span>
                      {name}
                      {id === roomData.ownerId ? <> 👑</> : ""}
                      {id === myUserId ? (
                        <span
                          style={{ color: "var(--text-dim)", fontSize: "12px" }}
                        >
                          {" "}
                          (You)
                        </span>
                      ) : (
                        ""
                      )}
                    </span>
                    {pingMap.has(id) && (
                      <span
                        id={`ol-ping-${id}`}
                        style={{
                          fontFamily: "Orbitron, monospace",
                          fontSize: "10px",
                          color: "var(--text-dim)",
                        }}
                      >
                        📶{pingMap.get(id)}ms
                      </span>
                    )}
                    {id !== roomData.ownerId &&
                      (readySet.has(id) ? (
                        <span
                          style={{
                            fontFamily: "Orbitron, monospace",
                            fontSize: "10px",
                            color: "var(--success, #4CAF50)",
                          }}
                        >
                          ✅ READY
                        </span>
                      ) : (
                        <span
                          style={{
                            fontFamily: "Orbitron, monospace",
                            fontSize: "10px",
                            color: "var(--text-dim)",
                          }}
                        >
                          … WAITING
                        </span>
                      ))}
                  </span>
                  {id === myUserId ? (
                    <div style={{ display: "flex", gap: "4px" }}>
                      <button
                        class={
                          "online-room-tag" +
                          (game === "tet" ? " online-room-tag-enabled" : "")
                        }
                        onclick={() => {
                          this.setPreferredRule("tet");
                          this.connection!.updatePlayerRule({
                            roomId: roomData.roomId,
                            rule: "tet",
                          }).then((r) => this.notifyIfFailed(r, "ルール変更"));
                        }}
                      >
                        {gameIcon("tet", 12)} TET
                      </button>
                      <button
                        class={
                          "online-room-tag" +
                          (game === "puyo" ? " online-room-tag-enabled" : "")
                        }
                        onclick={() => {
                          this.setPreferredRule("puyo");
                          this.connection!.updatePlayerRule({
                            roomId: roomData.roomId,
                            rule: "puyo",
                          }).then((r) => this.notifyIfFailed(r, "ルール変更"));
                        }}
                      >
                        {gameIcon("puyo", 12)} PUYO
                      </button>
                    </div>
                  ) : (
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        fontSize: "12px",
                        color: "var(--text-dim)",
                      }}
                    >
                      {gameIcon(game, 14)}
                      {Games.toAlt(game)}
                    </span>
                  )}
                </div>
              ))}
            </div>

            <spaceRow space={12} />

            {/* ── READY / GAME START ── */}
            {isOwner ? (
              allReady && roomData.players.length >= 2 ? (
                <button
                  class="menu-btn btn-versus-primary"
                  style={{ width: "100%" }}
                  onclick={async () => {
                    const result = await this.connection!.startMatch({
                      roomId: roomData.roomId,
                    });
                    if (!result.success) {
                      await Modal.alert(
                        result.message || "ゲーム開始に失敗しました。",
                        "エラー",
                      );
                    }
                  }}
                >
                  <span class="menu-btn-icon">▶</span>
                  <span>GAME START</span>
                </button>
              ) : (
                <>
                  <button
                    class="menu-btn"
                    style={{
                      width: "100%",
                      opacity: "0.4",
                      cursor: "not-allowed",
                    }}
                    disabled
                  >
                    <span class="menu-btn-icon">▶</span>
                    <span>GAME START</span>
                  </button>
                  <div
                    style={{
                      textAlign: "center",
                      color: "var(--text-dim)",
                      fontFamily: "Orbitron, monospace",
                      fontSize: "11px",
                      marginTop: "8px",
                    }}
                  >
                    {roomData.players.length < 2
                      ? "2人以上が揃うと開始できます"
                      : "全プレイヤーのREADYを待っています…"}
                  </div>
                </>
              )
            ) : (
              <>
                <button
                  class={
                    "menu-btn " +
                    (iAmReady ? "btn-secondary" : "btn-versus-primary")
                  }
                  style={{ width: "100%" }}
                  onclick={() => {
                    this.connection!.setReady({
                      roomId: roomData.roomId,
                      ready: !iAmReady,
                    }).then((r) => this.notifyIfFailed(r, "READY変更"));
                  }}
                >
                  <span class="menu-btn-icon">{iAmReady ? "↩" : "✔"}</span>
                  <span>{iAmReady ? "CANCEL READY" : "READY"}</span>
                </button>
                <div
                  style={{
                    textAlign: "center",
                    color: "var(--text-dim)",
                    fontFamily: "Orbitron, monospace",
                    fontSize: "11px",
                    marginTop: "8px",
                  }}
                >
                  {iAmReady
                    ? "ホストのゲーム開始を待っています…"
                    : "準備ができたら READY を押してください"}
                </div>
              </>
            )}

            <spaceRow space={16} />

            {/* ── マッチ設定 ── */}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                paddingTop: "12px",
              }}
            >
              <div
                style={{
                  fontFamily: "Orbitron, monospace",
                  fontSize: "11px",
                  letterSpacing: "2px",
                  color: "var(--text-dim)",
                  marginBottom: "10px",
                }}
              >
                MATCH SETTINGS{" "}
                {!isOwner && (
                  <span style={{ fontSize: "10px" }}>
                    （オーナーのみ変更可）
                  </span>
                )}
              </div>
              <div class="ms-grid">
                {toggleRow("HOLD", "holdEnabled", ms.holdEnabled)}
                {toggleRow("B2B BONUS", "b2bBonus", ms.b2bBonus)}
                {toggleRow("DMG ON CLEAR", "garbageDamageOnClear", ms.garbageDamageOnClear,)}
                {sliderRow("GARBAGE ×", "garbageMultiplier", ms.garbageMultiplier, 0, 3, 0.1, "x",)}
                {sliderRow("MARGIN TIME", "marginTime", ms.marginTime, 0, 300, 1, "s",)}
                {sliderRow("HOLE RATE", "garbageHoleRate", ms.garbageHoleRate, 0, 100, 1, "%",)}
                {sliderRow("OJAMA RATE", "ojamaRate", ms.ojamaRate, 0, 200, 1, "%",)}
              </div>
            </div>
          </div>
        </div>
      </>,
    );
  }

  /**
   * ルームに参加する処理
   * @param roomId 参加するルームのID
   * @param sendJoinRequest ルーム参加リクエストをサーバーに送信するかどうか。通常はtrueだが，ルーム作成処理に内部で参加処理があるため、その場合はfalseを指定して参加リクエストを送信しないようにする。
   */
  private async joinRoom(roomId: Uuid, sendJoinRequest: boolean = true) {
    // ルームに入る瞬間に一覧の自動更新を確実に止める（放置中に一覧が一瞬表示される不具合の防止）
    this.stopRoomListAutoRefresh();
    this.lastRoomSig = null; // 新しいルームでは必ず一度フル描画する
    this.state = OnlineModeState.InRoom;

    const onlineTopContainer = document.getElementById(
      "online-top-container",
    ) as HTMLDivElement | null;
    if (!onlineTopContainer) {
      throw new Error("Failed to find online top container element");
    }

    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button class="btn btn-secondary" disabled>
            ◀ BACK
          </button>
          <h1>🌐 ONLINE</h1>
          <button class="btn btn-settings" disabled>
            ⚙ SETTINGS
          </button>
        </div>
        <div class="online-top-content">
          <div>Joining room, please wait...</div>
        </div>
      </>,
    );

    if (sendJoinRequest) {
      const result = await this.connection!.joinRoom({
        roomId,
        username: this.userName,
        rule: this.getPreferredRule(),
      });
      if (!result.success) {
        this.logger.error(`Failed to join room ${roomId}: ${result.message}`);
        await Modal.alert(
          result.message || "不明なエラー",
          "ルームに参加できませんでした",
        );
        this.onlineTopPage();
        return;
      }
      this.logger.info(`Joined room with ID: ${roomId}`);

      this.currentRoom = {
        roomId,
        roomName: "",
        maxPlayers: 0,
        tags: [],
        isPublic: false,
      };
    } else {
      this.logger.info(`Joined room with ID: ${roomId} (no join request sent)`);
    }

    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button
            class="btn btn-secondary"
            onclick={this.onlineTopPage.bind(this)}
          >
            ◀ BACK
          </button>
          <h1>🌐 ONLINE - Room</h1>
          <button
            class="btn btn-settings"
            onclick={this.settingsModal.bind(this)}
          >
            ⚙ SETTINGS
          </button>
        </div>
        <div class="online-top-content">
          <div>Waiting room info notification...</div>
        </div>
      </>,
    );

    // 古いハンドラが残っていると多重描画になるため、登録前に必ず解除する
    if (this.roomEventHandlerId) {
      this.connection!.removeReaderFunction(this.roomEventHandlerId);
      this.roomEventHandlerId = null;
    }
    this.roomEventHandlerId = this.connection!.onGetRoomInfoNotifications(
      (notification) => {
        if (notification.roomId === roomId) {
          this.logger.log(
            "Received room info notification for current room:",
            notification,
          );
          this.roomDetailsPage(notification);
        } else {
          this.logger.log(
            "Received room info notification for another room (ignoring):",
            notification,
          );
        }
      },
    );

    this.connection!.roomInfoNotificationRequest({});
    this.connection!.startPingReporting(roomId);
  }

  /** ルーム作成ダイアログを表示し、作成して入室する */
  private async createRoomPage() {
    type CreateRoomForm = {
      roomName: string;
      maxPlayers: number;
      isPublic: boolean;
    };
    const form = await new Promise<CreateRoomForm | null>((resolve) => {
      const readForm = (): CreateRoomForm => {
        const nameInput = document.getElementById(
          "online-create-room-name",
        ) as HTMLInputElement | null;
        const maxInput = document.getElementById(
          "online-create-max-players",
        ) as HTMLSelectElement | null;
        const visInput = document.getElementById(
          "online-create-visibility",
        ) as HTMLSelectElement | null;
        return {
          roomName: nameInput?.value?.trim() || this.userName + "の部屋",
          maxPlayers: Number(maxInput?.value) || 4,
          isPublic: visInput?.value === "public",
        };
      };
      const modalContent = (
        <div
          style={{
            backgroundColor: "#000",
            padding: "20px",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            minWidth: "320px",
            color: "#fff",
          }}
        >
          <h2>ルーム作成</h2>
          <label
            style={{ display: "flex", flexDirection: "column", gap: "4px" }}
          >
            ルーム名
            <input
              id="online-create-room-name"
              class="settings-online-input"
              type="text"
              value={this.userName + "の部屋"}
            />
          </label>
          <label
            style={{ display: "flex", flexDirection: "column", gap: "4px" }}
          >
            最大人数
            <select
              id="online-create-max-players"
              class="settings-online-input"
            >
              <option value="4">4人</option>
              <option value="3">3人</option>
              <option value="2">2人</option>
            </select>
          </label>
          <label
            style={{ display: "flex", flexDirection: "column", gap: "4px" }}
          >
            公開設定
            <select id="online-create-visibility" class="settings-online-input">
              <option value="private">🔒 プライベート（コード参加のみ）</option>
              <option value="public">🌍 パブリック（一覧に表示）</option>
            </select>
          </label>
          <div
            style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}
          >
            <button
              class="btn btn-secondary"
              onclick={() => {
                Modal.hideModal();
                resolve(null);
              }}
            >
              キャンセル
            </button>
            <button
              class="btn btn-primary"
              onclick={() => {
                const values = readForm();
                Modal.hideModal();
                resolve(values);
              }}
            >
              作成
            </button>
          </div>
        </div>
      );
      Modal.showModal(modalContent);
    });
    if (!form) return;

    const { roomName, maxPlayers, isPublic } = form;

    const { roomId } = await this.connection!.createRoom({
      roomName,
      maxPlayers,
      tags: [],
      username: this.userName,
      rule: this.getPreferredRule(),
      isPublic,
    });
    this.logger.info("Created room with ID:", roomId);
    this.currentRoom = {
      roomId,
      roomName,
      maxPlayers,
      tags: [],
      isPublic,
    };
    this.joinRoom(roomId, false);
  }

  /** ランダムマッチ開始。ルール選択 → マッチング → 成立次第自動スタート */
  private async startRandomMatch() {
    // まず自分のルールを選択してもらう
    const selectedRule = await new Promise<Games | null>((resolve) => {
      let chosen: Games = this.getPreferredRule();
      const makeBtn = (rule: Games, label: string) => (
        <button
          class={
            "online-room-tag" +
            (chosen === rule ? " online-room-tag-enabled" : "")
          }
          style={{ fontSize: "14px", padding: "8px 16px" }}
          onclick={(e: Event) => {
            chosen = rule;
            // ボタンの active 状態を更新
            const parent = (e.target as HTMLElement).parentElement;
            parent
              ?.querySelectorAll("button")
              .forEach((b) => b.classList.remove("online-room-tag-enabled"));
            (e.target as HTMLElement).classList.add("online-room-tag-enabled");
          }}
        >
          {label}
        </button>
      );
      const content = (
        <div
          style={{
            backgroundColor: "#000",
            padding: "24px",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            minWidth: "300px",
            color: "#fff",
            alignItems: "center",
          }}
        >
          <h2>🎲 ランダムマッチ</h2>
          <div style={{ color: "var(--text-dim)", fontSize: "13px" }}>
            使用ルールを選んでください
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            {makeBtn("tet", "TET")}
            {makeBtn("puyo", "PUYO")}
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: "11px" }}>
            ※ 相手ルールは問いません
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              class="btn btn-secondary"
              onclick={() => {
                Modal.hideModal();
                resolve(null);
              }}
            >
              キャンセル
            </button>
            <button
              class="btn btn-primary"
              onclick={() => {
                Modal.hideModal();
                resolve(chosen);
              }}
            >
              マッチング開始
            </button>
          </div>
        </div>
      );
      Modal.showModal(content);
    });
    if (selectedRule === null) {
      // ルール選択キャンセル: 再マッチ経路では既にルームを退出済みなので、確実にロビーへ戻す
      this.onlineTopPage();
      return;
    }

    this.setPreferredRule(selectedRule);

    const res = await this.connection!.joinRandomMatch({
      username: this.userName,
      rule: selectedRule,
    });
    if (res.matched && res.roomId) {
      this.isRandomMatchRoom = true;
      this.joinRoom(res.roomId, false);
      return;
    }

    // 待機: マッチ成立時はサーバーが RoomInfoNotification を配ってくるのでそれを合図にする
    let finished = false;
    const handlerId = this.connection!.onGetRoomInfoNotifications((notif) => {
      if (finished) return;
      finished = true;
      this.connection!.removeReaderFunction(handlerId);
      Modal.hideModal();
      showToast("ONLINE", "対戦相手が見つかりました！", ToastColor["Success"]);
      this.isRandomMatchRoom = true;
      this.joinRoom(notif.roomId, false);
    });

    Modal.showModal(
      <div
        style={{
          backgroundColor: "#000",
          padding: "24px",
          borderRadius: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          minWidth: "300px",
          color: "#fff",
          alignItems: "center",
        }}
      >
        <h2>🔍 マッチング中…</h2>
        <div style={{ color: "var(--text-dim)" }}>対戦相手を探しています</div>
        <button
          class="btn btn-secondary"
          onclick={async () => {
            finished = true;
            this.connection!.removeReaderFunction(handlerId);
            Modal.hideModal();
            try {
              await this.connection!.cancelRandomMatch();
            } catch { }
            showToast(
              "ONLINE",
              "マッチングをキャンセルしました。",
              ToastColor["Info"],
            );
            // 謎のランダム用ルーム画面を出さず、確実にロビーへ戻す
            this.onlineTopPage();
          }}
        >
          キャンセル
        </button>
      </div>,
    );
  }

  /** 6桁コードでルームに参加する */
  private async joinRoomByCode() {
    const code = await Modal.prompt(
      "6桁のルームコードを入力してください。",
      "コードで参加",
      "",
      "参加",
      "キャンセル",
    );
    if (code === null) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      showToast(
        "ONLINE",
        "コードは6桁の数字で入力してください。",
        ToastColor["Warning"],
      );
      return;
    }
    const res = await this.connection!.joinByCode({
      code: trimmed,
      username: this.userName,
      rule: this.getPreferredRule(),
    });
    if (res.success && res.roomId) {
      this.joinRoom(res.roomId, false);
    } else {
      await Modal.alert(
        res.message || "不明なエラー",
        "ルームに参加できませんでした",
      );
    }
  }

  /**
   * オンラインのルーム一覧の画面
   */
  private async onlineTopPage() {
    this.state = OnlineModeState.RoomList;

    const { rooms } = await this.connection!.getRooms();
    this.logger.log("Received rooms from server:", rooms);

    // 直後に state が変わっていたら描画しない（自動更新とページ遷移の競合防止）
    if (this.state !== OnlineModeState.RoomList) return;

    this.userName = this.getUserName();

    const onlineTopContainer = document.getElementById(
      "online-top-container",
    ) as HTMLDivElement | null;
    if (!onlineTopContainer) {
      throw new Error("Failed to find online top container element");
    }
    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button
            class="btn btn-secondary"
            onclick={this.backToMainMenu.bind(this)}
          >
            ◀ BACK
          </button>
          <h1>🌐 ONLINE</h1>
          <button
            class="btn btn-settings"
            onclick={this.settingsModal.bind(this)}
          >
            ⚙ SETTINGS
          </button>
        </div>
        <div class="online-top-content online-list-layout">
          {/* 上段: [ルーム一覧 + 更新] ... [ルーム作成] */}
          <div class="online-list-header">
            <div class="online-list-title">
              <h2 style={{ margin: "0" }}>ルーム一覧</h2>
              <button
                class="btn btn-secondary"
                onclick={() => this.onlineTopPage()}
              >
                🔄 更新
              </button>
            </div>
            <button
              class="btn btn-save"
              onclick={this.createRoomPage.bind(this)}
            >
              ＋ ルーム作成
            </button>
          </div>

          {/* 中段: ルーム一覧（縦スクロール） */}
          <div id="online-rooms-container">
            {rooms.length > 0 ? (
              rooms.map((room) => (
                <div
                  class="online-room"
                  onclick={() => this.joinRoom(room.id, true)}
                >
                  <div class="online-room-main">
                    <span class="online-room-name">
                      {room.locked ? "🔒 " : ""}
                      {room.roomName}
                    </span>
                    <span class="online-room-count">
                      👤 {room.players}/{room.maxPlayers}
                    </span>
                  </div>
                  {room.tags && room.tags.length > 0 && (
                    <div class="online-room-tags">
                      {room.tags.map((tag) => (
                        <span class="online-room-tag online-room-tag-enabled">
                          {getTagName(tag)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div class="online-rooms-empty">現在ルームはありません．</div>
            )}
          </div>

          {/* 下段: [ランダムマッチ, コードで参加] */}
          <div class="online-list-footer">
            <button
              class="btn btn-primary"
              onclick={this.startRandomMatch.bind(this)}
            >
              🎲 ランダムマッチ
            </button>
            <button
              class="btn btn-primary"
              onclick={this.joinRoomByCode.bind(this)}
            >
              🔢 コードで参加
            </button>
          </div>
        </div>
      </>,
    );

    // 一覧表示中は10秒ごとに自動更新する。
    // ルームに入っている間は絶対に発火させない（一覧が一瞬表示される不具合の防止）。
    this.stopRoomListAutoRefresh();
    this.roomListRefreshId = window.setInterval(() => {
      const battleActive = document
        .getElementById("online-battle-page")
        ?.classList.contains("active");
      if (this.state === OnlineModeState.RoomList && !battleActive) {
        this.onlineTopPage();
      } else {
        this.stopRoomListAutoRefresh();
      }
    }, 10000);
  }

  private async settingsModal() {
    const modalContent = (
      <div
        style={{
          backgroundColor: "#000",
          padding: "20px",
          borderRadius: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          minWidth: "300px",
          color: "#fff",
        }}
      >
        <h2>Settings</h2>
        <div>
          <label>
            ユーザー名:
            <input
              id="online-mode-username-input"
              type="text"
              value={this.userName}
            />
          </label>
          <button
            class="btn btn-primary"
            onclick={() => {
              const input = document.getElementById(
                "online-mode-username-input",
              ) as HTMLInputElement | null;
              if (!input) {
                console.error(
                  "Failed to find username input element in settings modal.",
                );
                return;
              }
              localStorage.setItem("tetlaboUserName", input.value);
              showToast(
                "ONLINE",
                "ユーザー名を保存しました！",
                ToastColor["Success"],
              );
            }}
          >
            Save
          </button>
        </div>
        <div style="display: none;">
          <hr />
          <div>
            UserID: {this.discordUserId ? this.discordUserId : "Not connected"}
          </div>
          <div>
            <button
              class="btn btn-primary"
              onclick={() => {
                console.log(
                  "Connect Discord button clicked. (Not implemented yet)",
                );
              }}
            >
              Connect Discord
            </button>
          </div>
        </div>

        <hr />

        <div>
          <button
            class="btn btn-save"
            onclick={() => {
              Modal.hideModal();
            }}
          >
            Close
          </button>
        </div>
      </div>
    );
    Modal.showModal(modalContent);
  }

  public async init() {
    {
      this.state = OnlineModeState.Connecting;

      const onlineTopContainer = document.getElementById(
        "online-top-container",
      ) as HTMLDivElement | null;
      if (!onlineTopContainer) {
        throw new Error("Failed to find online top container element");
      }

      onlineTopContainer.replaceChildren(
        <>
          <div class="online-header">
            <button class="btn btn-secondary" disabled>
              ◀ BACK
            </button>
            <h1>🌐 ONLINE</h1>
            <button class="btn btn-settings" disabled>
              ⚙ SETTINGS
            </button>
          </div>
          <div class="online-top-content">
            <div>CONNECTING...</div>
          </div>
        </>,
      );

      const tetlaboServerUrl =
        localStorage.getItem("tetlaboServerUrl") || "wss://example.com/ws";

      const pages = document.querySelectorAll(".page");
      pages.forEach((p) => p.classList.remove("active"));

      const onlinePage = document.getElementById("online-top-page");
      if (onlinePage) onlinePage.classList.add("active");

      let connection: GameConnection | null = null;

      let errorOccurred = false;

      try {
        connection = new GameConnection(
          tetlaboServerUrl,
          async () => {
            if (!errorOccurred) {
              await Modal.alert("オンラインサーバーとの接続が切断されました。");
              this.logger.warn(
                "Connection to the online server has been closed.",
              );
              this.backToMainMenu();
            } else {
              this.logger.warn(
                "Connection closed during initialization, not showing alert.",
              );
            }
          },
          {
            // 瞬断時: ICE restart で復旧を試みている間の表示
            onReconnecting: () => {
              showToast(
                "再接続中…",
                "通信が不安定です。接続の復旧を試みています。",
                ToastColor.Warning,
              );
            },
            onReconnected: () => {
              showToast(
                "再接続しました",
                "接続が回復しました。",
                ToastColor.Success,
              );
            },
          },
        );
        if (!connection) {
          throw new Error("Failed to create GameConnection");
        }
        await connection.ready();
        this.connection = connection;
        (window as any)._olConn = connection; // E2Eテスト用フック（再接続検証など）

        console.log(await connection.sendBinaryPing());
        console.log(await connection.sendJsonPing());

        // サーバーとの時刻オフセットを確定（開始同期・マージン公平性の基盤）
        try {
          await connection.syncClock();
        } catch (e) {
          this.logger.warn("Clock sync failed (continuing with offset=0):", e);
        }

        this.onlineTopPage();

        this.logger.info("Successfully connected to the online server.");
      } catch (e) {
        this.logger.error("Failed to connect to the online server:", e);
        await Modal.alert("オンラインサーバーに接続できませんでした。");
        errorOccurred = true;

        this.backToMainMenu();
      }
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const tetlaboServerUrl = localStorage.getItem("tetlaboServerUrl");

  console.log("[ONLINE:INIT]", "WebSocket signaling URL:", tetlaboServerUrl);

  const onlineBtn = document.getElementById(
    "online-mode-button",
  ) as HTMLButtonElement | null;
  if (onlineBtn) {
    onlineBtn.onclick = () => {
      const onlineMode = new OnlineMode();
      onlineMode.init();
    };
  }
});
