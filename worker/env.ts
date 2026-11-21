export interface Env {
  DB: D1Database;
  DB_DEV: D1Database;
  ASSETS: Fetcher;

  DISCORD_CLIENT_ID: string;
  PROD_HOST: string;
  ADMIN_DISCORD_IDS: string;

  DISCORD_CLIENT_SECRET: string;
  TICKET_PRIVATE_KEY: string;
}

/** PROD_HOST はカンマ区切りで複数指定できる（独自ドメインへの移行中は新旧どちらも本番として扱う）。 */
export function isProdHost(host: string, env: Env): boolean {
  const h = host.toLowerCase();
  return env.PROD_HOST.split(",").some((p) => p.trim().toLowerCase() === h);
}

/** リクエスト先ホストで本番/開発DBを切り替える。一致しない場合は開発DB側に倒す。 */
export function pickDb(req: Request, env: Env): D1Database {
  const host = new URL(req.url).hostname;
  return isProdHost(host, env) ? env.DB : env.DB_DEV;
}
