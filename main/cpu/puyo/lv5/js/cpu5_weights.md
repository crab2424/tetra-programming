# cpu5_weights パラメータ解説

`cpu5_weights.js`（`PuyoCPU5.prototype._initWeights` / `_modeProfiles` / `_buildWeightsArray`）で定義する重みの詳細解説。
JS 側には各値の末尾に1行の要約コメントだけを残し、変数そのものの長い説明はこのファイルに集約する。

参考実装: `source_assets/puyoAI/ama-beam`（Ama）。⚠️ 値はすべて暫定＝実機で要チューニング（[[feedback-versus-cpu-verification]]）。

---

## 重みの3グループ

評価パラメータは用途で3つに分かれる。

- **報酬 (`rewardWeights`)** … 配置前後の盤面を比較し、配置後にのみ現れた変化に対して1回だけ加算する。
- **評価値 (`evalWeights`)** … 配置後の盤面状態をそのまま毎ターン評価する。
- **制御パラメータ (`controlWeights`)** … 発火閾値・緊急ラインなど、評価の振る舞いを制御するパラメータ。

`_initWeights()` の末尾で 3 グループをマージした `this.weights`（後方互換の読み取り専用エイリアス）を作る。
weightsArray への組み立ては `_buildWeightsArray()` で行う。

---

## evalWeights（評価値）

### shape / well / bump / qChain / qY / qKey / qChi / link2 / link3 — Ama 由来の評価値

参考: `source_assets/puyoAI/ama-beam`。いずれも加算式・0で無効化可。実機で要チューニング。

- `shapeWeight` … 理想L字形からの偏差ペナルティ
- `wellWeight` … 井戸（両隣より低い列）ペナルティ
- `bumpWeight` … 凸（両隣より高い列）ペナルティ
- `qChainWeight` … quiescence 連鎖ポテンシャル数
- `qYWeight` … quiescence 発火列高さ（高く積める連鎖を評価）
- `qKeyWeight` … quiescence 必要追加ぷよ数
- `qChiWeight` … quiescence 発火点の伸長余地
- `link2Weight` … 2連結
- `link3Weight` … 3連結（発火直前形に近く価値大）

### qLink2 / qLink3 — quiescence 発火直前盤面(remain)の連結数

Ama `eval.cpp:62-65`。発火直前の形に次連鎖の種がどれだけ仕込まれているかを評価。0で無効。
暫定値（要チューニング）。Ama build 比（link_2:150 / link_3:250）を qChain 縮尺に合わせて縮小。

- `qLink2Weight` … quiescence remain の2連結
- `qLink3Weight` … quiescence remain の3連結（次連鎖の種）

### sideWeight — 致死列(第3列) bias

Ama `eval.cpp:99-102`。`max(左2列和, 右3列和) - heights[2]` に乗じる。正で「3列目を周囲より低く保つ」誘導。
lv5 は別途 `heights[2]` の絶対ペナルティ（`calcEvalScore` 冒頭）も持つので、これは相対的な補助。
0 で無効（Ama build プロファイルも 0）。使う場合の目安は小さめの正値。

### tearWeight — ちぎり(tear)ペナルティ

Ama `beam/eval.cpp:105`（`node.score.action += tear * w.tear`）。横置きで2列に分かれてバラバラに落ちる配置に、
配置時1回だけ加算（負＝ちぎり回避）。Ama build 比 -250 を lv5 の縮尺（link3 250→qLink3 12 ≒ 1/20）に合わせ小さく。
ちぎりは連鎖構築上やむを得ない場合もあるので強くしすぎない。0 で無効。実機で要チューニング。

### wasteWeight — ama 型 eval の waste ペナルティ

`amaEvalMode=1` のときのみ作用。消したぷよ数（`chain.totalErased`）に乗じる小さな負値。
組み途中の無駄な小発火を弱く抑制。Ama `beam/eval.cpp`: `node.score.action += waste * w.waste`。
強くしすぎると発火自体を嫌う。

### formWeight — Ama 関係性 form テンプレート

GTR / SGTR / FRON の相対マッチ。0 で無効。Ama build は 50。

### link3FacL / link3FacH / link3FacV — 3連結の形状別倍率

百分率（＝×100。`link3Weight` / `qLink3Weight` の両方に共通で乗る）。
3連結トリオミノは縦一直線／横一直線／L字の3種。形状で発火直前形の価値が違うため細分化。
100=×1.0、60=×0.6。実機で要チューニング。

- `link3FacL` … L字（折れ）
- `link3FacH` … 横一直線
- `link3FacV` … 縦一直線

---

## controlWeights（制御パラメータ）

### ignitionThreshold / ignitionScoreThreshold — 発火閾値（旧eval専用）

旧 eval（`amaEvalMode=0`）の `calcRewardScore` が参照する発火閾値・スコア閾値。
現行の ama 型 eval（`amaEvalMode=1`）では未参照。weightsArray のスロット[7]/[9]の位置は
C++ がインデックス参照するため維持するが、静的な基準値を渡すだけ。
（かつて `_buildWeightsArray` が おじゃま数に応じて動的調整していたが撤去済み。詳細は「weightsArray」節。）

