// @ts-check
import { jsx, Fragment } from '../jsx-runtime';

import { GameConnection } from "./connection.js";

const backToMainMenu = () => {
  /// TODO: onlineの部分だけmodule化しているため，その他のファイルの関数を直で呼び出せない．
  /// 将来的にはすべてのファイルをモジュール化して、必要な関数をインポートして呼び出せるようにするべき．
  if ("switchPage" in window && typeof window.switchPage === "function") {
    window.switchPage("main-menu");
  } else {
    // フォールバック処理
    location.reload();
  }
};

const goToOnlineMode = async () => {
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
        console.warn(
          "[ONLINE:Loader]",
          "Connection to the online server has been closed.",
        );
        backToMainMenu();
      } else {
        console.warn(
          "[ONLINE:Loader]",
          "Connection to the online server has been closed due to an error during initialization.",
        );
      }
    });
    if (!connection) {
      throw new Error("Failed to create GameConnection");
    }
    await connection.ready();

    console.log(
      "[ONLINE:Loader]",
      "Successfully connected to the online server.",
    );

    console.log(await connection.sendBinaryPing());
    console.log(await connection.sendJsonPing());

    const { rooms } = await connection.getRooms();
    console.log("Rooms:", rooms);

    onlineTopContainer.replaceChildren(
      <>
        <div class="online-header">
          <button class="btn btn-secondary" onclick={() => {
            if (connection) {
              connection.close();
            }
            backToMainMenu();
          }}>◀ BACK</button>
          <h1>🌐 ONLINE</h1>
          <button class="btn btn-settings" onclick={backToMainMenu}>⚙ SETTINGS</button>
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
            <button class="btn btn-save" onclick={() => { console.log("るーむ！") }}>ルームを作成</button>
          </div>
        </div>
      </>
    );
  } catch (e) {
    console.error("[ONLINE:Loader]", "Failed to create GameConnection:", e);
    alert(
      "オンラインサーバーに接続できませんでした。",
    );
    errorOccurred = true;

    backToMainMenu();
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const tetlaboServerUrl = localStorage.getItem("tetlaboServerUrl");

  console.log("[ONLINE:Loader]", "WebSocket signaling URL:", tetlaboServerUrl);

  const onlineBtn = document.getElementById(
    "online-mode-button",
  ) as HTMLButtonElement | null;
  if (onlineBtn) {
    onlineBtn.onclick = (() => {
      /// どこぞのゲームと同じ仕様
      if (confirm("オンラインモードに接続しますか？")) {
        goToOnlineMode();
      } else {
        console.log("[ONLINE:Loader]", "User canceled entering online mode.");
      }
    });
  }
});
