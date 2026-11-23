import { isLegacyHost, type Env } from "./env";
import { handleAdminBanUser, handleAdminDeleteRecord, handleAdminListRecords } from "./admin";
import { handleCallback, handleDeleteMe, handleLogin, handleLogout, handleMe, handleUpdateName } from "./auth";
import { error, json } from "./http";
import { handleRanking, handleRankingMe, handleSubmitRecord } from "./records";
import { handleSyncGet, handleSyncPut } from "./sync";
import { handleOnlineTicket } from "./ticket";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 旧URL（workers.dev）: ゲーム画面と /api・/auth は外し、入口（/ と /index.html）ではお知らせを出す。
    // ここに来るのは wrangler.jsonc の run_worker_first に書いたパスだけ（他の静的ファイルは Worker を通らない）。
    if (isLegacyHost(url.hostname, env)) return handleLegacy(env, url);

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return handleApi(req, env, url);
    }

    return env.ASSETS.fetch(req);
  },
};

// お知らせ画面（public/legacy.html）。旧URLの手元のデータを tetlabo.com へ渡す入口も兼ねる
async function handleLegacy(env: Env, url: URL): Promise<Response> {
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    return error("moved", 410, "This address has moved to https://tetlabo.com");
  }
  const res = await env.ASSETS.fetch(new Request(new URL("/legacy", url), { method: "GET" }));
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/api/health") return json({ ok: true });

  if (pathname === "/auth/discord/login" && method === "GET") return handleLogin(req, env, url);
  if (pathname === "/auth/discord/callback" && method === "GET") return handleCallback(req, env, url);
  if (pathname === "/auth/logout" && method === "POST") return handleLogout(req, env, url);

  if (pathname === "/api/me" && method === "GET") return handleMe(req, env, url);
  if (pathname === "/api/me" && method === "DELETE") return handleDeleteMe(req, env, url);
  if (pathname === "/api/me/name" && method === "PUT") return handleUpdateName(req, env, url);

  if (pathname === "/api/records" && method === "POST") return handleSubmitRecord(req, env, url);

  if (pathname === "/api/sync" && method === "GET") return handleSyncGet(req, env, url);
  if (pathname === "/api/sync" && method === "PUT") return handleSyncPut(req, env, url);

  if (pathname === "/api/online-ticket" && method === "POST") return handleOnlineTicket(req, env, url);

  if (pathname === "/api/ranking" && method === "GET") return handleRanking(req, env, url);
  if (pathname === "/api/ranking/me" && method === "GET") return handleRankingMe(req, env, url);

  if (pathname === "/api/admin/records" && method === "GET") return handleAdminListRecords(req, env, url);

  const deleteRecordMatch = method === "DELETE" ? pathname.match(/^\/api\/admin\/records\/([^/]+)$/) : null;
  if (deleteRecordMatch) return handleAdminDeleteRecord(req, env, url, decodeURIComponent(deleteRecordMatch[1]));

  const banMatch = method === "POST" ? pathname.match(/^\/api\/admin\/users\/([^/]+)\/ban$/) : null;
  if (banMatch) return handleAdminBanUser(req, env, url, decodeURIComponent(banMatch[1]));

  return error("not_found", 404);
}
