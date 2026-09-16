import type { Env } from "./env";
import { pickDb } from "./env";
import { buildCookie, checkOrigin, error, isAllowedOrigin, json, readCookie } from "./http";

const OAUTH_COOKIE = "tl_oauth";
const SESSION_COOKIE = "tl_session";
const OAUTH_COOKIE_MAX_AGE_SEC = 600;
const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;
const SESSION_RENEW_THRESHOLD_MS = 7 * 24 * 3600 * 1000;

interface DiscordTokenResponse {
  access_token: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface SessionUser {
  discordId: string;
  name: string;
  avatarUrl: string;
  isAdmin: boolean;
}

interface ResolvedSession {
  user: SessionUser;
  renewCookie: string | null;
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function avatarUrl(discordId: string, avatar: string | null): string {
  if (avatar) return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=64`;
  const idx = Number((BigInt(discordId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function isAdmin(env: Env, discordId: string): boolean {
  return env.ADMIN_DISCORD_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(discordId);
}

function sessionCookie(token: string, url: URL, maxAge: number): string {
  return buildCookie(SESSION_COOKIE, token, { path: "/", maxAge, secure: url.protocol === "https:" });
}

function oauthCookie(value: string, url: URL, maxAge: number): string {
  return buildCookie(OAUTH_COOKIE, value, { path: "/auth", maxAge, secure: url.protocol === "https:" });
}

function redirect(location: string, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

// ── GET /auth/discord/login?return=menu|online ─────────────────────────
export async function handleLogin(_req: Request, env: Env, url: URL): Promise<Response> {
  if (!isAllowedOrigin(url.origin)) return error("bad_origin", 400);

  const returnTo = url.searchParams.get("return") === "online" ? "online" : "menu";
  const state = randomToken(32);

  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set("scope", "identify");
  authorizeUrl.searchParams.set("redirect_uri", `${url.origin}/auth/discord/callback`);
  authorizeUrl.searchParams.set("state", state);
  // prompt=noneは付けない: OAuth2仕様上「一切UIを出さない」の意味であり、
  // このアプリを初めて許可する場面(初回同意)ではUIを出せないためDiscordが
  // codeの代わりにerror=consent_required等を返して即座にリダイレクトしてしまい、
  // 認可画面が一瞬で消えてログイン失敗になる(2回目以降の同意省略はDiscordが自動で行う)。

  const headers = new Headers();
  headers.append("Set-Cookie", oauthCookie(`${state}.${returnTo}`, url, OAUTH_COOKIE_MAX_AGE_SEC));
  return redirect(authorizeUrl.toString(), headers);
}

// ── GET /auth/discord/callback?code=..&state=.. ────────────────────────
export async function handleCallback(req: Request, env: Env, url: URL): Promise<Response> {
  const clearOauth = oauthCookie("", url, 0);
  // reason はデバッグ用の非機微な短い識別子のみ（トークン等は絶対に含めない）。
  // wrangler tail がプレビューURL宛のトラフィックを拾えていない問題の暫定対応として、
  // URLに直接理由を載せてブラウザ側だけで原因を特定できるようにしている。
  const failure = (reason: "error" | "banned", debug?: string) =>
    redirect(`/?login=${reason}${debug ? `&reason=${encodeURIComponent(debug)}` : ""}`, { "Set-Cookie": clearOauth });

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const cookieValue = readCookie(req, OAUTH_COOKIE);
  if (!code || !stateParam || !cookieValue) {
    const discordError = url.searchParams.get("error");
    console.error("callback missing code/state/cookie", {
      hasCode: !!code,
      hasState: !!stateParam,
      hasCookie: !!cookieValue,
      discordError,
      discordErrorDescription: url.searchParams.get("error_description"),
    });
    return failure("error", discordError ? `discord:${discordError}` : "missing_params");
  }

  const dot = cookieValue.indexOf(".");
  if (dot === -1) return failure("error", "bad_oauth_cookie");
  const cookieState = cookieValue.slice(0, dot);
  const returnTo = cookieValue.slice(dot + 1) === "online" ? "online" : "menu";
  if (cookieState !== stateParam) {
    console.error("callback state mismatch");
    return failure("error", "state_mismatch");
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/auth/discord/callback`,
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error("discord token exchange failed", tokenRes.status, body);
    return failure("error", `token_exchange_${tokenRes.status}`);
  }
  const token = (await tokenRes.json()) as DiscordTokenResponse;

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) {
    console.error("discord /users/@me failed", meRes.status, await meRes.text());
    return failure("error", `me_fetch_${meRes.status}`);
  }
  const me = (await meRes.json()) as DiscordUser;

