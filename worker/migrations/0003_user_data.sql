-- 端末間で共有する利用者ごとのデータ（設定・全モードの自己ベスト）。worker/sync.ts。
-- 区分（section）ごとに 1 行。中身はクライアントが決める JSON で、サーバーは形を見ない。
CREATE TABLE user_data (
  discord_id  TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  section     TEXT NOT NULL,             -- 'tuning' | 'display' | 'binds' | 'gamepad' | 'records'
  data        TEXT NOT NULL,             -- JSON
  rev         INTEGER NOT NULL,          -- 書き込むたびに +1。端末は最後に見た rev を覚えておく
  updated_at  INTEGER NOT NULL,          -- 端末で変更した時刻（epoch ms・サーバー時刻を上限に丸める）
  PRIMARY KEY (discord_id, section)
);
