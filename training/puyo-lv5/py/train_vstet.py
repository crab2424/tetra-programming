"""T4：対テト（相手 テト CPU lv5）の vsTet / fastVsTet を CMA-ES で学習する（設計 lv6-vstet-design.md §11）。

    python3 py/train_vstet.py --run runs/vstet-001 --gens 30
    python3 py/train_vstet.py --run runs/vstet-001 --resume
    python3 py/train_vstet.py --run runs/vstet-001 --validate          # best.json を検証シードで 2000 局

fitness = テト lv5 に対する勝率（全候補を同じシード集合で打つ＝共通乱数。シード集合は世代ごとに入れ替える）。
  ・ぷよ側の Policy：build＝本線（vsTet として使う）・fast＝カウンター（fastVsTet として使う）・カウンター定数
  ・初期値（--init）：lv6b＝lv6 の対ぷよの build/fast（§9.2 で 0.140）／vstet＝今の本番 vsTet/fastVsTet（0.092）
  ・シード範囲: 学習 1..499999 / 平均ベクトルの定期評価 500000..749999 / 最終検証 750000..1000000
出力（--run 配下）: log.csv / state.json（再開用）/ best.json（定期評価で最良の平均ベクトル）/ args.json
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import puyosim as ps  # noqa: E402
import tetsim  # noqa: E402
from cmaes import CMAES  # noqa: E402
from vstet_baseline import wilson  # noqa: E402

TRAIN_SEED_RANGE = (1, 500000)
EVAL_SEED_RANGE = (500000, 750000)
VALID_SEED_RANGE = (750000, 1000001)


@dataclass(frozen=True)
class Param:
    name: str
    where: str      # "b"=build（vsTet） / "f"=fast（fastVsTet） / "ct"=カウンター発動量 / "cm"=倍率
    index: int
    lo: float
    hi: float
    integer: bool = True


# 探索空間（v1。2026-10-20）。qChainWeight はスケール基準で固定。formWeight・qSub は持論（§5.1・§5.1.1）で 0 に固定。
SPACE = [
    Param("heightPenalty",          "b",  2,   -60,      0),
    Param("bumpWeight",             "b", 12, -1500,      0),
    Param("qYWeight",               "b", 14,     0,    600),
    Param("qKeyWeight",             "b", 15,  -300,      0),
    Param("qChiWeight",             "b", 16,     0,    150),
    Param("link2Weight",            "b", 17,     0,     60),
    Param("link3Weight",            "b", 18,     0,    120),
    Param("qLink2Weight",           "b", 25,     0,     60),
    Param("qLink3Weight",           "b", 26,     0,    120),
    Param("tearWeight",             "b", 28,  -200,      0),
    Param("puyosWeight",            "b", 41,     0,     50),
    Param("height3Weight",          "b", 42,  -300,      0),
    Param("qExcessWeight",          "b", 43,  -400,      0),
    Param("qJunkWeight",            "b", 44,  -300,      0),   # 無駄ぷよ（§5.1.1 の「副砲」の訂正）
    Param("qKeepWeight",            "b", 54,     0,     15),   # ① 降っても撃てる（深さ2・1段で固定）
    Param("emergencyHeight",        "b",  8,     8,     12),
    Param("expChainWeight",         "b", 19,     0,  10000),
    Param("pruneChainScore",        "b", 29,     0,  20000),
    Param("fireChainCount",         "b", 32,     4,     15),
    Param("fireScoreThreshold",     "b", 34,  3000, 200000),
    Param("growthFireForbidChains", "b", 35,     0,      4),   # 整地だけの1連鎖（§5.1.1）
    Param("emergencyFireMinRatio",  "b", 36,     0,    100),
    Param("emergencyHardCol2",      "b", 37,     8,     12),
    Param("fast.qYWeight",          "f", 14,     0,    600),
    Param("fast.growthFireForbid",  "f", 35,     0,      4),
    Param("fast.emergencyFireMinRatio", "f", 36, 0,    100),
    Param("counterTrigger",         "ct", -1,    1,     20),
    Param("counterMargin",          "cm", -1,  0.6,    2.0, integer=False),
]
DIM = len(SPACE)


def init_policy(name: str) -> ps.Policy:
    b = ps.load_baseline()
    if name == "vstet":
        pol = tetsim.vstet_policy("lv6", b)
    else:   # lv6b：lv6 の対ぷよの build/fast＋対テトのカウンター定数（§9.2 の参考列）
        v = b["lv6"]["vsTet"]
        pol = ps.Policy(list(b["lv6"]["build"]), list(b["lv6"]["fast"]), int(v["counterTrigger"]),
                        float(v["counterMargin"]))
    pol.build[21] = 0    # formWeight（テンプレは使わない）
    pol.build[45] = 0    # qSubWeight（副砲は使わない）
    pol.build[55] = 2    # qKeepDepth（qKeepWeight>0 のときだけ効く）
    pol.build[56] = 1    # qKeepRows
    return pol


def get(pol: ps.Policy, p: Param) -> float:
    if p.where == "ct":
        return pol.counter_trigger
    if p.where == "cm":
        return pol.counter_margin
    return (pol.build if p.where == "b" else pol.fast)[p.index]


def encode(pol: ps.Policy) -> np.ndarray:
    return np.array([(np.clip(get(pol, p), p.lo, p.hi) - p.lo) / (p.hi - p.lo) for p in SPACE])


def decode(x: np.ndarray, base: ps.Policy) -> ps.Policy:
    x = np.clip(np.asarray(x, dtype=float), 0.0, 1.0)
    pol = ps.Policy(list(base.build), list(base.fast), base.counter_trigger, base.counter_margin, list(base.ext))
    for i, p in enumerate(SPACE):
        v = p.lo + x[i] * (p.hi - p.lo)
        if p.integer:
            v = int(round(v))
        if p.where == "ct":
            pol.counter_trigger = int(v)
        elif p.where == "cm":
            pol.counter_margin = round(float(v), 3)
        else:
            (pol.build if p.where == "b" else pol.fast)[p.index] = int(v)
    return pol


def describe(pol: ps.Policy, base: ps.Policy) -> dict:
    return {p.name: {"from": get(base, p), "to": get(pol, p)} for p in SPACE if get(pol, p) != get(base, p)}


def pol_json(pol: ps.Policy) -> dict:
    return {"build": pol.build, "fast": pol.fast, "counterTrigger": pol.counter_trigger,
            "counterMargin": pol.counter_margin, "ext": pol.ext}


def pol_from_json(d: dict) -> ps.Policy:
    return ps.Policy(list(d["build"]), list(d["fast"]), int(d["counterTrigger"]), float(d["counterMargin"]),
                     list(d.get("ext", [0] * ps.EXT_LEN)))


def winrate(pols: list[ps.Policy], seeds: np.ndarray) -> np.ndarray:
    w = tetsim.run_vstet_batch(np.stack([p.packed() for p in pols]), seeds)
    return w.mean(axis=1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--init", default="lv6b", choices=["lv6b", "vstet"])
    ap.add_argument("--gens", type=int, default=30)
    ap.add_argument("--popsize", type=int, default=16)
    ap.add_argument("--sigma", type=float, default=0.2)
    ap.add_argument("--seeds", type=int, default=300, help="1世代あたりのシード数（1候補あたりの局数）")
    ap.add_argument("--eval-every", type=int, default=5)
    ap.add_argument("--eval-seeds", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    run = Path(args.run)
    run.mkdir(parents=True, exist_ok=True)

    if args.validate:
        a = json.loads((run / "args.json").read_text())
        base = init_policy(a["init"])
        best = pol_from_json(json.loads((run / "best.json").read_text())["policy"])
        sd = np.arange(VALID_SEED_RANGE[0], VALID_SEED_RANGE[0] + 2000, dtype=np.uint32)
        w = tetsim.run_vstet_batch(np.stack([base.packed(), best.packed(),
                                             tetsim.vstet_policy("lv6").packed()]), sd)
        for name, row in zip(["初期値 " + a["init"], "best", "本番 vsTet"], w):
            lo, hi = wilson(int(row.sum()), len(row))
            print(f"{name:12s} {row.mean():.3f} [{lo:.3f}, {hi:.3f}]")
        print("best と初期値の差（勝ちに変わった/負けに変わった）:", int((w[1] & ~w[0]).sum()), int((~w[1] & w[0]).sum()))
        return 0

    rng = np.random.default_rng(args.seed)
    if args.resume:
        st = json.loads((run / "state.json").read_text())
        a = json.loads((run / "args.json").read_text())
        base = init_policy(a["init"])
        es = CMAES.from_dict(st["es"])
        rng.bit_generator.state = st["rng"]
        best_wr = st["best_wr"]
    else:
        (run / "args.json").write_text(json.dumps(vars(args), ensure_ascii=False, indent=1))
        base = init_policy(args.init)
        es = CMAES(encode(base), args.sigma, args.popsize, seed=args.seed)
        best_wr = -1.0
        # 初期値の勝率（定期評価と同じシード）
        ev = np.arange(EVAL_SEED_RANGE[0], EVAL_SEED_RANGE[0] + args.eval_seeds, dtype=np.uint32)
        best_wr = float(winrate([base], ev)[0])
        (run / "best.json").write_text(json.dumps({"gen": 0, "evalWinRate": best_wr, "policy": pol_json(base),
                                                   "changed": {}}, ensure_ascii=False, indent=1))
        print(f"初期値 {args.init} の定期評価 {best_wr:.3f}", flush=True)
    logp = run / "log.csv"
    new_log = not logp.exists()
    with open(logp, "a", newline="") as fp:
        wr_ = csv.writer(fp)
        if new_log:
            wr_.writerow(["gen", "sec", "best", "mean", "median", "sigma", "evalMean"])
        while es.gen < args.gens:
            t = time.time()
            xs = es.ask()
            pols = [decode(x, base) for x in xs]
            seeds = rng.choice(np.arange(*TRAIN_SEED_RANGE), size=args.seeds, replace=False).astype(np.uint32)
            wr = winrate(pols, seeds)
            es.tell(np.clip(xs, 0, 1), -wr)
            ev_s = ""
            if es.gen % args.eval_every == 0 or es.gen == args.gens:
                mean_pol = decode(es.mean, base)
                ev = np.arange(EVAL_SEED_RANGE[0], EVAL_SEED_RANGE[0] + args.eval_seeds, dtype=np.uint32)
                ev_wr = float(winrate([mean_pol], ev)[0])
                ev_s = f"{ev_wr:.3f}"
                if ev_wr > best_wr:
                    best_wr = ev_wr
                    (run / "best.json").write_text(json.dumps(
                        {"gen": es.gen, "evalWinRate": ev_wr, "policy": pol_json(mean_pol),
                         "changed": describe(mean_pol, base)}, ensure_ascii=False, indent=1))
            sec = time.time() - t
            wr_.writerow([es.gen, round(sec), round(wr.max(), 4), round(wr.mean(), 4), round(float(np.median(wr)), 4),
                          round(es.sigma, 4), ev_s])
            fp.flush()
            (run / "state.json").write_text(json.dumps({"es": es.to_dict(), "rng": rng.bit_generator.state,
                                                        "best_wr": best_wr}))
            print(f"gen {es.gen:3d}  {sec:5.0f}s  best {wr.max():.3f}  mean {wr.mean():.3f}  sigma {es.sigma:.3f}"
                  + (f"  評価(平均ベクトル) {ev_s}" if ev_s else ""), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
