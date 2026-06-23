# ぷよCPU lv5 現状レビュー資料（評価関数・探索・接続）

対象コミット: `ba18423`（v1.3ブランチ）時点の native 実装。
本書は「いま何がどう動いているか」をレビュー向けに俯瞰するための整理であり、各設計判断の是非はレビューで議論する前提で**事実ベース**で記述する。

---

## 0. 全体像（3行）

- **方式**: Ama（ama-beam）由来の **ビームサーチ**。TETLABO は内部で 20 NEXT を確定保持しているため、Ama 原典の擬似ランダム未来ツモ分岐は撤去し、**確定NEXTを1本のビームで深く読む**。
- **eval は「構築品質」に専念**（amaEvalMode=1）。発火（いつ・どれを撃つか）は eval に混ぜず、**探索側の chainTarget 巻き上げ＋fire gate** で初手選択に集約する。
- **接続**: JS（重み組立）→ Wasm `searchBestMovePuyoWasm`（重み展開）→ `searchBuildMode` → `runExpectedChainSelection`（ビーム＋初手選択＋発火トリガ）→ `outResult` を JS に返す。

---

## 1. データの流れ（接続）

```
cpu5_weights.js                cpu5.cpp                         build/build.cpp
─────────────────              ────────────────                ──────────────────────────
_initWeights()          ┌──>  searchBestMovePuyoWasm()  ┌──>  searchBuildMode()
  rewardWeights         │       weightsArray[0..33] を      │     └─ runExpectedChainSelection()
  evalWeights           │       EvalWeights w に展開          │          ビーム探索 + 初手選択 + 発火トリガ
  controlWeights        │       BitBoard.fromArray()         │          ↓ outResult[0..6]=着手, [7..19]=デバッグ
_buildWeightsArray() ───┘    → searchBuildMode(board,next,w) ┘
  Int32Array[34]
  (ojama動的閾値を反映)
```

- **入力**: `boardData`(uint8 盤面), `nextPairs`(int配列, 各 depth に pivot/child の2色), `weightsArray[34]`。
- **出力**: `outResult[0..6]` = `col1,rot1,score,col2,rot2,col3,rot3`（着手＋表示用先読み2手）。`outResult[7..19]` はデバッグ統計（JS worker が console 可視化）。
- **重みの34要素対応表**は `cpu5.cpp:49-100` と `cpu5_weights.js:144-194` が一対一で対応。`ojamaCount` による発火閾値の**動的緩和**は JS 側（`cpu5_weights.js:148-157`）で `[7]/[9]` に焼き込む（※後述の通り amaEvalMode=1 では実質未使用）。

ファイル分割（ama-beam 構成を踏襲）:
| ファイル | 役割 |
|---|---|
| `def.h` | 盤面定数（COLS/ROWS/HIDDEN/TOTAL_ROWS） |
| `core/bitboard` | BitBoard（1マス3bit×uint64×6列）、配置生成、ちぎり判定 |
| `core/chain` | 連鎖シミュ `simulateChain` / 連鎖ポテンシャル `calcChainPotential` |
| `core/weights.h` | `EvalWeights` 構造体（34フィールド） |
| `eval/shape` | Ama 形状ヘルパー（shape/well/bump/side/link23）＋ **quiescence** |
| `eval/form` | Ama 関係性 form テンプレート（GTR/SGTR/FRON の相対マッチ） |
| `eval/eval` | `evaluateBoard`（報酬＋評価値の統合エントリ） |
| `search/node.h` | `SearchNode`＋盤面ハッシュ（置換表用） |
| `build/build` | build モード探索本体（**現状の唯一の経路**） |

`free / fast / allClear` モードはディレクトリだけ存在し未実装（README のみ）。`cpu5.cpp:107` で常に build へ振り分ける。

---

## 2. 評価関数（eval）

### 2.1 統合エントリ `evaluateBoard`（eval.cpp:166）

配置後盤面 1 つにつき 1 回呼ばれ、整数スコアを返す。先頭で配置後の各列高さ `heights[COLS]` を数える。

**現行は amaEvalMode=1 が有効**（`cpu5_weights.js:109`）なので、実際に走るのは次の早期 return パスのみ:

```cpp
if (w.amaEvalMode) {
    int evalScoreAma = calcEvalScore(postBoard, w, heights, outPotChainScore);
    return evalScoreAma + chain.totalErased * w.wasteWeight;   // waste = 消したぷよ数への小ペナルティ
}
```

→ **発火報酬・−5000ペナルティ・chainPotential・緊急ボーナス・全消し・動的発火閾値（＝`calcRewardScore`）は一切呼ばれない。** eval は「構築品質 `calcEvalScore`」＋「waste（無駄な小発火の抑制）」だけ。
発火の価値は eval ではなく **探索側 chainTarget** が担う（§3.3）。

