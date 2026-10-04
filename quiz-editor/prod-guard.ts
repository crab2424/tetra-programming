// ─────────────────────────────────────────────
// prod-guard.ts
// 本番ホストでは起動しない（エディタはプレビュー限定。vite.config.ts で本番ビルドからは外しているが、念のため）。
// main.ts の最初に import する。ここで例外を投げると main.ts 以降のモジュールは実行されない。
// ─────────────────────────────────────────────
export const PROD_HOST = 'citgame.pptlabo.workers.dev';

if (location.hostname === PROD_HOST) {
    document.body.textContent = 'QUIZ EDITOR は本番では使えません。';
    throw new Error('quiz-editor: disabled on production host');
}
