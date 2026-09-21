PRAGMA foreign_keys = ON;

CREATE TABLE users (
  discord_id    TEXT PRIMARY KEY,          -- Discordのsnowflake（文字列で保持。JSのNumberでは桁落ちする）
  username      TEXT NOT NULL,             -- Discordの一意ユーザー名
  global_name   TEXT,                      -- 表示名（NULLならusernameを表示）
  avatar        TEXT,                      -- アバターのhash（NULL=デフォルトアイコン）
  created_at    INTEGER NOT NULL,          -- epoch ms
  last_login_at INTEGER NOT NULL,
  banned_at     INTEGER                    -- NULL=通常 / 値あり=BAN
);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,            -- SHA-256(セッショントークン)のhex。生トークンは保存しない
  discord_id  TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(discord_id);

-- 受理した提出の履歴（自己ベストを更新したものだけ保存する＝行数を抑える）
CREATE TABLE records (
  id             TEXT PRIMARY KEY,         -- サーバー発番uuid
  discord_id     TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  mode_key       TEXT NOT NULL,            -- 'ultra' | 'sprint:40'（records.jsのキーと同一）
  value          INTEGER NOT NULL,         -- 主指標の生値（ultra=score, sprint=timeMs）
  detail         TEXT NOT NULL,            -- JSON {score, lines, timeMs}
  source         TEXT NOT NULL,            -- 'play' | 'local_import'
  client_version TEXT,
  played_at      INTEGER NOT NULL,         -- クライアント申告（records.jsのat）。表示用のみ
  created_at     INTEGER NOT NULL,         -- サーバー受理時刻。同点の順位決定に使う（改ざん不可）
  deleted_at     INTEGER,
  deleted_by     TEXT
);
CREATE INDEX records_by_user_mode ON records(discord_id, mode_key, deleted_at);

-- ランキング用：ユーザー×モードの自己ベスト1行
CREATE TABLE best_records (
  mode_key    TEXT NOT NULL,
  discord_id  TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  rank_value  INTEGER NOT NULL,            -- 昇順で良い順になるよう正規化: ultra=-score / sprint=timeMs
  created_at  INTEGER NOT NULL,            -- 同点時は先に達成した方が上
  PRIMARY KEY (mode_key, discord_id)
);
CREATE INDEX best_records_rank ON best_records(mode_key, rank_value, created_at);
