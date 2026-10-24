"""§18 H2（後打ち）で勝敗が変わった局の確認（lv6-vstet/4-stability-fg.md §18.17）。

  python3 py/vstet_h2_check.py <base.jsonl> <h2q.jsonl>
base で「届く前に撃った」カウンターの連鎖（受け量はゲージ込みで 13個超え・届いた分は 13個以下）について、
連鎖の途中でテトから届いたおじゃまと、段ごとの相殺（stepOff 3＝ただの相殺）を数える。記録は tetsim.trace_vstet。
"""
import json
import sys
from collections import Counter

T, TURN, MODE, INC, QUEUE, FIRE = range(6)


def load(p):
    return {d["seed"]: d for d in map(json.loads, open(p, encoding="utf-8"))}


def early_fires(game):
    """base のゲージで入ったカウンターの発火（その手の届いた分 ≤ 13 かつ受け量 > 届いた分）"""
    turns = {t[TURN]: t for t in game["P"]["turns"]}
    out = []
    for f in game["P"]["fires"]:
        t = turns.get(f["turn"])
        if f["mode"] == 1 and t and t[QUEUE] <= 13 and t[INC] > t[QUEUE]:
            out.append((f, t))
    return out


def summarize(f):
    so, sq = f["stepOff"], f["stepQueue"]
    free_after = sum(1 for k, (o, q) in enumerate(zip(so, sq)) if o == 3 and q > f["queue"])
    return (f"t={f['t0'] / 1000:.1f}s {f['chains']}連鎖 {f['score']}点 撃つ前の受け {f['queue']}・連鎖中に届いた {f['arrived']}"
            f"・段の受け {sq}・相殺 {so}（3＝ただ）・相殺 {f['offset']}・送 {f['sent']}")


def main():
    base, var = load(sys.argv[1]), load(sys.argv[2])
    allf = [ft for g in base.values() for ft in early_fires(g)]
    arrived = [f for f, _ in allf if f["arrived"] > 0]
    free_arr = [f for f in arrived if any(o == 3 and q > f["queue"] for o, q in zip(f["stepOff"], f["stepQueue"]))]
    any_free = [f for f, _ in allf if 3 in f["stepOff"]]
    print(f"base の届く前のカウンター発火 {len(allf)} 回：連鎖中に届いた {len(arrived)}・その届いた分を後の段でただの相殺 {len(free_arr)}"
          f"・どこかの段でただの相殺 {len(any_free)}")
    print("  段数", Counter(f["chains"] for f, _ in allf).most_common(), " 撃つ時点のゲージ換算 中央",
          sorted(t[INC] - t[QUEUE] for _, t in allf)[len(allf) // 2])
    flips = Counter()
    seeds = {}
    for s, b in base.items():
        d = (var[s]["winner"] == 0) - (b["winner"] == 0)
        if d == 0:
            continue
        ef = early_fires(b)
        f_arr = any(f["arrived"] > 0 for f, _ in ef)
        f_free = any(any(o == 3 and q > f["queue"] for o, q in zip(f["stepOff"], f["stepQueue"])) for f, _ in ef)
        flips[(d, bool(ef), f_arr, f_free)] += 1
        seeds.setdefault((d, bool(ef)), []).append(s)
    print("勝敗が変わった局（変化, base で届く前に撃った, 連鎖中に届いた, 届いた分をただの相殺）:")
    for k, n in sorted(flips.items()):
        print("  ", k, n)
    for k, v in sorted(seeds.items()):
        print("  シード", k, v)
    if len(sys.argv) > 3:
        for s in map(int, sys.argv[3].split(",")):
            b, v = base[s], var[s]
            print(f"\n== seed {s}  base {'勝' if b['winner'] == 0 else '負'} → h2q {'勝' if v['winner'] == 0 else '負'}")
            for f, t in early_fires(b)[:2]:
                print("  base 届く前:", summarize(f), f"（ゲージ換算 {t[INC] - t[QUEUE]}）")
                t0 = f["t0"]
                for g in (v["P"]["fires"]):
                    if t0 - 1500 <= g["t0"] <= t0 + 8000:
                        print("    h2q 発火:", "mode", g["mode"], "理由", g["reason"], summarize(g))
                drops = [(round(d[0] / 1000, 1), d[2]) for d in v["P"]["drops"] if t0 - 1500 <= d[0] <= t0 + 8000]
                print("    h2q 降った:", drops)


if __name__ == "__main__":
    main()
