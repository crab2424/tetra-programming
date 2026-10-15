"""評価の項（提案3 など）を lv6 に足した候補を、本番 lv6 と VERSUS で A/B 比較する。

  python3 py/ab_eval.py [--set e1] [--seeds 300] [--opp lv6|lv5]
  先後2局×シード数で、候補視点の勝率と 95% 幅（シードごとの先後2局の平均のばらつきから）を出す。
  シードは学習・定期評価・記録と重ならない 960000〜 を使う。
設計: source_assets/memory/cpu/puyo/lv6-harass-design.md
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from solo_baseline import I_QEXCESS_W, with_build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def configs(base: dict, which: str) -> dict[str, ps.Policy]:
    lv6 = ps.Policy.lv6(base)
    if which == "e1":
        return {f"lv6 qx{v}": with_build(lv6, {I_QEXCESS_W: v}) for v in (-60, -100, -200)}
    raise ValueError(which)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="e1", choices=["e1"])
    ap.add_argument("--seeds", type=int, default=300)
    ap.add_argument("--opp", default="lv6", choices=["lv6", "lv5"])
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    base = ps.load_baseline()
    opp = ps.Policy.lv6(base) if args.opp == "lv6" else ps.Policy.baseline(base)
    cfg = configs(base, args.set)
    if args.only:
        keep = set(args.only.split(","))
        cfg = {k: v for k, v in cfg.items() if k in keep}
    seeds = np.arange(960000, 960000 + args.seeds, dtype=np.uint32)
    names = list(cfg)
    t = time.time()
    r = ps.play_both_sides(np.stack([cfg[n].packed() for n in names]), opp.packed(), seeds)
    lines = [f"## A/B {args.set}（相手 {args.opp}・{args.seeds}シード×先後＝{2 * args.seeds}局・{time.time() - t:.0f}秒）",
             "| 候補 | 勝率 | 95%幅 |", "|---|---|---|"]
    for i, n in enumerate(names):
        per_seed = r["score"][:, i, :].mean(axis=0)
        half = 1.96 * per_seed.std(ddof=1) / np.sqrt(len(per_seed))
        lines.append(f"| {n} | {r['winRate'][i]:.3f} | ±{half:.3f} |")
    text = "\n".join(lines)
    print(text)
    out = ROOT / "runs" / "analysis" / f"ab_{args.set}_vs_{args.opp}.md"
    out.write_text(text + "\n")
    print(f"→ {out}")


if __name__ == "__main__":
    main()
