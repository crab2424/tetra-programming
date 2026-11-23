// ─────────────────────────────────────────────
// prod-guard.ts
// 本番ホストでは起動しない（エディタはプレビュー限定。vite.config.ts で本番ビルドからは外しているが、念のため）。
// main.ts の最初に import する。ここで例外を投げると main.ts 以降のモジュールは実行されない。
// ─────────────────────────────────────────────
// 本番は独自ドメイン tetlabo.com。旧URL workers.dev は v2.6.1 でゲーム画面ごと外したが（worker/index.ts の handleLegacy）、念のため残す
export const PROD_HOSTS = ['tetlabo.com', 'citgame.pptlabo.workers.dev'];

if (PROD_HOSTS.includes(location.hostname)) {
    document.body.textContent = 'QUIZ EDITOR は本番では使えません。';
    throw new Error('quiz-editor: disabled on production host');
}
