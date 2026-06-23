// ─────────────────────────────────────────────
// sw.js  Service Worker for TETLABO
// 配置場所: public/sw.js  （Viteビルド後はdist/sw.jsに出力される）
//
// キャッシュ戦略:
//   Cache First  … BGM(.ogg) / 画像(.png) / WASM(.wasm)
//                  重いバイナリは初回以降ネットワーク不使用
//   Network First … JS / CSS / JSON / HTML
//                  更新が必要なファイルは常に最新を優先
// ─────────────────────────────────────────────

const CACHE_VERSION = "tetlabo-v1";
//                              ↑
//【CACHE_VERSION の更新タイミング】
// BGMや画像を差し替えたとき、sw.js の先頭の
// const CACHE_VERSION = 'tetlabo-v1'; を 'tetlabo-v2' のように変更してください。
// activateイベントが古いキャッシュを自動削除します。 JSやCSSはNetwork Firstなので、sw.jsの更新なしで 自動的に最新版が使われます。

// Cache First で扱う拡張子
const CACHE_FIRST_EXTS = [".ogg", ".mp3", ".wav", ".png", ".jpg", ".webp"];

// ──────────────────────────────────────────────
// install: 必ずキャッシュしておきたいコアアセットを事前取得
// ──────────────────────────────────────────────
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE_VERSION)
            .then((cache) => {
                return cache.addAll([
                    // BGM（最も重いので確実にキャッシュ）
                    "/assets/audio/bgm/menu_1.ogg",
                    "/assets/audio/bgm/vs_1.ogg",
                ]);
            })
            .then(() => self.skipWaiting()),
    );
});

// ──────────────────────────────────────────────
// activate: 古いバージョンのキャッシュを削除
// ──────────────────────────────────────────────
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_VERSION)
                        .map((key) => caches.delete(key)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

// ──────────────────────────────────────────────
// fetch: リクエストをインターセプトしてキャッシュ戦略を適用
// ──────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // 同一オリジンのGETリクエストのみ対象
    if (event.request.method !== "GET" || url.origin !== self.location.origin) {
        return;
    }

    const ext = url.pathname.substring(url.pathname.lastIndexOf("."));

    if (CACHE_FIRST_EXTS.includes(ext)) {
        // ── Cache First ──────────────────────────
        // キャッシュにあればそのまま返す。なければネットワーク取得してキャッシュに追加。
        event.respondWith(
            caches.open(CACHE_VERSION).then(async (cache) => {
                const cached = await cache.match(event.request);
                if (cached) return cached;

                const response = await fetch(event.request);
                // 正常レスポンスのみキャッシュ（エラーはキャッシュしない）
                if (response.ok) {
                    cache.put(event.request, response.clone());
                }
                return response;
            }),
        );
    } else {
        // ── Network First ────────────────────────
        // ネットワーク優先。オフライン時はキャッシュにフォールバック。
        event.respondWith(
            caches.open(CACHE_VERSION).then(async (cache) => {
                try {
                    const response = await fetch(event.request);
                    if (response.ok) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                } catch {
                    const cached = await cache.match(event.request);
                    return cached ?? new Response("Offline", { status: 503 });
                }
            }),
        );
    }
});
