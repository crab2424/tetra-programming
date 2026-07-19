declare const APP_VERSION: string;

// 対戦共通モジュール（window.BattleGarbage / window.BattleLayout を登録。
// プレーンJSエンジン(public/)からの参照はこの副作用importで成立する）
import "./battle/garbage_router";
import "./battle/layout";
import "./battle/lifecycle";
import "./battle/driver";

document.addEventListener("DOMContentLoaded", () => {
  const versionElement = document.getElementById("title-version");
  if (versionElement) {
    versionElement.textContent = `v${APP_VERSION}`;
  }
});
