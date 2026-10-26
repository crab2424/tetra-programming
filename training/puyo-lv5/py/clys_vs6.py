"""参考AI clys と lv6（PC 探索あり）の対戦（設計 source_assets/memory/cpu/tet/clys-port-design.md §6）。

探索（PC 探索・ビーム・clys）に実際にかかった時間を操作開始の待ちに入れる（tetsim.set_model_think）。
clys は1手 thinkMs（既定 100ms）まで考える。ツモは本番 VERSUS どおり両者共通（--tumo own で別）。
  python3 py/clys_vs6.py --seeds 100 --threads 12 --name base
結果は runs/clys_vs6/<name>.jsonl（1局1行）と <name>.summary.json。
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

import tetsim
from tvt_baseline import wilson

ROOT = Path(__file__).resolve().parent.parent

PER_GAME = ["tet_attack", "tsd", "tss", "tst", "ts_mini", "tetrises", "pcs", "pc_searches", "pc_found", "pc_aborted",
            "pc_moves", "pc_search_ms", "b2bs", "holds", "tet_sent", "lines_received", "garbage_taken", "max_ren",
            "max_spike", "think_ms", "wait_ms", "pieces", "lines", "dead", "final_height", "route_miss"]


def summarize(res: list[dict]) -> dict:
    n = len(res)
    w = np.array([r["winner"] for r in res])
    score = (w == 0) + 0.5 * (w == -1)
    lo, hi = wilson(score.sum(), n)
    minutes = np.array([r["ms"] for r in res]) / 60000.0
    out = {"games": n, "lv6_win": float(score.mean()), "ci95": [lo, hi], "draws": int((w == -1).sum()),
           "lv6_wins": int((w == 0).sum()), "clys_wins": int((w == 1).sum()), "mean_sec": float(minutes.mean() * 60)}
    for s, name in (("a", "lv6"), ("b", "clys")):
        g = {k: float(np.mean([r[f"{s}_{k}"] for r in res])) for k in PER_GAME}
        tot = {k: float(np.sum([r[f"{s}_{k}"] for r in res])) for k in PER_GAME}
        g["apm"] = tot["tet_attack"] / minutes.sum()
        g["sent_pm"] = tot["tet_sent"] / minutes.sum()
        g["pps"] = tot["pieces"] / (minutes.sum() * 60)
        g["attack_per_piece"] = tot["tet_attack"] / max(tot["pieces"], 1)
        g["think_ms_per_piece"] = tot["think_ms"] / max(tot["pieces"], 1)
        g["wait_ms_per_piece"] = tot["wait_ms"] / max(tot["pieces"], 1)
        g["pc_ms_per_search"] = tot["pc_search_ms"] / max(tot["pc_searches"], 1)
        g["per100"] = {k: 100 * tot[k] / max(tot["pieces"], 1) for k in ("tsd", "tss", "tst", "tetrises", "pcs", "b2bs", "holds")}
        out[name] = g
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=100)
    ap.add_argument("--seed-base", type=int, default=1)
    ap.add_argument("--threads", type=int, default=12)
    ap.add_argument("--max-ms", type=float, default=300000.0)
    ap.add_argument("--tumo", choices=["shared", "own"], default="shared")
    ap.add_argument("--clys-ms", type=int, default=100)
    ap.add_argument("--think-scale", type=float, default=1.0)
    ap.add_argument("--no-pc", action="store_true", help="lv6 を PC 探索なしにする")
    ap.add_argument("--lv6-scale", type=float, default=1.0, help="lv6 のビーム探索時間の倍率（実機 wasm 相当にする）")
    ap.add_argument("--lv6-pc-scale", type=float, default=1.0, help="lv6 の PC 探索時間の倍率（上限 300/100ms で頭打ち）")
    ap.add_argument("--name", default="base")
    args = ap.parse_args()
    tetsim.set_model_think(True, args.think_scale)
    tetsim.set_clys(think_ms=args.clys_ms)
    lv6 = 6 if args.no_pc else tetsim.TET_LV6_PC
    tetsim.set_think_scale(lv6, args.lv6_scale, args.lv6_pc_scale)
    seeds = list(range(args.seed_base, args.seed_base + args.seeds))
    t0 = time.time()
    res = tetsim.vs_run(6 if args.no_pc else tetsim.TET_LV6_PC, tetsim.TET_CLYS, seeds, max_ms=args.max_ms,
                        shared_tumo=args.tumo == "shared", jitter_ms=10.0, threads=args.threads)
    d = ROOT / "runs" / "clys_vs6"
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"{args.name}.jsonl", "w") as f:
        for r in res:
            f.write(json.dumps({k: (float(v) if isinstance(v, (np.floating, float)) else v) for k, v in r.items()}) + "\n")
    s = summarize(res)
    s["args"] = vars(args)
    s["wall_sec"] = time.time() - t0
    (d / f"{args.name}.summary.json").write_text(json.dumps(s, indent=1, ensure_ascii=False))
    print(json.dumps(s, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
