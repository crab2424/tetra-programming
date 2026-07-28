# TETLABO オンライン／VERSUS おじゃま送信処理メモ

作成日: 2026-07-21  
調査対象: `public/game/*`, `public/app/versus.js`, `src/battle/garbage_router.ts`, `src/online/online_game.ts`  
対象: VERSUS(CPU戦) とオンライン対戦

## 結論の前提

- 送信入口は、テト側が `Game.sendGarbage()`、ぷよ側が `PuyoGame.sendGarbage()`。
- `src/battle/garbage_router.ts` の `routeGarbage()` が、送信量の乗率、受け手ルール別の変換、テト穴パターン生成を担当する。
- CPU戦は相手インスタンスの `garbageQueue` に直接積む。オンラインは `online_game.ts` が `sendGarbage` をネットワークフレーム送信へ差し替え、受信側で自分のルール用キューに積む。
- キュー状態は概ね次の3段階。
  - `internal: true`: ぷよ送信でのみ使う内部段階。予告非表示、まだ降下不可。
  - `ready: false, internal: false`: 猶予中。予告表示はされるが降下不可。
  - `ready: true, internal: false`: 確定／点滅状態。相殺対象で、エンジンの降下トリガーが成立すれば降る。
- 相殺は基本的に `ready` を古い順に先に消費し、その後 `ready:false` を消費する。したがって「相手に届いた」ことと「降下可能」なことは別状態。

## 1. TET vs TET

### おじゃま計算・変換

- `tet/scoring.js` の `Scoring()` が、消去ライン、T-spin、PC、B2B、REN、TETマージンテーブルからライン火力を算出する。
- `tet/board.js` の `secureMino()` で、今回の `generatedGarbage` に `vsAttackMultiplier` を適用し、`offsetGarbage()` の戻り値（相殺後の余り）だけを送信する。
- TET同士では、TETラインをおじゃまぷよへ変換しない。`BattleGarbage.routeGarbage(... targetRule:'tet')` がライン数をそのまま送り、穴配列を送信側で確定する。

### 送信タイミング

- CPU戦: ライン消去を含むミノ固定（`secureMino()`）の中で相殺後すぐ送信。
- オンライン: 同じ `secureMino()` のタイミングで `Garbage` フレーム（ライン数＋穴配列）を送信。

### 相手側の状態・降下トリガー

- CPU戦・オンライン受信とも、TET受け側には `ready:false` で投入される。
- CPU戦は `deliverLocalWithReadyTimer(..., 1500)`、オンラインも `deliverGarbageToPlayer()` で1500ms後に `ready:true` へ遷移する（ポーズ中はCPU／オンラインのローカルエンジン側でタイマー停止可能）。
- `ready:true` のおじゃまは、受け手の次のミノ固定直後、`secureMino()` の末尾で `applyGarbage()` が実行されたときに降る。異種戦ではなくTET同士なので一度に全量を処理する。

### 相殺

- TET側のライン消去時に `offsetGarbage(effectiveGarbage)` を実行。
- `ready:true` → `ready:false` の順に相殺し、余りだけ相手へ送信。
- 相殺でキュー量を減らした場合、穴配列も残量に合わせて調整される。

## 2. PUYO vs PUYO

### おじゃま計算・変換

- `puyo/engine.js` の `_calcChainScore()` が連鎖得点を `attackScore` に加算し、おじゃまレート（通常70、マージン中は `vsOjamaRate`）単位で `pendingFire` を蓄積する。
- 連鎖の消去実行時（`erasing` → `_applyErase()` 後）に `_applyOjamaOffset(pendingFire)` を呼ぶ。
- 同種PUYO戦では変換なし。`pendingFire` はおじゃまぷよ個数として `GarbagePuyo`（オンライン）または相手のぷよキューへ送る。

### 送信タイミング

- CPU戦: ぷよが実際に消えた瞬間に相殺・送信量を確定し、`sendGarbage()` で相手へ段階投入。送信オブジェクトは500msの内部段階を経て、送り手の連鎖終了時 `_confirmSentGarbage()` で `ready:true` に確定する。
- オンライン: `online_game.ts` が `sendGarbage` をフックしているため、CPU版の送信側段階キューは使わない。消去時の `_applyOjamaOffset()` から直ちに `GarbagePuyo` フレームを送る。

### 相手側の状態・降下トリガー

- CPU戦: 受け手にはまず `internal:true`（非表示）で積む。受信側の500msタイマーで `internal:false, ready:false`（予告表示）へ移り、送り手の連鎖終了後に `ready:true` になる。受け手は連鎖終了時の `checkErase` で、`ready:true` があれば `_generateOjama()` を実行する。
- オンライン: `GarbagePuyo` 受信時に `deliverOjamaToPlayer()` が `ready:false, internal:false` で積み、800ms後に `ready:true` へ変更する。受け手の連鎖が終わった `checkErase` で、同じく `_generateOjama()` が降下トリガーになる。
- ぷよの `_generateOjama()` は `ready:true && !internal` のみを最大30個ずつ降下させる。1回の降下で最大30個、フィールド上では6列換算で行と端数に変換する。

