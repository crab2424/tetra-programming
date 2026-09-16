import type { Env } from "./env";
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

async function handleApi(_req: Request, _env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/health") {
    return json({ ok: true });
  }

  return error("not_found", 404);
}
