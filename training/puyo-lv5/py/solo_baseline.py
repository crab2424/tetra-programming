"""ひとり用の基準計測：有効ぷよ量・最初の本線・整地（段階0）。

  python3 py/solo_baseline.py [--seeds 300] [--turns 80] [--only 名前,...]
  python3 py/solo_baseline.py --report-only        # 記録済みの runs/analysis/solo_*.jsonl を集計し直す

対戦の勝率より雑音が小さく速いので、評価の項（提案3）の当たりをつけるのに使う。
設計: source_assets/memory/cpu/puyo/lv6-harass-design.md（§3・§4 段階0）

見るもの（相手がいないのでカウンター・後打ちは働かない）
  ・有効ぷよ量＝色ぷよ − 残り色ぷよ − 途中段の余剰（いま起こせる最大連鎖＝bestIgnition を回して数える）
  ・最初の本線（おじゃま30個以上）：手数・段数・発火理由・発火時の色ぷよ・途中段の余剰・残り
  ・育成中の小連鎖（発火理由0＝撃つ判断ではなく育成手で消えたもの）を「整地」「こぼし」に分ける
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from analyze_losses import BIG, IGN, RATE, fire_feats, pct  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "runs" / "analysis"
WASTE = 16                       # turns[] の [色ぷよ, 残り色ぷよ, 途中段の余剰]
I_WASTE_W, I_PUYOS_W = 31, 41    # weightsArray の添字（wasteWeight / puyosWeight）
REASONS = {1: "目標", 2: "緊急", 3: "延命"}


def configs(base: dict) -> dict[str, ps.Policy]:
    lv6 = ps.Policy.lv6(base)

    def with_build(**kw):
        p = ps.Policy(list(lv6.build), list(lv6.fast), lv6.counter_trigger, lv6.counter_margin, list(lv6.ext))
        for i, v in kw.items():
            p.build[int(i[1:])] = v
        return p

    cfg = {"lv5": ps.Policy.baseline(base), "lv6": lv6}
    for v in (2, 5, 10, 25):
        cfg[f"lv6 puyos{v}"] = with_build(**{f"i{I_PUYOS_W}": v})
    cfg["lv6 waste0"] = with_build(**{f"i{I_WASTE_W}": 0})
    return cfg


def slug(name: str) -> str:
    return name.replace(" ", "_")


# ─── 整地の分類（育成中の1〜2連鎖）───
def growth_fires(P: dict, upto_turn: int | None = None) -> list[dict]:
    """発火理由0（育成手で消えた）の連鎖を、置く前（turn k）と連鎖後（turn k+1）の記録で分類する。

    整地  : 残り色ぷよ（無駄ぷよ）が減り、起こせる連鎖の段数が落ちていない
    こぼし: 起こせる連鎖が2段以上落ちた（本線を崩した）
    その他: どちらでもない（無駄ぷよも減らず本線も崩れない消去など）
    """
    by_turn = {x[1]: x for x in P["turns"]}
    out = []
    for f in P["fires"]:
        if f["reason"] != 0 or f["chains"] > 2:
            continue
        if upto_turn is not None and f["turn"] >= upto_turn:
            continue
        a, b = by_turn.get(f["turn"]), by_turn.get(f["turn"] + 1)
        if a is None or b is None:
            continue
        dLeft = b[WASTE][1] - a[WASTE][1]
        dIgn = b[IGN][0] - a[IGN][0]
        if dLeft < 0 and dIgn >= 0:
            kind = "整地"
        elif dIgn <= -2:
            kind = "こぼし"
        else:
            kind = "その他"
        last = f["steps"][-1]
        out.append({"kind": kind, "chains": f["chains"], "erased": f["pb"] - f["pa"],
                    "dLeft": dLeft, "dIgn": dIgn, "lastMulti": len(last) > 1 or sum(last) > 4})
    return out


def first_main(P: dict):
    for f in P["fires"]:
        if f["score"] >= BIG * RATE:
            return f
    return None


def report(name: str, path: Path, turns: int) -> list[str]:
    games = [json.loads(l) for l in path.open()]
    n = len(games)
    mains, gf_pre, gf_all, traj = [], [], [], {t: [] for t in (10, 20, 30, 40)}
    died = 0
    for g in games:
        P = g["P"]
        died += g["died"]
        fm = first_main(P)
        if fm:
            mains.append(dict(fm, **fire_feats(fm)))
        cut = fm["turn"] if fm else None
        gf_pre.append(growth_fires(P, cut))
        gf_all.append(growth_fires(P))
        for x in P["turns"]:
            if x[1] in traj and (cut is None or x[1] <= cut):
                traj[x[1]].append(x[WASTE])

    L = [f"### {name}（{n} 局・{turns} 手まで）"]
    # 最初の本線
    if mains:
        reasons = {k: sum(1 for m in mains if m["reason"] == k) for k in REASONS}
        eff = [m["puyosBefore"] - m["leftover"] - m["midExtra"] for m in mains]
        L.append(f"- 最初の本線: 到達 {pct(len(mains), n)}・手数 {np.median([m['turn'] for m in mains]):.0f}（中央値）・"
                 f"段数 {np.mean([m['chains'] for m in mains]):.2f}・おじゃま換算 {np.mean([m['score'] for m in mains]) / RATE:.0f}個・"
                 f"理由 " + " / ".join(f"{REASONS[k]}{pct(v, len(mains))}" for k, v in reasons.items()))
        L.append(f"  - 発火時の色ぷよ {np.mean([m['puyosBefore'] for m in mains]):.1f}・途中段の余剰 "
                 f"{np.mean([m['midExtra'] for m in mains]):.1f}・残り {np.mean([m['leftover'] for m in mains]):.1f}・"
                 f"有効ぷよ量 {np.mean(eff):.1f}・4個消しだけの段 "
                 f"{pct(sum(m['pure4'] for m in mains), sum(m['chains'] for m in mains))}")
    L.append(f"- 窒息 {pct(died, n)}")
    # 有効ぷよ量の推移（最初の本線より前）
    cells = []
    for t, xs in traj.items():
        if len(xs) >= n // 4:
            a = np.array(xs, dtype=float)
            cells.append(f"{t}手 {a[:, 0].mean():.1f}/{a[:, 1].mean():.1f}/{a[:, 2].mean():.1f}"
                         f"→{(a[:, 0] - a[:, 1] - a[:, 2]).mean():.1f}")
    L.append("- 色ぷよ/残り/余剰→有効（本線前）: " + "・".join(cells))
    # 育成中の小連鎖
    for label, gfs in (("本線前", gf_pre), ("全体", gf_all)):
        flat = [x for l in gfs for x in l]
        kinds = {k: sum(1 for x in flat if x["kind"] == k) for k in ("整地", "こぼし", "その他")}
        L.append(f"- 育成中の1〜2連鎖（{label}）: 1局 {len(flat) / n:.2f}回（"
                 + "・".join(f"{k} {v / n:.2f}" for k, v in kinds.items()) + "）"
                 + (f"・消去 {np.mean([x['erased'] for x in flat]):.1f}個・最終段同時消し "
                    f"{pct(sum(x['lastMulti'] for x in flat), len(flat))}" if flat else ""))
    return L


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=300)
    ap.add_argument("--turns", type=int, default=80)
    ap.add_argument("--only", default="")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()
    base = ps.load_baseline()
    cfg = configs(base)
    if args.only:
        keep = set(args.only.split(","))
        cfg = {k: v for k, v in cfg.items() if k in keep}
    OUT.mkdir(parents=True, exist_ok=True)
    seeds = np.arange(940000, 940000 + args.seeds, dtype=np.uint32)
    lines = [f"## ひとり用の基準計測（シード {args.seeds}・{args.turns} 手）"]
    for name, pol in cfg.items():
        path = OUT / f"solo_{slug(name)}.jsonl"
        if not args.report_only:
            ps.trace_solo(pol.packed(), seeds, path, max_turns=args.turns)
        lines += [""] + report(name, path, args.turns)
        print("\n".join(lines[-12:]), flush=True)
    (OUT / "solo_baseline.md").write_text("\n".join(lines) + "\n")
    print(f"\n→ {OUT / 'solo_baseline.md'}")


if __name__ == "__main__":
    main()
