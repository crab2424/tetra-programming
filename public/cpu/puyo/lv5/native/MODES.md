# ぷよCPU lv5 — 探索モード

`searchBestMovePuyoWasm`（`cpu5.cpp`）が、JS から受け取った重みに応じて
モード別の探索ルーチンへ振り分ける。各モードは `native/<mode>/` に
`<mode>.h` / `<mode>.cpp` を置き、`searchBestMovePuyoWasm` 内で呼び出す。

## 実装済み

| モード | ディレクトリ | 概要 |
|--------|--------------|------|
| `build` | `build/` | 連鎖を組むモード（現行の本命戦略）。確定NEXT(TETLABO内部20本)を1本のビームで深く読み、各初手の到達連鎖スコア（quiescence潜在＋実発火）を巻き上げて初手を選ぶ。Ama `search_multi` 由来・確定NEXT版。 |

## 未実装（構想のみ）

`free` / `fast` / `allClear` を将来追加する想定。実装する際の手順:

1. `native/<mode>/<mode>.h` / `<mode>.cpp` を追加する。
2. `native/build.sh` の `SRCS` に `<mode>/<mode>.cpp` を足す。
3. `native/cpu5.cpp` の `searchBestMovePuyoWasm` 内のモード振り分けに登録する。

ama-beam の `ai/search/{dfs,beam}` の構成（`source_assets/puyoAI/ama-beam`）が参考になる。
ビーム探索のノード型・盤面ハッシュは全モード共通で `core/node.h` にある。