### expChainWeight — 初手選択の「同点崩しband」

連鎖スコア主体の選択における同点崩し幅（旧 `expChainWeight` を流用）。
選択は「到達連鎖スコア `chainTarget` 最大」が主体（Ama「最終選択は連鎖スコア」）。
このbandは “到達連鎖が最大値からこの差（連鎖スコア単位）以内なら base（構築品質）で選ぶ” 許容幅。
0=厳密に連鎖最大のみ（同値は最初の候補）。大きいほど構築品質寄りになる。

★ TETLABO は内部20NEXT確定保持のため擬似未来ツモ列は不要＝1本の確定NEXTビーム。

### expBranch / expMaxDepth / expBeamWidth — 確定NEXTビームの探索コスト（速度調整）

コストは概ね `expMaxDepth × 幅` に比例。小さくすると軽くなる。

- `expBranch` … 擬似分岐撤去により**未使用**（後方互換のため配線のみ残置）
- `expMaxDepth` … 確定NEXTビームの深さ 1..8（0=8）
- `expBeamWidth` … depth>=1 のビーム幅（0=従来テーパ）

### pruneChainScore — Ama 由来の発火枝刈り（PRUNE）

参考: ama-beam `beam.cpp` PRUNE=5000。連鎖スコアがこの値以上のノードは、連鎖を記録した上で次層に伝播させない（捨てる）。
発火後の崩れた盤面でビーム枠を浪費せず「組み途中」の盤面に集中させる＝同じ幅で深く探れる。
閾値が低すぎると小さな消えで枝が切れすぎ、高すぎると枝刈りがほぼ効かない（要実機チューニング）。
0 で無効＝従来動作。期待連鎖スコア選択（`expChainWeight>0`）の探索でのみ作用する。

### amaEvalMode — eval スコア関数の A/B 切替（核心）

参考: ama-beam `beam/eval.cpp`。★この値が切り替えるのは `evaluateBoard` 内の「1ノードの盤面スコア関数」だけ。
探索構造（確定NEXTビーム／`chainTarget` 巻き上げ／後述の fire gate）は main 経路削除（commit ba18423）以降
このフラグに依存せず常に走る。

- **1 = ama型**: `calcRewardScore`（発火報酬／−5000ペナルティ／chainPotential／緊急／全消し／おじゃま動的閾値）を使わず、
  構築品質（quiescence/shape/well/bump/link/side/form）＋ waste だけでスコアリング。発火価値は `chainTarget` 経由で初手選択に集約。
- **0 = 旧 eval**: `calcRewardScore` を使う。ただし“従来動作”ではなく「ama探索＋旧eval」のハイブリッドになる
  （旧 main 探索は削除済み）。基本は 1 運用。

★ ama型(1)では `expChainWeight` を高め（目安50〜）、`pruneChainScore` を有効値（目安5000）、
`wasteWeight` を小さな負（目安-2）に設定すること。

### fireChainCount / fireEmergency / fireScoreThreshold — 発火トリガ（fire gate）

「いつ撃つか」を初手選択直前で決める。※ `amaEvalMode` に依存せず常に作用する（`build.cpp` の初手選択末尾で無条件実行）。
ama型evalは「撃たずに育てる」器なので、これが無いと無限に積み続ける。
初手選択の直前に「今そのまま置けば実発火する連鎖（depth0）」で各初手を測り、

1. 今撃てる連鎖が `fireChainCount` 段以上、または
2. `fireEmergency` かつ盤面緊急、

のとき『今撃てる最大連鎖の初手』を選ぶ（①は目標段数を満たす中で最大）。
`fireChainCount=0` で目標発火を無効化（緊急発火だけにできる）。

3. **和集合条件**: 今撃てる連鎖スコアが `fireScoreThreshold` 以上なら段数未満でも発火（0=無効）。
   段数だけだと「段数は浅いが点数の大きい連鎖」を撃ち逃すための補完。

- `fireChainCount` … 目標連鎖数。今撃てる連鎖がこの段数以上で発火（0=無効）
- `fireEmergency` … 緊急発火 1/0。盤面緊急時に出せる最大連鎖を即発火
- `fireScoreThreshold` … 目標発火のスコア閾値（連鎖スコア単位。0=スコア条件 無効）

### growthFireForbidChains — 育成こぼし抑制

「育成（撃たず）」と判定された手でも、置いた瞬間に小連鎖を巻き込む（無駄消し）ことがある。
今そのまま置くとこの段数「以上」を発火する初手を育成選択から除外する。

- 0=無効（従来どおり）/ 1=こぼし全面禁止 / 2=1連鎖こぼしまで許容 / 3=2連鎖まで許容 …
- band内の全候補がこぼす場合はフィルタを外して再選択する（必ず手は残る）。

