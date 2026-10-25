"""テト同士の総当たり（lv4/lv5/lv6）：勝率・席の偏り・火力・速度。

設計: source_assets/memory/cpu/tet/lv5-terrain-design.md §4・§5.1
  python3 py/tvt_baseline.py                    # 既定 200 シード × 席を入れ替えた2局 × 3 組
  python3 py/tvt_baseline.py --seeds 500 --pairs 4-5 5-6
同じレベル同士は既定でツモを両者別にする（--tumo auto。共通ツモだと相殺し合ってほぼ全局が上限まで引き分け）。
同じレベル同士は席を入れ替えた2局が鏡写しになり勝率はちょうど 0.5（シミュに席の偏りが無いことの確認にしかならない）。
結果は runs/tvt/baseline.json と runs/tvt/baseline.md に書く。
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np

import tetsim

ROOT = Path(__file__).resolve().parent.parent


def wilson(k: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def summarize(res: list[dict], la: int, lb: int) -> dict:
    n = len(res)
    w = np.array([r["winner"] for r in res])
    a_first = np.array([r["a_first"] for r in res]) == 1   # A が席0
    # 引き分けは半勝ち扱い
    score = (w == 0) + 0.5 * (w == -1)
    lo, hi = wilson(score.sum(), n)
    minutes = np.array([r["ms"] for r in res]) / 60000.0
    side = {}
    for s in ("a", "b"):
        pieces = np.array([r[f"{s}_pieces"] for r in res])
        side[s] = {
            "pps": float(pieces.sum() / (minutes.sum() * 60)),
            "apm": float(np.sum([r[f"{s}_tet_attack"] for r in res]) / minutes.sum()),
            "tspins_per100": float(100 * np.sum([r[f"{s}_tspins"] for r in res]) / pieces.sum()),
            "tetrises_per100": float(100 * np.sum([r[f"{s}_tetrises"] for r in res]) / pieces.sum()),
            "garbage_taken_per_game": float(np.mean([r[f"{s}_garbage_taken"] for r in res])),
        }
    return {
        "a": la, "b": lb, "games": n,
        "a_win": float(score.mean()), "ci95": [lo, hi],
        "draws": int((w == -1).sum()),
        "a_win_seat0": float(score[a_first].mean()),
        "a_win_seat1": float(score[~a_first].mean()),
        "mean_sec": float(minutes.mean() * 60),
        "side": side,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=200)
    ap.add_argument("--seed-base", type=int, default=1)
    ap.add_argument("--pairs", nargs="*", default=["4-5", "5-6", "4-6"])
    ap.add_argument("--jitter", type=float, default=10.0)
    ap.add_argument("--max-ms", type=float, default=300000.0)
    ap.add_argument("--tumo", choices=["auto", "shared", "own"], default="auto",
                    help="shared=本番どおり両者共通 / own=両者別 / auto=同じレベル同士だけ別（共通だと相殺し合って上限まで引き分けになる）")
    ap.add_argument("--out", default=str(ROOT / "runs" / "tvt" / "baseline"))
    args = ap.parse_args()
    seeds = list(range(args.seed_base, args.seed_base + args.seeds))
    rows = []
    for p in args.pairs:
        la, lb = (int(x) for x in p.split("-"))
        t0 = time.time()
        shared = args.tumo == "shared" or (args.tumo == "auto" and la != lb)
        res = tetsim.vs_run(la, lb, seeds, max_ms=args.max_ms, jitter_ms=args.jitter, shared_tumo=shared)
        s = summarize(res, la, lb)
        s["tumo"] = "共通" if shared else "別"
        s["wall_sec"] = time.time() - t0
        rows.append(s)
        print(f"lv{la} 対 lv{lb}（ツモ{s['tumo']}）: lv{la} の勝率 {s['a_win']:.3f} [{s['ci95'][0]:.3f}, {s['ci95'][1]:.3f}]"
              f"  引分 {s['draws']}  席0 {s['a_win_seat0']:.3f}/席1 {s['a_win_seat1']:.3f}"
              f"  平均 {s['mean_sec']:.0f}秒  ({s['wall_sec']:.0f}s)", flush=True)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".json").write_text(json.dumps({"args": vars(args), "rows": rows}, ensure_ascii=False, indent=1))
    lines = [f"# テト同士の総当たり（{args.seeds} シード × 席を入れ替えた2局、揺らぎ {args.jitter}ms、上限 {args.max_ms / 1000:.0f}秒、引分は半勝ち）", "",
             "| 対戦 | ツモ | 左の勝率 | 95%区間 | 引分 | 左が席0/席1 | 平均秒 | 左 PPS/APM | 右 PPS/APM | 左 T-spin・4L /100手 | 右 T-spin・4L /100手 |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in rows:
        a, b = s["side"]["a"], s["side"]["b"]
        lines.append(f"| lv{s['a']} 対 lv{s['b']} | {s['tumo']} | {s['a_win']:.3f} | {s['ci95'][0]:.3f}–{s['ci95'][1]:.3f} | {s['draws']} | "
                     f"{s['a_win_seat0']:.3f}/{s['a_win_seat1']:.3f} | {s['mean_sec']:.0f} | "
                     f"{a['pps']:.2f}/{a['apm']:.0f} | {b['pps']:.2f}/{b['apm']:.0f} | "
                     f"{a['tspins_per100']:.1f}・{a['tetrises_per100']:.1f} | {b['tspins_per100']:.1f}・{b['tetrises_per100']:.1f} |")
    out.with_suffix(".md").write_text("\n".join(lines) + "\n")
    print(f"→ {out.with_suffix('.md')}")


if __name__ == "__main__":
    main()
