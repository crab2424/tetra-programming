"""学習結果の検証と本番反映用の出力（設計書 §5.5）。

    python3 py/validate.py --best runs/build-001/best.json --seeds 1000

  ・学習にも定期評価にも使っていないシード（750000..1000000）で、best vs 現行 lv5 を先後2局ずつ
  ・勝率と 95% 信頼区間（シードごとの先後2局の平均を1標本とする）
  ・ひとり用の構築指標（最大連鎖・10連鎖到達手数・窒息率）を両者で比較
  ・cpu5_weights.js / cpu5_worker_io.js に書き写す値（変化したものだけ）
採用目安: 勝率 55% 以上かつ信頼区間の下限 > 50%
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import params as P  # noqa: E402
import puyosim as ps  # noqa: E402
from train import VALID_SEED_RANGE, draw_seeds, policy_from_json  # noqa: E402


def solo_summary(pol: ps.Policy, seeds: np.ndarray, threads: int) -> dict:
    r = ps.run_solo(pol.packed(), seeds, max_turns=60, target_chain=10, threads=threads)
    reached = r["firstBigTurn"] >= 0
    return {"maxChain": float(r["maxChain"].mean()), "maxChainScore": float(r["maxChainScore"].mean()),
            "reach10Rate": float(reached.mean()),
            "reach10Turn": float(r["firstBigTurn"][reached].mean()) if reached.any() else None,
            "diedRate": float(r["died"].mean())}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--best", required=True)
    ap.add_argument("--seeds", type=int, default=1000)
    ap.add_argument("--solo-seeds", type=int, default=300)
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    base = ps.Policy.baseline()
    best = policy_from_json(json.loads(Path(args.best).read_text())["policy"])
    rng = np.random.default_rng(424242)
    seeds = draw_seeds(rng, args.seeds, VALID_SEED_RANGE)

    r = ps.play_both_sides(best.packed(), base.packed(), seeds, threads=args.threads)
    per_seed = r["score"][:, 0, :].mean(axis=0)
    wr = float(per_seed.mean())
    half = 1.96 * float(per_seed.std(ddof=1)) / np.sqrt(len(per_seed))
    print(f"VERSUS vs 現行 lv5: 勝率 {wr:.3f}  95%CI [{wr - half:.3f}, {wr + half:.3f}]  ({len(seeds) * 2} 局)")
    ok = wr >= 0.55 and wr - half > 0.5
    print("→ 採用目安を満たす" if ok else "→ 採用目安（勝率55%以上・CI下限>50%）に届かない")

    solo_seeds = draw_seeds(rng, args.solo_seeds, VALID_SEED_RANGE)
    print("\nひとり用（60手・おじゃま無し）:")
    for name, pol in (("現行", base), ("best", best)):
        print(f"  {name}: {solo_summary(pol, solo_seeds, args.threads)}")

    print("\n本番へ書き写す値（変化したもののみ）:")
    for k, v in P.describe(best, base).items():
        where = "cpu5_worker_io.js" if k.startswith("COUNTER_") else "cpu5_weights.js"
        print(f"  {k:28s} {v['from']} → {v['to']}   ({where})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
