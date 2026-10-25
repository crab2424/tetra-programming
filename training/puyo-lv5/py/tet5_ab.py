"""テト lv5 地形強化の A/B（設計 source_assets/memory/cpu/tet/lv5-terrain-design.md §5.2・§9）。

新 lv5（レベル 5＝本番 cpu5.cpp）の重みを差し替えて、地形（ひとり用）と勝率（対 lv4・lv6・旧 lv5）を測る。
  python3 py/tet5_ab.py base "T1 cap16" slopeCap=16 "T1+skip" slopeCap=16,slopeWellSkip=2
  python3 py/tet5_ab.py --vs 4,6,15 --vs-seeds 300 base "T3" tsdDirtHole=10,tsdDirtCover=4
引数は「ラベル」と「名前=値,...」を交互に並べる（base＝本番の既定のまま）。名前は cpu5.js の this.weights のキー。
  --from 名前=値,...  すべての案に共通で先に当てる（採用済みの項を積んだ上で次を試す）
  --act/--hd          新 lv5 の操作時間（ms）。指定すると本番の actionDelay/harddropDelay の代わりに使う（強さの調整）
地形：おじゃま無し（--terrain-seeds 局 × 250 手）と 8手ごとに2段。勝率：共通ツモ（旧 lv5 も共通）、席を入れ替えた2局、引分は半勝ち。
結果は runs/tet5_ab/<--name>.{json,md} に追記する。
"""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np

import tetsim
from tvt_baseline import summarize

ROOT = Path(__file__).resolve().parent.parent
LV5_OLD = 15


def weight_names() -> list[str]:
    """本番 cpu5.js onMinoSpawned の weightsArray の並び（this.weights のキー）。"""
    src = (tetsim._REPO / "public/cpu/tet/lv5/cpu5.js").read_text(encoding="utf-8")
    spawn = src[src.index("onMinoSpawned()"):]
    arr = re.search(r"weightsArray\s*=\s*new Int32Array\(\[(.*?)\]\)", spawn, re.S).group(1)
    arr = re.sub(r"//[^\n]*", "", arr)
    return [re.search(r"this\.weights\.(\w+)", a).group(1) for a in arr.split(",") if a.strip()]


def apply(base: list[int], spec: str, names: list[str]) -> list[int]:
    w = list(base)
    for kv in [x for x in spec.split(",") if x.strip()]:
        k, v = kv.split("=")
        k = k.strip()
        if k == "P1_WEIGHT":
            w[names.index(k)] = int(round(float(v) * 100))
        else:
            w[names.index(k)] = int(float(v))
    return w


def terrain(w, seeds, ge=0, gl=0):
    return tetsim.terrain_lv(5, seeds, weights=w, max_pieces=250, garbage_every=ge, garbage_lines=gl)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("items", nargs="*")
    ap.add_argument("--from", dest="base_spec", default="")
    ap.add_argument("--terrain-seeds", type=int, default=100)
    ap.add_argument("--vs", default="4,6", help="勝率を測る相手（4,6,15＝旧 lv5）。空で勝率なし")
    ap.add_argument("--vs-seeds", type=int, default=300)
    ap.add_argument("--seed-base", type=int, default=1)
    ap.add_argument("--act", type=float, default=0)
    ap.add_argument("--hd", type=float, default=0)
    ap.add_argument("--name", default="ab")
    args = ap.parse_args()
    names = weight_names()
    prod = tetsim.prod_weights(5)
    base = apply(prod, args.base_spec, names)
    items = args.items or ["base"]
    variants = []
    i = 0
    while i < len(items):
        label = items[i]
        spec = items[i + 1] if i + 1 < len(items) and "=" in items[i + 1] else ""
        i += 2 if spec else 1
        variants.append((label, spec))
    tseeds = list(range(1001, 1001 + args.terrain_seeds))
    vseeds = list(range(args.seed_base, args.seed_base + args.vs_seeds))
    opps = [int(x) for x in args.vs.split(",") if x.strip()]
    if args.act or args.hd:
        tetsim.set_level_timing(5, args.act or None, args.hd or None)
    out = ROOT / "runs" / "tet5_ab" / args.name
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for label, spec in variants:
        t0 = time.time()
        w = apply(base, spec, names)
        t_clean = terrain(w, tseeds)
        t_g = terrain(w, tseeds, 8, 2)
        vs = {}
        for o in opps:
            res = tetsim.vs_run(5, o, vseeds, w_a=w, shared_tumo=True)
            s = summarize(res, 5, o)
            vs[o] = {"win": s["a_win"], "ci95": s["ci95"], "draws": s["draws"], "sec": s["mean_sec"],
                     "apm": s["side"]["a"]["apm"], "pps": s["side"]["a"]["pps"],
                     "tspins": s["side"]["a"]["tspins_per100"], "tetrises": s["side"]["a"]["tetrises_per100"],
                     "dead_a": int(sum(r["a_dead"] for r in res)), "dead_b": int(sum(r["b_dead"] for r in res))}
        r = {"label": label, "spec": spec, "from": args.base_spec, "clean": t_clean, "garbage8x2": t_g, "vs": vs,
             "act": args.act, "hd": args.hd, "sec": time.time() - t0}
        rows.append(r)
        vs_s = "  ".join(f"対{o} {v['win']:.3f}[{v['ci95'][0]:.2f},{v['ci95'][1]:.2f}] 引{v['draws']} TS{v['tspins']:.1f} APM{v['apm']:.0f}"
                         for o, v in vs.items())
        print(f"{label:<18} 穴{t_clean['holes']:.2f} 穴3+{t_clean['holes3']:.1%} 凸凹{t_clean['bump']:.1f} 段3+{t_clean['step3']:.2f} "
              f"作{t_clean['created']:.1f} TS{t_clean['tspins']:.2f} 4L{t_clean['tetrises']:.2f} 火{t_clean['attack']:.1f} | "
              f"8x2 穴{t_g['holes']:.2f} 穴3+{t_g['holes3']:.1%} TS{t_g['tspins']:.2f} | {vs_s}  ({r['sec']:.0f}s)", flush=True)
    with out.with_suffix(".jsonl").open("a") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, default=float) + "\n")


if __name__ == "__main__":
    main()
