# tet モード 描画カクつき / 入力レイテンシ 調査レポート

最終更新: 2026-06-20
対象ブランチ: `v1.3`
結論: **macOS 固有現象．Web レイヤ側の最適化は打ち止め．Windows では同コードでカクつき無し**

---

## 1. 症状

- tet モード全般（ソロ／対戦）で，横移動・ソフトドロップ操作時にフレーム飛びの体感
- Chrome DevTools Performance プロファイル：
  - フレーム間隔は 8.3ms（120Hz 目標は満たしている）
  - Keyboard イベントの内訳が **「入力遅延 1ms / 処理期間 0ms / 表示の遅延 21〜28ms」**
  - 「表示の遅延」だけが常時残り続け，操作系最適化で消えなかった
- DevTools タイムラインに「灰色横棒線」（フレームドロップ）が散見される

## 2. 環境

| 項目 | 値 |
|---|---|
| 開発機 | MacBook Pro M4，内蔵 Liquid Retina XDR 120Hz（ProMotion） |
| 比較対象 | Windows 機，144Hz ディスプレイ |
| Web 配信 | Vite dev server (`localhost:5173`) ／本番は Cloudflare 経由 |
| ブラウザ | Chrome / Safari 両方で同じ遅延を確認 |

## 3. 実施した修正（時系列）

すべて v1.3 ブランチ．基本的には [[build-script-versioning]] により `index.html` の `?v=` を更新済み．

### 3.1 JS 層（占有マップ・キャッシュ・即時反映）

| 項目 | 内容 |
|---|---|
| `Field._occ` Uint8Array 化 | `has()` を O(1) 化．旧 `blocks.some()` の線形探索を排除．y<0 まで含む `TOP_PAD=5` ぶん余裕を持つ |
| `getGhostY()` のゼロアロケ化 | 旧実装は毎フレ `new Set()` + `"x,y"` 文字列を生成．`_occ` 直接参照に置換 |
| `Mino.getNewBlocks()` バッファ使い回し | `_tmpBuf` を毎回返す方式．`new Block × 4 + map/forEach` を撤廃 |
| `valid()` / `validRotated()` 素ループ化 | every/map クロージャを廃し，早期 return の素ループに |
| `Field._fixedCanvas` オフスクリーンキャッシュ | 固定ブロック群を別 canvas に焼き込み．`drawAll` での drawImage 1 回に．`markDirty` 時のみ再構築 |
| `nextQueue` 描画の素 for ループ化 | `slice(0,5).forEach` を撤廃 |
| `_keyDownHandler` 内で初動を直接実行 | rAF poll 待ちの 1 フレ短縮．横移動・回転・ソフトドロップ初動をその場で `drawAll` 同期実行し `_needsRedraw` を消費 |
| 入力ポーリングの rAF 統合 | 旧 `setInterval(…, 4)` (250Hz) を撤廃．`startRenderLoop` の中で `_pollInput → _applyGravityTick → drawAll` を同期 |
| 重力 tick の rAF 統合 | 旧 `setInterval` 駆動の重力を，経過時間 / `LEVEL_SPEEDS` の floor 回数ぶん一括落下に置換．高 Hz モニタでの「瞬間移動」現象を解消 |

### 3.2 Canvas / CSS 層

| 項目 | 内容 |
|---|---|
| `desynchronized: true` | `mainCanvas.getContext('2d', { desynchronized: true })` で Chrome 低遅延パスを要求 |
| `will-change: transform; transform: translateZ(0); contain: layout style paint` | `#main-canvas` / `#player-main-canvas` / `#cpu-main-canvas` に付与．独立 compositor layer 化 |

### 3.3 GC churn 系（並行作業の流用）

versus でのカクつき調査（[[project_render_stutter_gc]]）由来：
- `_getGhostEraseInfo` (engine.js) の整数シグネチャ＋キャッシュ化．毎フレの盤面複製を排除
- `_getConnectImageInfo` (connect.js) のクロージャ撤去＋キー文字列事前計算

## 4. 効果

| 指標 | 修正前 | 修正後 |
|---|---|---|
| 「処理期間」 | 5〜8ms | **0ms（消えた）** |
| 「入力遅延」 | 1〜3ms | **1ms（極小）** |
| 「表示の遅延」 | 28ms | **21ms** |
| JS heap | 6.3→12.7MB ノコギリ波 | ほぼ平坦 |

JS 側の最適化目標は全て達成．しかし **「表示の遅延」は構造的に残り続けた**．

## 5. 反証された仮説

### 5.1 box-shadow を wrapper div に逃がす（**悪化**）

