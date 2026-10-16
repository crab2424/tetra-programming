"""催促（H1）・対応（H2）の中身を記録で確かめる（段階2。設計: lv6-harass-design.md §9.4）。

  python3 py/harass_trace.py --cand "H1H2" --opp lv6 [--seeds 300]

候補 X と相手 Y を先後2局ずつ記録し（trace_matches）、次を集計する。
  ・催促（発火理由4）の回数・段数・送った量・撃った手数
  ・催促を受けた側の次の発火：本線級（おじゃま30個以上）で返したか、小さく返したか、返さなかったか
  ・カウンター（mode 1）で撃った連鎖の大きさ（H2 で本線を吐かなくなったか）
  ・勝率（催促を撃った局／撃たなかった局）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from analyze_losses import BIG, RATE  # noqa: E402
from solo_baseline import I_H2, I_H_KEEP, I_H_REACH, I_H_MAXC, I_H_MIN, I_QJUNK_W, I_QSUB_W, with_build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "runs" / "analysis"
HARASS = 4


def policies(base: dict) -> dict[str, ps.Policy]:
    lv6 = ps.Policy.lv6(base)
    h1 = {I_H_MIN: 12, I_H_MAXC: 3, I_H_KEEP: 80}
    return {
        "lv6": lv6,
        "lv6h2": with_build(lv6, {I_H2: 1}),
        "H1": with_build(lv6, h1),
        "H1H2": with_build(lv6, {**h1, I_H2: 1}),
        "H1H2E2": with_build(lv6, {**h1, I_H2: 1, I_QJUNK_W: -60, I_QSUB_W: 40}),
        "H1r300": with_build(lv6, {**h1, I_H_REACH: 300}),
        "H1r300H2E2": with_build(lv6, {**h1, I_H_REACH: 300, I_H2: 1, I_QJUNK_W: -60, I_QSUB_W: 40}),
    }


def summarize(games: list[dict], label: str, side_of) -> list[str]:
    n = len(games)
    wins = harass_games = harass_wins = 0
    h_fires, replies, counter_sizes = [], {"本線級で返す": 0, "小さく返す": 0, "返さない": 0}, []
    for g in games:
        me, opp = side_of(g)
        P, Q = g[me], g[opp]
        win = g["winner"] == (0 if me == "A" else 1)
        wins += win
        hs = [f for f in P["fires"] if f["reason"] == HARASS]
        if hs:
            harass_games += 1
            harass_wins += win
        for f in hs:
            h_fires.append(f)
            # 相手の次の発火（催促の連鎖が終わってから 3 秒以内に始まったもの）
            nxt = next((q for q in Q["fires"] if f["t1"] <= q["t0"] <= f["t1"] + 3000), None)
            if nxt is None:
                replies["返さない"] += 1
            elif nxt["score"] >= BIG * RATE:
                replies["本線級で返す"] += 1
            else:
                replies["小さく返す"] += 1
        counter_sizes += [len(f["steps"]) for f in P["fires"] if f["mode"] == 1]
    L = [f"### {label}（{n} 局）", f"- 勝率 {wins / n:.3f}"]
    if h_fires:
        L.append(f"- 催促 {len(h_fires) / n:.2f} 回/局（撃った局 {harass_games}・その勝率 {harass_wins / max(1, harass_games):.3f}）"
                 f"・段数 {np.mean([len(f['steps']) for f in h_fires]):.2f}・送った {np.mean([f['sent'] for f in h_fires]):.1f} 個"
                 f"・相殺 {np.mean([f['offset'] for f in h_fires]):.1f} 個・手数（中央値）{np.median([f['turn'] for f in h_fires]):.0f}")
        tot = sum(replies.values())
        L.append("- 催促への相手の返し（3秒以内）: " + "・".join(f"{k} {v / tot:.0%}" for k, v in replies.items()))
    else:
        L.append("- 催促 0 回")
    if counter_sizes:
        a = np.array(counter_sizes)
        L.append(f"- カウンター発火 {len(a) / n:.2f} 回/局・段数 平均 {a.mean():.2f}・8連鎖以上 {np.mean(a >= 8):.0%}")
    return L


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cand", default="H1H2")
    ap.add_argument("--opp", default="lv6")
    ap.add_argument("--seeds", type=int, default=300)
    args = ap.parse_args()
    pol = policies(ps.load_baseline())
    X, Y = pol[args.cand].packed(), pol[args.opp].packed()
    n = args.seeds
    seeds = np.arange(960000, 960000 + n, dtype=np.uint32)
    path = OUT / f"harass_{args.cand}_vs_{args.opp}.jsonl"
    # 先頭 n 局は A=候補、続く n 局は A=相手（同じシードで先後を入れ替える）
    ps.trace_matches(np.concatenate([np.tile(X, (n, 1)), np.tile(Y, (n, 1))]),
                     np.concatenate([np.tile(Y, (n, 1)), np.tile(X, (n, 1))]),
                     np.concatenate([seeds, seeds]), path)
    games = [json.loads(l) for l in path.open()]
    cand_side = lambda g: ("A", "B") if g["job"] < n else ("B", "A")
    opp_side = lambda g: ("B", "A") if g["job"] < n else ("A", "B")
    lines = [f"## 催促の記録 {args.cand} 対 {args.opp}（{n} シード × 先後）", ""]
    lines += summarize(games, f"{args.cand}（候補）", cand_side) + [""]
    lines += summarize(games, f"{args.opp}（相手）", opp_side)
    text = "\n".join(lines)
    print(text)
    (OUT / f"harass_{args.cand}_vs_{args.opp}.md").write_text(text + "\n")


if __name__ == "__main__":
    main()
