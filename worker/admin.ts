import type { Env } from "./env";
import { pickDb } from "./env";
import { checkOrigin, error, json } from "./http";
import { resolveName, resolveSession, type SessionUser } from "./auth";
import { RANKED_MODES, isRankedMode, parseDetail, rankValueOf, rankingCacheKey, type ModeKey } from "./records";

// セッション解決＋管理者判定。管理者でなければ呼び出し側にそのままreturnさせるためResponseを返す。
async function resolveAdmin(req: Request, env: Env, url: URL): Promise<SessionUser | Response> {
  const resolved = await resolveSession(req, env, url);
  if (!resolved) return error("not_logged_in", 401);
  if (!resolved.user.isAdmin) return error("forbidden", 403);
  return resolved.user;
}

// そのユーザー・モードの非削除記録から自己ベストを再計算してbest_recordsへ反映する
// （記録の論理削除・BAN解除の両方で使う）。該当記録が無ければbest_recordsの行を消す。
async function recomputeBestRecord(db: D1Database, discordId: string, modeKey: ModeKey): Promise<void> {
  const order = RANKED_MODES[modeKey].better === "higher" ? "DESC" : "ASC";
  const best = await db
    .prepare(
      `SELECT id, value, created_at FROM records
       WHERE discord_id = ? AND mode_key = ? AND deleted_at IS NULL
       ORDER BY value ${order}, created_at ASC
       LIMIT 1`,
    )
    .bind(discordId, modeKey)
    .first<{ id: string; value: number; created_at: number }>();

  if (!best) {
    await db.prepare(`DELETE FROM best_records WHERE mode_key = ? AND discord_id = ?`).bind(modeKey, discordId).run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO best_records (mode_key, discord_id, record_id, rank_value, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(mode_key, discord_id) DO UPDATE SET
         record_id = excluded.record_id,
         rank_value = excluded.rank_value,
         created_at = excluded.created_at`,
    )
    .bind(modeKey, discordId, best.id, rankValueOf(modeKey, best.value), best.created_at)
    .run();
}

interface AdminRecordRow {
  id: string;
  discord_id: string;
  mode_key: string;
  value: number;
  detail: string;
  source: string;
  client_version: string | null;
  played_at: number;
  created_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
  username: string;
  global_name: string | null;
  custom_name: string | null;
}

// ── GET /api/admin/records?mode=&user= ──────────────────────────────────
export async function handleAdminListRecords(req: Request, env: Env, url: URL): Promise<Response> {
  const admin = await resolveAdmin(req, env, url);
  if (admin instanceof Response) return admin;

  const modeParam = url.searchParams.get("mode");
  if (modeParam && !isRankedMode(modeParam)) return error("unranked_mode", 400);
  const userParam = url.searchParams.get("user");

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (modeParam) {
    conditions.push("r.mode_key = ?");
    binds.push(modeParam);
  }
  if (userParam) {
    conditions.push("(r.discord_id = ? OR u.username LIKE ? OR u.global_name LIKE ? OR u.custom_name LIKE ?)");
    binds.push(userParam, `%${userParam}%`, `%${userParam}%`, `%${userParam}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const db = pickDb(req, env);
  const rows = await db
    .prepare(
      `SELECT r.id, r.discord_id, r.mode_key, r.value, r.detail, r.source, r.client_version,
              r.played_at, r.created_at, r.deleted_at, r.deleted_by, u.username, u.global_name, u.custom_name
       FROM records r JOIN users u ON u.discord_id = r.discord_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT 200`,
    )
    .bind(...binds)
    .all<AdminRecordRow>();

  const records = rows.results.map((row) => ({
    id: row.id,
    modeKey: row.mode_key,
    value: row.value,
    detail: parseDetail(row.detail),
    source: row.source,
    clientVersion: row.client_version,
    playedAt: row.played_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    user: { id: row.discord_id, name: resolveName(row.custom_name, row.global_name, row.username) },
  }));

  return json({ records });
}

// ── DELETE /api/admin/records/:id ───────────────────────────────────────
export async function handleAdminDeleteRecord(req: Request, env: Env, url: URL, recordId: string): Promise<Response> {
  if (!checkOrigin(req)) return error("bad_origin", 403);
  const admin = await resolveAdmin(req, env, url);
  if (admin instanceof Response) return admin;

  const db = pickDb(req, env);
  const row = await db
    .prepare(`SELECT discord_id, mode_key, deleted_at FROM records WHERE id = ?`)
    .bind(recordId)
    .first<{ discord_id: string; mode_key: string; deleted_at: number | null }>();
  if (!row) return error("not_found", 404);
  if (row.deleted_at) return json({ deleted: true }); // 既に削除済み(冪等)

  await db
    .prepare(`UPDATE records SET deleted_at = ?, deleted_by = ? WHERE id = ?`)
    .bind(Date.now(), admin.discordId, recordId)
    .run();

  if (isRankedMode(row.mode_key)) {
    await recomputeBestRecord(db, row.discord_id, row.mode_key);
    await caches.default.delete(rankingCacheKey(url, row.mode_key));
  }

  return json({ deleted: true });
}

interface BanBody {
  banned?: boolean;
}

// ── POST /api/admin/users/:id/ban ───────────────────────────────────────
export async function handleAdminBanUser(req: Request, env: Env, url: URL, targetDiscordId: string): Promise<Response> {
  if (!checkOrigin(req)) return error("bad_origin", 403);
  const admin = await resolveAdmin(req, env, url);
  if (admin instanceof Response) return admin;

  let body: BanBody;
  try {
    body = (await req.json()) as BanBody;
  } catch {
    return error("invalid_body", 400);
  }
  const banned = body.banned === true;

  const db = pickDb(req, env);
  const userRow = await db.prepare(`SELECT discord_id FROM users WHERE discord_id = ?`).bind(targetDiscordId).first();
  if (!userRow) return error("not_found", 404);

  const modeKeys = Object.keys(RANKED_MODES) as ModeKey[];

  if (banned) {
    // BAN: ログイン・提出を拒否(セッション全削除)し、ランキングから除外(記録自体は監査用に残す)
    await db.batch([
      db.prepare(`UPDATE users SET banned_at = ? WHERE discord_id = ?`).bind(Date.now(), targetDiscordId),
      db.prepare(`DELETE FROM sessions WHERE discord_id = ?`).bind(targetDiscordId),
      db.prepare(`DELETE FROM best_records WHERE discord_id = ?`).bind(targetDiscordId),
    ]);
  } else {
    // BAN解除: 非削除記録から自己ベストを再計算してランキングに復帰させる
    await db.prepare(`UPDATE users SET banned_at = NULL WHERE discord_id = ?`).bind(targetDiscordId).run();
    for (const modeKey of modeKeys) {
      await recomputeBestRecord(db, targetDiscordId, modeKey);
    }
  }

  for (const modeKey of modeKeys) {
    await caches.default.delete(rankingCacheKey(url, modeKey));
  }

  return json({ banned });
}
