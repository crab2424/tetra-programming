// @ts-check
import { jsx, Fragment } from '../jsx-runtime';

import { GameConnection } from "./connection";
import { Logger } from "./logger";
import { type Uuid } from "./payload";
class OnlineMode {
  private readonly logger = new Logger("ONLINE:Loader");
  private userName: string = "さすらいの研究者";
  private connection: GameConnection | null = null;

  private discordUserId: number | null = null;

  constructor() {
    this.userName = this.getUserName();
    this.logger.log("OnlineMode instance created.");
  }

  private backToMainMenu() {
    /// TODO: onlineの部分だけmodule化しているため，その他のファイルの関数を直で呼び出せない．
    /// 将来的にはすべてのファイルをモジュール化して、必要な関数をインポートして呼び出せるようにするべき．
    if ("switchPage" in window && typeof window.switchPage === "function") {
      window.switchPage("main-menu");
    } else {
      // フォールバック処理
      location.reload();
    }
  }

  private showModal(content: HTMLElement) {
    const modalContainer = document.getElementById("online-modal-container");
    if (!modalContainer) {
      throw new Error("Failed to find modal container element");
    }
    modalContainer.replaceChildren(content);
    modalContainer.classList.add("online-modal-active");
  }

  private hideModal() {
    const modalContainer = document.getElementById("online-modal-container");
    if (!modalContainer) {
      throw new Error("Failed to find modal container element");
    }
    modalContainer.classList.remove("online-modal-active");
    modalContainer.replaceChildren();
  }


  private getUserNameNullable(): string | null {
    return localStorage.getItem("tetlaboUserName");
  }

  private getUserName(): string {
    const storedName = this.getUserNameNullable();
    if (storedName) {
      return storedName;
    }
    let name = prompt("オンラインモードで使用するユーザー名を入力してください。", "さすらいの研究者");
    if (!name) {
      name = "Player";
    }
    localStorage.setItem("tetlaboUserName", name);
    return name;
  }

  private changeUserName() {
    const newName = prompt("新しいユーザー名を入力してください。", this.getUserNameNullable() || "さすらいの研究者");
    if (newName) {
      localStorage.setItem("tetlaboUserName", newName);
      alert(`ユーザー名を「${newName}」に変更しました。`);
    }
  }

  private async roomJoined(id: Uuid) {
    this.logger.info(`Joined room with ID: ${id}`);
  }

  private async createRoomPage() {
    const roomName = this.userName + "の部屋";
    const { roomId } = await this.connection!.createRoom({
      roomName,
      maxPlayers: 4,
      tags: []
    });
    const result = await this.connection!.joinRoom({ roomId });
    if (result.success) {
      this.roomJoined(roomId);
    } else {
      this.logger.error(`Failed to join room ${roomId}: ${result.message}`);
      alert(`ルームへの参加に失敗しました: ${result.message || "不明なエラー"}`);
      this.onlineTopPage();
    }
  }

  /**
   * オンラインのルーム一覧の画面
   */
  private async onlineTopPage() {
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
          <button class="btn btn-secondary" onclick={() => {
            if (this.connection) {
              this.connection.close();
            }
            this.backToMainMenu();
          }}>◀ BACK</button>
          <h1>🌐 ONLINE</h1>
          <button class="btn btn-settings" onclick={this.backToMainMenu}>⚙ SETTINGS</button>
        </div>
        <div class="online-top-content">
          <div id="online-rooms-container">
            {
              rooms.length > 0 ? (
                <>
                  {rooms.map((room) => (
                    <div class="online-room" data-room-id={room.id}>
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
            <button class="btn btn-save" onclick={this.createRoomPage}>ルームを作成</button>
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
            Username:
            <input type="text" value={this.userName} oninput={(e) => {
              const target = e.target as HTMLInputElement;
              this.userName = target.value;
            }} />
          </label>
        </div>
        <div>
          <button class="btn btn-primary" onclick={() => {
            localStorage.setItem("tetlaboUserName", this.userName);
            alert("ユーザー名を保存しました。");
            this.hideModal();
          }}>Save</button>
          <button class="btn btn-secondary" onclick={() => {
            this.hideModal();
          }}>Cancel</button>
        </div>
        <hr />
        <div>
          UserID: {this.discordUserId ? this.discordUserId : "Not connected"}
        </div>
        <div>
          <button class="btn btn-primary" onclick={() => {
            alert("Discord連携機能は現在開発中です。");
          }}>Connect Discord</button>
        </div>
      </div>
    );
    this.showModal(modalContent);
  }

  public async init() {
    {
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
        connection = new GameConnection(tetlaboServerUrl, () => {
          if (!errorOccurred) {
            alert(
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
        alert(
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
      /// どこぞのゲームと同じ仕様にしてみた
      if (confirm("オンラインモードに接続しますか？")) {
        const onlineMode = new OnlineMode();
        onlineMode.init();
      } else {
        console.log("[ONLINE:INIT]", "User canceled entering online mode.");
      }
    });
  }
});
