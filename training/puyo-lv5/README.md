# ぷよCPU lv5 学習（CMA-ES × 対戦シミュレータ）

現行 lv5 に VERSUS で勝ち越す重みを、自己対戦の勝率を目的関数にした CMA-ES で探す。
設計: `source_assets/memory/cpu/puyo/lv5-training-design.md`

- **C++（sim/）**：対戦シミュレータ＋lv5 の JS 側ポリシー（モード切替・受け量推定）の移植。
  探索は本番と同じ `public/cpu/puyo/lv5/native` をコピーせず直接コンパイルする（`cpu5.cpp` だけ除外）。
  → 学習した重みはそのまま本番の `cpu5_weights.js` に書き写せる。
- **Python（py/）**：ctypes でジョブを渡すだけ。CMA-ES は numpy のみの自前実装（`py/cmaes.py`）。
- 本番の重みは **`tools/export_weights.mjs` が本番 JS から毎回取り出す**（手で写さない）。

## 準備

```bash
cd training/puyo-lv5
pip install -r requirements.txt   # numpy（必須）/ matplotlib・jupyter（ノートブックを使う場合）
./build.sh                        # build/libpuyosim.dylib
python3 tests/test_parity.py      # JS エンジンとの一致テスト（乱数・ツモ・連鎖）
bash tests/run_cpp_tests.sh       # おじゃまの相殺・着弾シナリオ
```

本番の native ソースを変えたら `./build.sh` をやり直す（`puyosim.build(force=True)` でも可）。

## 学習・検証

```bash
# 学習（スリープ防止付き。中断しても --resume で続きから）
caffeinate -i python3 py/train.py --run runs/build-001 --gens 100
caffeinate -i python3 py/train.py --run runs/build-001 --gens 100 --resume

# 検証（学習に使っていないシードで best vs 現行を 2000 局）
python3 py/validate.py --best runs/build-001/best.json --seeds 1000

# lv6 を初期値・学習相手にして学習し直す（新しい項 qExcessWeight を含む。1世代 約10分）
caffeinate -i python3 py/train.py --run runs/lv6-e1-001 --opp lv6 --init-set qExcessWeight=-100 --gens 20
python3 py/validate.py --best runs/lv6-e1-001/best.json --seeds 1000   # 相手は best.json の opp（lv6）
```
- 相手プール（鏡写し対策）：`--opp-pool opponents/pool-v1.json`。下の「相手プール」参照。
- `--opp lv5|lv6`：学習相手と定期評価の相手（本番の重み。lv6 は後打ち p2 込み）。`--init`：初期値（既定は `--opp`）。
  学習しない部分（fast・ext）は初期値のまま。`--init-set 名前=値` で初期値の一部を書き換える（複数可）。
- `params.SPACE` を変えると次元が変わるので、それ以前の run は `--resume` できない（検出して止まる）。
- lv6 の結果は `cpu6.js` の `TRAINED_BUILD` / `TRAINED_COUNTER` に写す（validate.py が書き写し先を出す）。

| ノートブック | 内容 |
|---|---|
| `notebooks/01_baseline.ipynb` | 一致テスト・現行 lv5 の基準値・1世代の所要時間 |
| `notebooks/02_train.ipynb` | `runs/<名前>/log.csv` の可視化（学習本体は CLI で回す） |
| `notebooks/03_validate.ipynb` | 検証の実行 |

