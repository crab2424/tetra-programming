// ─────────────────────────────────────────────
// scripts/quiz-editor-files.ts
// クイズエディタ用の、dev サーバー（vite）だけにある読み書き口。
// File System Access の無いブラウザ（Safari 等）でも tdata/pdata.json・解答ファイルに書けるようにする。
// 設計: source_assets/memory/quiz-editor/tetlabo-quiz-editor-drafts.md §1.3 A
//
//   GET  /__quiz-editor/files              … 使える名前の一覧（エディタが起動時に確かめる）
//   GET  /__quiz-editor/file?name=…        … 中身（text）と SHA-256（hash）
//   POST /__quiz-editor/file  {name, text, base}
//        base = 読んだ時の hash。今のファイルと違えば 409（外で変更された）
//
// 守り: server.host: true で LAN に公開しているため、接続元がループバックの時だけ受ける。
//       Origin / Sec-Fetch-Site で他のサイトのページからの要求を拒む。名前は下の 3 つだけ（パスは受け取らない）。
//       configureServer はビルドには入らない（プレビュー・本番には無い）。
// ─────────────────────────────────────────────
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES: Record<string, { rel: string; kind: "tet" | "puyo" | "solutions" }> = {
  "tdata.json": { rel: "public/assets/quizlevels/tdata.json", kind: "tet" },
  "pdata.json": { rel: "public/assets/quizlevels/pdata.json", kind: "puyo" },
  "tsolutions.json": { rel: "source_assets/quizlevels/tsolutions.json", kind: "solutions" },
};
const MAX_BODY = 5 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** ループバックからで、他のサイトのページからの要求ではないか */
function allowed(req: IncomingMessage): string | null {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return "loopback only";
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return "cross-site";
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return "bad origin";
    } catch {
      return "bad origin";
    }
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readCurrent(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** 書く前の形の確認（壊れた内容で上書きしない） */
function validate(kind: string, text: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "JSON として読めません";
  }
  if (kind === "solutions") return v && typeof v === "object" && !Array.isArray(v) ? null : "解答ファイルの形ではありません";
  if (!Array.isArray(v)) return "問題の配列ではありません";
  if (v.some((l) => (l as { rule?: unknown })?.rule !== kind)) return `${kind.toUpperCase()} 以外の問題が含まれています`;
  return null;
}

export function quizEditorFiles(): Plugin {
  return {
    name: "quiz-editor-files",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__quiz-editor", (req, res) => {
        void (async () => {
          const deny = allowed(req);
          if (deny) return send(res, 403, { error: deny });
          const url = new URL(req.url ?? "/", "http://x");
          if (req.method === "GET" && url.pathname === "/files") return send(res, 200, { files: Object.keys(FILES) });
          if (url.pathname !== "/file") return send(res, 404, { error: "not found" });

          if (req.method === "GET") {
            const f = FILES[url.searchParams.get("name") ?? ""];
            if (!f) return send(res, 400, { error: "unknown file" });
            const text = await readCurrent(path.join(ROOT, f.rel));
            return send(res, 200, { text: text ?? "", hash: text === null ? "" : sha256(text), exists: text !== null });
          }
          if (req.method !== "POST") return send(res, 405, { error: "method" });
          // JSON 以外の Content-Type は受けない（他のサイトのフォームからは送れない形にする）
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "json only" });
          const body = JSON.parse(await readBody(req)) as { name?: string; text?: unknown; base?: unknown };
          const f = FILES[body.name ?? ""];
          if (!f) return send(res, 400, { error: "unknown file" });
          if (typeof body.text !== "string" || typeof body.base !== "string") return send(res, 400, { error: "bad body" });
          const bad = validate(f.kind, body.text);
          if (bad) return send(res, 422, { error: bad });
          const abs = path.join(ROOT, f.rel);
          const cur = await readCurrent(abs);
          const curHash = cur === null ? "" : sha256(cur);
          if (curHash !== body.base) return send(res, 409, { error: "changed", hash: curHash });
          const tmp = `${abs}.tmp-${process.pid}`;
          try {
            await writeFile(tmp, body.text, "utf8");
            await rename(tmp, abs);
          } catch (err) {
            await unlink(tmp).catch(() => {});
            throw err;
          }
          server.config.logger.info(`[quiz-editor] wrote ${f.rel}`, { timestamp: true });
          return send(res, 200, { hash: sha256(body.text) });
        })().catch((err: unknown) => {
          server.config.logger.error(`[quiz-editor] ${(err as Error).message}`);
          if (!res.headersSent) send(res, 500, { error: (err as Error).message });
        });
      });
    },
  };
}
