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

1. 問題のタブ・アクティビティバーの LEVELS・`Ctrl/⌘+P`（PC）／トップバーの LEVELS（スマホ）で問題の一覧を開いて選ぶ（新規は ≡ メニューの NEW / PASTE JSON）
2. 盤面・NEXT・クリア条件などを編集（キー一覧は `?`）
3. OUTPUT の検証結果を確認し、TEST PLAY で実際のゲームで遊んで確認（ファイルは変更しない）
4. WRITE FILE で `public/assets/quizlevels/tdata.json` / `pdata.json` に書き込む（Chrome / Edge）。
   編集した問題の範囲だけを書き換え、他の問題のテキストは変えない。位置を選べば移動・挿入もできる。
   直接書き込めないブラウザでは COPY JSON でコピーして配列に貼り付ける
5. `public/core/base.js` の `ASSET_VERSION` を +1（キャッシュ対策）

データ仕様は `public/assets/quizlevels/template.txt` を参照。

## PC の画面配置

設計: `source_assets/memory/quiz-editor/tetlabo-quiz-editor-layout.md`（VS Code と同じ並び）・`tetlabo-quiz-editor-tools.md`（LEVELS・NEXT モード・TOOLS）

- タイトルバー: ≡ メニュー（NEW / PASTE JSON / DRAFTS）・TET/PUYO・**問題のタブ**（押すか `Ctrl/⌘+P` でサイドバーの LEVELS へ）・状態チップ・UNDO/REDO
- 左端のアクティビティバー: LEVELS / INFO / STEPS / OUTPUT をサイドバーに出す。LEVELS は番号タイル（矢印と Enter・`/` で絞り込み欄へ）。選択中をもう一度押す（`Ctrl/⌘+B`）と閉じる。サイドバーの右端はドラッグで幅を変えられる（ダブルクリックで元に戻す）。幅 1000px 未満は盤面に重ねて開く
- 中央: モード切替＋HOLD｜FIELD｜NEXT＋（SOLVE 中は）NEXT 全体＋プレイ画面の見出し。マスはテト基準で最大 28px、ぷよはテトの盤面の枠に収まる大きさ（隠し段は低く描く）
- 右: TOOLS（モードの道具）。全モード共通の 3 段＝ピース行（色・ミノ。I O T J L S Z の位置は全モード同じ）／操作パッド（十字＋アクション行）／その他
- ステータスバー: モード・盤面サイズ・操作キー・検証の件数（押すと OUTPUT）・SYNC・🔔 LOG。お知らせ（トースト）はその上の右下に出る
- 高さ 600px 以上ではページをスクロールさせず、盤面のマスを画面の高さと幅に合わせる
- 状態チップ: FILE（ファイルのまま）/ EDITED（変更点）/ SOLUTION（手順だけ変更）/ NEW。REVERT でファイルの内容に戻す（UNDO 可）。
  自動保存はブラウザ内と Gist の下書きだけで、tdata/pdata.json は WRITE FILE でしか変わらない

## モード（PAINT / STAMP / NEXT / SOLVE）

盤面の上の `[PAINT][STAMP][NEXT] [SOLVE]` で切り替える。選択中のボタン・盤面の枠・ステータスバーの色で今のモードが分かる。

- オレンジ = **EDIT**（PAINT・STAMP・NEXT）: 初期盤面・NEXT を変える＝問題が変わる
- 青緑 = **SOLVE**: 解答手順を記録するだけ＝問題は変わらない
- キー: `P` で EDIT（最後に使ったモード）⇔ SOLVE、`Shift+P` で PAINT → STAMP → NEXT、`N` で NEXT ⇔ 直前の PAINT / STAMP
- キーはフォーカスの場所ではなく**今のモード**が受け取る（テキスト欄を除く）。NEXT モードではミノ文字で挿入・矢印でキャレット・Alt+↑↓ で並べ替え
- NEXT 列を押すと NEXT モード、NEXT モードで盤面を押すと直前の PAINT / STAMP に戻ってそのまま塗る（PC。スマホは NEXT タブ）

## ミノ配置と解答手順（STAMP・SOLVE）

- **SOLVE**: NEXT の順にミノを置いて解答手順を記録する。1手ごとにライン消去・T-Spin・REN・パフェ・スコアを計算し、
  クリア条件を満たした手に ✓ を付ける。判定は `public/game/tet/` と `public/quiz/quiz.js` を移植したもの（`tet-sim.ts`）
- **STAMP**: 好きなミノを初期盤面に直接置く（ライン消去なし）。盤面作成の補助
- 操作キーは TETLABO の KEY CONFIG（同じ dev サーバーの localStorage `game_binds`）と同期する。
  設定が無ければ ←→↓ / SPACE / Z・X 回転 / C で HOLD
- 押し続けた時の連続移動は TETLABO の DAS / ARR（localStorage `game_tuning`。無ければ既定 9f / 1.6f）。
  ハードドロップ・回転・HOLD などは押した瞬間の1回だけ（押し続けても連発しない）
- **STRICT**（SOLVE のチェック）: 1段上・浮いたままの確定・マウス配置を使えなくし、出現位置から移動・回転・ドロップで置いた手だけを記録する
  （記録した手順がそのままゲームで入力できる手になる）。重力・固定猶予の時間はエディタに無いので、最終確認は TEST PLAY
