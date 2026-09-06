/* ─────────────────────────────────────────────
   外部ページローダー
   index.html の肥大化を防ぐため、CREDITS / CHANGELOG など
   情報系ページの HTML を pages/*.html に分離し、
   必要なタイミングで fetch して #external-pages へ注入する。
───────────────────────────────────────────── */

// 外部 HTML 断片のマップ（?v= はキャッシュ対策）
const EXTERNAL_PAGES = {
  credits:   'pages/credits.html?v=2',
  changelog: 'pages/changelog.html?v=5',
  // PRACTICEモード関連ファイルは public/practice/ にまとめている（設計 Phase6 §9.1）。
  // このマップはパスに制約が無く、'pages/' 配下である必要はない。
  'practice-help': 'practice/help.html?v=4',
};

// 読み込み済みフラグ（多重 fetch 防止 / Promise を保持して重複読込を共有）
const _externalPageLoads = {};

// 注入先コンテナを取得（無ければ body 直下に作成）
function _getExternalPagesContainer() {
  let c = document.getElementById('external-pages');
  if (!c) {
    c = document.createElement('div');
    c.id = 'external-pages';
    document.body.appendChild(c);
  }
  return c;
}

// 指定ページの HTML を確実に読み込む（既読ならそのまま解決）
function ensureExternalPage(id) {
  if (!EXTERNAL_PAGES[id]) return Promise.resolve();
  if (_externalPageLoads[id]) return _externalPageLoads[id];

  _externalPageLoads[id] = fetch(EXTERNAL_PAGES[id])
    .then((res) => {
      if (!res.ok) throw new Error(`failed to load page: ${id} (${res.status})`);
      return res.text();
    })
    .then((html) => {
      // 既に注入済み（重複呼び出しの競合）なら何もしない
      if (!document.getElementById(id + '-page')) {
        const container = _getExternalPagesContainer();
        container.insertAdjacentHTML('beforeend', html);
        // 注入したページ内のバージョン表記を反映
        if (typeof window.applyAppVersion === 'function') {
          window.applyAppVersion(document.getElementById(id + '-page') || container);
        }
      }
    })
    .catch((err) => {
      console.error('[pages] ' + err.message);
      // 失敗時は再試行できるようフラグを解除
      delete _externalPageLoads[id];
    });

  return _externalPageLoads[id];
}

// 外部ページへ遷移（読み込み完了を待ってから switchPage）
async function openInfoPage(id) {
  await ensureExternalPage(id);
  if (typeof switchPage === 'function') switchPage(id);
  // 再閲覧時に前回のスクロール位置（＝下＝古い履歴）が残らないよう先頭へ戻す
  const page = document.getElementById(id + '-page');
  if (page) {
    page.querySelectorAll('.changelog-list, #changelog-container, .credits-list, .practice-help-list').forEach((el) => {
      el.scrollTop = 0;
    });
  }
}

// 起動時に先読みしておく（クリック時の待ち時間をなくす）
// ★ ただし DOMContentLoaded で即取りに行くと、起動時に本当に必要な素材
//   （ブロック画像・ぷよ画像・SE・BGM）と回線と帯域を奪い合う。
//   CREDITS / CHANGELOG はクリックされて初めて必要になり、openInfoPage() は
//   ensureExternalPage() の完了を await するため、間に合わなくても壊れない。
//   そこでアイドル時間に回す（対応していない環境では従来どおり読み込み後すぐ）。
window.addEventListener('DOMContentLoaded', () => {
  const prefetchAll = () => Object.keys(EXTERNAL_PAGES).forEach((id) => ensureExternalPage(id));
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(prefetchAll, { timeout: 5000 });
  } else {
    setTimeout(prefetchAll, 1500);
  }
});

// グローバル公開（onclick から参照するため）
window.ensureExternalPage = ensureExternalPage;
window.openInfoPage = openInfoPage;
