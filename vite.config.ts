import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// クイズエディタ（quiz-editor/）はプレビュー（main 以外のブランチ）のビルドにだけ含める。
// Workers Builds は WORKERS_CI_BRANCH にブランチ名を入れる。ローカルでは QUIZ_EDITOR=1 の時だけ含める
// （普段の pnpm build は本番と同じ＝含めない）。プレビューURLは Cloudflare Access で保護済み。
const ciBranch = process.env.WORKERS_CI_BRANCH;
const includeQuizEditor = ciBranch
  ? ciBranch !== "main"
  : process.env.QUIZ_EDITOR === "1";

console.log(
  `Building TETLABO v${process.env.npm_package_version} using Vite...`,
);
console.log(
  `quiz-editor: ${includeQuizEditor ? "included" : "excluded"} (branch: ${ciBranch ?? "local"})`,
);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plguins: [],
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
