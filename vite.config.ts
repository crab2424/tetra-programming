import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { quizEditorFiles } from "./scripts/quiz-editor-files.ts";

// クイズエディタ（quiz-editor/）はプレビュー（main 以外のブランチ）のビルドにだけ含める。
// Workers Builds は WORKERS_CI_BRANCH にブランチ名を入れる。ローカルでは QUIZ_EDITOR=1 の時だけ含める
// （普段の pnpm build は本番と同じ＝含めない）。プレビューURLは Cloudflare Access で保護済み。
const ciBranch = process.env.WORKERS_CI_BRANCH;
const includeQuizEditor = ciBranch
  ? ciBranch !== "main"
  : process.env.QUIZ_EDITOR === "1";

// エディタの SYNC 画面が「スマホで開く URL（プレビュー）」の既定値を作るのに使う
function currentBranch(): string {
  if (ciBranch) return ciBranch;
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// 録画・再生（REPLAY）がリプレイに書く「録画したビルド」（設計 tetlabo-record-design.md §7）。
// コミットの短いハッシュ。追跡しているファイルに未コミットの変更があれば -dirty を付ける
// （dev サーバーは起動した時点の状態。起動後にコミットしても変わらない）。
function buildId(): string {
  const ciSha = process.env.WORKERS_CI_COMMIT_SHA;
  if (ciSha) return ciSha.slice(0, 7);
  try {
    const hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty =
      execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return "unknown";
  }
}
const APP_BUILD = buildId();

console.log(
  `Building TETLABO v${process.env.npm_package_version} (${APP_BUILD}) using Vite...`,
);
console.log(
  `quiz-editor: ${includeQuizEditor ? "included" : "excluded"} (branch: ${ciBranch ?? "local"})`,
);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // クイズエディタの tdata/pdata.json・解答ファイルの読み書き口（dev サーバーだけ。scripts/quiz-editor-files.ts）
  plugins: [quizEditorFiles()],
  clearScreen: false,
  build: includeQuizEditor
    ? {
        rolldownOptions: {
          input: {
            main: fileURLToPath(new URL("./index.html", import.meta.url)),
            "quiz-editor": fileURLToPath(
              new URL("./quiz-editor/index.html", import.meta.url),
            ),
          },
        },
      }
    : {},
  define: {
    APP_VERSION: JSON.stringify(process.env.npm_package_version),
    APP_BUILD: JSON.stringify(APP_BUILD),
    QUIZ_EDITOR_BRANCH: JSON.stringify(currentBranch()),
    // プレビューの DRAFTS に「問題一覧はデプロイ時点の内容」と出すため（drafts §5.4）
    QUIZ_EDITOR_BUILT_AT: JSON.stringify(new Date().toISOString()),
  },
  server: {
    host: true,
    allowedHosts: ["tetlabo-canary-client.nattyantv.info"],
    proxy: {
      // changeOrigin:false でHostヘッダを:5173のまま転送する。
      // Workerはこれをリクエストのoriginとして使い、Discordの許可リダイレクトURL
      // (http://localhost:5173/auth/discord/callback) と一致させている（worker/http.ts）。
      "/api": { target: "http://localhost:8787", changeOrigin: false },
      "/auth": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
}));
