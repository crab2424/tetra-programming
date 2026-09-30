import type { Env } from "./env";
import { pickDb } from "./env";
import { checkOrigin, error, json } from "./http";
import { avatarUrl, resolveName, resolveSession } from "./auth";

const SUBMIT_MIN_INTERVAL_MS = 3000;
const RANKING_LIMIT = 100;
const RANKING_CACHE_MAX_AGE_SEC = 30;

// キーは public/config/records.js の RANKED_KEYS と一致させる
export const RANKED_MODES = {
  "marathon:endless": { primary: "score", better: "higher", min: 0, max: 999_999_999 },
  "sprint:40": { primary: "timeMs", better: "lower", min: 1_000, max: 3_600_000 },
  ultra: { primary: "score", better: "higher", min: 0, max: 99_999_999 },
  puyo: { primary: "score", better: "higher", min: 0, max: 999_999_999 },
} as const;

export type ModeKey = keyof typeof RANKED_MODES;

export function isRankedMode(key: string): key is ModeKey {
  return Object.prototype.hasOwnProperty.call(RANKED_MODES, key);
}

export function rankValueOf(modeKey: ModeKey, value: number): number {
  return RANKED_MODES[modeKey].better === "higher" ? -value : value;
}

// mode毎に固定のURLをキャッシュキーにする(ホストが異なれば別キー=本番/プレビューが混ざらない)
export function rankingCacheKey(url: URL, modeKey: ModeKey): Request {
  return new Request(new URL(`/api/ranking?mode=${encodeURIComponent(modeKey)}`, url.origin).toString());
}

interface SubmitBody {
  modeKey?: string;
  record?: Record<string, unknown>;
  source?: string;
  playedAt?: string;
  clientVersion?: string;
}

