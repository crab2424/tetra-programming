// @ts-check
import { jsx, Fragment } from '../jsx-runtime';

import { GameConnection } from "./connection";
import { Logger } from "./logger";
import { type Uuid, type RoomInfoNotification, Games, type UpdateRoomRequest } from "./payload";
import { showToast, ToastColor } from "../toast";
import { AllTags, getTagName, RoomTag } from './room';

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

  static async alert(message: string, title?: string, okMessage: string = "OK"): Promise<void> {
    return new Promise<void>((resolve) => {
      const modalContent = (
        <div style={{
          backgroundColor: "#000",
          padding: "20px",
          borderRadius: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          minWidth: "300px",
          color: "#fff"
        }}>
          {title && <h2>{title}</h2>}
          <div>{message}</div>
          <div>
            <button class="btn btn-save" onclick={() => {
              Modal.hideModal();
              resolve();
            }}>{okMessage}</button>
          </div>
        </div>
      );
      Modal.showModal(modalContent);
    });
  }

  static async confirm(message: string, title?: string, okMessage: string = "OK", cancelMessage: string = "Cancel"): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modalContent = (
        <div style={{
          backgroundColor: "#000",
          padding: "20px",
          borderRadius: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          minWidth: "300px",
          color: "#fff"
        }}>
          {title && <h2>{title}</h2>}
          <div>{message}</div>
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button class="btn btn-secondary" onclick={() => {
              Modal.hideModal();
              resolve(false);
            }}>{cancelMessage}</button>
            <button class="btn btn-primary" onclick={() => {
              Modal.hideModal();
              resolve(true);
            }}>{okMessage}</button>
          </div>
        </div>
      );
      Modal.showModal(modalContent);
    });
  }

  static async prompt(message: string, title?: string, defaultValue: string = "", okMessage: string = "OK", cancelMessage?: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const modalContent = (
        <div style={{
          backgroundColor: "#000",
          padding: "20px",
          borderRadius: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          minWidth: "300px",
          color: "#fff"
        }}>
          {title && <h2>{title}</h2>}
          <div>{message}</div>
          <input id="online-prompt-input" type="text" value={defaultValue} style={{ padding: "8px", borderRadius: "4px", border: "1px solid #555", backgroundColor: "#222", color: "#fff" }} />
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            {cancelMessage && <button class="btn btn-secondary" onclick={() => {
              Modal.hideModal();
              resolve(null);
            }}>{cancelMessage}</button>}
            <button class="btn btn-primary" onclick={() => {
              const input = document.getElementById("online-prompt-input") as HTMLInputElement | null;
              if (!input) {
                alert("Failed to find prompt input element.");
                return;
              } else {
                Modal.hideModal();
                resolve(input.value);
              }
            }}>{okMessage}</button>
          </div>
        </div>
      );
      Modal.showModal(modalContent);
    });
  }
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
    if (this._state === OnlineModeState.InRoom && value !== OnlineModeState.InRoom) {
      this.connection!.removeReaderFunction(this.roomEventHandlerId!);
      this.roomEventHandlerId = null;
    }
    this._state = value;
  }

  public currentRoom: Omit<UpdateRoomRequest, "id"> | null = null;
  public roomEventHandlerId: Uuid | null = null;

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
    } catch (e) {
      ;
    }
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
   * ユーザー名をローカルストレージから取得する。存在しない場合はプロンプトで入力を求める。
   * @returns {string} ユーザー名
          */
  private async getUserNameAsync(): Promise<string> {
    const storedName = this.getUserNameNullable();
    if (storedName) {
      return storedName;
    }
    let name = await Modal.prompt("ユーザー名を入力してください。", "ユーザー名の設定", "さすらいの研究者", "保存");
    if (!name) {
      name = "Player";
    }
    localStorage.setItem("tetlaboUserName", name);
    return name;
  }

  private async changeUserName() {
    const newName = await Modal.prompt("新しいユーザー名を入力してください。", "ユーザー名の変更", this.userName || "さすらいの研究者", "保存", "キャンセル");
    if (newName) {
      localStorage.setItem("tetlaboUserName", newName);
      await Modal.alert("ユーザー名を変更しました。", "ユーザー名の変更");
      this.userName = newName;
    }
  }

  /**
   * 現在参加中のルームのページ
   * 可能なら，RoomInfoNotificationを受け取るたびにうまいこと更新する
   * @param roomData 
   */
  private async roomDetailsPage(roomData: RoomInfoNotification) {
    this.currentRoom = {
      roomId: roomData.roomId,
      roomName: roomData.roomName,
      maxPlayers: roomData.maxPlayers,
      tags: roomData.tags,
      ...this.currentRoom, // passwordなどの情報は保持する
    };

    const isOwner = roomData.ownerId === this.connection!.userId;
    const onlineTopContainer = document.getElementById("online-top-container") as HTMLDivElement | null;
    if (!onlineTopContainer) {
      throw new Error("Failed to find online top container element");
    }
    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button class="btn btn-secondary" onclick={
            async () => {
              const isOnlyPlayer = roomData.players.length === 1;

              const confirmLeave = await Modal.confirm(
                isOnlyPlayer ? "ルームから退出しますか？　退出するとこのルームは解散されます。" : (
                  isOwner ? "ルームから退出しますか？　ルームのオーナー権は別のプレイヤーに渡ります。" :
                    "ルームから退出しますか？"
                )
                , "ルーム退出の確認", "退出", "キャンセル");
              if (confirmLeave) {
                await this.connection!.leaveRoom({ roomId: roomData.roomId });
                this.currentRoom = null;
                showToast("ONLINE", "ルームから退出しました。", ToastColor["Info"]);
                this.onlineTopPage();
              } else {
                this.logger.info("User canceled leaving the room.");
              }
            }
          }>◀ LEAVE</button>
          <h1>🌐 ONLINE</h1>
          <button class="btn btn-settings" onclick={this.settingsModal.bind(this)}>⚙ SETTINGS</button>
        </div>
        <div class="online-top-content">
          <div class="width-full">
            <div class="flex width-full flex-row space-between">
              <h2>
                <>{roomData.roomName}</>
                &nbsp;
                <>{
                  this.currentRoom.password !== undefined ? "🔒" : ""
                }</>
              </h2>
              <div>👤 {roomData.players.length} / {roomData.maxPlayers}</div>
            </div>

            <div>
              🏷️ <>
                {
                  AllTags.map((tag) => <span onclick={() => {
                    if (isOwner) {
                      const hasTag = roomData.tags.includes(tag);
                      const newTags = hasTag ? roomData.tags.filter(t => t !== tag) : [...roomData.tags, tag];
                      this.connection!.updateRoom({
                        roomId: roomData.roomId,
                        roomName: roomData.roomName,
                        maxPlayers: roomData.maxPlayers,
                        tags: newTags,
                        password: "",
                      });
                    }
                  }} class={
                    "online-room-tag" + (roomData.tags.includes(tag) ? " online-room-tag-enabled" : "")
                  }>{getTagName(tag)}</span>)
                }
              </>
            </div>

            <spaceRow space={12} />

            <div>
              {roomData.players.map(([id, name, game]) => (
                <div data-user-id={id}>
                  <img src={Games.toIcon(game)} alt={Games.toAlt(game)} style={{ width: "18px", height: "18px" }} />
                  <> - </>
                  <>{name}</>
                  <>{
                    id === roomData.ownerId ? " - 👑" : ""
                  }</>
                  <>{
                    id === this.connection!.userId ? " - (You)" : ""
                  }</>
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  }

  /**
   * ルームに参加する処理
   * @param roomId 参加するルームのID
   * @param sendJoinRequest ルーム参加リクエストをサーバーに送信するかどうか。通常はtrueだが，ルーム作成処理に内部で参加処理があるため、その場合はfalseを指定して参加リクエストを送信しないようにする。
   */
  private async joinRoom(roomId: Uuid, sendJoinRequest: boolean = true, passwordRequired: boolean = false) {
    this.state = OnlineModeState.InRoom;

    const onlineTopContainer = document.getElementById("online-top-container") as HTMLDivElement | null;
    if (!onlineTopContainer) {
      throw new Error("Failed to find online top container element");
    }

    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button class="btn btn-secondary" disabled>◀ BACK</button>
          <h1>🌐 ONLINE</h1>
          <button class="btn btn-settings" disabled>⚙ SETTINGS</button>
        </div>
        <div class="online-top-content">
          <div>Joining room, please wait...</div>
        </div>
      </>
    );

    if (sendJoinRequest) {
      let password: string | undefined = undefined;
      if (passwordRequired) {
        const password = await Modal.prompt("このルームはパスワードで保護されています。パスワードを入力してください。", "パスワード入力", "", "参加", "キャンセル");
        if (password === null) {
          this.logger.info("User canceled joining the room.");
          this.onlineTopPage();
          return;
        }
      }
      const result = await this.connection!.joinRoom({ roomId, username: this.userName, rule: "tet", password: password });
      if (!result.success) {
        this.logger.error(`Failed to join room ${roomId}: ${result.message}`);
        await Modal.alert(result.message || "不明なエラー", "ルームに参加できませんでした");
        this.onlineTopPage();
      }
      this.logger.info(`Joined room with ID: ${roomId}`);

      this.currentRoom = {
        roomId,
        roomName: "",
        maxPlayers: 0,
        tags: [],
        password: password,
      }
    } else {
      this.logger.info(`Joined room with ID: ${roomId} (no join request sent)`);
    }

    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button class="btn btn-secondary" onclick={this.onlineTopPage.bind(this)}>◀ BACK</button>
          <h1>🌐 ONLINE - Room</h1>
          <button class="btn btn-settings" onclick={this.settingsModal.bind(this)}>⚙ SETTINGS</button>
        </div>
        <div class="online-top-content">
          <div>Waiting room info notification...</div>
        </div>
      </>
    );

    this.roomEventHandlerId = this.connection!.onGetRoomInfoNotifications((notification) => {
      if (notification.roomId === roomId) {
        this.logger.log("Received room info notification for current room:", notification);
        this.roomDetailsPage(notification);
      } else {
        this.logger.log("Received room info notification for another room (ignoring):", notification);
      }
    });

    this.connection!.roomInfoNotificationRequest({});
  }

  private async createRoomPage() {
    const roomName = this.userName + "の部屋";
    const { roomId } = await this.connection!.createRoom({
      roomName,
      maxPlayers: 4,
      tags: [],
      username: this.userName,
      rule: "tet",
    });
    console.log("Created room with ID:", roomId);
    this.joinRoom(roomId, false);
  }

  /**
   * オンラインのルーム一覧の画面
   */
  private async onlineTopPage() {
    this.state = OnlineModeState.RoomList;

    const { rooms } = await this.connection!.getRooms();
    this.logger.log("Received rooms from server:", rooms);

    this.userName = this.getUserName();

    const onlineTopContainer = document.getElementById("online-top-container") as HTMLDivElement | null;
    if (!onlineTopContainer) {
      throw new Error("Failed to find online top container element");
    }
    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button class="btn btn-secondary" onclick={this.backToMainMenu.bind(this)}>◀ BACK</button>
          <h1>🌐 ONLINE</h1>
          <button class="btn btn-settings" onclick={this.settingsModal.bind(this)}>⚙ SETTINGS</button>
        </div>
        <div class="online-top-content">
          <div id="online-rooms-container">
            {
              rooms.length > 0 ? (
                <>
                  {rooms.map((room) => (
                    <div class="online-room" onclick={() => this.joinRoom(room.id, true, room.locked)}>
                      {room.roomName} ({room.players}/{room.maxPlayers}){room.locked ? " 🔒" : ""}
                    </div>
                  ))}
                </>
              ) : (
                <>現在ルームはありません．</>
              )
            }
          </div>
          <div>
            <button class="btn btn-save" onclick={this.createRoomPage.bind(this)}>ルームを作成</button>
          </div>
        </div>
      </>
    );
  }

  private async settingsModal() {
    const modalContent = (
      <div style={{
        backgroundColor: "#000",
        padding: "20px",
        borderRadius: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        minWidth: "300px",
        color: "#fff"
      }}>
        <h2>Settings</h2>
        <div>
          <label>
            ユーザー名:
            <input id="online-mode-username-input" type="text" value={this.userName} />
          </label>
          <button class="btn btn-primary" onclick={() => {
            const input = document.getElementById("online-mode-username-input") as HTMLInputElement | null;
            if (!input) {
              console.error("Failed to find username input element in settings modal.");
              return;
            }
            localStorage.setItem("tetlaboUserName", input.value);
            showToast("ONLINE", "ユーザー名を保存しました！", ToastColor["Success"]);
          }}>Save</button>
        </div>
        <div style="display: none;">
          <hr />
          <div>
            UserID: {this.discordUserId ? this.discordUserId : "Not connected"}
          </div>
          <div>
            <button class="btn btn-primary" onclick={() => {
              console.log("Connect Discord button clicked. (Not implemented yet)");
            }}>Connect Discord</button>
          </div>
        </div>

        <hr />

        <div>
          <button class="btn btn-save" onclick={() => {
            Modal.hideModal();
          }}>Close</button>
        </div>
      </div>
    );
    Modal.showModal(modalContent);
  }

  public async init() {
    {
      this.state = OnlineModeState.Connecting;

      const onlineTopContainer = document.getElementById("online-top-container") as HTMLDivElement | null;
      if (!onlineTopContainer) {
        throw new Error("Failed to find online top container element");
      }

      onlineTopContainer.replaceChildren(
        <>
          <div class="online-header">
            <button class="btn btn-secondary" disabled>◀ BACK</button>
            <h1>🌐 ONLINE</h1>
            <button class="btn btn-settings" disabled>⚙ SETTINGS</button>
          </div>
          <div class="online-top-content">
            <div>CONNECTING...</div>
          </div>
        </>
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
        connection = new GameConnection(tetlaboServerUrl, async () => {
          if (!errorOccurred) {
            await Modal.alert(
              "オンラインサーバーとの接続が切断されました。",
            );
            this.logger.warn("Connection to the online server has been closed.");
            this.backToMainMenu();
          } else {
            this.logger.warn("Connection closed during initialization, not showing alert.");
          }
        });
        if (!connection) {
          throw new Error("Failed to create GameConnection");
        }
        await connection.ready();
        this.connection = connection;

        console.log(await connection.sendBinaryPing());
        console.log(await connection.sendJsonPing());

        this.onlineTopPage();

        this.logger.info("Successfully connected to the online server.");

      } catch (e) {
        this.logger.error("Failed to connect to the online server:", e);
        await Modal.alert(
          "オンラインサーバーに接続できませんでした。",
        );
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
    onlineBtn.onclick = (() => {
      const onlineMode = new OnlineMode();
      onlineMode.init();
    });
  }
});
