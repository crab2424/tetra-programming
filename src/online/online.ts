// @ts-check

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
  const tetlaboServerUrl =
    localStorage.getItem("tetlaboServerUrl") || "wss://example.com/ws";

  const pages = document.querySelectorAll(".page");
  pages.forEach((p) => p.classList.remove("active"));

  const onlinePage = document.getElementById("online-top-page");
  if (onlinePage) onlinePage.classList.add("active");

  let connection: GameConnection | null = null;

  let connectionEstablished = false;

  try {
    connection = new GameConnection(tetlaboServerUrl, () => {
      if (connectionEstablished) {
        alert(
          "オンラインサーバーとの接続が切断されました。\nConnection to the online server has been lost.",
        );
        console.warn(
          "[ONLINE:Loader]",
          "Connection to the online server has been closed.",
        );
        backToMainMenu();
      } else {
        console.warn(
          "[ONLINE:Loader]",
          "Connection to the online server has been closed before it was fully established.",
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

    connectionEstablished = true;

    console.log(await connection.sendBinaryPing());
    console.log(await connection.sendJsonPing());
    console.log(await connection.getRooms());
  } catch (e) {
    console.error("[ONLINE:Loader]", "Failed to create GameConnection:", e);
    alert(
      "オンラインサーバーに接続できませんでした。\nFailed to connect to the online server.",
    );

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
    onlineBtn.onclick = goToOnlineMode;
  }
});
