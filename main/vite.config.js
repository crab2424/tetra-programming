import { defineConfig } from 'vite'

export default defineConfig({
  // ルートは index.html がある場所（このフォルダ自体）
  root: '.',

  // 開発サーバーの設定
  server: {
    port: 5173,
    open: false,
    // ホットリロード有効
    watch: {
      // .playwright-mcp などは監視対象外
      ignored: ['**/.playwright-mcp/**'],
    },
  },

  // ビルド出力先（必要に応じて）
  build: {
    outDir: 'dist',
  },
})