> `amaEvalMode=0`（旧経路）の `calcRewardScore`（eval.cpp:59-160）も残置されているが、**現行設定では到達しないデッドパス**。レビュー時はここを「現在は無効」と認識して良い。

### 2.2 構築品質 `calcEvalScore`（eval.cpp:15）— 毎ターン加算

配置後盤面の状態だけを見る加算式。各重み 0 で個別に無効化可能。

| 項目 | 内容 | 重み | 既定値 |
|---|---|---|---|
| 致死列高さ | `heights[2]>=8` で `(h-7)*heightPenalty` | heightPenalty | -100 |
| 全列高さ | `heights[c]>=10` で `(h-9)*heightPenalty/3` | (同上) | |
| 隣接列高さ差 | `Σ|h[c]-h[c+1]| * heightDiffPenalty` | heightDiffPenalty | -8 |
| shape | 理想L字 `coef={1,1,1,-1,-1,-1}` からの偏差（GTR土台誘導） | shapeWeight | -8 |
| well | 井戸（両隣より低い列の落差合計） | wellWeight | -10 |
| bump | 凸（両隣より高い列の突出合計） | bumpWeight | -10 |
| side | 致死列bias `max(左2列和,右3列和)-h[2]` | sideWeight | 0（無効） |
| link2/link3 | 2連結/3連結の数（BFSで連結成分サイズ分類） | link2/link3Weight | 6 / 30 |
| **quiescence** | 連鎖ポテンシャル評価（§2.3） | （複数） | |
| form | GTR/SGTR/FRON 関係性テンプレートの一致 | formWeight | 50 |

shape/well/bump/side/link は **`heights` または連結数の単純な盤面メトリクス**で、Ama の eval.cpp を bitboard 上にスカラ移植したもの。

### 2.3 quiescence（shape.cpp:126）— 連鎖の組みやすさを毎ターン誘導

評価の中核。「**いま各列に同色を最大3個まで落としたら、どれくらいの連鎖が組めるか**」を先読みして加点する。

手順:
1. 発火可能な列範囲 `[xMin,xMax]`（11段以下の列）を求める。
2. 各列 x × 各色(1..5) について、その列に色を1〜3個積み、**4連結ができた瞬間**に発火試行（`hasGroup4At` で軽量判定）。
3. 発火したら `simulateChain` で連鎖を回し、qスコアを計算:
   ```
   q = chains*qChain + heights[x]*qY + placed*qKey + getChi*qChi
       + remain_link2*qLink2 + remain_link3*qLink3
   ```
   - `qChain`(1000): 連鎖数。**主項**。
   - `qY`(12): 発火列の高さ（高く積める連鎖を優遇）。
   - `qKey`(-30): 発火に必要な追加ぷよ数（少ない方が良い）。
   - `qChi`(20): 発火点が左右にどれだけ伸ばせるか。
   - `qLink2/3`(4/12): **発火直前盤面(remain)** の2/3連結＝次連鎖の種（Ama eval.cpp:62-65）。
4. 全候補(列×色)の中の **q 最大値**を eval に加える。

さらに `outChainScore` に「**今撃てば出る最大連鎖スコア（生の chain.score の最大）**」を別個に書き出す。
これは q（重み付き評価）とは **argmax が一致するとは限らない別追跡** であり、探索側の発火価値巻き上げ（chainTarget）の元になる（§3.3）。

> 性能対策: 関連重みが全て0なら計算をスキップ。`MAX_QDROP=3`、列範囲を11段以下に bound。

### 2.4 form（form.cpp）— 関係性テンプレート

GTR/SGTR/FRON を「**ラベル番号＋同色/異色の関係行列**」で表現（絶対座標・絶対色に非依存）。盤面下6段の実際の同色/異色関係が matrix の符号と一致すれば加点、矛盾で即失格(-100)、おじゃま混入で0。土台が左右にずれても効く相対方式。formWeight=50。

---

## 3. 探索（build モード）

`runExpectedChainSelection`（build.cpp:65）が本体。

### 3.1 ビーム構造

- ルート = 現盤面1ノード。`depth=0..maxDepth-1`（既定 maxDepth=8）で `stepDepth` を反復。
- **各 depth は確定NEXT `nextPairs[depth*2], nextPairs[depth*2+1]` の1ペア**を全ノードに適用（擬似ランダム分岐なし＝確定NEXT1本ビーム）。
- ビーム幅 `expBeamWidth(depth)`:
  - depth0 = `EXP_MAXCAND`(24) … 全初手をシード。
  - cfgWidth(=expBeamWidth JS設定, 既定10) > 0 なら depth>=1 を一律その幅。
  - 0 なら従来テーパ 12/8/6/5。

