# THIRD PARTY NOTICES

TETLABO のソースコードは原則として [MIT License](LICENSE) で提供していますが、以下のファイル・素材は**例外**です。
これらは各権利者のライセンス・利用規約に従い、TETLABO の MIT License の対象には含まれません。

| 対象 | ライセンス / 条件 | 詳細 |
|---|---|---|
| `public/cpu/tet/lv6/native/tslot.cpp`, `tslot.h` | MPL-2.0 | [Cold Clear](#cold-clear) |
| `public/cpu/puyo/lv4/native/`, `public/cpu/puyo/lv5/native/` の Ama 由来部分 | MIT（著作権表示の保持が必要） | [Ama](#ama) |
| `public/cpu/tet/lv6/pc/native/pc6.cpp` の sfinder 準拠部分 | MIT（著作権表示の保持が必要） | [solution-finder](#solution-finder) |
| `public/assets/audio/` 以下の音声ファイル | 各配布元の利用規約 | [音声素材](#音声素材) |
| `public/assets/quizlevels/` の一部レベル | 再利用不可 | [クイズデータ](#クイズデータ) |

---

## プログラム

### Cold Clear

- Repository: https://github.com/MinusKelvin/cold-clear
- License: Mozilla Public License 2.0（https://mozilla.org/MPL/2.0/）
- 対象: `public/cpu/tet/lv6/native/tslot.cpp`, `public/cpu/tet/lv6/native/tslot.h`
- 内容: `bot/src/evaluation/standard.rs` の T-slot 検出（`tst_twist_*` / `fin_*` ほか）を C++ に移植・改変したもの。

上記2ファイルは MPL-2.0 の対象であり、改変して配布する場合もソースコードを MPL-2.0 で公開する必要があります。
MPL-2.0 はファイル単位の条件であるため、それ以外の TETLABO のファイルには影響しません。

```
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/.
```

### Ama

- Repository: https://github.com/citrus610/ama
- License: MIT
- 対象: `public/cpu/puyo/lv4/native/` および `public/cpu/puyo/lv5/native/` の
  `eval/shape.*`, `eval/form.*`, `eval/eval.cpp`, `build/build.*`, `core/weights.h`, `core/bitboard.h`, `cpu4.cpp` / `cpu5.cpp`
- 内容: 盤面形状評価・form テンプレート・潜在連鎖スコア選択（search_multi）・PRUNE 等を移植・改変したもの。

```
MIT License

Copyright (c) 2023 citrus610

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### solution-finder

- Repository: https://github.com/knewjade/solution-finder
  （.NET ラッパー [PerfectClearNET](https://github.com/mat1jaczyyy/PerfectClearNET) 経由で参照）
- License: MIT
- 対象: `public/cpu/tet/lv6/pc/native/pc6.cpp`
- 内容: パーフェクトクリア探索（leftLine 追跡 DFS・`validate` / `isWallBetween` / `calcScore` 相当）を参考に実装したもの。

```
MIT License

Copyright (c) 2020 knewjade

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 謝辞（コードは含まれていません）

以下のプロジェクトは、アルゴリズムの考え方のみを参考にしました。コードは含まれていません。

- Hoiko — https://github.com/ultimacrown/HoikoCode20230120
- Zetris — https://github.com/ZetrisAI/Zetris

---

## 音声素材

`public/assets/audio/` 以下の BGM・効果音は各作者・配布元に権利があり、**TETLABO の MIT License の対象外**です。
TETLABO 内での再生のためにのみ同梱しています。素材として再利用・再配布する場合は、各配布元から入手し、その利用規約に従ってください。
配布元の規約に従い、音源は難読化した `.dat` 形式で同梱しており、TETLABO の実行時にのみ復号して再生します（`scripts/obfuscate_audio.mjs`）。

### BGM

| 作者 | 曲名 | 配布元 | ライセンス / 規約 |
|---|---|---|---|
| Kubbi | Antlers | https://kubbi.bandcamp.com/track/antlers-4 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) ※ |
| Tak_mfk | Neon Velocity | https://zalsoba.booth.pm/items/7439613 | 配布ページの利用条件 |
| まんぼう二等兵 | Clock Jitter | https://opentracks.com/bgm/detail/20144 | [OpenTracks 音源ライセンス](https://opentracks.com/help/articles/license/) |
| まんぼう二等兵 | 晴色カレイドスコープ | https://opentracks.com/bgm/detail/20103 | [OpenTracks 音源ライセンス](https://opentracks.com/help/articles/license/) |
| Lime | Replica | https://gdbg.tv/2018/spark/ | [kanki2.net ガイドライン](http://kanki2.net/#guidelines) |
| Springin' Sound Stock | フューチャー3 | https://www.springin.org/sound-stock/ | [Springin' Sound Stock ガイドライン](https://www.springin.org/sound-stock/guideline/) |
| Springin' Sound Stock | テクノ1 | https://www.springin.org/sound-stock/ | [Springin' Sound Stock ガイドライン](https://www.springin.org/sound-stock/guideline/) |
| yuhei komatsu | Gravity | https://opentracks.com/bgm/detail/17384 | [OpenTracks 音源ライセンス](https://opentracks.com/help/articles/license/) |

※ "Antlers" by Kubbi is licensed under CC BY-SA 4.0. TETLABO に同梱しているファイルは、原曲を OGG (Opus) 形式に変換・編集したもので、同じく CC BY-SA 4.0 で提供されます。

### 効果音

| 配布元 | 規約 |
|---|---|
| 効果音ラボ | https://soundeffect-lab.info/faq/ |
| OpenTracks（旧 DOVA-SYNDROME） | https://opentracks.com/help/articles/license/ |
| 効果音辞典 | https://sounddictionary.info/terms-of-use/ |
| フリー効果音素材 くらげ工匠 | http://www.kurage-kosho.info/guide.html |
| Springin' Sound Stock | https://www.springin.org/sound-stock/guideline/ |
| Taira Komori | https://taira-komori.net/welcome.html |

---

## クイズデータ

`public/assets/quizlevels/tdata.json`, `pdata.json` のうち、以下のレベルには第三者が作成した問題の盤面が含まれるため、**TETLABO の MIT License の対象外**です（自作の盤面に差し替える予定です）。

- TET: `tet-10`, `tet-1.6`, `tet-1.8`, `tet-1.9`
- PUYO: `puyo-5`, `puyo-6`, `puyo-8`, `puyo-9`, `puyo-10`, `puyo-1.1` 〜 `puyo-2.0`

---

## 商標について

TETLABO は非公式のファンメイド作品であり、The Tetris Company および株式会社セガとは一切関係ありません。
Tetris は The Tetris Company の商標、ぷよぷよ は株式会社セガの商標です。
