/* ─────────────────────────────────────────────
   アプリのバージョン（単一の真実の源）
   現在バージョンの表記はここだけを編集すればよい。
   画面側は data-app-version 属性を付けた要素に自動反映される。
   （変更履歴ページは過去バージョンの一覧なので個別に記述する）
───────────────────────────────────────────── */

window.APP_VERSION = 'v1.1';

// data-app-version を持つ要素にバージョン文字列を流し込む
function applyAppVersion(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-app-version]').forEach((el) => {
    el.textContent = window.APP_VERSION;
  });
}

window.applyAppVersion = applyAppVersion;

// 初期表示（index.html 内の要素に反映）
document.addEventListener('DOMContentLoaded', () => applyAppVersion());
