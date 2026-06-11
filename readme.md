# TETLABO

https://citgame.pptlabo.workers.dev/

# ローカルでの開発方法

## 依存関係

- Node.js
- pnpm

## セットアップ

```bash
$ pnpm install # パッケージのインストール
$ pnpm dev:client # クライアントサーバーの起動
```

Viteが起動して， [http://localhost:5173/](http://localhost:5173/) でアクセスできるようになります．

なお，バックエンドサーバーを同じディレクトリでCloneしている場合は，以下のコマンドでバックエンドサーバーも起動できます．

```bash
$ pnpm dev:server # バックエンドサーバーの起動
```

これら2つをまとめて，

```bash
$ pnpm dev # クライアントサーバーとバックエンドサーバー
```

で起動することもできます．
