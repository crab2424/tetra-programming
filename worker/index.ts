import type { Env } from "./env";
import { handleAdminBanUser, handleAdminDeleteRecord, handleAdminListRecords } from "./admin";
import { handleCallback, handleDeleteMe, handleLogin, handleLogout, handleMe, handleUpdateName } from "./auth";
import { error, json } from "./http";
import { handleRanking, handleRankingMe, handleSubmitRecord } from "./records";
import { handleOnlineTicket } from "./ticket";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return handleApi(req, env, url);
    }

    return env.ASSETS.fetch(req);
  },
};

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
