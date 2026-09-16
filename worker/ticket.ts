import type { Env } from "./env";
import { checkOrigin, error, json } from "./http";
import { resolveSession } from "./auth";

// 有効期限(秒)。tetra-server側の許容誤差(±30秒)より十分長く、かつ流出時の被害を
// 小さくするため短く保つ（設計 v2.2.2 §7.1）。
const TICKET_TTL_SEC = 120;
// ホスト名として妥当な文字だけを許可する(なりすまし対策。任意ホスト自体は許可してよい
// ＝悪意あるサーバーへ送っても、そのチケットは公式サーバーのaud検査で弾かれる)。
const AUD_RE = /^[a-zA-Z0-9.-]{1,255}(?::\d{1,5})?$/;

interface TicketBody {
  aud?: string;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function randomJti(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── POST /api/online-ticket {aud} ───────────────────────────────────────
// tetra-server(WebRTC signaling)へ渡す短寿命チケットを発行する(設計 v2.2.2 §7.1)。
export async function handleOnlineTicket(req: Request, env: Env, url: URL): Promise<Response> {
  if (!checkOrigin(req)) return error("bad_origin", 403);

  const resolved = await resolveSession(req, env, url);
  if (!resolved) return error("not_logged_in", 401);

  let body: TicketBody;
  try {
    body = (await req.json()) as TicketBody;
  } catch {
    return error("invalid_body", 400);
  }
  const aud = typeof body.aud === "string" ? body.aud.trim() : "";
  if (!AUD_RE.test(aud)) return error("invalid_audience", 400);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sub: resolved.user.discordId,
    name: resolved.user.name,
    avatarUrl: resolved.user.avatarUrl,
    aud,
    iat: now,
    exp: now + TICKET_TTL_SEC,
    jti: randomJti(),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

  let ticket: string;
  try {
    const keyData = base64ToBytes(env.TICKET_PRIVATE_KEY);
    const key = await crypto.subtle.importKey("pkcs8", keyData, { name: "Ed25519" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("Ed25519", key, payloadBytes);
    ticket = `${base64url(payloadBytes)}.${base64url(new Uint8Array(signature))}`;
  } catch (e) {
    console.error("failed to sign online ticket", e);
    return error("ticket_signing_failed", 500);
  }

  const headers = new Headers();
  if (resolved.renewCookie) headers.append("Set-Cookie", resolved.renewCookie);
  return json({ ticket }, { headers });
}
