"""既定0で挙動が変わっていないかの確認（構造を足す前後で対局結果が完全一致するか）。

    python3 py/regress.py --save     # 変更前に、今の対局結果を build/regress.json に控える
    python3 py/regress.py            # 変更後に、控えた結果と完全一致するかを見る

対局（lv6 / lv6g / lv5 の3組×先後×シード120）と、ひとり用（lv6 / lv6g・シード60・80手）の
集計値（勝者・手数・最大連鎖・送受のおじゃま・時間など全列）を比べる。
weightsArray の長さが変わっても比べられるよう、ポリシーは毎回本番 JS から作り直す（追加分は0）。
設計: source_assets/memory/cpu/puyo/lv6-harass-design.md §13
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from train import named_policy  # noqa: E402

OUT = ps.BUILD / "regress.json"


def collect() -> dict:
    base = ps.load_baseline()
    pol = {n: named_policy(n, base).packed() for n in ("lv6", "lv6g", "lv5")}
    seeds = np.arange(990000, 990120, dtype=np.uint32)
    res = {}
    for a, b in (("lv6", "lv6g"), ("lv6", "lv5"), ("lv6g", "lv5")):
        for x, y in ((a, b), (b, a)):
            r = ps.run_matches(pol[x], pol[y], seeds)
            res[f"{x}_vs_{y}"] = {k: np.asarray(v).round(3).tolist() for k, v in r.items()}
    for n in ("lv6", "lv6g"):
        r = ps.run_solo(pol[n], np.arange(991000, 991060, dtype=np.uint32), max_turns=80, target_chain=10)
        res[f"solo_{n}"] = {k: np.asarray(v).tolist() for k, v in r.items()}
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", action="store_true")
    args = ap.parse_args()
    ps.build(force=True)
    cur = collect()
    if args.save:
        OUT.write_text(json.dumps(cur))
        print(f"→ {OUT}（{len(cur)} 組）")
        return 0
    ref = json.loads(OUT.read_text())
    bad = 0
    for k, cols in ref.items():
        for c, v in cols.items():
            if cur[k][c] != v:
                diff = sum(1 for p, q in zip(cur[k][c], v) if p != q)
                print(f"✗ {k} {c}: {diff} 件ちがう")
                bad += 1
    print("✅ 完全一致" if bad == 0 else f"❌ {bad} 列が不一致")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