### 相殺

- `_applyOjamaOffset()` は実効火力に `vsAttackMultiplier * vsMarginMultiplier` を適用。
- 受信キューの `ready:true` を先に、次に `ready:false` を相殺する。
- 相殺後の `remaining` があれば、その個数を `sendGarbage()` で相手へ送る。CPU戦は内部段階へ、オンラインは即 `GarbagePuyo` 送信。
- なお、ぷよの連鎖中は `pendingFire` に保持し、実際の相殺・送信は消去タイミングにまとめられる。連鎖終了まで待つ設計ではない。

## 3. TET vs PUYO

### TET → PUYO: 計算・変換

- TETの通常ライン火力（`generatedGarbage`）とは別に、`tet/board.js` の `secureMino()` が対ぷよ用 `puyoAttack` を計算する。
- 対ぷよ用は、ライン数／T-spin／B2B／PC／RENとTETマージンステップの専用テーブルを使う。
- 今回発生した内部火力 `effectiveGenerated` は、TET側の相殺用として `pendingInternalAttack` に蓄積する。一方、相手へ送る表示用火力は `pendingAttack` に蓄積する。
- ライン消去時は今回発生分だけで相殺し、相殺に使った量を `canceledGarbage` として `puyoAttack` から差し引く。
- ライン消去がないミノ固定時に、蓄積した `pendingInternalAttack` で相殺し、残った `pendingAttack` を送信する。
- CPU戦の `BattleGarbage.routeGarbage(... gaugeToOjama:true)` では、テト火力をおじゃま個数へ変換する。変換表は `0,4,5,6,8,10,13,16,20,24,28,33,38,43,49,55,61,68`（18以上は式）である。
- オンラインではエンジンがすでに対ぷよ用の実効おじゃま個数を渡すため、ネットワーク側で再変換しない。`GarbagePuyo` として送る。

### TET → PUYO: 送信タイミング

- CPU戦: ライン消去時には `pendingAttack` へ貯め、ライン消去なしの次のミノ固定時に相殺後の余りを送信することがある。対ぷよ送信は `deliverLocalWithReadyTimer(..., 1000)`。
- オンライン: 受信側ルール向けの量が確定した時点（上記の `sendGarbage()` 呼び出し）で `GarbagePuyo` を送信。ぷよ受け側で800msの猶予を作る。

### PUYO → TET: 計算・変換

- ぷよ側は連鎖得点を使う通常の `pendingFire` とは別に、`_resolveTetAttack()` でテト用ライン火力を算出する。
- 連鎖1段目は持ち越し得点＋落下点＋消去得点、2段目以降は前段の端数＋消去得点。得点閾値テーブル（1〜7ライン）と消去ぷよ数追加ラインを適用し、全消しは2ライン追加する。
- ぷよ側の受信おじゃまを相殺するため、相殺対象個数×現在の `vsOjamaRate` と実効スコアを比較する。相殺できなかった端数は次連鎖へ持ち越す。
- 算出された `tetPendingFire` はライン数として送信する。CPU戦・オンラインとも、テト受け手に渡すときの逆変換は行わない。

### PUYO → TET: 送信タイミング・相殺

- `_resolveTetAttack()` の実行タイミングは「点滅開始」ではなく、ぷよが実際に消えた `erasing` 中（`_applyErase()` 後）。点滅中に到着したおじゃまも相殺対象に入る。
- その直後、`pendingFire`／`tetPendingFire` を `_applyOjamaOffset()` で相殺・送信する。したがってオンラインでも連鎖終了まで送信を遅延させない。
- CPU戦のぷよ送信は内部段階（500ms）を通り、連鎖終了の `_confirmSentGarbage()` で `ready:true` に確定する。テト受け手側に別の1500ms配送タイマーはない。
- オンラインでは `sendGarbage` フックから `Garbage`（ライン数＋穴配列）を即送信し、テト受け手が1500ms後に `ready:true` へする。
- ぷよ側の相殺は `ready:true` → `ready:false` の順。テト側で受けたライン火力の相殺は TET側の `offsetGarbage()` が `ready:true` → `ready:false` の順で行う。

## ルール別の差分一覧

