"""CMA-ES で lv5 / lv6 の build を最適化する（設計書 §5）。夜間に回す前提の CLI。

    python3 py/train.py --run runs/build-001 --gens 100
    python3 py/train.py --run runs/build-001 --resume          # 途中から再開（世代ごとに保存）
    # lv6 を初期値・学習相手にして、新しい項（qExcessWeight）を含めて学習し直す（lv6-harass-design.md §7）
    python3 py/train.py --run runs/lv6-e1-001 --opp lv6 --init-set qExcessWeight=-100 --gens 20

fitness = 学習相手（--opp。既定は現行 lv5・固定）＋殿堂（過去世代の平均ベクトル）に対する勝率。
  ・初期値（--init。既定は --opp と同じ）が、学習しない部分（fast・ext＝後打ちなど）の値も決める
  ・全候補を同じシード集合で評価する（共通乱数）。シード集合は世代ごとに入れ替える
  ・各シードは先後を入れ替えて2局（同時刻イベントの先手優遇を打ち消す）
  ・シード範囲: 学習 1..499999 / 平均ベクトルの定期評価 500000..749999 / 最終検証 750000..1000000
出力（--run 配下）: log.csv（世代ごとの記録）/ state.json（再開用）/ best.json（定期評価で最良の平均ベクトル）
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import params as P  # noqa: E402
import puyosim as ps  # noqa: E402
from cmaes import CMAES  # noqa: E402

TRAIN_SEED_RANGE = (1, 500000)
EVAL_SEED_RANGE = (500000, 750000)
VALID_SEED_RANGE = (750000, 1000001)


def draw_seeds(rng: np.random.Generator, n: int, lohi: tuple[int, int]) -> np.ndarray:
    return rng.choice(np.arange(*lohi, dtype=np.int64), size=n, replace=False).astype(np.uint32)


def policy_to_json(pol: ps.Policy) -> dict:
    return {"build": pol.build, "fast": pol.fast, "counterTrigger": pol.counter_trigger,
            "counterMargin": pol.counter_margin, "ext": pol.ext}


def _pad(v: list, n: int) -> list:
    """weightsArray が伸びる前（43 要素）の記録は、増えた分を 0（＝無効）で埋める。"""
    return list(v) + [0] * (n - len(v))


def policy_from_json(d: dict) -> ps.Policy:
    return ps.Policy(_pad(d["build"], ps.W_LEN), _pad(d["fast"], ps.W_LEN), int(d["counterTrigger"]),
                     float(d["counterMargin"]), _pad(d.get("ext", []), ps.EXT_LEN))


def upgrade_packed(h: list) -> np.ndarray:
    """古い長さの packed（殿堂）を今の PP_LEN にそろえる。build/fast は末尾の新しい重みを 0 で、ext は 0 で埋める。"""
    h = list(h)
    if len(h) == ps.PP_LEN:
        return np.array(h, dtype=np.int32)
    for w_old in range(ps.W_LEN, 0, -1):
        for ext_old in (ps.EXT_LEN, 0):
            if len(h) == 2 * w_old + 2 + ext_old:
                b, f, rest = h[:w_old], h[w_old:2 * w_old], h[2 * w_old:]
                return np.array(_pad(b, ps.W_LEN) + _pad(f, ps.W_LEN) + rest[:2] + _pad(rest[2:], ps.EXT_LEN),
                                dtype=np.int32)
    raise ValueError(f"殿堂の長さ {len(h)} を解釈できない")


# lv6h＝本番 lv6 に催促 H1・対応 H2 を入れた学習相手（lv6-harass-design.md §9.5・§9.9）。
#   H1 の値は A/B（ab_eval --set h2）で悪化しなかったもの。lv6 単体だと「催促に弱い」点を突くことばかり学ぶため。
LV6H_SET = {46: 12, 47: 3, 48: 80, 49: 1, 50: 300}   # harassMinOjama/MaxChains/KeepPct/counterKeepReach/MinReach


def named_policy(name: str, base_json: dict) -> ps.Policy:
    if name == "lv6h":
        pol = ps.Policy.lv6(base_json)
        for i, v in LV6H_SET.items():
            pol.build[i] = v
        return pol
    return ps.Policy.lv6(base_json) if name == "lv6" else ps.Policy.baseline(base_json)


def apply_init_set(pol: ps.Policy, items: list[str]) -> ps.Policy:
    """--init-set 名前=値（SPACE の名前）で初期値を書き換える。"""
    by_name = {p.name: p for p in P.SPACE}
    for it in items:
        k, v = it.split("=", 1)
        p = by_name[k]
        if p.index == -1:
            pol.counter_trigger = int(v)
        elif p.index == -2:
            pol.counter_margin = float(v)
        else:
            pol.build[p.index] = int(v)
    return pol


def evaluate(cands: np.ndarray, opponents: list[np.ndarray], seeds: np.ndarray,
             settings: ps.Settings, threads: int, hof_share: float) -> np.ndarray:
    """候補 (nCand, PP_LEN) の勝率。opponents[0]=学習相手（--opp）、以降=殿堂（シードの hof_share を等分）。"""
    if len(opponents) == 1:
        return ps.play_both_sides(cands, opponents[0], seeds, settings, threads)["winRate"]
    n_hof = len(opponents) - 1
    k = int(round(len(seeds) * (1 - hof_share)))
    wr = 0.0
    wr += (1 - hof_share) * ps.play_both_sides(cands, opponents[0], seeds[:k], settings, threads)["winRate"]
    chunks = np.array_split(seeds[k:], n_hof)
    for opp, sd in zip(opponents[1:], chunks):
        wr = wr + (hof_share / n_hof) * ps.play_both_sides(cands, opp, sd, settings, threads)["winRate"]
    return wr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="出力ディレクトリ（runs/<名前>）")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--gens", type=int, default=100)
    ap.add_argument("--seeds", type=int, default=100, help="1候補あたりのシード数（×先後2局）")
    ap.add_argument("--popsize", type=int, default=16, help="0=4+3ln(n)。勝率は雑音が大きいので標準(14)より多め")
    ap.add_argument("--sigma", type=float, default=0.1, help="正規化座標での初期ステップ幅")
    ap.add_argument("--threads", type=int, default=0, help="0=全コア")
    ap.add_argument("--master-seed", type=int, default=20261015)
    ap.add_argument("--opp", default="lv5", choices=["lv5", "lv6", "lv6h"], help="学習相手・定期評価の相手（本番の重み。lv6h＝lv6＋催促 H1・対応 H2）")
    ap.add_argument("--init", default=None, choices=["lv5", "lv6", "lv6h"], help="初期値（既定は --opp と同じ）")
    ap.add_argument("--init-set", action="append", default=[], metavar="名前=値",
                    help="初期値の一部を書き換える（params.SPACE の名前。複数可）")
    ap.add_argument("--eval-every", type=int, default=5, help="平均ベクトルを学習相手と評価する間隔（世代）")
    ap.add_argument("--eval-seeds", type=int, default=200)
    ap.add_argument("--hof-start", type=int, default=30, help="この世代から殿堂入り（過学習対策）を始める")
    ap.add_argument("--hof-every", type=int, default=10)
    ap.add_argument("--hof-size", type=int, default=3)
    ap.add_argument("--hof-share", type=float, default=0.5, help="殿堂に割くシードの割合")
    args = ap.parse_args()

    run = Path(args.run)
    run.mkdir(parents=True, exist_ok=True)
    base_json = ps.load_baseline()
    P.check_indices(base_json)
    if args.resume and (run / "args.json").exists():
        saved = json.loads((run / "args.json").read_text())   # 相手・初期値は開始時の設定に従う
        args.opp, args.init, args.init_set = saved.get("opp", "lv5"), saved.get("init"), saved.get("init_set", [])
    args.init = args.init or args.opp
    opp = named_policy(args.opp, base_json)
    opp_packed = opp.packed()
    base = apply_init_set(named_policy(args.init, base_json), args.init_set)   # 初期値＝decode の基準
    settings = ps.Settings()

    state_path = run / "state.json"
    if args.resume and state_path.exists():
        st = json.loads(state_path.read_text())
        es = CMAES.from_dict(st["es"])
        if es.n != P.DIM:
            raise SystemExit(f"探索空間の次元が違う（保存 {es.n} / 今 {P.DIM}）。params.SPACE を変える前の run は再開できない")
        hof = [upgrade_packed(h) for h in st["hof"]]
        best = st["best"]
        print(f"resume: gen={es.gen} sigma={es.sigma:.4f} best={best['winRate'] if best else None}")
    else:
        es = CMAES(P.encode(base), args.sigma, args.popsize or None, seed=args.master_seed)
        hof, best = [], None
        (run / "args.json").write_text(json.dumps(vars(args), indent=1))
        (run / "baseline.json").write_text(json.dumps(policy_to_json(base), indent=1))
    eval_seeds = draw_seeds(np.random.default_rng(args.master_seed + 1), args.eval_seeds, EVAL_SEED_RANGE)

    log_path = run / "log.csv"
    new_log = not log_path.exists()
    with open(log_path, "a", newline="") as lf:
        log = csv.writer(lf)
        if new_log:
            log.writerow(["gen", "sec", "games", "sigma", "wr_best", "wr_mean", "wr_median",
                          "eval_wr", "hof", "mean_x"])
        while es.gen < args.gens:
            t0 = time.time()
            gen = es.gen
            rng = np.random.default_rng([args.master_seed, gen])
            seeds = draw_seeds(rng, args.seeds, TRAIN_SEED_RANGE)
            xs = es.ask()
            cands = np.stack([P.decode(x, base).packed() for x in xs])
            wr = evaluate(cands, [opp_packed] + hof, seeds, settings, args.threads, args.hof_share)
            # 範囲外は端に丸めて評価し、はみ出し量に小さな罰則（平均が箱の外へ逃げないように）
            out_of_box = np.sum((xs - np.clip(xs, 0, 1)) ** 2, axis=1)
            es.tell(xs, -wr + out_of_box)

            eval_wr = ""
            mean_pol = P.decode(es.mean, base)
            if es.gen % args.eval_every == 0 or es.gen == args.gens:
                ewr = float(ps.play_both_sides(mean_pol.packed(), opp_packed, eval_seeds,
                                               settings, args.threads)["winRate"][0])
                eval_wr = f"{ewr:.4f}"
                if best is None or ewr > best["winRate"]:
                    best = {"gen": es.gen, "winRate": ewr, "opp": args.opp, "policy": policy_to_json(mean_pol),
                            "changed": P.describe(mean_pol, opp)}
                    (run / "best.json").write_text(json.dumps(best, indent=1, ensure_ascii=False))
            if es.gen >= args.hof_start and (es.gen - args.hof_start) % args.hof_every == 0:
                hof = (hof + [mean_pol.packed()])[-args.hof_size:]

            sec = time.time() - t0
            games = len(xs) * len(seeds) * 2 + (len(eval_seeds) * 2 if eval_wr else 0)
            log.writerow([es.gen, f"{sec:.1f}", games, f"{es.sigma:.5f}", f"{wr.max():.4f}",
                          f"{wr.mean():.4f}", f"{np.median(wr):.4f}", eval_wr, len(hof),
                          json.dumps(np.round(es.mean, 4).tolist())])
            lf.flush()
            state_path.write_text(json.dumps({"es": es.to_dict(), "hof": [h.tolist() for h in hof],
                                              "best": best}))
            print(f"gen {es.gen:4d}  {sec:6.1f}s  sigma={es.sigma:.4f}  wr best/mean={wr.max():.3f}/{wr.mean():.3f}"
                  + (f"  eval(mean)={eval_wr}" if eval_wr else ""), flush=True)
    print(f"done. best: gen={best['gen']} winRate={best['winRate']:.4f}" if best else "done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
