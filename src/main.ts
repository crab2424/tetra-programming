declare const APP_VERSION: string;

// 対戦共通モジュール（window.BattleGarbage / window.BattleLayout を登録。
// プレーンJSエンジン(public/)からの参照はこの副作用importで成立する）
import "./battle/garbage_router";
import "./battle/layout";
import "./battle/lifecycle";
import "./battle/driver";
import "./battle/freeze";
import "./battle/finish_overlay";
import { showToast, ToastColor } from "./components/toast";

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
