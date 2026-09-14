# PRACTICE 専用 SE 置き場

`public/core/base.js` 末尾の `AudioLoader.loadSe({...})` に登録済み。
ファイルが無い間は `loadSe` の `.catch` でスキップされるだけ（＝該当SEが無音）なので、
用意でき次第ここへ置けばそのまま鳴る。

| ファイル名  | キー              | 鳴るタイミング |
|-------------|-------------------|----------------|
| rewind.ogg  | practice_rewind   | 1手戻す（既定 Q / パッド） |
| advance.ogg | practice_advance  | 1手進める（既定 E / パッド） |
| cycle.ogg   | practice_cycle    | 即時ツモ変化 CYCLE（既定 S/D / パッド）。変化に成功した時だけ |

以下3つは容量削減のため専用ファイルを持たず、既存キーと同一音源（`base.js`側で
src を共用させているだけ・ファイルはここに置かない）：

| キー                    | 共用元              | 鳴るタイミング |
|-------------------------|----------------------|----------------|
| practice_panel_open     | `pause`（se/menu/pause.ogg）  | 設定パネルを開く（⚙タブ / Tab） |
| practice_panel_close    | `pause`（se/menu/pause.ogg）  | 設定パネルを閉じる（⚙タブ / Tab / Esc） |
| practice_board_clear    | `menu_decide`（se/menu/decide.ogg） | 「盤面クリア」実行 |

GOAL 達成は PRACTICE 専用音ではなく共通の `clear`（`se/menu/clear.ogg`）を使う。
音量はキー別係数 `SeManager._gain`（base.js）で調整する＝ファイルは無改変のままでよい
（同一音源を共用しているキー同士でも、gain はキーごとに独立して効く）。