### 3.2 1段の処理 `stepDepth`（build.cpp:87）

各ノードについて:
1. `getAllPlacements` で全配置（最大6列×4回転）を生成。空なら死亡ノード（-999999）。
2. 配置前盤面で `isEmergencyPre`（平均高 ≥ emergencyHeight または 3列目 ≥ 9）と `prePot = calcChainPotential` を計算。
3. 各配置に対し:
   - `applyPlacement` → `simulateChain` で連鎖結果。
   - `evaluateBoard(..., &potChain)` でスコア＋potChain（今撃てば出る連鎖スコア）。
   - ちぎりペナルティ `placementTear(p)*tearWeight` を配置コストとして1回加算。
   - **depth0 のみ** `score = score * p1Weight / 100`。さらに depth ぶん `score = score*9/10`（深い手を割引）。
   - ノード `accumulatedScore += score`。
4. **chainTarget 巻き上げ**（§3.3）。
5. **PRUNE**（§3.4）。
6. 層末で **置換表**（§3.5）→ accumulatedScore 降順ソート → ビーム幅に切り詰め。
7. `captureBase=true` で各初手の `bestAccum`（順位付け/同点崩し用）と**表示用先読み col2/col3**（最も深く辿れたノード）を確定。

### 3.3 chainTarget 巻き上げ（核心①）

```cpp
long long reach = max(potChain, chain.score);   // 潜在 or 実発火の大きい方
if (reach > cands[fm].chainTarget) cands[fm].chainTarget = reach;
```

各ノードが属する **初手 fm** に対し、subtree 全体を横断して到達できる最大連鎖スコアを記録する。
「組む手（quiescence潜在）」と「撃つ手（実 chain.score）」を統一して**その初手から到達可能な最大連鎖**として扱う。

### 3.4 発火枝刈り PRUNE（build.cpp:174）

```cpp
if (pruneChainScore > 0 && depth >= 1 && chain.score >= pruneChainScore) { dbgPrune++; continue; }
```

連鎖スコアが閾値（既定3000）以上のノードは **chainTarget に記録した上で次層に伝播させない**。発火後の崩れた盤面でビーム枠を浪費せず「組み途中」の盤面に幅を使う＝同じ幅で深く読める。Ama beam.cpp の PRUNE=5000 由来。

### 3.5 置換表 dedup（build.cpp:185）

同一盤面（`hashBoard` = FNV-1a で6列 uint64 を混ぜる）に複数経路で到達したら `accumulatedScore` 最大の1ノードだけ残す。限られたビーム幅を多様な盤面に使う。Ama Layer::add 相当。

### 3.6 初手選択（連鎖スコア主体・base同点崩し）build.cpp:242

1. 全初手の chainTarget 最大 `bestChain` を求める。
2. `chainFloor = bestChain - band`（band = expChainWeight、既定1500、連鎖スコア単位）。
3. **chainTarget ≥ chainFloor の初手の中で base（構築品質 = bestAccum）最大**を選ぶ。
   - base = `bestAccum`（無ければ depth0Score フォールバック）。
   - `bestChain==0`（序盤でまだ連鎖が組めない）なら全初手が band 内 → base のみで選ぶ＝素直に積む。

→ 「到達連鎖がほぼ最大の手の中で、最も綺麗に積める初手」を選ぶ設計。

### 3.7 発火トリガ fire gate（build.cpp:276）★いつ撃つか

ama 型 eval は放っておくと**無限に積み続ける**ため、§3.6 で決めた「育成初手 bestFm」を、次の条件で「**今そのまま置けば実発火する初手**」に上書きする:

- 各初手の `fireChains/fireScore` = **depth0 でその初手を今置いた瞬間の実連鎖**（build.cpp:152-155 で記録）。
- ① **目標発火**: `fireChains >= fireChainCount`（既定10段）を満たす初手の中で fireScore 最大 → 発火。
- ② **緊急発火**: `fireEmergency` かつ盤面緊急（avgH≥emergencyHeight or 3列目≥9）なら、発火可能な初手の最大 fireScore → 即発火。
- ①が成立すれば①優先、なければ②。どちらも無ければ育成（bestFm）のまま。

> 注: `fireEmergency` の JS 既定値は `2`（build.cpp 側は `if (w.fireEmergency)` の真偽判定なので 2 でも有効）。

### 3.8 出力（build.cpp:320）