// ── POST /api/records ───────────────────────────────────────────────────
export async function handleSubmitRecord(req: Request, env: Env, url: URL): Promise<Response> {
  if (!checkOrigin(req)) return error("bad_origin", 403);

  const resolved = await resolveSession(req, env, url);
  if (!resolved) return error("not_logged_in", 401);

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return error("invalid_body", 400);
  }

  const modeKey = body.modeKey;
  if (typeof modeKey !== "string" || !isRankedMode(modeKey)) return error("unranked_mode", 400);

  const source = body.source === "local_import" ? "local_import" : "play";
  const record = body.record;
  if (!record || typeof record !== "object") return error("invalid_record", 400);

  const mode = RANKED_MODES[modeKey];
  const value = record[mode.primary];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return error("invalid_record", 400);
  }
  if (value < mode.min || value > mode.max) return error("invalid_record", 400);

  const playedAtMs = body.playedAt ? Date.parse(body.playedAt) : NaN;
  const playedAt = Number.isFinite(playedAtMs) ? playedAtMs : Date.now();
  const clientVersion = typeof body.clientVersion === "string" ? body.clientVersion.slice(0, 32) : null;

  const db = pickDb(req, env);
  const discordId = resolved.user.discordId;
  const now = Date.now();

  // 連続提出の抑止はモード単位（ユーザー単位だと syncLocalBests が複数モードを続けて送ったとき2件目以降が429になる）
  const lastRow = await db
    .prepare("SELECT created_at FROM records WHERE discord_id = ? AND mode_key = ? ORDER BY created_at DESC LIMIT 1")
    .bind(discordId, modeKey)
    .first<{ created_at: number }>();
  if (lastRow && now - lastRow.created_at < SUBMIT_MIN_INTERVAL_MS) {
    return error("too_many_requests", 429);
  }

  const bestRow = await db
    .prepare(
      `SELECT b.rank_value, b.created_at, r.value
       FROM best_records b JOIN records r ON r.id = b.record_id
       WHERE b.mode_key = ? AND b.discord_id = ?`,
    )
    .bind(modeKey, discordId)
    .first<{ rank_value: number; created_at: number; value: number }>();

  const newRankValue = rankValueOf(modeKey, value);
  const improved = !bestRow || newRankValue < bestRow.rank_value;
  const prevValue = bestRow ? bestRow.value : null;

  let finalRankValue = bestRow ? bestRow.rank_value : newRankValue;
  let finalCreatedAt = bestRow ? bestRow.created_at : now;

  if (improved) {
    const recordId = crypto.randomUUID();
    let detail: string;
    try {
      detail = JSON.stringify(record);
    } catch {
      return error("invalid_record", 400);
    }

    await db.batch([
      db
        .prepare(
          `INSERT INTO records (id, discord_id, mode_key, value, detail, source, client_version, played_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(recordId, discordId, modeKey, value, detail, source, clientVersion, playedAt, now),
      db
        .prepare(
          `INSERT INTO best_records (mode_key, discord_id, record_id, rank_value, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(mode_key, discord_id) DO UPDATE SET
             record_id = excluded.record_id,
             rank_value = excluded.rank_value,
             created_at = excluded.created_at`,
        )
        .bind(modeKey, discordId, recordId, newRankValue, now),
    ]);

    finalRankValue = newRankValue;
    finalCreatedAt = now;

    // 自己ベストが変わったのでランキングのエッジキャッシュを破棄する
    await caches.default.delete(rankingCacheKey(url, modeKey));
  }

  const rankRow = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM best_records
       WHERE mode_key = ? AND (rank_value < ? OR (rank_value = ? AND created_at < ?))`,
    )
    .bind(modeKey, finalRankValue, finalRankValue, finalCreatedAt)
    .first<{ rank: number }>();

  return json({
    accepted: true,
    improved,
    value: improved ? value : prevValue,
    rank: rankRow ? rankRow.rank : null,
    prevValue,
  });
}

interface RankingRow {
  record_id: string;
  rank_value: number;
  created_at: number;
  value: number;
  detail: string;
  played_at: number;
  discord_id: string;
  username: string;
  global_name: string | null;
  custom_name: string | null;
  avatar: string | null;
}

export function parseDetail(detail: string): unknown {
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

// ── GET /api/ranking?mode=ultra ─────────────────────────────────────────
// 未ログインでも見られる。上位100位のみ・30秒エッジキャッシュ(Cache API)。
export async function handleRanking(req: Request, env: Env, url: URL): Promise<Response> {
  const modeKey = url.searchParams.get("mode");
  if (typeof modeKey !== "string" || !isRankedMode(modeKey)) return error("unranked_mode", 400);

  const cache = caches.default;
  const cacheKey = rankingCacheKey(url, modeKey);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const db = pickDb(req, env);
  const rows = await db
    .prepare(
      `SELECT r.id AS record_id, b.rank_value, b.created_at, r.value, r.detail, r.played_at,
              u.discord_id, u.username, u.global_name, u.custom_name, u.avatar
       FROM best_records b
       JOIN records r ON r.id = b.record_id
       JOIN users u   ON u.discord_id = b.discord_id
       WHERE b.mode_key = ?
       ORDER BY b.rank_value ASC, b.created_at ASC
       LIMIT ?`,
    )
    .bind(modeKey, RANKING_LIMIT)
    .all<RankingRow>();

  // 同点は同順位(競技ランキング方式): rank_valueが直前行と同じなら同じ順位を使う
  let lastRankValue: number | null = null;
  let lastRank = 0;
  const entries = rows.results.map((row, idx) => {
    if (lastRankValue === null || row.rank_value !== lastRankValue) {
      lastRank = idx + 1;
      lastRankValue = row.rank_value;
    }
    return {
      rank: lastRank,
      recordId: row.record_id,
      user: {
        id: row.discord_id,
        name: resolveName(row.custom_name, row.global_name, row.username),
        avatarUrl: avatarUrl(row.discord_id, row.avatar),
      },
      value: row.value,
      detail: parseDetail(row.detail),
      playedAt: row.played_at,
    };
  });

  const response = json({ mode: modeKey, updatedAt: Date.now(), entries });
  const toCache = response.clone();
  toCache.headers.set("Cache-Control", `public, max-age=${RANKING_CACHE_MAX_AGE_SEC}`);
  await cache.put(cacheKey, toCache);
  return response;
}

// ── GET /api/ranking/me?mode=ultra ──────────────────────────────────────
// 要ログイン。自分の順位と自己ベストのみ返す。キャッシュしない。
export async function handleRankingMe(req: Request, env: Env, url: URL): Promise<Response> {
  const modeKey = url.searchParams.get("mode");
  if (typeof modeKey !== "string" || !isRankedMode(modeKey)) return error("unranked_mode", 400);

  const resolved = await resolveSession(req, env, url);
  if (!resolved) return error("not_logged_in", 401);

  const db = pickDb(req, env);
  const discordId = resolved.user.discordId;

  const bestRow = await db
    .prepare(
      `SELECT r.id AS record_id, b.rank_value, b.created_at, r.value, r.detail, r.played_at
       FROM best_records b JOIN records r ON r.id = b.record_id
       WHERE b.mode_key = ? AND b.discord_id = ?`,
    )
    .bind(modeKey, discordId)
    .first<{
      record_id: string;
      rank_value: number;
      created_at: number;
      value: number;
      detail: string;
      played_at: number;
    }>();

  const headers = new Headers({ "Cache-Control": "no-store" });
  if (resolved.renewCookie) headers.append("Set-Cookie", resolved.renewCookie);

  if (!bestRow) return json({ hasRecord: false }, { headers });

  const rankRow = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM best_records
       WHERE mode_key = ? AND (rank_value < ? OR (rank_value = ? AND created_at < ?))`,
    )
    .bind(modeKey, bestRow.rank_value, bestRow.rank_value, bestRow.created_at)
    .first<{ rank: number }>();

  return json(
    {
      hasRecord: true,
      rank: rankRow ? rankRow.rank : null,
      recordId: bestRow.record_id,
      value: bestRow.value,
      detail: parseDetail(bestRow.detail),
      playedAt: bestRow.played_at,
    },
    { headers },
  );
}
