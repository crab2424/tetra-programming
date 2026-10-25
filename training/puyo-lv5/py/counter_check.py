"""§10.5 少量の催促で fast（カウンター）に入り形が崩れる問題の記録（lv6-harass-design.md §13.5）。

    python3 py/counter_check.py [--seeds 300] [--cand lv6] [--opp lv6g] [--set counterTerrainMax=18] [--tag 名前]

記録付き対局（先後）で、候補がカウンター（fast）に入ってから抜けるまでを1回として数える。
受け量（入った時点）ごとに：回数・手数・撃てたか・降ったか・本線（起こせる連鎖）の変化・その局の勝率。
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from analyze_losses import FIRE, IGN, INC, MODE, PUYOS, TURN  # noqa: E402
import params as P  # noqa: E402
from train import named_policy  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "runs" / "analysis"
MAINSUB = 17
BINS = [(1, 6), (7, 12), (13, 18), (19, 29), (30, 10 ** 9)]


def episodes(P: dict) -> list[dict]:
    """mode==1（fast）が続いた区間。前後の手の起こせる連鎖・本線の段数で崩れ方を見る。"""
    T = P["turns"]
    out, i = [], 0
    while i < len(T):
        if T[i][MODE] not in (1, 4):   # 1=カウンター（fast） 4=地形優先の対応（T）
            i += 1
            continue
        j = i
        while j < len(T) and T[j][MODE] in (1, 4):
            j += 1
        before = T[i - 1] if i > 0 else T[i]
        after = T[j] if j < len(T) else None
        drops = [d for d in P["drops"] if T[i][TURN] <= d[1] <= (T[j - 1][TURN] + 1)]
        out.append({
            "inc": T[i][INC], "len": j - i, "fired": any(x[FIRE] > 0 for x in T[i:j]),
            "dropped": sum(d[2] for d in drops),
            "ignBefore": before[IGN][0], "ignAfter": after[IGN][0] if after else None,
            "mainBefore": before[MAINSUB][0], "mainAfter": after[MAINSUB][0] if after else None,
            "turn": T[i][TURN],
        })
        i = j
    return out


def report(path: Path, label: str) -> list[str]:
    by = defaultdict(list)
    cf, wins = [], []
    n = 0
    for line in path.open():
        g = json.loads(line)
        n += 1
        for side, me in (("A", 0), ("B", 1)):
            if g["cand"] != side:
                continue
            win = 1.0 if g["winner"] == me else 0.0 if g["winner"] == 1 - me else 0.5
            wins.append(win)
            cf += [(f["chains"], f["pb"] - f["pa"], f["offset"]) for f in g[side]["fires"] if f["mode"] in (1, 4)]
            for e in episodes(g[side]):
                b = next(k for k, (lo, hi) in enumerate(BINS) if lo <= e["inc"] <= hi)
                by[b].append(dict(e, win=win))
    L = [f"### {label}（{n} 局）",
         "| 入った時の受け量 | 回/局 | 手数 | 撃てた | 降った量 | 起こせる連鎖 前→後 | 本線の段数 前→後 | 局の勝率 |",
         "|---|---|---|---|---|---|---|---|"]
    a = np.array(cf) if cf else np.zeros((1, 3))
    L.insert(1, f"- 勝率 {np.mean(wins):.3f}・カウンター中の発火 {len(cf) / n:.2f} 回/局"
                f"（平均 {a[:, 0].mean():.1f} 連鎖・色ぷよ {a[:, 1].mean():.1f} 個・相殺 {a[:, 2].mean():.1f} 個）")
    for k, (lo, hi) in enumerate(BINS):
        es = by.get(k, [])
        if not es:
            continue
        done = [e for e in es if e["ignAfter"] is not None]
        L.append(f"| {lo}〜{hi if hi < 10 ** 8 else ''} | {len(es) / n:.2f} | {np.mean([e['len'] for e in es]):.1f} | "
                 f"{np.mean([e['fired'] for e in es]):.0%} | {np.mean([e['dropped'] for e in es]):.1f} | "
                 f"{np.mean([e['ignBefore'] for e in done]):.1f}→{np.mean([e['ignAfter'] for e in done]):.1f} | "
                 f"{np.mean([e['mainBefore'] for e in done]):.1f}→{np.mean([e['mainAfter'] for e in done]):.1f} | "
                 f"{np.mean([e['win'] for e in es]):.2f} |")
    return L


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=300)
    ap.add_argument("--cand", default="lv6")
    ap.add_argument("--opp", default="lv6g")
    ap.add_argument("--tag", default="")
    ap.add_argument("--set", action="append", default=[], help="候補の build を 名前=値 で書き換える")
    args = ap.parse_args()
    base = ps.load_baseline()
    cand, opp = named_policy(args.cand, base), named_policy(args.opp, base).packed()
    for kv in args.set:   # 例: --set counterTerrainMax=18
        k, v = kv.split("=", 1)
        cand.build[P.NAMED[k].index] = int(v)
    cand = cand.packed()
    seeds = np.arange(960000, 960000 + args.seeds, dtype=np.uint32)
    OUT.mkdir(parents=True, exist_ok=True)
    tag = args.tag or f"{args.cand}_vs_{args.opp}"
    raw = OUT / f"counter_{tag}.raw.jsonl"
    n = len(seeds)
    ps.trace_matches(np.concatenate([np.tile(cand, (n, 1)), np.tile(opp, (n, 1))]),
                     np.concatenate([np.tile(opp, (n, 1)), np.tile(cand, (n, 1))]),
                     np.concatenate([seeds, seeds]), raw)
    path = OUT / f"counter_{tag}.jsonl"
    with raw.open() as fi, path.open("w") as fo:
        for line in fi:
            g = json.loads(line)
            g["cand"] = "A" if g["job"] < n else "B"
            fo.write(json.dumps(g) + "\n")
    raw.unlink()
    text = "\n".join(report(path, f"{args.cand}（相手 {args.opp}）"))
    print(text)
    (OUT / f"counter_{tag}.md").write_text(text + "\n")


if __name__ == "__main__":
    main()
