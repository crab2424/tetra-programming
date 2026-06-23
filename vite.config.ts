import { defineConfig } from "vite";

console.log(
  `Building TETLABO v${process.env.npm_package_version} using Vite...`,
);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [],
  clearScreen: false,
  define: {
    APP_VERSION: JSON.stringify(process.env.npm_package_version),
  },
  server: {
    host: true,
    allowedHosts: ["tetlabo-canary-client.nattyantv.info"],
  },
}));
