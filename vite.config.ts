import { defineConfig } from "vite";

console.log(
  `Building TETLABO v${process.env.npm_package_version} using Vite...`,
);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plguins: [],
  clearScreen: false,
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
