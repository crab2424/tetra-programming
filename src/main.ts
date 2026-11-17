declare const APP_VERSION: string;
declare const APP_BUILD: string;

// 録画・再生（public/core/replay.js）がリプレイに書く版（アプリの版とビルドのコミット）
(window as any).TETLABO_BUILD = { app: APP_VERSION, build: APP_BUILD };

// 対戦共通モジュール（window.BattleGarbage / window.BattleLayout を登録。
// プレーンJSエンジン(public/)からの参照はこの副作用importで成立する）
import "./battle/garbage_router";
import "./battle/layout";
import "./battle/lifecycle";
import "./battle/driver";
import "./battle/freeze";
import "./battle/finish_overlay";
import "./battle/local_loading";
import { showToast, ToastColor } from "./components/toast";

// プレーンJS（public/core/replay.js・public/app/replays.js）からの短いお知らせ（CLIP の保存・遊べない理由など）
(window as any).showGlobalToast = (message: string) => showToast("REPLAY", message, ToastColor.Info);
// 設定の端末間共有（public/config/cloud_sync.js）からのお知らせ
(window as any).showSyncToast = (message: string) => showToast("SYNC", message, ToastColor.Info);

document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const tetlaboServerUrl = urlParams.get("tetlaboServerUrl");
  if (tetlaboServerUrl) {
    console.log(`URL Parameter "tetlaboServerUrl" found: ${tetlaboServerUrl}`);
    localStorage.setItem("tetlaboServerUrl", tetlaboServerUrl);

    const backendUrlInput = document.getElementById(
      "settings-online-backend",
    ) as HTMLInputElement | null;
    if (backendUrlInput) backendUrlInput.value = tetlaboServerUrl;

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.delete("tetlaboServerUrl");
    history.replaceState(null, "", newUrl.toString());

    console.log(
      `LocalStorage updated with new tetlaboServerUrl: ${tetlaboServerUrl}`,
    );
    showToast(
      "設定完了",
      "オンラインサーバーのURLが変更されました。設定画面で確認できます。",
      ToastColor.Success,
    );
  }

  const versionElement = document.getElementById("title-version");
  if (versionElement) {
    versionElement.textContent = `v${APP_VERSION}`;
  }

  applyAppVersion(document);
});

/**
 * [data-app-version] 属性を持つ要素へバージョン文字列を流し込む。
 * config/pages.js が外部ページ(CREDITS等)注入直後にも呼ぶため window に公開する。
 */
function applyAppVersion(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-app-version]").forEach((el) => {
    el.textContent = `v${APP_VERSION}`;
  });
}
(window as any).applyAppVersion = applyAppVersion;