### emergencyFireMinRatio / emergencyHardCol2 — 緊急発火の発火対象制限

本線を巻き込む部分発火の防止。緊急回避(②)は無条件に「今撃てる最大連鎖」を撃つが、本線が未完成だと
部分連鎖や横の暴発で組み上げた本線を巻き込んで壊す。これを潜在比でガードする。

- **(a) 潜在比ガード (`emergencyFireMinRatio`)**: 今撃てる最大連鎖が本線潜在(bestChain)のこの割合以上＝本線がほぼ
  完成している時のみ緊急発火を許す。0=無効（従来どおり無制限）。連鎖スコアは段数に対し超線形なので、
  70 で「本線の最大潜在から約1連鎖以内」が目安。
- **(b) 窒息寸前の延命 (`emergencyHardCol2`)**: 致死列(第3列)がこの段数以上なら比ガードを無視して延命発火（最終手段）。
  可視12段で窒息=12。既定11＝窒息1歩手前。0=最終手段なし（比ガードを常に適用）。

---

## weightsArray（C++ 側との対応）

`_buildWeightsArray(knownNextCount)` が C++ 側 `weightsArray[N]` と対応する `Int32Array` を組み立てる。
インデックス順は C++ 側の `weightsArray[N]` と一致させること。

| idx | 内容 | idx | 内容 |
|----|------|----|------|
| 0 | chainBonus | 21 | formWeight |
| 1 | erasedBonus | 22 | expBranch |
| 2 | heightPenalty | 23 | expMaxDepth |
| 3 | heightDiffPenalty | 24 | expBeamWidth |
| 4 | zenkeshiBonus | 25 | qLink2Weight |
| 5 | chainPotentialBonus | 26 | qLink3Weight |
| 6 | p1Weight | 27 | sideWeight |
| 7 | ignitionThreshold（旧eval専用・ama型では未参照） | 28 | tearWeight |
| 8 | emergencyHeight | 29 | pruneChainScore |
| 9 | ignitionScoreThreshold（旧eval専用・ama型では未参照） | 30 | amaEvalMode |
| 10 | shapeWeight | 31 | wasteWeight |
| 11 | wellWeight | 32 | fireChainCount |
| 12 | bumpWeight | 33 | fireEmergency |
| 13 | qChainWeight | 34 | fireScoreThreshold |
| 14 | qYWeight | 35 | growthFireForbidChains |
| 15 | qKeyWeight | 36 | emergencyFireMinRatio |
| 16 | qChiWeight | 37 | emergencyHardCol2 |
| 17 | link2Weight | 38 | link3FacL |
| 18 | link3Weight | 39 | link3FacH |
| 19 | expChainWeight | 40 | link3FacV |
| 20 | knownNextCount（C++ では w.knownNextCount に代入されるのみのデッド配線） | | |

### ignition 動的閾値の撤去について

かつて `_buildWeightsArray` は おじゃま数（ojamaCount）に応じて発火閾値[7]/[9]を動的調整していたが、
発火制御はモードプロファイル（build/fast）＋VERSUS カウンターの `fireChainCount` / `fireScoreThreshold` へ移行し、
[7]/[9] は `amaEvalMode=1` の現行 eval では未参照のため動的調整を撤去した。

---

## モードプロファイル（`_modeProfiles`）

build = 基準（差分なし）。各モードは build からの差分だけを書き、`setMode()` で「基準値へ復帰 → 差分を上書き」する。
native 側は無改造（探索は build を流用＝`searchBuildMode`）で、モードの違いは重み（評価値の重み付け＋発火トリガ）だけで表現する。
`_initWeights()` 末尾で build 基準値を `this._buildBaseline` に退避しておく。

### fast — 速攻型

Ama `config.json` の fast プロファイル（build比）の相対値を lv5 の重み縮尺へ写像。要点:

- 発火点を高く積まない（`qY` を大きく下げる: ama y 289→77 ≒×0.27）
- 大連鎖への執着を下げる（`qChain` ×0.5 / `link3` ×0.6）
- 形の強制を緩めて速く積む（`shape` / `well` / `bump` / `tear` を大幅緩和）
- 小さい連鎖でも早く撃つ（発火トリガを浅く・こぼし抑制を外す）

＝「多少汚くても浅い連鎖を速く返す」挙動。

### vsTet — 相手がテトのときの本線構築

`_updateVersusCounterMode()` がカウンター（fast）不要と判定したとき、相手種別で build を分岐する:
相手がぷよ（またはソロ）なら `build`、相手がテト（`_isOpponentTet()` ＝ 相手が `PuyoGame` でない）なら `vsTet`。
おじゃま着弾の早さ・攻撃ゲージ特性がぷよ相手と異なるため、テト専用の構築プロファイルを分離する狙い。

★ 現状はモード分岐のみ＝`build` と同一（差分なし）。挙動は build から変わらない。テト相手向けの重み調整は今後。
