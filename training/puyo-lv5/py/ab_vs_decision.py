"""提案1（相手を見た発火判断）・提案2（後打ちの活用）の試作を、現行 lv5 と A/B 比較する。

  python3 py/ab_vs_decision.py [--seeds 300] [--only 名前,...]
  候補はすべて lv5 の重みのまま ext[] だけを変える（sim.h ExtIndex）。先後2局×シード数で勝率を出す。
設計: source_assets/memory/cpu/puyo/lv5-vs-decision-design.md
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def configs(base: ps.Policy) -> dict[str, ps.Policy]:
    P1 = dict(p1_enable=1, p1_alpha=100)
    P2 = dict(p2_enable=1, p2_min_incoming=30)
    return {
        "lv5（基準）": base,
        "P2 待つ・build重み": base.with_ext(**P2),
        "P2 待つ・build重み・余裕300ms": base.with_ext(**P2, p2_safety_ms=300),
        "P2 待つ・build重み・余裕800ms": base.with_ext(**P2, p2_safety_ms=800),
        "P2 待つ・fast重み": base.with_ext(**P2, p2_wait_fast=1),
        "P2 待つ・小さい受けでも": base.with_ext(p2_enable=1, p2_min_incoming=1),
        "P1 α100": base.with_ext(**P1),
        "P1 α130": base.with_ext(p1_enable=1, p1_alpha=130),
        "P1 α100＋狙い撃ちk50": base.with_ext(**P1, p1_kill_ratio=50, p1_kill_min=30),
        "P1 α100＋狙い撃ちk75": base.with_ext(**P1, p1_kill_ratio=75, p1_kill_min=30),
        "P1＋P2": base.with_ext(**P1, **P2, p1_kill_ratio=50, p1_kill_min=30),
        # ── 改良版（1回目の結果を受けて）──
        "P2＋足りていれば即撃ち110": base.with_ext(**P2, p2_fire_if_pct=110),
        "P2＋こぼし禁止": base.with_ext(**P2, p2_no_spill=1),
        "P2＋即撃ち110＋こぼし禁止": base.with_ext(**P2, p2_fire_if_pct=110, p2_no_spill=1),
        "P2＋即撃ち150＋こぼし禁止": base.with_ext(**P2, p2_fire_if_pct=150, p2_no_spill=1),
        "P1脅威 α100": base.with_ext(**P1, p1_use_threat=1),
        "P1脅威 α100＋狙い撃ちk50": base.with_ext(**P1, p1_use_threat=1, p1_kill_ratio=50, p1_kill_min=30),
        "P1脅威 α100＋狙い撃ちk30": base.with_ext(**P1, p1_use_threat=1, p1_kill_ratio=30, p1_kill_min=60),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=300)
    ap.add_argument("--only", default="")
    ap.add_argument("--opp", default="lv5", help="lv5 / lv6（runs/build-001/best.json）")
    args = ap.parse_args()
    base = ps.Policy.baseline()
    opp = base
    if args.opp == "lv6":
        b = json.loads((ROOT / "runs" / "build-001" / "best.json").read_text())["policy"]
        opp = ps.Policy(b["build"], b["fast"], b["counterTrigger"], b["counterMargin"])
    seeds = np.arange(950000, 950000 + args.seeds, dtype=np.uint32)
    only = [s for s in args.only.split(",") if s]
    for name, pol in configs(base).items():
        if only and name not in only:
            continue
        t = time.time()
        r = ps.play_both_sides(pol.packed(), opp.packed(), seeds)
        sc = r["score"].ravel()
        wr = sc.mean()
        se = sc.std(ddof=1) / np.sqrt(len(sc))
        dur = r["durationMs"].mean() / 1000
        print(f"{name:28s} 勝率 {wr:.3f} ±{1.96 * se:.3f}  平均 {dur:.0f}秒/局  ({time.time() - t:.0f}s)", flush=True)


if __name__ == "__main__":
    main()