| ケース | 送信量 | CPU送信状態 | オンライン送信状態 | 降下条件 |
|---|---|---|---|---|
| TET→TET | TETライン（穴付き） | `ready:false` → 1500ms後`ready:true` | `Garbage` → 受信側1500ms後`ready:true` | 次ミノ固定時の`applyGarbage()` |
| PUYO→PUYO | おじゃま個数 | `internal:true` → 500ms後表示 → 連鎖終了で`ready:true` | `GarbagePuyo` → 800ms後`ready:true` | ぷよ連鎖終了時の`_generateOjama()` |
| TET→PUYO | TET対ぷよ火力をおじゃま個数化 | `ready:false` → 1000ms後`ready:true` | `GarbagePuyo` → 800ms後`ready:true` | ぷよ連鎖終了／`checkErase`で`_generateOjama()` |
| PUYO→TET | ぷよ対テト火力をライン化 | 500ms内部段階 → 送り手の連鎖終了で`ready:true` | `Garbage` → 受信側1500ms後`ready:true` | 次ミノ固定時の`applyGarbage()` |

## 参照箇所

- `public/game/tet/scoring.js`: TET火力計算
- `public/game/tet/board.js`: TET同種／対ぷよの相殺・蓄積・送信タイミング
- `public/game/tet/garbage.js`: TET受信、ready化、降下、相殺
- `public/game/puyo/engine.js`: ぷよの連鎖得点、消去タイミング、降下トリガー
- `public/game/puyo/ojama.js`: PUYO送信、相殺、ぷよ→テト変換、降下
- `src/battle/garbage_router.ts`: CPU／オンライン共通の変換・穴・ローカル配送タイマー
- `src/online/online_game.ts`: オンラインの送信フック、受信フレーム、受信側タイマー
- `public/app/versus.js`: CPU戦のTET／PUYOインスタンスと相手ルール設定

## 4. 2026-07-22 対戦テスト結果と追加修正設計

### 観測した不具合

- TET/TET: オンライン結果画面の `LEAVE` が操作できない。
- PUYO/PUYO: 連鎖途中におじゃま降下トリガーが分割される。複数回の攻撃で予告表示は分割してよいが、1連鎖が完了するまでの降下判定は1回にまとめる必要がある。
- TET/PUYO: 異種戦の送信値が相手ルール用に変換されず、TET 1ライン = PUYO 4個などの変換が適用されない。
- 共通: オンライン盤面の配置・ラベルが CPU 戦と異なる、相手側にカウントダウンがない、相手 PUYO のちぎり／連鎖後の落下アニメーションがない。

### 修正方針

1. **結果画面**
   - 結果オーバーレイを画面全体の最前面に置き、`pointer-events: auto` を明示する。
   - `LEAVE` は投票通知の到着を待たず、押下時にローカル cleanup と退出コールバックを即時実行する。通知送信は並行して行い、二重押下を無効化する。

2. **PUYO のおじゃまキュー**
   - 受信イベントごとの `ready` は予告表示専用とし、降下可能量とは分離する。
   - `ready:true` のキューが複数存在しても、連鎖中は `_generateOjama()` を起動しない。
   - `checkErase` で連鎖が完全終了したタイミングに、ready 済みキューをまとめて1回だけ降下させる。
   - 1回の降下上限30個は維持し、残量と列配列をキューへ戻す。
   - 送信側の攻撃を予告単位で分割しても、受信側の `chainGeneration`（連鎖1回単位）の降下トリガーは共有する。

3. **異種戦の火力変換**
   - 変換は攻撃量確定後、送信前に1回だけ行う。
   - TET→PUYO は TET 攻撃ゲージを PUYO おじゃま個数へ変換する（1ライン = 4個を基準に、既存 `tetGaugeToOjama` テーブルを利用）。
   - PUYO→TET は PUYO 火力を TET ライン数へ変換する。相殺後の余りだけを変換・送信し、二重変換しない。
   - wire payload は受信側ルールに関わらず `Garbage(0x24)` とし、`holes` は TET 受けなら穴列、PUYO 受けなら列番号とする。

4. **オンライン画面と相手演出**
   - オンライン DOM に CPU 戦と同じ HOLD/NEXT ラベル、フィールド内 overlay、左右配置を持たせる。
   - 自分と全相手の TET/PUYO フィールドに同じカウントダウンを表示する。
   - 相手 PUYO の Lock snapshot は即時確定表示ではなく、前スナップショットとの差分から `_dropAnim` を構築して落下させる。
   - ChainReplay は点滅だけで終わらせず、消去後の snapshot 差分を使って `_buildDropAnim()` 相当のアニメーションを実行する。受信パペット自身はゲームループを持たないため、driver が短時間の render loop を担当する。

### 実装後の検証項目

- 結果画面で `ROOM`、`REMATCH`、`LEAVE` がすべて押下可能で、連打しても1回だけ遷移する。
- PUYO で2回以上の連鎖攻撃を受け、予告は分割表示されても、連鎖終了後の降下トリガーは1回である。
- TET→PUYO の1ライン、PUYO→TET の1個／1連鎖を含む変換量が一致する。
- TET/TET、PUYO/PUYO、TET/PUYO でオンライン画面が CPU 戦と同じ基準位置・ラベル配置になる。
- 両プレイヤーのカウントダウン、PUYO のちぎり、連鎖後の落下が相手画面で表示される。