`outResult[0,1]=col1,rot1`（選択初手）, `[2]=selChain`（到達 or 実発火の連鎖スコア＝eval-value 表示用）, `[3..6]=col2,rot2,col3,rot3`（表示先読み）。`[7..19]` は PRUNE数/dedup数/候補数/深さ/band/bestChain/selBase/selChain/発火段数 等のデバッグ統計。`[20..25]` は追加デバッグ（[20]=選択初手の到達連鎖段数, [21][22]=理論上いま撃てる最大連鎖の段数/スコア, [23]=発火理由, [24]=選択手の実こぼし段数, [25]=到達連鎖を達成した深さ＝何手後）。

---

## 4. eval と探索の接続（まとめ）

```
                  ┌─────────────── 各配置後盤面 ───────────────┐
  探索 stepDepth →│ evaluateBoard()                            │
                  │   amaEvalMode=1: calcEvalScore + waste     │→ accumulatedScore（構築品質の累積）
                  │   calcQuiescenceEval → outPotChain ────────┼──┐
                  └────────────────────────────────────────────┘  │
                                                                   ↓
  chainTarget[fm] = max(potChain, 実 chain.score) を subtree 横断で巻き上げ
                                                                   ↓
  初手選択: chainTarget 主体（band 内で base=構築品質 同点崩し）
                                                                   ↓
  fire gate: 目標連鎖到達 or 緊急 なら「今撃てる最大連鎖の初手」に上書き
```

**役割分担が明確**:
- **eval（accumulatedScore）= 構築品質**。ビームの生存（どのノードを残すか）と初手の同点崩し（base）に使う。
- **chainTarget = 発火の到達価値**。初手選択の主軸。
- **fire gate = 発火タイミング**。育成と発火の切替。

この3者で「綺麗に積みながら、目標連鎖まで育て、頃合いor緊急で撃つ」を実現している。

---

## 5. レビュー時の着眼候補（事実として気づいた点）

純粋にコードを読んで気づいた箇所。是非はレビューで判断する前提。

1. **デッドコードの規模**: amaEvalMode=1 固定運用下で `calcRewardScore`（eval.cpp:59-160, 約100行）と関連制御パラメータ（chainBonus/erasedBonus/zenkeshi/chainPotential/ignitionThreshold/ignitionScoreThreshold とその ojama 動的緩和）が**全て未到達**。A/B 切替を残すか、ama 型に一本化して撤去するかは設計判断。
2. **`expBranch` は完全未使用**（擬似分岐撤去済み、配線のみ残置）。`knownNextCount[20]` も runExpectedChainSelection 内で参照されていない（確定NEXTを maxDepth まで読むだけ）。
3. **quiescence のコスト**: `stepDepth` の各配置ごとに `calcQuiescenceEval`（列×色×最大3ドロップ＋`simulateChain`）が走る。ビーム幅×深さ×全配置に対して効くため、速度のホットスポット。memory の `project_cpu5_perf_backlog` #3（postPot/prePot のbeam深さ間キャッシュ）が未着手。
4. **`getLink23`/`hasGroup4At` が `static bool seen[TOTAL_ROWS][COLS]` を関数内 static で持つ**。シングルスレッド Wasm 前提なので動くが、再入不可。今後の並列化時は要注意。
5. **fire gate の発火連鎖は depth0 の実発火のみ**で測る（「今1手で撃てる連鎖」）。「2手仕込んでから撃つと大きい」ケースは fireChains には乗らず chainTarget 側（育成継続）で評価される設計。意図通りかはレビュー対象。
6. **`selChain`（outResult[2]）の意味が経路で変わる**: 育成時は chainTarget（潜在含む）、発火時は実 fireScore。表示用途なので実害は薄いが、解釈に注意。

---

## 6. 主要な既定重み（cpu5_weights.js）

| グループ | 重み | 値 |
|---|---|---|
| reward（※amaで未使用）| chainBonus / erasedBonus / zenkeshi / chainPotential | 300 / 10 / 100 / 200 |
| eval 高さ | heightPenalty / heightDiffPenalty | -100 / -8 |
| eval 形状 | shape / well / bump / side | -8 / -10 / -10 / 0 |
| eval 連結 | link2 / link3 | 6 / 30 |
| quiescence | qChain / qY / qKey / qChi | 1000 / 12 / -30 / 20 |
| quiescence remain | qLink2 / qLink3 | 4 / 12 |
| form | formWeight | 50 |
| ちぎり | tearWeight | -20 |
| 制御 | p1Weight / emergencyHeight | 100 / 11 |
| 選択 | expChainWeight(band) / expMaxDepth / expBeamWidth | 1500 / 8 / 10 |
| 枝刈り | pruneChainScore | 3000 |
| ama型 | amaEvalMode / wasteWeight | 1 / -2 |
| 発火 | fireChainCount / fireEmergency | 10 / 2 |
</content>