### 相手プール（opponents/*.json・`py/pool.py`）
学習相手が1体（＝ほぼ同じ重み）だと対局が鏡写しになり、その相手の弱点を突く方向に偏る。立ち回りの違う相手を混ぜて、重み付き勝率を fitness にする。
```bash
caffeinate -i python3 py/train.py --run runs/lv6-pool-001 --opp lv6 --opp-pool opponents/pool-v1.json --hof-start 10 --gens 20
python3 py/validate.py --best runs/lv6-pool-001/best.json --seeds 1000   # 相手別の勝率も出る
```
- 定義：`members[]` に `base`（lv5/lv6/lv6h）・`set`（params.SPACE の名前で上書き）・`weight`（シード配分）。`perturb` は base の全重みに正規化座標で σ の雑音を足した count 体（学習は世代ごとに作り直し、定期評価は固定）。
- 全候補が同じシード→同じ相手の割り当てを共通で使う（共通乱数）。全相手を1バッチで回すので速度は単一相手と同じ。
- `--worst-lambda`（既定0.3）：best の選抜は「平均勝率 − λ×最悪の相手への負け越し」。学習の fitness は重み付き平均のまま（相手1体あたり約15シードでは最悪値が雑音になるため）。
- 殿堂（`--hof-start`）はプール全体に (1−hof_share)、殿堂に hof_share を割る。**既定の 30 世代目だと 20 世代の run では一度も効かない**ので、プール時は 10 程度にする。
- log.csv に `pool_wr`（その世代の相手別の候補平均）と `eval_pool_wr`（定期評価の相手別）が増える。
- pool-v1 の現行 lv6 の勝率（400シード）：main .50 / fast_attack .75 / big_chain .48 / responder .60 / lv5 .76 / perturb .52・.67。
  fast_attack を「7連鎖で撃つ」極端な設定にすると lv6 が 98% 勝って勾配にならなかったので、強さが近い別スタイルになるよう調整した。

### 主なオプション（train.py）
| 引数 | 既定 | 意味 |
|---|---|---|
| `--seeds` | 100 | 1候補あたりのシード数（各シード先後2局） |
| `--popsize` | 16 | 1世代の候補数 |
| `--sigma` | 0.1 | 初期ステップ幅（正規化座標 0..1） |
| `--eval-every` / `--eval-seeds` | 5 / 200 | 平均ベクトルを現行と定期評価 → `best.json` |
| `--hof-start` / `--hof-every` / `--hof-size` / `--hof-share` | 30 / 10 / 3 / 0.5 | 殿堂（過去世代）も対戦相手に混ぜる |

### 所要時間（M4 Pro 12コアでの実測）
- 速度は1局の長さで決まる。現行 lv5 同士は相殺し合って長期戦（両者計 約160手）になり **約2.5局/秒**。
  現行と離れた候補が相手だと約半分の長さで **約5局/秒**。
- 既定（16候補×100シード×2局＝3200局/世代）で **1世代 約10〜21分、100世代 約17〜35時間**。
  短くしたいときは `--seeds 60` などで減らす（勝率の雑音は増える）。

## 負け方の分析（記録モード）
対局を記録して、負けの分類・発火点の生死・連鎖の中身・撃ち合いの勝率を集計する。
結果と考察: `source_assets/memory/cpu/puyo/lv5-improvement-notes.md`

```bash
python3 py/analyze_losses.py --collect     # runs/analysis/ に記録（lv6(best) vs lv5・lv5同士・おじゃま実験。約12分）
python3 py/analyze_losses.py runs/analysis/lv6_vs_lv5.jsonl --a-label lv6 --b-label lv5 --split 300
python3 py/analyze_losses.py --harass      # 指定手数でおじゃまを降らせたときの被害
```
- 記録は `Player::trace`（`sim/sim.h` の `PlayerTrace`）。nullptr の学習時は何もしない（学習速度は不変）
- 発火点指標 `bestIgnition`：1列に同色1〜3個を足して起こせる最大連鎖（ツモ非依存の「撃てる状態」）
- 有効ぷよ量（turns[16] = [色ぷよ, 残り色ぷよ, 途中段の余剰]）：`bestIgnition` の連鎖を回して数える。有効 = 色ぷよ − 残り − 余剰

### ひとり用の基準計測（評価の項を試すとき）
```bash
python3 py/solo_baseline.py                 # lv5 / lv6 / lv6+puyosWeight / lv6 wasteWeight=0（300シード×80手・約8分）
python3 py/solo_baseline.py --only lv6      # 一部だけ
python3 py/solo_baseline.py --report-only   # 記録済みを集計し直す → runs/analysis/solo_baseline.md
```
最初の本線（段数・発火理由・発火時の色ぷよ・余剰・残り）、有効ぷよ量の推移、育成中の1〜2連鎖の「整地（無駄ぷよが減り起こせる段数が落ちない）／こぼし（起こせる段数が2段以上落ちる）」を出す。

