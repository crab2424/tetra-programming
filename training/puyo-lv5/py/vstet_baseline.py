"""異種戦の基準計測：ぷよ（本番 lv6 の vsTet/fastVsTet）対 テト CPU lv5。

    python3 py/vstet_baseline.py                 # 600局（シード 1..600）
    python3 py/vstet_baseline.py --games 200

設計: source_assets/memory/cpu/puyo/lv6-vstet-design.md §7.4 T2
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim  # noqa: E402
import tetsim  # noqa: E402


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def report(rs: list[dict]) -> str:
    a = {k: np.array([r[k] for r in rs]) for k in tetsim.VSTET_KEYS}
    n = len(rs)
    win = int((a["winner"] == 0).sum())
    lose = int((a["winner"] == 1).sum())
    lo, hi = wilson(win, n)
    sec = a["ms"] / 1000
    L = [f"局数 {n}：ぷよ勝ち {win}（{win / n:.3f} [{lo:.3f}, {hi:.3f}]）・テト勝ち {lose}・引分 {n - win - lose}",
         f"決着時間 平均 {sec.mean():.1f}s・中央 {np.median(sec):.1f}s（ぷよ勝ち {sec[a['winner'] == 0].mean():.1f}s／テト勝ち {sec[a['winner'] == 1].mean():.1f}s）",
         f"96秒（マージン）までに決着 {(sec < 96).mean():.1%}"]
    for name, m in (("ぷよ勝ち", a["winner"] == 0), ("テト勝ち", a["winner"] == 1)):
        if m.sum() == 0:
            continue
        L.append(f"[{name}] ぷよ最大連鎖 {a['puyo_max_chain'][m].mean():.1f}・ぷよ→テト {a['puyo_lines_sent'][m].mean():.1f} ライン・"
                 f"ぷよの被弾 {a['puyo_ojama_received'][m].mean():.1f} 個・カウンター手 {a['puyo_counter_turns'][m].mean():.1f}・"
                 f"ただの相殺 {a['free_offsets'][m].mean():.2f} 回・点で相殺 {a['offset_by_score'][m].mean():.1f} 個／"
                 f"テト→ぷよ {a['tet_ojama_sent'][m].mean():.1f} 個・テトのせり上がり {a['tet_garbage_taken'][m].mean():.1f}・テト最終高さ {a['tet_final_height'][m].mean():.1f}")
    mc = a["puyo_max_chain"].astype(int)
    hist = np.bincount(mc, minlength=12)
    L.append("ぷよ最大連鎖の分布: " + " ".join(f"{i}:{hist[i]}" for i in range(len(hist)) if hist[i]))
    rate = a["tet_ojama_sent"].sum() / a["ms"].sum() * 60000
    L.append(f"テト→ぷよ 全体 {rate:.1f} 個/分・テト毎秒ミノ {a['tet_pieces'].sum() / a['ms'].sum() * 1000:.2f}")
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=600)
    ap.add_argument("--seed0", type=int, default=1)
    ap.add_argument("--policy", default="lv6")
    args = ap.parse_args()
    pol = tetsim.vstet_policy(args.policy)
    t = time.time()
    rs = tetsim.run_vstet(pol, np.arange(args.seed0, args.seed0 + args.games), both_orders=False)
    print(f"（{time.time() - t:.0f}s）")
    print(report(rs))


if __name__ == "__main__":
    main()
