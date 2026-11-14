// ─────────────────────────────────────────────
// sync.ts — 設定・自己ベストの端末間共有（クライアント: public/config/cloud_sync.js）
//
// GET /api/sync            … このアカウントの全区分を返す
// PUT /api/sync {sections} … 区分ごとに書き込む。食い違ったときの決め方は区分で違う:
//   設定（tuning/display/binds/gamepad）＝新しい方が勝つ。端末が最後に見た rev と今の rev が
//     違っていても、端末の変更時刻の方が新しければ受け付ける。
//   records ＝端末側で「モードごとに良い方」を合成する。rev が違えば必ず断り、今の中身を返して
//     端末に合成し直させる（時刻で片方を捨てると記録が消えるため）。
// ─────────────────────────────────────────────

import type { Env } from "./env";
import { pickDb } from "./env";
import { resolveSession } from "./auth";
import { checkOrigin, error, json } from "./http";

const SECTIONS = {
  tuning: { strict: false },
  display: { strict: false },
  binds: { strict: false },
  gamepad: { strict: false },
  records: { strict: true },
} as const;

type Section = keyof typeof SECTIONS;

const MAX_DATA_BYTES = 32 * 1024;

function isSection(name: string): name is Section {
  return Object.prototype.hasOwnProperty.call(SECTIONS, name);
}

interface Row {
  section: string;
  data: string;
  rev: number;
  updated_at: number;
}

function rowToJson(row: Row) {
  let data: unknown = null;
  try {
    data = JSON.parse(row.data);
  } catch {
    /* 壊れた行は null で返す（端末側は「無い」と同じに扱う） */
  }
  return { data, rev: row.rev, updatedAt: row.updated_at };
}

// ── GET /api/sync ───────────────────────────────────────────────────────
export async function handleSyncGet(req: Request, env: Env, url: URL): Promise<Response> {
  const resolved = await resolveSession(req, env, url);
  if (!resolved) return error("not_logged_in", 401);

  const { results } = await pickDb(req, env)
    .prepare("SELECT section, data, rev, updated_at FROM user_data WHERE discord_id = ?")
    .bind(resolved.user.discordId)
    .all<Row>();

  const sections: Record<string, unknown> = {};
  for (const row of results) {
    if (isSection(row.section)) sections[row.section] = rowToJson(row);
  }
  return json({ sections }, { headers: { "Cache-Control": "no-store" } });
}

interface PutEntry {
  data?: unknown;
  baseRev?: unknown;
  changedAt?: unknown;
}

// ── PUT /api/sync ───────────────────────────────────────────────────────
export async function handleSyncPut(req: Request, env: Env, url: URL): Promise<Response> {
  if (!checkOrigin(req)) return error("bad_origin", 403);

  const resolved = await resolveSession(req, env, url);
  if (!resolved) return error("not_logged_in", 401);

  let body: { sections?: Record<string, PutEntry> };
  try {
    body = (await req.json()) as { sections?: Record<string, PutEntry> };
  } catch {
    return error("invalid_body", 400);
  }
  const incoming = body.sections;
  if (!incoming || typeof incoming !== "object") return error("invalid_body", 400);

  const db = pickDb(req, env);
  const discordId = resolved.user.discordId;
  const now = Date.now();
  const out: Record<string, unknown> = {};

  for (const [name, entry] of Object.entries(incoming)) {
    if (!isSection(name) || !entry || typeof entry !== "object") return error("invalid_section", 400);
    const { data } = entry;
    if (!data || typeof data !== "object" || Array.isArray(data)) return error("invalid_data", 400);
    const text = JSON.stringify(data);
    if (new TextEncoder().encode(text).length > MAX_DATA_BYTES) return error("too_large", 413);

    const baseRev = Number.isInteger(entry.baseRev) ? (entry.baseRev as number) : 0;
    // 進んだ時計の端末がいつまでも勝ち続けないよう、サーバー時刻を上限にする
    const changedAt =
      typeof entry.changedAt === "number" && Number.isFinite(entry.changedAt)
        ? Math.min(Math.floor(entry.changedAt), now)
        : now;

    const current = await db
      .prepare("SELECT section, data, rev, updated_at FROM user_data WHERE discord_id = ? AND section = ?")
      .bind(discordId, name)
      .first<Row>();
    const currentRev = current ? current.rev : 0;

    if (current && currentRev !== baseRev) {
      const newer = !SECTIONS[name].strict && changedAt > current.updated_at;
      if (!newer) {
        out[name] = { accepted: false, ...rowToJson(current) };
        continue;
      }
    }

    // 読んでから書くまでの間に別の端末が書いていたら何も変えない（rev を条件にする）
    const result = current
      ? await db
          .prepare(
            "UPDATE user_data SET data = ?, rev = rev + 1, updated_at = ? WHERE discord_id = ? AND section = ? AND rev = ?",
          )
          .bind(text, changedAt, discordId, name, currentRev)
          .run()
      : await db
          .prepare(
            "INSERT INTO user_data (discord_id, section, data, rev, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING",
          )
          .bind(discordId, name, text, changedAt)
          .run();

    if (result.meta.changes === 1) {
      out[name] = { accepted: true, rev: currentRev + 1, updatedAt: changedAt };
    } else {
      const latest = await db
        .prepare("SELECT section, data, rev, updated_at FROM user_data WHERE discord_id = ? AND section = ?")
        .bind(discordId, name)
        .first<Row>();
      out[name] = latest ? { accepted: false, ...rowToJson(latest) } : { accepted: false, data: null, rev: 0, updatedAt: 0 };
    }
  }

  return json({ sections: out }, { headers: { "Cache-Control": "no-store" } });
}