  const db = pickDb(req, env);
  const now = Date.now();
  let banned = false;
  let sessionToken: string;
  try {
    await db
      .prepare(
        `INSERT INTO users (discord_id, username, global_name, avatar, created_at, last_login_at, banned_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(discord_id) DO UPDATE SET
           username = excluded.username,
           global_name = excluded.global_name,
           avatar = excluded.avatar,
           last_login_at = excluded.last_login_at`,
      )
      .bind(me.id, me.username, me.global_name ?? null, me.avatar ?? null, now, now)
      .run();

    const userRow = await db
      .prepare("SELECT banned_at FROM users WHERE discord_id = ?")
      .bind(me.id)
      .first<{ banned_at: number | null }>();
    banned = !!userRow?.banned_at;

    sessionToken = randomToken(32);
    if (!banned) {
      const idHash = await sha256Hex(sessionToken);
      const expiresAt = now + SESSION_MAX_AGE_SEC * 1000;
      await db
        .prepare("INSERT INTO sessions (id_hash, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(idHash, me.id, now, expiresAt)
        .run();
    }
  } catch (e) {
    console.error("callback D1 write failed", e);
    return failure("error", "db_write");
  }
  if (banned) return failure("banned");

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(sessionToken, url, SESSION_MAX_AGE_SEC));
  headers.append("Set-Cookie", clearOauth);
  return redirect(`/?login=ok&return=${returnTo}`, headers);
}

// ── POST /auth/logout ───────────────────────────────────────────────────
export async function handleLogout(req: Request, env: Env, url: URL): Promise<Response> {
  if (!checkOrigin(req)) return error("bad_origin", 403);

  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const db = pickDb(req, env);
    const idHash = await sha256Hex(token);
    await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
  }

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie("", url, 0));
  return new Response(null, { status: 204, headers });
}

// ── セッション解決（/api/* の共通処理） ────────────────────────────────
export async function resolveSession(req: Request, env: Env, url: URL): Promise<ResolvedSession | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const db = pickDb(req, env);
  const idHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT u.discord_id, u.username, u.global_name, u.avatar, u.banned_at, s.expires_at
       FROM sessions s JOIN users u ON u.discord_id = s.discord_id
       WHERE s.id_hash = ?`,
    )
    .bind(idHash)
    .first<{
      discord_id: string;
      username: string;
      global_name: string | null;
      avatar: string | null;
      banned_at: number | null;
      expires_at: number;
    }>();
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now || row.banned_at) return null;

  let renewCookie: string | null = null;
  if (row.expires_at - now < SESSION_RENEW_THRESHOLD_MS) {
    const newExpiresAt = now + SESSION_MAX_AGE_SEC * 1000;
    await db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(newExpiresAt, idHash).run();
    renewCookie = sessionCookie(token, url, SESSION_MAX_AGE_SEC);
  }

  return {
    user: {
      discordId: row.discord_id,
      name: row.global_name ?? row.username,
      avatarUrl: avatarUrl(row.discord_id, row.avatar),
      isAdmin: isAdmin(env, row.discord_id),
    },
    renewCookie,
  };
}

// ── GET /api/me ──────────────────────────────────────────────────────────
export async function handleMe(req: Request, env: Env, url: URL): Promise<Response> {
  const resolved = await resolveSession(req, env, url);
  if (!resolved) return json({ loggedIn: false });

  const headers = new Headers();
  if (resolved.renewCookie) headers.append("Set-Cookie", resolved.renewCookie);
  return json(
    {
      loggedIn: true,
      user: { id: resolved.user.discordId, name: resolved.user.name, avatarUrl: resolved.user.avatarUrl },
      isAdmin: resolved.user.isAdmin,
    },
    { headers },
  );
}

// ── DELETE /api/me（退会） ─────────────────────────────────────────────
export async function handleDeleteMe(req: Request, env: Env, url: URL): Promise<Response> {
  if (!checkOrigin(req)) return error("bad_origin", 403);

  const resolved = await resolveSession(req, env, url);
  if (!resolved) return error("not_logged_in", 401);

  const db = pickDb(req, env);
  await db.prepare("DELETE FROM users WHERE discord_id = ?").bind(resolved.user.discordId).run();

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie("", url, 0));
  return new Response(null, { status: 204, headers });
}
