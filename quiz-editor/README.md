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

## ミノ配置と解答手順（PLACE・TET のみ）

TOOLS の PLACE（または `P`）で切り替える。

- **SOLVE**: NEXT の順にミノを置いて解答手順を記録する。1手ごとにライン消去・T-Spin・REN・パフェ・スコアを計算し、
  クリア条件を満たした手に ✓ を付ける。判定は `public/game/tet/` と `public/quiz/quiz.js` を移植したもの（`tet-sim.ts`）
- **STAMP**: 好きなミノを初期盤面に直接置く（ライン消去なし）。盤面作成の補助
- 操作キーは TETLABO の KEY CONFIG（同じ dev サーバーの localStorage `game_binds`）と同期する。
  設定が無ければ ←→↓ / SPACE / Z・X 回転 / C で HOLD
- 解答は問題 JSON には含めず、`source_assets/quizlevels/tsolutions.json`（git 管理外）に SAVE SOLUTION で保存する
  （Chrome / Edge はファイルへ直接書き込み、それ以外のブラウザはダウンロード）
- マウスで置いた T は操作経路が無いため、T-Spin 判定は「回転入れした」と見なした推定になる。
  確実な確認はキー操作か、実機でのテストプレイで行う