## 異種戦のテト側（相手役 テト CPU lv5）
設計: `source_assets/memory/cpu/puyo/lv6-vstet-design.md` §7・§8。
本番 `public/cpu/tet/lv5/cpu5.cpp` を `sim/tet_cpu5.cpp` から名前空間に包んで native ビルドし、
操作の組み立て・時間（`cpu5.js`）と設置・攻撃・受け（`game/tet/*.js`）を `sim/tet_player.cpp` に移した。
```bash
python3 tests/test_tet_parity.py 5 # 探索結果が本番 wasm（node で実行）と全件一致するか（引数なしで lv4/lv6 も）
python3 tests/test_tet_attack.py   # ぷよ→テトの火力（_resolveTetAttack）が本番 JS と一致するか
python3 py/vstet_baseline.py       # ぷよ lv6（vsTet/fastVsTet）対 テト lv5 の勝率と負け方（600局・約1分）
```
Python からは `py/tetsim.py`（`solo_run` でひとり用の毎秒ミノ数・攻撃量、`trace_cases` で探索の入出力、
`run_vstet`／`vstet_policy` で異種戦）。

## テト同士（テト CPU lv4・lv5・lv6）
設計: `source_assets/memory/cpu/tet/lv5-terrain-design.md` §4。テト lv5 強化（地形）の計測用。
本番の探索をそのまま native ビルドする：lv4 `cpu4.cpp`（`sim/tet_cpu4.cpp`）、lv5 `cpu5.cpp`（`sim/tet_cpu5n.cpp`）、
lv6 `lv6/native/*.cpp` を1つにまとめたもの（`sim/tet_cpu6.cpp`。**PC 探索は無し**＝空盤面の開幕 PC だけ本番と差が出る）。
操作の組み立てと時間はレベルごと（lv4 60/200ms・lv5 45/150ms・lv6 40/80ms＋cpu6.js の SD/AC 群の組み立て）、
受けは本番のテト同士の分岐（消去時に相殺して即送信・1500ms で ready・せり上がりの上限なし）。ツモは両者共通。
```bash
python3 tests/test_tet_parity.py         # lv4/lv5/lv6 の探索が本番 wasm と全件一致するか＋既定の重みが本番 JS と同じか（約1分半）
python3 py/tvt_baseline.py               # 総当たり（200シード×席を入れ替えた2局×3組）→ runs/tvt/baseline.{json,md}
```
- **レベル番号：4・5・6＝本番、15＝旧 lv5**（2026-10-25 時点の cpu5.cpp を `sim/frozen/cpu5_v1.cpp` に固定したもの）。
  ぷよの対テト学習（`run_vstet` など）の相手役は `TetPlayer` の既定＝15 なので、本番 lv5 を変えても数字は動かない。
  新旧の A/B は `vs_run(5, 15, ...)`。旧 lv5 の重みは 33 要素、新 lv5 は 47 要素（[33..] は地形強化 T1〜T6、設計 §3）。
- **lv6 強化の A/B**（設計 `source_assets/memory/cpu/tet/lv6-boost-design.md`）：`python3 py/tet6_ab.py --vs-seeds 150 "案" 名前=値,...`。
  新 lv6（重みを差し替え）対 本番 lv6、両者別ツモ（同じレベル同士は NEXT を共通にすると決着がつかない）、地形と探索時間も出す。
  lv6 同士は1局が平均200〜250秒と長く、300局で約15〜20分（12スレッド）。
- 地形の指標（設計 §1.3）：`tetsim.terrain_lv(level, seeds, weights)`。A/B は `python3 py/tet5_ab.py base "案" 名前=値,...`（`--vs 4,6,15`）。
- `search_cases_lv(level, cases, weights)`：trace の局面で探索だけを回す（新旧の既定値一致の確認用）。
  `PUYOSIM_LIB=…` で別ビルドの共有ライブラリを使える。`set_level_timing(level, act, hd)` で操作時間を差し替える。
