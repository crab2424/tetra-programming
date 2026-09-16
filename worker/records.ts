import type { Env } from "./env";
import { pickDb } from "./env";
import { checkOrigin, error, json } from "./http";
import { resolveSession } from "./auth";

const SUBMIT_MIN_INTERVAL_MS = 3000;

export const RANKED_MODES = {
  ultra: { primary: "score", better: "higher", min: 0, max: 99_999_999 },
  "sprint:40": { primary: "timeMs", better: "lower", min: 1_000, max: 3_600_000 },
} as const;

type ModeKey = keyof typeof RANKED_MODES;

function isRankedMode(key: string): key is ModeKey {
  return Object.prototype.hasOwnProperty.call(RANKED_MODES, key);
}

function rankValueOf(modeKey: ModeKey, value: number): number {
  return RANKED_MODES[modeKey].better === "higher" ? -value : value;
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

  const lastRow = await db
    .prepare("SELECT created_at FROM records WHERE discord_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(discordId)
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
