// ─────────────────────────────────────────────
// gist.ts
// GitHub Gist API の薄いラッパ（PC とスマホの同期用。設計書 §14.3）。
// ブラウザから api.github.com を直接呼ぶ（CORS 可）。トークンは Gist 権限だけの fine-grained token を想定。
// ─────────────────────────────────────────────

const API = 'https://api.github.com';
/** 同期用 Gist の説明欄。初回接続時にこの説明の Gist を探し、無ければ作る */
export const GIST_DESCRIPTION = 'TETLABO quiz-editor sync';

/** トークンが無効・期限切れ・権限不足（401/403） */
export class GistAuthError extends Error { }
/** Gist が見つからない（削除された・別アカウントのトークン） */
export class GistNotFoundError extends Error { }

export interface GistSnapshot {
    files: Record<string, string>;   // ファイル名 → 中身
    etag: string | null;
    htmlUrl: string;
}

interface GistJson {
    id: string;
    description: string | null;
    html_url: string;
    files: Record<string, { filename: string; content?: string; truncated?: boolean; raw_url: string } | null>;
}

async function request(token: string, method: string, path: string, opts: { body?: unknown; etag?: string | null; keepalive?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    const res = await fetch(API + path, {
        method, headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        // GitHub の GET は max-age=60 が付くので、ブラウザのキャッシュは使わず ETag を自前で付ける
        cache: 'no-store',
        keepalive: opts.keepalive,
    });
    if (res.status === 401 || res.status === 403) throw new GistAuthError(`GitHub が拒否しました（HTTP ${res.status}）`);
    if (res.status === 404) throw new GistNotFoundError('Gist が見つかりません');
    if (res.status !== 304 && !res.ok) throw new Error(`GitHub API エラー（HTTP ${res.status}）`);
    return res;
}

async function toSnapshot(g: GistJson, etag: string | null): Promise<GistSnapshot> {
    const files: Record<string, string> = {};
    for (const [name, f] of Object.entries(g.files)) {
        if (!f) continue;
        // 1MB を超えるファイルは content が切り詰められるので raw_url から取り直す（通常は起きない大きさ）
        files[name] = f.truncated || f.content === undefined
            ? await (await fetch(f.raw_url, { cache: 'no-store' })).text()
            : f.content;
    }
    return { files, etag, htmlUrl: g.html_url };
}

/** 説明欄が GIST_DESCRIPTION の Gist を探す。無ければ initialFiles で非公開 Gist を作る */
export async function findOrCreateGist(token: string, initialFiles: Record<string, string>): Promise<string> {
    for (let page = 1; page <= 10; page++) {
        const res = await request(token, 'GET', `/gists?per_page=100&page=${page}`);
        const list = await res.json() as GistJson[];
        const hit = list.find(g => g.description === GIST_DESCRIPTION);
        if (hit) return hit.id;
        if (list.length < 100) break;
    }
    const files = Object.fromEntries(Object.entries(initialFiles).map(([k, v]) => [k, { content: v }]));
    const res = await request(token, 'POST', '/gists', { body: { description: GIST_DESCRIPTION, public: false, files } });
    return (await res.json() as GistJson).id;
}

/** Gist を読む。etag を渡して変化が無ければ null（304。GitHub のレート制限にも数えられない） */
export async function getGist(token: string, gistId: string, etag: string | null): Promise<GistSnapshot | null> {
    const res = await request(token, 'GET', `/gists/${gistId}`, { etag });
    if (res.status === 304) return null;
    return toSnapshot(await res.json() as GistJson, res.headers.get('ETag'));
}

/**
 * ファイルを書き換える。値が null のファイルは削除。書かなかったファイルはそのまま残る。
 * 戻り値は更新後の Gist 全体（keepalive 時はページが閉じる途中なので読まない＝null）
 */
export async function patchGist(token: string, gistId: string, files: Record<string, string | null>, keepalive = false): Promise<GistSnapshot | null> {
    const body = { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === null ? null : { content: v }])) };
    const res = await request(token, 'PATCH', `/gists/${gistId}`, { body, keepalive });
    if (keepalive) return null;
    return toSnapshot(await res.json() as GistJson, res.headers.get('ETag'));
}
