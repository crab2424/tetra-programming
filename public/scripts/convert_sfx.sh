#!/usr/bin/env bash
#
# convert_sfx.sh — SE素材の mp3/wav を Ogg-Opus に変換する
#
# sfx_source配下（購入・DL直後の効果音素材）を、そのまま
#   1. 一度だけ Opus(libopus) へエンコード（低ビットレートで Vorbis より高音質）
# して sfx_ogg 配下へ書き出します。無音カット等は行いません（trim_bgm.sh の担当）。
# 出力は拡張子 .ogg（Ogg コンテナの Opus）。Opus の仕様上、サンプルレートは
# 常に 48kHz へ変換されます。
#
# 出力ファイルが既に存在する場合は変換をスキップします（-f で上書き）。
# 同名の入力ファイルが複数ディレクトリにあっても、先に処理した方が出力を
# 作った時点で以降は自動的にスキップされます＝重複変換なし。
#
# 必要ツール: ffmpeg(libopus付き)
#   brew install ffmpeg     # 通常 libopus を含む
#
# 使い方:
#   convert_sfx.sh [オプション] [入力ファイル...]
#
# オプション:
#   -i DIR    入力ディレクトリ (デフォルト: ./sfx_source)。個別ファイル引数を
#             渡した場合はそちらを優先し、このディレクトリのスキャンはしない。
#   -o DIR    出力先ディレクトリ (デフォルト: ./sfx_ogg)
#   -b KBPS   Opus のビットレート kbps (デフォルト: 96)
#   -r        入力ディレクトリを再帰的に探索し、出力側もサブディレクトリ構成を保つ
#             （将来 sfx_source 配下を se/tet・se/puyo 等に分けた場合向け）
#   -f        出力先に同名ファイルがあっても上書きする
#   -h        このヘルプを表示
#
# 例:
#   # source_assets 直下で実行し、sfx_source の全 mp3/wav を sfx_ogg へ変換
#   cd source_assets && ../public/scripts/convert_sfx.sh
#
#   # 入出力ディレクトリを明示的に指定（拡張用）
#   public/scripts/convert_sfx.sh -i some/other/source -o some/other/ogg
#
#   # 個別ファイルだけ変換
#   public/scripts/convert_sfx.sh -o sfx_ogg "sfx_source/決定ボタンを押す24.mp3"
#
#   # サブディレクトリ構成を保ったまま再帰変換
#   public/scripts/convert_sfx.sh -r -i sfx_source -o sfx_ogg
#
set -euo pipefail

INDIR="./sfx_source"
OUTDIR="./sfx_ogg"
BITRATE=96
FORCE=0
RECURSE=0

usage() {
  # 先頭のコメントブロック（shebang を除く）だけをヘルプとして表示
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  exit "${1:-0}"
}

while getopts ":i:o:b:rfh" opt; do
  case "$opt" in
    i) INDIR="$OPTARG" ;;
    o) OUTDIR="$OPTARG" ;;
    b) BITRATE="$OPTARG" ;;
    r) RECURSE=1 ;;
    f) FORCE=1 ;;
    h) usage 0 ;;
    :) echo "エラー: -$OPTARG には値が必要です" >&2; exit 2 ;;
    \?) echo "エラー: 不明なオプション -$OPTARG" >&2; usage 2 ;;
  esac
done
shift $((OPTIND - 1))

# 必要なコマンドの存在チェック
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "エラー: 'ffmpeg' が見つかりません。 brew install ffmpeg" >&2
  exit 3
fi

# libopus エンコーダの存在チェック
if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q '\blibopus\b'; then
  echo "エラー: この ffmpeg は libopus 非対応です。 brew reinstall ffmpeg などで libopus 付きを入れてください" >&2
  exit 3
fi

# 変換対象リストを組み立てる： "入力パス<TAB>出力パス" の行の配列
targets=()

if [ "$#" -gt 0 ]; then
  # 個別ファイル指定：出力はすべて OUTDIR 直下（サブディレクトリは保たない）
  for in in "$@"; do
    base="$(basename "$in")"
    name="${base%.*}"
    targets+=("$in"$'\t'"$OUTDIR/$name.ogg")
  done
else
  if [ ! -d "$INDIR" ]; then
    echo "エラー: 入力ディレクトリが見つかりません: $INDIR" >&2
    exit 2
  fi
  find_opts=(-type f \( -iname '*.mp3' -o -iname '*.wav' \))
  [ "$RECURSE" -eq 0 ] && find_opts=(-maxdepth 1 "${find_opts[@]}")
  while IFS= read -r -d '' in; do
    if [ "$RECURSE" -eq 1 ]; then
      rel="${in#"$INDIR"/}"
      reldir="$(dirname "$rel")"
      base="$(basename "$in")"
      name="${base%.*}"
      if [ "$reldir" = "." ]; then
        out="$OUTDIR/$name.ogg"
      else
        out="$OUTDIR/$reldir/$name.ogg"
      fi
    else
      base="$(basename "$in")"
      name="${base%.*}"
      out="$OUTDIR/$name.ogg"
    fi
    targets+=("$in"$'\t'"$out")
  done < <(find "$INDIR" "${find_opts[@]}" -print0 | sort -z)
fi

if [ "${#targets[@]}" -eq 0 ]; then
  echo "変換対象がありません（$INDIR に mp3/wav が無いか、指定ファイルが空です）" >&2
  exit 0
fi

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null; }

printf '%-28s %10s   %-s\n' "file" "dur(s)" "output"
printf '%s\n' "------------------------------------------------------------------------"

status=0
for pair in "${targets[@]}"; do
  in="${pair%%$'\t'*}"
  out="${pair#*$'\t'}"

  if [ ! -f "$in" ]; then
    echo "スキップ(見つからない): $in" >&2
    status=1
    continue
  fi

  if [ -e "$out" ] && [ "$FORCE" -ne 1 ]; then
    echo "スキップ(既に変換済み / -f で上書き): $out" >&2
    continue
  fi

  mkdir -p "$(dirname "$out")"

  if ffmpeg -hide_banner -loglevel error -y -i "$in" \
        -vn -map_metadata -1 -c:a libopus -b:a "${BITRATE}k" "$out" ; then
    out_dur="$(dur "$out")"
    printf '%-28s %10.2f   %s\n' "$(basename "$in")" "${out_dur:-0}" "$out"
  else
    echo "失敗: $in" >&2
    status=1
  fi
done

exit "$status"
