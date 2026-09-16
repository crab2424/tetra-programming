import type { Env } from "./env";
import { handleCallback, handleDeleteMe, handleLogin, handleLogout, handleMe } from "./auth";
import { error, json } from "./http";

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

  return error("not_found", 404);
}
