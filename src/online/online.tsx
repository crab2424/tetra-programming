// @ts-check
import { jsx, Fragment } from '../jsx-runtime';

import { GameConnection } from "./connection";
import { Logger } from "./logger";

class OnlineMode {
  private readonly logger = new Logger("ONLINE:Loader");
  private userName: string = "さすらいの研究者";

  constructor() {
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

  private getUserName(): string {
    const storedName = localStorage.getItem("tetlaboUserName");
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
    const newName = prompt("新しいユーザー名を入力してください。", this.getUserName());
    if (newName) {
      localStorage.setItem("tetlaboUserName", newName);
      alert(`ユーザー名を「${newName}」に変更しました。`);
    }
  }

  private async roomJoined() {
    
  }

  private async createRoomPage() {
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

        console.log(await connection.sendBinaryPing());
        console.log(await connection.sendJsonPing());

        this.logger.info("Successfully connected to the online server.");

        const { rooms } = await connection.getRooms();
        this.logger.log("Received rooms from server:", rooms);

        this.userName = this.getUserName();

        onlineTopContainer.replaceChildren(
          <>
            <div class="online-header">
              <button class="btn btn-secondary" onclick={() => {
                if (connection) {
                  connection.close();
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
