"""異種戦（ぷよ lv6 対 テト lv5）の A/B：持論の構造（設計 lv6-vstet-design.md §10）を1つずつ足して 600 局。

    python3 py/vstet_ab.py base k1 k2            # 名前は VARIANTS を参照
    python3 py/vstet_ab.py --list

同じシード（1..600・同時刻はぷよ先）で打つので、基準との差は対応のある比較（勝ち負けが入れ替わった局の数）で見る。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import tetsim  # noqa: E402
from vstet_baseline import wilson  # noqa: E402


def mk(build=None, fast=None, **ext):
    """build/fast：{添字: 値}。ext：puyosim.EXT の名前。"""
    def f(pol):
        for k, v in (build or {}).items():
            pol.build[k] = v
        for k, v in (fast or {}).items():
            pol.fast[k] = v
        return pol.with_ext(**ext) if ext else pol
    return f


# 重みの添字（core/weights.h）
QSUB, SUB_MC, SUB_MP, SUB_FILL, KEEP_W, KEEP_D, KEEP_R = 45, 51, 52, 53, 54, 55, 56
VARIANTS = {
    "base": mk(),
    # ① 降っても撃てる（K）：おじゃまを qKeepRows 段載せた後に起こせる連鎖に価値（正）／失う量に罰（負）
    "k1":   mk({KEEP_W: 5, KEEP_D: 2, KEEP_R: 1}),
    "k2":   mk({KEEP_W: 10, KEEP_D: 2, KEEP_R: 1}),
    "k3":   mk({KEEP_W: 20, KEEP_D: 2, KEEP_R: 1}),
    "k2r2": mk({KEEP_W: 10, KEEP_D: 2, KEEP_R: 2}),
    "kn":   mk({KEEP_W: -10, KEEP_D: 2, KEEP_R: 1}),
    "kn2":  mk({KEEP_W: -20, KEEP_D: 2, KEEP_R: 1}),
    # ② 相殺用の副砲＋本線（E2b qSub と G1）＋カウンターで本線を残す（H2）
    "s1":   mk({QSUB: 45, SUB_MC: 5, SUB_MP: 20}),
    "s2":   mk({QSUB: 100, SUB_MC: 5, SUB_MP: 20}),
    "s3":   mk({QSUB: 100, SUB_MC: 4, SUB_MP: 0}),
    "h2":   mk(vt_keep_reach=1),
    "h2c":  mk(vt_keep_reach=3),
    "s2h2": mk({QSUB: 100, SUB_MC: 5, SUB_MP: 20}, vt_keep_reach=1),
    # ③ 経過時間で本線の目標発火を下げる
    "d60":  mk(vt_decay_start_s=60, vt_decay_step_s=10, vt_decay_min=4),
    "d30":  mk(vt_decay_start_s=30, vt_decay_step_s=10, vt_decay_min=4),
    "d15":  mk(vt_decay_start_s=15, vt_decay_step_s=10, vt_decay_min=4),
    "d15m5": mk(vt_decay_start_s=15, vt_decay_step_s=10, vt_decay_min=5),
    # ④ カウンターをただの相殺に合わせる
    "c100":  mk(vt_counter_pct=100),
    "c100q": mk(vt_counter_pct=100, vt_queue_only=1),
    "c80q":  mk(vt_counter_pct=80, vt_queue_only=1),
    "c130q": mk(vt_counter_pct=130, vt_queue_only=1),
}


def run(name: str, games: int, pol0) -> dict:
    pol = VARIANTS[name](tetsim.vstet_policy("lv6").__class__(list(pol0.build), list(pol0.fast),
                                                               pol0.counter_trigger, pol0.counter_margin,
                                                               list(pol0.ext)))
    rs = tetsim.run_vstet(pol, np.arange(1, games + 1), both_orders=False)
    w = np.array([r["winner"] == 0 for r in rs])
    a = {k: np.array([r[k] for r in rs]) for k in tetsim.VSTET_KEYS}
    return {"win": w, "a": a}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--games", type=int, default=600)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        print(" ".join(VARIANTS))
        return
    pol0 = tetsim.vstet_policy("lv6")
    base = None
    for name in (["base"] + [n for n in args.names if n != "base"]):
        t = time.time()
        r = run(name, args.games, pol0)
        w = r["win"]
        a = r["a"]
        lo, hi = wilson(int(w.sum()), len(w))
        line = (f"{name:7s} 勝率 {w.mean():.3f} [{lo:.3f}, {hi:.3f}]")
        if base is not None:
            gain = int((w & ~base).sum()); loss = int((~w & base).sum())
            line += f"  基準比 +{gain}/−{loss}"
        lose = a["winner"] == 1
        line += (f"｜決着 中央 {np.median(a['ms']) / 1000:.1f}s・最大連鎖 {a['puyo_max_chain'].mean():.2f}"
                 f"（≧6 {(a['puyo_max_chain'] >= 6).mean():.1%}）・送 {a['puyo_lines_sent'].mean():.1f} ライン・"
                 f"被弾 {a['puyo_ojama_received'].mean():.1f}・ただの相殺 {a['free_offsets'].mean():.2f}・"
                 f"カウンター手 {a['puyo_counter_turns'].mean():.1f}・負け局の最大連鎖 {a['puyo_max_chain'][lose].mean():.2f}"
                 f"（{time.time() - t:.0f}s）")
        print(line, flush=True)
        if base is None:
            base = w


if __name__ == "__main__":
    main()
