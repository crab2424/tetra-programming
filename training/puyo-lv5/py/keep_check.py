"""提案5 発火点の保全（K）の事前確認：ひとり用で途中におじゃまを降らせ、撃てる状態が残るかを見る。

    python3 py/keep_check.py [--seeds 200] [--only 名前,...]

候補ごとに、降らせない基準と「20手目に 6 個／18 個」（notes §4.6 と同じ条件）を同じツモで打ち、
起こせる連鎖（着弾前→後）・起こせなくなった割合・最初の本線の段数・本線が出ないまま60手・窒息を出す
（analyze_losses.harass_report）。降らせない基準の行は、最初の本線そのものの変化（段数・窒息）を見るため。
設計: source_assets/memory/cpu/puyo/lv6-harass-design.md §13.4
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from analyze_losses import harass_report  # noqa: E402
from solo_baseline import I_KEEP_D, I_KEEP_W, with_build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "runs" / "analysis"


def configs(base: dict) -> dict[str, ps.Policy]:
    lv6 = ps.Policy.lv6(base)
    cfg = {"lv6": lv6}
    for v, d in ((2, 0), (5, 0), (10, 0), (5, 2), (20, 0)):
        cfg[f"K{v} d{d}"] = with_build(lv6, {I_KEEP_W: v, I_KEEP_D: d})
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=200)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    cfg = configs(ps.load_baseline())
    if args.only:
        cfg = {k: v for k, v in cfg.items() if k in set(args.only.split(","))}
    seeds = np.arange(930000, 930000 + args.seeds, dtype=np.uint32)
    OUT.mkdir(parents=True, exist_ok=True)
    lines = [f"## 発火点の保全 K（ひとり用・{args.seeds} シード・60手・20手目に降らせる）"]
    for name, pol in cfg.items():
        tag = name.replace(" ", "_")
        paths = {}
        for amt in (0, 6, 18):
            path = OUT / f"keep_{tag}_a{amt}.jsonl"
            ps.trace_solo(pol.packed(), seeds, path, max_turns=60, harass_turn=20 if amt else 0, harass_amount=amt)
            if amt:
                paths[(20, amt)] = path
        sec = harass_report(paths, OUT / f"keep_{tag}_a0.jsonl")
        sec[1] = f"### {name}"
        lines += sec
        print("\n".join(sec), flush=True)
    md = OUT / "keep_check.md"
    md.write_text("\n".join(lines) + "\n")
    print(f"→ {md}")


if __name__ == "__main__":
    main()
