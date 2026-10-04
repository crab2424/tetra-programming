# QUIZ EDITOR

TETLABO のクイズ問題（`public/assets/quizlevels/tdata.json` / `pdata.json`）を編集するツール。
本番ビルドには含まれない（main 以外のブランチのビルドにだけ含まれる）。

## 開き方

```bash
pnpm dev:client
```

ブラウザで `http://localhost:5173/quiz-editor/` を開く。

### オンライン（プレビュー）

main 以外のブランチを push すると、Workers Builds のプレビューURLでも開ける
（例: v2.3 → `https://v2-3-citgame.pptlabo.workers.dev/quiz-editor/`）。プレビューは Cloudflare Access で保護されている。

- ビルドに含めるかは `vite.config.ts` が `WORKERS_CI_BRANCH`（Workers Builds が設定するブランチ名）で判定する。
  ローカルの `pnpm build` は本番と同じく含めない。確認したい時は `QUIZ_EDITOR=1 pnpm build`
- 万一本番ホスト（`citgame.pptlabo.workers.dev`）で開かれても `prod-guard.ts` が起動を止める
- プレビューで読める tdata/pdata.json は「そのブランチをデプロイした時点」のもの

## 使い方

1. 上部の LEVELS から既存の問題を開く（または NEW / PASTE JSON）
2. 盤面・NEXT・クリア条件などを編集（キー一覧は `?`）
3. OUTPUT の検証結果を確認し、TEST PLAY で実際のゲームで遊んで確認（ファイルは変更しない）
4. WRITE FILE で `public/assets/quizlevels/tdata.json` / `pdata.json` に書き込む（Chrome / Edge）。
   編集した問題の範囲だけを書き換え、他の問題のテキストは変えない。位置を選べば移動・挿入もできる。
   直接書き込めないブラウザでは COPY JSON でコピーして配列に貼り付ける
5. `public/core/base.js` の `ASSET_VERSION` を +1（キャッシュ対策）

データ仕様は `public/assets/quizlevels/template.txt` を参照。

## 盤面のモード（PAINT / STAMP / SOLVE）

TOOLS の `[PAINT][STAMP][SOLVE]` で切り替える。盤面の上の帯と枠の色で今のモードが分かる。

- オレンジ = **EDIT**（PAINT・STAMP）: 初期盤面を変える＝問題が変わる
- 青緑 = **SOLVE**: 解答手順を記録するだけ＝問題は変わらない
- キー: `P` で EDIT（最後に使った PAINT / STAMP）⇔ SOLVE、`Shift+P` で PAINT ⇔ STAMP

## ミノ配置と解答手順（STAMP・SOLVE・TET のみ）

- **SOLVE**: NEXT の順にミノを置いて解答手順を記録する。1手ごとにライン消去・T-Spin・REN・パフェ・スコアを計算し、
  クリア条件を満たした手に ✓ を付ける。判定は `public/game/tet/` と `public/quiz/quiz.js` を移植したもの（`tet-sim.ts`）
- **STAMP**: 好きなミノを初期盤面に直接置く（ライン消去なし）。盤面作成の補助
- 操作キーは TETLABO の KEY CONFIG（同じ dev サーバーの localStorage `game_binds`）と同期する。
  設定が無ければ ←→↓ / SPACE / Z・X 回転 / C で HOLD
- 押し続けた時の連続移動は TETLABO の DAS / ARR（localStorage `game_tuning`。無ければ既定 9f / 1.6f）。
  ハードドロップ・回転・HOLD などは押した瞬間の1回だけ（押し続けても連発しない）
- 解答は問題 JSON には含めず、`source_assets/quizlevels/tsolutions.json`（git 管理外）に SAVE SOLUTION で保存する
  （Chrome / Edge はファイルへ直接書き込み、それ以外のブラウザはダウンロード）
- マウスで置いた T は操作経路が無いため、T-Spin 判定は「回転入れした」と見なした推定になる。
  確実な確認はキー操作か、実機でのテストプレイで行う

## PC とスマホの同期（SYNC・DRAFTS）

編集中の問題と解答手順を、自分の GitHub アカウントの**非公開 Gist** で共有する（サーバーは使わない）。

1. GitHub で fine-grained token を作る（Account permissions → **Gists: Read and write** のみ・有効期限を設定）
2. エディタ右上の **SYNC** → トークンを貼って CONNECT（説明欄 `TETLABO quiz-editor sync` の Gist を探し、無ければ作る）
3. スマホは SYNC → SHOW QR の QR コードを読む（`#sync=…` にトークンが入った URL。読み込むと URL から消える）

- 問題を編集すると下書き（`draft-<id>.json`）が自動で作られ、編集が止まって 1.5 秒後・画面を隠した時に Gist へ送られる。
  表示中は 10 秒ごと・画面に戻った時に取得し、開いている下書きが他の端末で更新されていれば読み込む
- LEVELS から開いただけ（未編集）の問題は下書きにならない。その間に他の端末が同じ問題の下書きを作る・更新すると、自動でその下書きに切り替わる
- 同じ下書きを両方で編集した場合は上書きせず、後から送った方を「競合コピー」として別に保存する
- **DRAFTS** で一覧・切替・削除。スマホで作り終えたら OUTPUT の **MARK READY**（PC の DRAFTS に目立つ表示）。
  WRITE FILE が成功すると自動で WRITTEN になる
- 同期中は解答手順の正本は Gist の `tsolutions.json`。ローカルファイルとは SYNC 画面の IMPORT LOCAL FILE / EXPORT TO FILE
  （SOLVE の EXPORT FILE も同じ）でやり取りする。同期しなければ今まで通りローカルファイルだけで動く
- 実装: `gist.ts`（API）・`sync.ts`（キュー・マージ・ポーリング）・`sync-ui.ts`（画面）。設定は端末×オリジンごとの localStorage

## スマホでの編集

幅 760px 以下では下部タブ（FIELD / NEXT / GOAL / STEPS / OUT）で1項目ずつ表示する。盤面は画面に収まる大きさに縮む。

- 盤面は指でなぞって塗る。STAMP・SOLVE は盤面に触れている間ミノが指に付いてきて、DROP / LOCK で確定する（離しただけでは確定しない）
- 操作パッドの ←→↓↑ は長押しで連続移動。NEXT は長押しで掴んで並べ替え（または MOVE ◀ / MOVE ▶）
- スマホではファイルへの書き込みとテストプレイはできない。作り終えたら OUT の MARK READY を押し、PC で WRITE FILE する

## テストプレイの仕組み

TEST PLAY は編集中の1問を localStorage（`tetlabo.quizEditor.test`）に置き、`/?quizTest=1` を開く。
`public/quiz/quiz.js` の `_bootQuizEditorTest` が **localhost とプレビュー（`*-citgame.pptlabo.workers.dev`）のときだけ** それを読み、メモリ上の問題一覧に
差し込んで（同じ ID なら置換・新規なら末尾）準備画面を開く。本番ホストでは何もしない。