- 仮説: shadow blur のため canvas が compositor 経路に乗り `desynchronized:true` が無効化されている．wrapper div に逃がせば独立 desync 経路に乗るはず
- 実装: 3 つの tet canvas を `<div class="canvas-shadow">` で囲み，box-shadow をクラス側に移動．同時に `will-change / translateZ(0) / contain` を撤去
- 結果: ユーザ実機で**操作遅延がむしろ増えた感覚**＋灰色横棒線（フレームドロップ）も増加
- 解釈: `will-change` を剥がしたことで canvas が親 `#container` (transform:scale 持ち) と同一レイヤとなり，canvas 更新ごとに親レイヤ全体の再合成が発生．desync 経路の効果より独立レイヤ化の効果のほうが支配的だった
- 対処: 同セッション内で `git checkout -- index.html src/styles/style.css` で完全 revert
- 教訓:
  - `desynchronized:true` と「独立 compositor layer」を相反扱いするのは誤り
  - `will-change` を気休めと見なして外すと，ancestor transform 持ちページでは確実に悪化
  - 次に同方向を試すなら **`will-change / translateZ` は維持したまま box-shadow だけ wrapper に逃がす A/B** にすべき

### 5.2 ProMotion 適応制御を疑い 120Hz 固定検証（**実施不能**）

- 仮説: macOS が「Web ページはアイドル」と判定して内蔵 ProMotion を 60Hz に落としているのでは
- 試行: システム設定 → ディスプレイ → リフレッシュレートを「120Hz」固定にしたい
- 結果: M4 MacBook Pro 内蔵ディスプレイには **「120Hz」の固定選択肢が存在しない**（ProMotion / 60 / 59.94 / 50 / 48 / 47.95 のみ．後者は動画用の固定低レート）
- 解釈: 内蔵 Liquid Retina XDR では 120Hz を出す経路が ProMotion 一本しかない仕様．**OS 設定からはこの仮説を検証できない**

### 5.3 BGM/SE などの音声キャッシュ（**検証は安価／本命ではない**）

- 仮説: 音声まわりが描画に干渉している可能性
- 判定: 「表示の遅延 21ms 常時」という症状の形（スパイクではなく一定値）から本命ではないと判断
- ユーザ側でミュート検証推奨（実装変更不要）

## 6. 切り分け確定事項

| 観点 | 結果 |
|---|---|
| **OS 依存** | **Windows では同コードでカクつき無し** ← 最重要．Mac 固有 |
| **ブラウザ依存** | Chrome / Safari の両方で同遅延 → **ブラウザ実装の問題ではなく macOS の合成パイプライン問題** |
| **JS 負荷** | DevTools プロファイル上「処理期間 0ms」.「JS が遅い」ではない |
| **GC** | heap ほぼ平坦．「ゴミが多い」でもない |
| **コード側でやれること** | 出尽くした．これ以上いじっても Mac の症状は直らない |

## 7. macOS Chrome / Safari 描画パイプの構造的制約

ユーザ環境で残る 21ms の出どころ：

1. **Core Animation 経由の合成が必須**
   Chrome (Skia) も Safari (WebKit) も，描画結果は **CALayer に渡され macOS WindowServer が合成**する．Windows の DirectComposition のように GPU 側で完結できない．これだけで +1 vsync ぶん（8〜16ms）食う構造
2. **`desynchronized: true` が macOS で実質効かない**
   Chromium 側で「macOS では desync 効果薄」という既知挙動．`getContextAttributes().desynchronized === true` でも実体は普通の経路を通る
3. **ProMotion の適応制御**
   Web ページ用 CALayer に対しては 120Hz 全開を維持しないケースがある．Web 側からは制御不能
4. **GPU プロセス → ブラウザプロセス → WindowServer の IPC 段数**
   Windows より 1〜2 frame ぶんバッファリングしがち

## 8. アプリ化での解消可能性

| 方式 | 遅延解消 | 既存コード流用 |
|---|---|---|
| Electron | ❌ Chromium そのまま乗せるだけ | ◎ |
| Tauri / WKWebView | ❌ Safari と同じ WebKit + Core Animation 経路 | ◎ |
| ネイティブ Swift + Metal | ✅ vsync 直結で物理下限まで落ちる | × 全書き直し |
| Unity / Godot 移植 | ✅ ブラウザ非経由 | × 全書き直し |

→ **アプリ化で macOS 遅延を消す現実的選択肢は無い**．Web 配布前提で問題なし

## 9. 結論と推奨運用

- **コード側の対策は完了扱い**．今後 tet モードで「カクつく」報告が来ても，Mac 環境であれば構造的問題として扱う
- 主開発・主動作確認は **Windows 機を基準**にする．Mac は許容
- 「カクつきます」と問い合わせを受けた場合の案内候補：
  - Chrome ハードウェアアクセラレーション ON 確認（既定 ON）
  - `chrome://flags/#enable-zero-copy` / `#enable-gpu-rasterization` → Enabled
  - **Windows 機で試してください**（最終手段）
- 次に深追いするとしたら：コードではなく `chrome://gpu` の Metal 有効状態・macOS Chrome の起動フラグ調査の方向．コード最適化は打ち止め

## 10. 関連メモ（auto memory）

- `project-tet-input-lag` — 本件の経緯（決着済み）
- `project_render_stutter_gc` — versus の GC churn 調査（puyo 側．こちらは効果あり）
- `build_script_versioning` — `index.html` の `?v=` バンプ規約
- `feedback-versus-cpu-verification` — CPU/対戦系の検証はユーザ側で行う方針
