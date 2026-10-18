"""評価の項（提案3 など）を lv6 に足した候補を、本番 lv6 と VERSUS で A/B 比較する。

  python3 py/ab_eval.py [--set e1|e2|h|h2|k|t|p] [--seeds 300] [--opp lv6|lv5]
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
from train import named_policy  # noqa: E402
from solo_baseline import I_P1_ALPHA, I_TERRAIN_MAX, I_KEEP_D, I_KEEP_W, I_H2, I_H_KEEP, I_H_REACH, I_H_MAXC, I_H_MIN, I_QEXCESS_W, I_QJUNK_W, I_QSUB_W, with_build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def configs(base: dict, which: str) -> dict[str, ps.Policy]:
    lv6 = ps.Policy.lv6(base)
    if which == "e1":
        return {f"lv6 qx{v}": with_build(lv6, {I_QEXCESS_W: v}) for v in (-60, -100, -200)}
    if which == "e2":   # 提案3 E2a（ゴミ×埋まり具合）/ E2b（副砲）
        return {
            "lv6 junk-30": with_build(lv6, {I_QJUNK_W: -30}),
            "lv6 junk-60": with_build(lv6, {I_QJUNK_W: -60}),
            "lv6 sub40": with_build(lv6, {I_QSUB_W: 40}),
            "lv6 junk-60 sub40": with_build(lv6, {I_QJUNK_W: -60, I_QSUB_W: 40}),
        }
    if which == "h":    # 段階2 H1 催促（個数・段数上限・残す本線%）／H2 対応（§9.4）
        h2 = {I_H2: 1}
        h1 = lambda n, k, keep: {I_H_MIN: n, I_H_MAXC: k, I_H_KEEP: keep}
        return {
            "lv6 H2": with_build(lv6, h2),
            "lv6 H1(12,3,80)": with_build(lv6, h1(12, 3, 80)),
            "lv6 H1(6,3,80)": with_build(lv6, h1(6, 3, 80)),
            "lv6 H1(18,4,80)": with_build(lv6, h1(18, 4, 80)),
            "lv6 H1(12,3,60)": with_build(lv6, h1(12, 3, 60)),
            "lv6 H1(12,3,95)": with_build(lv6, h1(12, 3, 95)),
            "lv6 H1(12,3,80)+H2": with_build(lv6, {**h1(12, 3, 80), **h2}),
            "lv6 H1(12,3,80)+H2+E2": with_build(lv6, {**h1(12, 3, 80), **h2, I_QJUNK_W: -60, I_QSUB_W: 40}),
        }
    if which == "h2":   # H1 に「撃った後に残す本線の絶対量」（個）を加えた版（§9.9）
        h1 = lambda n, k, keep, reach: {I_H_MIN: n, I_H_MAXC: k, I_H_KEEP: keep, I_H_REACH: reach}
        return {
            "lv6 H1(12,3,80,r300)": with_build(lv6, h1(12, 3, 80, 300)),
            "lv6 H1(12,3,80,r500)": with_build(lv6, h1(12, 3, 80, 500)),
            "lv6 H1(12,3,80,r700)": with_build(lv6, h1(12, 3, 80, 700)),
            "lv6 H1(12,3,0,r500)": with_build(lv6, h1(12, 3, 0, 500)),
            "lv6 H1(18,4,80,r500)": with_build(lv6, h1(18, 4, 80, 500)),
            "lv6 H1(12,3,80,r500)+H2+E2": with_build(lv6, {**h1(12, 3, 80, 500), I_H2: 1, I_QJUNK_W: -60, I_QSUB_W: 40}),
        }
    if which == "k":    # §13.4 提案5 発火点の保全（qKeepWeight・掛ける深さ）
        return {f"lv6 K{v} d{d}": with_build(lv6, {I_KEEP_W: v, I_KEEP_D: d}) for v, d in
                ((0, 0), (2, 0), (5, 0), (10, 0), (5, 2), (20, 0), (1, 0), (-1, 0), (-2, 0), (-5, 0))}
    if which == "t":    # §13.5 T 地形優先の対応（この受け量以下は fast に入らず、降った後の地形が最大の手）
        return {f"lv6 T{v}": with_build(lv6, {I_TERRAIN_MAX: v}) for v in (0, 6, 12, 18, 29)}
    if which == "p":    # §13.6 P 相手を見て撃つ（目標発火の相手比 %）
        return {f"lv6 P{v}": with_build(lv6, {I_P1_ALPHA: v}) for v in (100, 110, 130, 160, 200)}
    raise ValueError(which)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="e1", choices=["e1", "e2", "h", "h2", "k", "t", "p"])
    ap.add_argument("--seeds", type=int, default=300)
    ap.add_argument("--opp", default="lv6", choices=["lv6", "lv6h2", "lv6g", "lv5"])   # lv6h2＝lv6＋H2 対応
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    base = ps.load_baseline()
    opp = {"lv6": lambda: ps.Policy.lv6(base),
           "lv6h2": lambda: with_build(ps.Policy.lv6(base), {I_H2: 1}),
           "lv6g": lambda: named_policy("lv6g", base),
           "lv5": lambda: ps.Policy.baseline(base)}[args.opp]()
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
