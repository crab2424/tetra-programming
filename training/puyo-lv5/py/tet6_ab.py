"""テト lv6 強化の A/B（設計 source_assets/memory/cpu/tet/lv6-boost-design.md §4）。

新 lv6（重みを差し替えた lv6）を 現行 lv6（本番 cpu6.js の重み）と対戦させ、地形（ひとり用）と探索時間も測る。
  python3 py/tet6_ab.py base "B2" holeAboveWell=1 "B1" actCost=-20,sdCost=-100
  python3 py/tet6_ab.py --from holeAboveWell=1 "B2+B3" rowTrans=-10
引数は「ラベル」と「名前=値,...」を交互に並べる（base＝本番の既定のまま）。名前は cpu6.js の this.weights のキー。
  --from 名前=値,...  すべての案に共通で先に当てる（採用済みの項を積んだ上で次を試す）。相手は常に本番の lv6
  --tumo own|shared   同じレベル同士なので既定は own（両者別ツモ）。共通だと打ち方が揃って決着がつきにくい（§5.1）
勝率は席（ツモ・穴・揺らぎの乱数）を入れ替えた2局で1シード、引分は半勝ち。結果は runs/tet6_ab/<--name>.jsonl に追記。
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


def weight_names() -> list[str]:
    """本番 cpu6.js onMinoSpawned の weightsArray の並び（this.weights のキー）。"""
    src = (tetsim._REPO / "public/cpu/tet/lv6/cpu6.js").read_text(encoding="utf-8")
    spawn = src[src.index("onMinoSpawned()"):]
    arr = re.search(r"weightsArray\s*=\s*new Int32Array\(\[(.*?)\]\)", spawn, re.S).group(1)
    arr = re.sub(r"//[^\n]*", "", arr)
    return [re.search(r"this\.weights\.(\w+)", a).group(1) for a in arr.split(",") if a.strip()]


def apply(base: list[int], spec: str, names: list[str]) -> list[int]:
    w = list(base)
    for kv in [x for x in spec.split(",") if x.strip()]:
        k, v = kv.split("=")
        k = k.strip()
        w[names.index(k)] = int(round(float(v) * 100)) if k == "P1_WEIGHT" else int(float(v))
    return w


_CASES = None


def search_ms(w, n_seeds=4) -> float:
    """探索1回あたりの時間（native・1スレッド）。おじゃま有り無しの trace 局面で測る。"""
    global _CASES
    if _CASES is None:
        _CASES = np.concatenate([tetsim.trace_cases_lv(6, sd, 120, ge, gl)
                                 for sd in range(1, 1 + n_seeds) for ge, gl in ((0, 0), (8, 2))])
    t = time.perf_counter()
    tetsim.search_cases_lv(6, _CASES, w, threads=1)
    return (time.perf_counter() - t) / len(_CASES) * 1000


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("items", nargs="*")
    ap.add_argument("--from", dest="base_spec", default="")
    ap.add_argument("--terrain-seeds", type=int, default=60)
    ap.add_argument("--vs-seeds", type=int, default=300)
    ap.add_argument("--seed-base", type=int, default=1)
    ap.add_argument("--tumo", choices=["own", "shared"], default="own")
    ap.add_argument("--no-terrain", action="store_true")
    ap.add_argument("--name", default="ab")
    args = ap.parse_args()
    names = weight_names()
    prod = tetsim.prod_weights(6)
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
    out = ROOT / "runs" / "tet6_ab" / args.name
    out.parent.mkdir(parents=True, exist_ok=True)
    ms0 = search_ms(prod)
    for label, spec in variants:
        t0 = time.time()
        w = apply(base, spec, names)
        ms = search_ms(w)
        tc = tg = None
        if not args.no_terrain:
            tc = tetsim.terrain_lv(6, tseeds, weights=w, max_pieces=250)
            tg = tetsim.terrain_lv(6, tseeds, weights=w, max_pieces=250, garbage_every=8, garbage_lines=2)
        res = tetsim.vs_run(6, 6, vseeds, w_a=w, w_b=prod, shared_tumo=args.tumo == "shared")
        s = summarize(res, 6, 6)
        a, b = s["side"]["a"], s["side"]["b"]
        r = {"label": label, "spec": spec, "from": args.base_spec, "tumo": args.tumo, "seeds": args.vs_seeds,
             "seed_base": args.seed_base, "win": s["a_win"], "ci95": s["ci95"], "draws": s["draws"],
             "sec": s["mean_sec"], "a": a, "b": b, "search_ms": ms, "search_ms_base": ms0,
             "dead_a": int(sum(x["a_dead"] for x in res)), "dead_b": int(sum(x["b_dead"] for x in res)),
             "clean": tc, "garbage8x2": tg, "wall": time.time() - t0}
        ter = ""
        if tc:
            ter = (f"| 穴{tc['holes']:.2f} 穴3+{tc['holes3']:.1%} 凸凹{tc['bump']:.1f} TS{tc['tspins']:.1f} 4L{tc['tetrises']:.1f} "
                   f"火{tc['attack']:.0f} PPS{tc['pps']:.2f} | 8x2 穴3+{tg['holes3']:.1%} TS{tg['tspins']:.1f} 火{tg['attack']:.0f} ")
        print(f"{label:<16} 勝率 {s['a_win']:.3f}[{s['ci95'][0]:.3f},{s['ci95'][1]:.3f}] 引{s['draws']} {s['mean_sec']:.0f}s "
              f"APM {a['apm']:.0f}/{b['apm']:.0f} PPS {a['pps']:.2f}/{b['pps']:.2f} TS {a['tspins_per100']:.1f}/{b['tspins_per100']:.1f} "
              f"4L {a['tetrises_per100']:.1f}/{b['tetrises_per100']:.1f} 探索 {ms:.1f}ms({ms / ms0 - 1:+.0%}) {ter}({r['wall']:.0f}s)",
              flush=True)
        with out.with_suffix(".jsonl").open("a") as f:
            f.write(json.dumps(r, ensure_ascii=False, default=float) + "\n")


if __name__ == "__main__":
    main()
