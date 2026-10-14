// vite.config.ts の define で埋め込む値
/** ビルド/起動時の git ブランチ名（取れなければ空文字） */
declare const QUIZ_EDITOR_BRANCH: string;
/** ビルドした時刻（ISO）。dev サーバーでは起動した時刻 */
declare const QUIZ_EDITOR_BUILT_AT: string;
