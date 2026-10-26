#!/bin/bash
# テト CPU lv6 新探索（レベル36）の P2 の A/B を、対 clys_full・50シード×席入れ替え＝各100局でまとめて回す。
#   設計 source_assets/memory/cpu/tet/lv6-phase1-search-design.md §7。1 run ≒ 5分（12スレッド）。
#   結果 runs/phase0/p2_*.summary.json。既にある run は飛ばす（途中で止めても続きから回せる）。
#   ./py/p2_batch.sh grid            … 段階1：幅 128/256/384/500 × 締め切り 56/80（8 run ≒ 40分）
#   ./py/p2_batch.sh switch [BASE]   … 段階2：BASE（既定 lv6n_w256_t56）に §2.2・L1〜L5 を1つずつ（14 run ≒ 70分）
#   python3 py/phase0_table.py p2_   … 表にする
# 同じ時間帯にまとめて回すこと（思考時間を実測で待ちに入れるので、マシンの負荷で勝率がぶれる）。
set -e
cd "$(dirname "$0")/.."

run() {   # run <名前> <A のプリセット> [--wa 添字=値,...]
    local name="p2_$1"; shift
    local a="$1"; shift
    if [ -f "runs/phase0/$name.summary.json" ]; then
        echo "skip $name"
        return
    fi
    echo "== $name（$a $*）"
    python3 py/phase0.py vs --a "$a" --b clys_full --seeds 50 --name "$name" "$@" > /dev/null
    python3 -c "import json; s=json.load(open('runs/phase0/$name.summary.json')); print(f\"   A 勝率 {s['a_win']:.3f} {[round(x,2) for x in s['ci95']]}  {s['wall_sec']:.0f}s\")"
}

case "${1:-}" in
grid)
    for w in 128 256 384 500; do
        for t in 56 80; do
            run "w${w}_t${t}" "lv6n_w${w}_t${t}"
        done
    done
    ;;
switch)
    BASE="${2:-lv6n_w256_t56}"
    B="${BASE#lv6n_}"
    # 重みの添字は public/cpu/tet/lv6/engine/ai/eval.h の表
    run "${B}_base"      "$BASE"
    run "${B}_selbest"   "$BASE" --wa 56=1                    # 初手をキー最大で選ぶ（原作は visit）
    run "${B}_pcnext"    "$BASE" --wa 54=1                    # §2.2 pc_next に w.pc_next(1000) を掛ける
    run "${B}_trans20"   "$BASE" --wa 55=1,23=-20             # §2.2・L4 transition（行方向の切り替わり）に重み
    run "${B}_trans8"    "$BASE" --wa 55=1,23=-8
    run "${B}_ren10"     "$BASE" --wa 60=10,61=30             # L1 REN を満額で買うのは 最大高さ＋rem ≥ 10 のときだけ（平時 30%）
    run "${B}_ren10z"    "$BASE" --wa 60=10,61=0
    run "${B}_inc50"     "$BASE" --wa 57=-50                  # L2 受ける前提のおじゃま rem 1段あたり
    run "${B}_incd14"    "$BASE" --wa 58=14,59=-200           # L2 最大高さ＋rem が 14 を超えた段に −200
    run "${B}_incboth"   "$BASE" --wa 57=-50,58=14,59=-200
    run "${B}_tq7"       "$BASE" --wa 62=7                    # L3 T の本数を確定 NEXT 7本＋HOLD で数える
    run "${B}_tq14"      "$BASE" --wa 62=14
    run "${B}_nl20"      "$BASE" --wa 63=20                   # L5 消去ありの手に幅の 20% のビーム
    run "${B}_nl40"      "$BASE" --wa 63=40
    ;;
*)
    sed -n 2,8p "$0"
    exit 1
    ;;
esac
