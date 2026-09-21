-- TETLABO専用の表示名（Discordのglobal_name/usernameとは別に上書きできる）。
-- NULL = 未設定（global_name ?? username を使う）。設計 §3。
-- 重複は許可する（アイコンはDiscordのまま固定なので見分けは付く）。
ALTER TABLE users ADD COLUMN custom_name TEXT;
-- 変更頻度の簡易レート制限（1分に1回まで）に使う。NULL = 未変更。
ALTER TABLE users ADD COLUMN custom_name_changed_at INTEGER;
