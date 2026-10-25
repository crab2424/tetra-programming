"""提案1 相手を見て撃つ：保留・狙い撃ちが起きる回数の記録（lv6-harass-design.md §13.6）。

    python3 py/p1_check.py [--seeds 300] [--only 名前,...]

記録付き対局（相手は現行 lv6・先後）で、候補ごとに：
  ・本線級（おじゃま30個以上）の発火の理由の内訳（目標・緊急・延命・催促／後打ちの締切・カウンター）
  ・提案1の保留（目標到達だが相手が返せるので撃たない）・狙い撃ち（目標未達だが相手が返せないので撃つ）の回数
  ・保留・狙い撃ちが起きた局の勝率
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from analyze_losses import BIG, RATE  # noqa: E402
from solo_baseline import I_P1_ALPHA, with_build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "runs" / "analysis"
REASON = {0: "育成", 1: "目標", 2: "緊急", 3: "延命", 4: "催促"}
MODE = {0: "build", 1: "カウンター", 2: "待つ", 3: "締切"}


def configs(base: dict) -> dict[str, ps.Policy]:
    lv6 = ps.Policy.lv6(base)
    return {
        "lv6": lv6,
        "P1 α100": lv6.with_ext(p1_enable=1, p1_alpha=100),
        "P1 α130": lv6.with_ext(p1_enable=1, p1_alpha=130),
        "P1 α100 k50": lv6.with_ext(p1_enable=1, p1_alpha=100, p1_kill_ratio=50, p1_kill_min=30),
        "P1 α100 NEXT": lv6.with_ext(p1_enable=1, p1_alpha=100, p1_use_threat=1),
        "P130": with_build(lv6, {I_P1_ALPHA: 130}),        # 作り直した P（wasm の fire gate。§13.6）
        "P160": with_build(lv6, {I_P1_ALPHA: 160}),
    }


def report(path: Path, name: str, n_seeds: int) -> list[str]:
    reasons, holds, kills, wins, hold_w, kill_w = Counter(), [], [], [], [], []
    n_main = 0
    for line in path.open():
        g = json.loads(line)
        side, me = ("A", 0) if g["job"] < n_seeds else ("B", 1)
        P = g[side]
        win = 1.0 if g["winner"] == me else 0.0 if g["winner"] == 1 - me else 0.5
        wins.append(win)
        holds.append(P["p1Holds"])
        kills.append(P["p1Kills"])
        if P["p1Holds"]:
            hold_w.append(win)
        if P["p1Kills"]:
            kill_w.append(win)
        for f in P["fires"]:
            if f["score"] >= BIG * RATE:
                n_main += 1
                key = REASON.get(f["reason"], "?") if f["mode"] == 0 else MODE.get(f["mode"], "?")
                reasons[key] += 1
    n = len(wins)
    L = [f"### {name}（{n} 局）",
         f"- 勝率 {np.mean(wins):.3f}",
         f"- 本線級の発火 {n_main / n:.2f} 回/局：" + "・".join(f"{k} {v / max(1, n_main):.0%}" for k, v in reasons.most_common()),
         f"- 保留 {np.mean(holds):.2f} 回/局（起きた局 {np.mean([h > 0 for h in holds]):.0%}・その局の勝率 "
         f"{np.mean(hold_w) if hold_w else float('nan'):.2f}）",
         f"- 狙い撃ち {np.mean(kills):.2f} 回/局（起きた局 {np.mean([k > 0 for k in kills]):.0%}・その局の勝率 "
         f"{np.mean(kill_w) if kill_w else float('nan'):.2f}）"]
    return L


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=300)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    base = ps.load_baseline()
    cfg = configs(base)
    if args.only:
        cfg = {k: v for k, v in cfg.items() if k in set(args.only.split(","))}
    opp = ps.Policy.lv6(base).packed()
    seeds = np.arange(960000, 960000 + args.seeds, dtype=np.uint32)
    n = len(seeds)
    OUT.mkdir(parents=True, exist_ok=True)
    lines = [f"## 提案1の記録（相手 lv6・{n}シード×先後）"]
    for name, pol in cfg.items():
        c = pol.packed()
        path = OUT / f"p1_{name.replace(' ', '_')}.jsonl"
        ps.trace_matches(np.concatenate([np.tile(c, (n, 1)), np.tile(opp, (n, 1))]),
                         np.concatenate([np.tile(opp, (n, 1)), np.tile(c, (n, 1))]),
                         np.concatenate([seeds, seeds]), path)
        sec = [""] + report(path, name, n)
        lines += sec
        print("\n".join(sec), flush=True)
    (OUT / "p1_check.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
