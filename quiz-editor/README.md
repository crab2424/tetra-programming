# QUIZ EDITOR

TETLABO のクイズ問題（`public/assets/quizlevels/tdata.json` / `pdata.json`）を編集するローカル専用ツール。
本番ビルド（`dist/`）には含まれない。

## 開き方

```bash
pnpm dev:client
```

ブラウザで `http://localhost:5173/quiz-editor/` を開く。

## 使い方

1. 上部の LEVELS から既存の問題を開く（または NEW / PASTE JSON）
2. 盤面・NEXT・クリア条件などを編集（キー一覧は `?`）
3. OUTPUT の検証結果を確認し、COPY JSON で1問ぶんの JSON をコピー
4. `tdata.json` / `pdata.json` の配列に貼り付け、`public/core/base.js` の `ASSET_VERSION` を +1

データ仕様は `public/assets/quizlevels/template.txt` を参照。
