// @ts-check

import { GameConnection } from "./connection.js";

/**
 * hex文字列からUint8Array形式のハッシュ値を取得する関数
 * @param {string} hexString 16進数形式のハッシュ値を表す文字列（"[1, 21, 41, 52]"）
 * @returns {number[]} ハッシュ値を表す数値の配列
 */
const getHashFromHexString = (hexString: string): number[] => {
  return hexString
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replaceAll(" ", "")
    .split(",")
    .map((s) => parseInt(s.trim()));
};

const goToOnlineMode = async () => {
  const wtSupported = typeof WebTransport !== "undefined";
  if (!wtSupported) {
    console.error(
      "[ONLINE:Loader]",
      "WebTransport is not supported in this browser.",
    );
    alert(
      "このブラウザはWebTransportに対応していないため、オンラインモードをプレイできません。\nYou cannot play online mode because your browser does not support WebTransport.",
    );
    return;
  }

  const tetlaboServerUrl =
    localStorage.getItem("tetlaboServerUrl") || "https://example.com/online";
  const tetlaboServerHash = localStorage.getItem("tetlaboServerHash");

  const pages = document.querySelectorAll(".page");
  pages.forEach((p) => p.classList.remove("active"));

  const onlinePage = document.getElementById("online-top-page");
  if (onlinePage) onlinePage.classList.add("active");

  /** @type {GameConnection} */
  let connection;

  try {
    connection = new GameConnection(
      tetlaboServerUrl,
      tetlaboServerHash
        ? {
            serverCertificateHashes: [
              {
                algorithm: "sha-256",
                value: new Uint8Array(getHashFromHexString(tetlaboServerHash)),
              },
            ],
          }
        : undefined,
    );
    await connection.ready();

    console.log(
      "[ONLINE:Loader]",
      "Successfully connected to the online server.",
    );
  } catch (e) {
    console.error("[ONLINE:Loader]", "Failed to create GameConnection:", e);
    alert(
      "オンラインサーバーに接続できませんでした。\nFailed to connect to the online server.",
    );

    /// TODO: onlineの部分だけmodule化しているため，その他のファイルの関数を直で呼び出せない．
    /// 将来的にはすべてのファイルをモジュール化して、必要な関数をインポートして呼び出せるようにするべき．
    if ("switchPage" in window && typeof window.switchPage === "function") {
      window.switchPage("main-menu");
    } else {
      // フォールバック処理
      location.reload();
    }
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const wtSupported = typeof WebTransport !== "undefined";
  const tetlaboServerUrl = localStorage.getItem("tetlaboServerUrl");
  const tetlaboServerHash = localStorage.getItem("tetlaboServerHash");

  console.log("[ONLINE:Loader]", "WebTransport supported:", wtSupported);
  console.log("[ONLINE:Loader]", "WebTransport server URL:", tetlaboServerUrl);
  console.log(
    "[ONLINE:Loader]",
    "WebTransport server hash:",
    tetlaboServerHash ? getHashFromHexString(tetlaboServerHash) : null,
  );

  const onlineBtn =
    /** @type {HTMLButtonElement | null} */ document.getElementById(
      "online-mode-button",
    );
  if (onlineBtn) {
    onlineBtn.onclick = goToOnlineMode;
  }
});