Python からは `tetsim.vs_run(lv_a, lv_b, seeds, w_a=None, w_b=None)`（重みの差し替えで A/B）、
`solo_run_lv`・`trace_cases_lv`（ひとり用・探索の入出力）、`prod_weights(level)`（本番 JS の重み）。
- 1シードにつき席（ツモ・送る穴・揺らぎの乱数と同時刻の先後）を入れ替えて2局。同時刻の設置はまず起きないので、先後だけの入れ替えでは2局が同じ展開になる。
- `jitter_ms`（既定 10）：操作開始に 0〜10ms の揺らぎを足す。シミュは決定的なので、0 だと同じ重み同士は鏡写しで全局引き分けになる。
- `shared_tumo`（既定 True＝本番どおり共通）：同じレベル同士を共通ツモで打たせると、同じ消し方で攻撃が相殺し合ってほぼ全局が上限（300秒）まで引き分けになる。
  同じ重み同士は席の入れ替えで勝率がちょうど 0.5 になる（A/B は違う重み同士で使う）。
- 思考時間は無視（native で lv4 約4ms・lv5 約3ms・lv6 約13ms/回。ハードドロップ後の待ち 80〜200ms に隠れる前提）。

## 対戦判断の A/B（ext[]）
`PolicyParams.ext[16]`（`sim/sim.h` ExtIndex、既定0＝現行 lv5）で対戦判断を切り替える。
本番 lv6 は「後打ちの活用」（p2_*）が有効で、`ps.Policy.lv6()` が本番 `cpu6.js` から設定を読む。
```bash
python3 py/ab_vs_decision.py --opp lv6    # 試作を lv6（重みのみ）相手に600局ずつ比較
```
- **lv5 同士の A/B は使わない**（同じシード・同じ重みだと鏡写しになり、後打ちの場面が生まれない）
- 設計と結果: `source_assets/memory/cpu/puyo/lv5-vs-decision-design.md`

## 出力（runs/<名前>/、git 管理外）
- `log.csv` … 世代ごとの sigma・候補の勝率（最高/平均/中央値）・定期評価・平均ベクトル
- `state.json` … 再開用（CMA-ES の状態・殿堂・best）
- `best.json` … 定期評価で最良だった平均ベクトル（※選抜に使った評価なので勝率は過大。必ず validate.py で確認）

## シミュレータの忠実度
JS と完全一致を確認したもの（`tests/test_parity.py`、本番 JS の関数を Node で直接実行して照合）:
乱数（xorshift32）、ツモ列（色シャッフル→初期 NEXT→取り出し）、連鎖スコア・段数（3000局面）。

シナリオで確認したもの（`tests/test_ojama.cpp`）: 相殺順（ready→未ready）、送信（500ms 非表示→送り手の連鎖終了で確定）、
着弾（最大30個・端数列）、マージンタイムのレート表。

近似・省略しているもの:
- CPU の思考時間は 0（spawnAnim 中の前倒し計算に収まる前提）。RAF の 16ms 粒度、操作中の自然落下、開始カウントダウンは無視
- 同時刻のイベントは先手（A）から処理する → 単局では先手が有利に偏るので、学習・検証は必ず先後2局で打ち消す
- 相手の「発火中連鎖の全段見込み」（_oppChainFull）は連鎖開始時に一括計算（毎フレーム推定と同じ値）
- 対戦の相手はぷよのみ（テト相手は作成中＝上の「異種戦のテト側」。混在戦は対象外）

本番 JS の挙動として**そのまま再現している**癖:
- 連鎖1段ごとに連鎖文字の表示位置（draw.js `_prepareChainTextDOM`）で乱数を1回消費する → 連鎖の段数が違うと両者のツモがずれる
- 相手の連鎖終了〜spawnAnim 終了の間は `generatedOjamaTotal=0` なのに `chainCount>0` のため、
  受け量の予測（anticipated）が全段見込みを二重に数える（cpu5_worker_io.js `_getIncomingBaseline` の現仕様）

## 本番への反映
`validate.py` の最後に、変化した値と書き写す先（`cpu5_weights.js` / `cpu5_worker_io.js`）が出る。
採用目安（勝率55%以上かつ95%信頼区間の下限>50%）を満たしたら書き写し、実機の CPU 同士モードで確認する。
fast（カウンター）は build の倍率 `{x:}` で作られているため、build を変えると本番では fast も動く。
学習中は fast を現行値で固定しているので、反映時は fast を現行の絶対値で書き直すか、倍率のまま追従させるかを決める（設計 D2）。