- **ぷよの SOLVE**（STAMP は無い）: NEXT の順にペアを置く。移動・回転（壁蹴り・押し上げ・クイックターン）・ちぎれ・連鎖・得点・全消しは
  `public/game/puyo/` を移植したもの（`puyo-sim.ts`）。ゴーストの位置で消えるぷよを強調し、各手は連鎖後の盤面で表示する。
  `,` `.`（CHAIN の ‹ ›）で「置いた直後 → n 連鎖目が消えた後 …」の途中の盤面を見られる。STRICT は上への移動・マウス配置を使えなくする。
  NEXT 列はゲームと同じ 2 ペア。ソフトドロップの加点は数えない（score 条件は下限）
- 解答は問題 JSON には含めず、`source_assets/quizlevels/tsolutions.json`（テト）・`psolutions.json`（ぷよ）（git 管理外）に SAVE SOLUTION で保存する
  （Chrome / Edge はファイルへ直接書き込み、それ以外のブラウザはダウンロード）
- マウスで置いた T は操作経路が無いため、T-Spin 判定は「回転入れした」と見なした推定になる。
  確実な確認はキー操作か、実機でのテストプレイで行う

## PC とスマホの同期（SYNC・DRAFTS）

編集中の問題と解答手順を、自分の GitHub アカウントの**非公開 Gist** で共有する（サーバーは使わない）。

1. GitHub で fine-grained token を作る（Account permissions → **Gists: Read and write** のみ・有効期限を設定）
2. エディタ右上の **SYNC** → トークンを貼って CONNECT（説明欄 `TETLABO quiz-editor sync` の Gist を探し、無ければ作る）
3. スマホは SYNC → SHOW QR の QR コードを読む（`#sync=…` にトークンが入った URL。読み込むと URL から消える）

- **自動保存は端末の中だけ**（localStorage・問題ごとに1つ）。別の問題を開いても編集中の内容は残り、LEVELS に印が付く
  （`●` 問題に未書込の変更・`◆` 問題はファイルのまま解答手順だけ未保存）。
  ファイルの内容（と保存済みの手順）と同じに戻すと（REVERT・WRITE FILE・SAVE SOLUTION）その下書きは消える
- Gist へは OUTPUT の **SAVE**（Ctrl/⌘+Shift+S）を押した時だけ保存する（`draft-<id>.json`・1問につき1つ）。
  自動送信・一定間隔の取得はしない（GitHub の回数制限に当たらないように）。取得は起動時・画面に戻った時・DRAFTS を開いた時・SYNC NOW
- 状態チップの横に `SAVED`（Gist と同じ）/ `SAVED*`（保存後に変更あり）/ `↓ iPhone`（他の端末の別の内容が届いている）。
  届いた時はお知らせ（OPEN）と LEVELS の `↓` で知らせ、勝手には切り替えない
- SAVE の時に他の端末が同じ問題を別の内容で保存していたら「上書きする / 別の下書きとして保存 / やめる」を選ぶ
- **DRAFTS**: 上がこの端末の下書き（OPEN / SAVE / DISCARD）、下が Gist の下書き＝PC で書き込み待ち（OPEN / DELETE）。
  WRITE FILE が成功するとその問題の Gist の下書きは自動で消える。CLEAN UP でファイルと同じ・旧 WRITTEN・元の問題が無く30日以上の物を整理。
  Gist 20件・端末30件を超えると DRAFTS のバッジに `!`
- GitHub の回数制限（403/429）はトークン無効と区別し、`SYNC: WAIT hh:mm` で待って自動で再開する
- 同期中は解答手順の正本は Gist の `tsolutions.json`・`psolutions.json`。ローカルファイルとは SYNC 画面の IMPORT LOCAL FILE / EXPORT TO FILE
  （SOLVE の EXPORT FILE も同じ）でやり取りする。同期しなければ今まで通りローカルファイルだけで動く
- 実装: `gist.ts`（API・回数制限の判定）・`sync.ts`（保存・取得・解答のマージ）・`local-drafts.ts`（端末内の下書き）・`sync-ui.ts`（画面）。設定は端末×オリジンごとの localStorage
- お知らせは画面右下（スマホは下部タブの上）に重ねて出すトースト（`toast.ts`）。直近20件は LOG（PC はステータスバーの 🔔）で見られる

## スマホでの編集

幅 760px 以下では下部タブ（FIELD / NEXT / GOAL / STEPS / OUT）で1項目ずつ表示する。盤面は画面に収まる大きさに縮む。

- 盤面は指でなぞって塗る。STAMP・SOLVE は盤面に触れている間ミノが指に付いてきて、DROP / LOCK で確定する（離しただけでは確定しない）
- 操作パッドの ←→↓↑ は長押しで連続移動。NEXT は長押しで掴んで並べ替え（または MOVE ◀ / MOVE ▶）
- スマホではファイルへの書き込みとテストプレイはできない。作り終えたら OUT の SAVE を押し、PC の DRAFTS から開いて WRITE FILE する

## テストプレイの仕組み

TEST PLAY は編集中の1問を localStorage（`tetlabo.quizEditor.test`）に置き、`/?quizTest=1` を開く。
`public/quiz/quiz.js` の `_bootQuizEditorTest` が **localhost とプレビュー（`*-citgame.pptlabo.workers.dev`）のときだけ** それを読み、メモリ上の問題一覧に
差し込んで（同じ ID なら置換・新規なら末尾）準備画面を開く。本番ホストでは何もしない。
