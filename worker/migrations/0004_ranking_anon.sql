-- ランキングの匿名表示（アカウント画面の RANKING NAME）。
-- ranking_anon = 1 のとき、GET /api/ranking では名前を "PLAYER-<anon_tag>"、アイコンなし、Discord の ID なしで返す。
-- anon_tag は最初に匿名にしたときに作る 4 桁の 16 進（以後ずっと同じ。OFF に戻しても消さない）。重複は許す。
ALTER TABLE users ADD COLUMN ranking_anon INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN anon_tag TEXT;
