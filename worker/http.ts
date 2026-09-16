export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
  });
}

export function error(code: string, status: number, message?: string): Response {
  return json({ error: code, message }, { status });
}

export interface CookieOptions {
  path?: string;
  maxAge?: number; // seconds. 0 = 削除
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export function buildCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  parts.push(`Max-Age=${opts.maxAge ?? 0}`);
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// 本番ホスト・プレビューホスト(<branch>-citgame.pptlabo.workers.dev)・ローカル開発(vite)のみ許可
const ALLOWED_ORIGIN_RE = /^https:\/\/(?:[a-z0-9-]+-)?citgame\.pptlabo\.workers\.dev$|^http:\/\/localhost:5173$/;

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN_RE.test(origin);
}

/** 状態を変えるリクエスト(POST/DELETE)のCSRF対策: OriginがこのWorker自身の許可リストと一致するか */
export function checkOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && isAllowedOrigin(origin);
}
