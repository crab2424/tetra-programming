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

(ただし，これを実行するには事前にcargo-watchをインストールしておく必要があります．)

> `cargo install cargo-watch` でインストールできます．

これら2つをまとめて，

```bash
$ pnpm dev # クライアントサーバーとバックエンドサーバー
```

で，フロントエンドサーバーとバックエンドサーバーを同時に起動することもできます．

ちなみに，同じディレクトリでCloneされているとは，

```bash
player@tetlabo /home/User/Documents $ ls -al
total 2
drwxr-xr-x 14 player users  4096  6月 18 20:00 tetra-programming
drwxr-xr-x  9 player users  4096  6月 18 20:00 tetra-server
```

のような状態を指します．
