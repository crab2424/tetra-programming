#!/usr/bin/env bash
#
# trim_bgm.sh — BGM/SE の先頭・末尾の無音をカットして Ogg-Opus に変換する
#
# 元の mp3/wav ソース（無劣化のうちに編集するのが理想）から、
#   1. 先頭・末尾の無音だけをカット（曲中の無音は保持）
#   2. 一度だけ Opus(libopus) へエンコード（低ビットレートで Vorbis より高音質）
# します。reverse を使う方式なので、曲の途中にある無音は削られません。
# 出力は拡張子 .ogg のまま（Ogg コンテナの Opus）＝既存の *.ogg 参照に差替可。
# Opus の仕様上、サンプルレートは常に 48kHz へ変換されます。
#
# 必要ツール: ffmpeg(libopus付き) / ffprobe
#   brew install ffmpeg     # 通常 libopus を含む
#
# 使い方:
#   scripts/trim_bgm.sh [オプション] <入力ファイル...>
#
# オプション:
#   -o DIR    出力先ディレクトリ (デフォルト: ./bgm_trimmed)
#   -b KBPS   Opus のビットレート kbps (デフォルト: 96)
#   -d DB     無音と判定するしきい値。数値は -DB として扱う (デフォルト: 50 → -50dB)
#   -n        無音カットをしない（Opus へ変換のみ。-d は無視される）
#   -f        出力先に同名ファイルがあっても上書きする
#   -h        このヘルプを表示
#
# 例:
#   # mp3bgm のソースを 96kbps で書き出し（main から実行する想定）
#   scripts/trim_bgm.sh -b 96 -o assets/audio/bgm_trimmed "../mp3bgm/1-03 Replica.mp3"
#
#   # 複数ファイルをまとめて 64kbps で
#   scripts/trim_bgm.sh -b 64 ../mp3bgm/*.mp3
#
#   # 無音カットせず Opus 変換だけ
#   scripts/trim_bgm.sh -n -b 96 "../mp3bgm/Clock_Jitter.mp3"
#
set -euo pipefail

OUTDIR="./bgm_trimmed"
BITRATE=96
THRESH_DB=50
FORCE=0
TRIM=1

usage() {
  # 先頭のコメントブロック（shebang を除く）だけをヘルプとして表示
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  exit "${1:-0}"
}

while getopts ":o:b:d:nfh" opt; do
  case "$opt" in
    o) OUTDIR="$OPTARG" ;;
    b) BITRATE="$OPTARG" ;;
    d) THRESH_DB="$OPTARG" ;;
    n) TRIM=0 ;;
    f) FORCE=1 ;;
    h) usage 0 ;;
    :) echo "エラー: -$OPTARG には値が必要です" >&2; exit 2 ;;
    \?) echo "エラー: 不明なオプション -$OPTARG" >&2; usage 2 ;;
  esac
done
shift $((OPTIND - 1))

if [ "$#" -eq 0 ]; then
  echo "エラー: 入力ファイルを指定してください" >&2
  usage 2
fi

# 必要なコマンドの存在チェック
for cmd in ffmpeg ffprobe; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "エラー: '$cmd' が見つかりません。 brew install ffmpeg" >&2
    exit 3
  fi
done

# libopus エンコーダの存在チェック
if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q '\blibopus\b'; then
  echo "エラー: この ffmpeg は libopus 非対応です。 brew reinstall ffmpeg などで libopus 付きを入れてください" >&2
  exit 3
fi

mkdir -p "$OUTDIR"

SILREMOVE="silenceremove=start_periods=1:start_threshold=-${THRESH_DB}dB:start_silence=0,areverse,silenceremove=start_periods=1:start_threshold=-${THRESH_DB}dB:start_silence=0,areverse"

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null; }

printf '%-28s %10s %10s   %-s\n' "file" "in(s)" "out(s)" "output"
printf '%s\n' "------------------------------------------------------------------------"

status=0
for in in "$@"; do
  if [ ! -f "$in" ]; then
    echo "スキップ(見つからない): $in" >&2
    status=1
    continue
  fi

  base="$(basename "$in")"
  name="${base%.*}"
  out="$OUTDIR/$name.ogg"

  if [ -e "$out" ] && [ "$FORCE" -ne 1 ]; then
    echo "スキップ(既に存在 / -f で上書き): $out" >&2
    status=1
    continue
  fi

  in_dur="$(dur "$in")"

  # -n 指定時は無音カットのフィルタを付けず、Opus 変換のみ
  af_args=()
  [ "$TRIM" -eq 1 ] && af_args=(-af "$SILREMOVE")

  # ffmpeg 1パスで （無音カット →）Opus(libopus) エンコード
  if ffmpeg -hide_banner -loglevel error -y -i "$in" \
        -vn -map_metadata -1 "${af_args[@]+"${af_args[@]}"}" \
        -c:a libopus -b:a "${BITRATE}k" "$out" ; then
    out_dur="$(dur "$out")"
    printf '%-28s %10.1f %10.1f   %s\n' "$base" "${in_dur:-0}" "${out_dur:-0}" "$out"
  else
    echo "失敗: $in" >&2
    status=1
  fi
done

exit "$status"
