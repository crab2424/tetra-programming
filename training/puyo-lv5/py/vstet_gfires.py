"""§18 G（発火理由 10）が撃った局面の集計（lv6-vstet/4-stability-fg.md §18.10・§18.12 の見方）。

  python3 py/vstet_gfires.py <base.jsonl> <variant.jsonl>
  記録は tetsim.trace_vstet（同じシード）で取る。勝敗が変わった局と、G で撃った手を
  経過秒・届いた量（incoming）・本線そのものを撃ったか（撃った段数＝今撃てる最大）で分ける。
"""
import json
import sys
from collections import Counter, defaultdict

# TraceTurn の並び（sim/api.cpp の JSONL）
T, TURN, MODE, INC, QUEUE, FIRE, REASON, FB_CH, FB_SC, POT_CH, POT_SC, IGN, PUYOS, OJAMA, H = range(15)


def load(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        d = json.loads(line)
        out[d["seed"]] = d
    return out


def main():
    base, var = load(sys.argv[1]), load(sys.argv[2])
    flips = Counter()                 # (G で撃ったか, 変化)
    by = defaultdict(Counter)         # 見方 → 区分 → (+1 負→勝 / −1 勝→負)
    gfires = []
    for seed, v in var.items():
        b = base[seed]
        bw, vw = b["winner"] == 0, v["winner"] == 0      # winner 0＝ぷよの勝ち
        turns = v["P"]["turns"]
        g = [tt for tt in turns if tt[REASON] == 10 and tt[FIRE] > 0]
        gfires += g
        change = (vw - bw)
        flips[(bool(g), change)] += 1
        if not g or change == 0:
            continue
        f = g[0]   # 最初の G 発火（それまでは base と同じ手）
        avg_h = sum(f[H]) / 6
        by["経過"]["0-10s" if f[T] < 10000 else "10-20s" if f[T] < 20000 else "20s+"] += change
        by["届いた量"]["1-5" if f[INC] < 6 else "6" if f[INC] == 6 else "7-11" if f[INC] < 12 else "12+"] += change
        by["本線そのもの"]["yes" if f[FIRE] >= f[FB_CH] else "no"] += change
        by["平均の高さ"]["<6" if avg_h < 6 else "6-8" if avg_h < 8 else "8+"] += change
    n_g = sum(n for (g, _), n in flips.items() if g)
    print(f"G で撃った局 {n_g}・撃った回数 {len(gfires)}")
    print(f"勝敗の変化：G で撃った局 負→勝 {flips[(True, 1)]}・勝→負 {flips[(True, -1)]}／"
          f"撃たなかった局 負→勝 {flips[(False, 1)]}・勝→負 {flips[(False, -1)]}")
    if gfires:
        inc = sorted(f[INC] for f in gfires)
        ts = sorted(f[T] for f in gfires)
        main_self = sum(f[FIRE] >= f[FB_CH] for f in gfires)
        print(f"撃った手：届いた量 中央 {inc[len(inc) // 2]}・経過 中央 {ts[len(ts) // 2] / 1000:.1f}s・"
              f"本線そのもの {main_self}/{len(gfires)}・段数 {Counter(f[FIRE] for f in gfires).most_common()}")
    for k, c in by.items():
        print(f"  {k}（負→勝 − 勝→負、最初の G 発火で区分）:", "  ".join(f"{a} {n:+d}" for a, n in sorted(c.items())))


if __name__ == "__main__":
    main()
