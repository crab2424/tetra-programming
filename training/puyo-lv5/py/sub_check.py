"""副砲・催促の本線条件（G1/G2）の事前確認（lv6-harass-design.md §10.4）。

    python3 py/sub_check.py [--seeds 300] [--only 名前,...] [--skip-solo]

候補（現行 lv6 ＋ §10.4 の固定値 ＋ 副砲の重み）ごとに次を出す。
  ひとり用（80手）: 副砲を持っている手の割合・初めて副砲が評価に乗った手数とそのときの本線の段数
  対戦（現行 lv6 相手・先後）: 勝率・催促の回数（全体／本線7連鎖以上の局面）・時期・催促した局の勝率・
                              カウンターで使った色ぷよ数
目安: 催促は本線が7連鎖を超えた後に限って 1局 0.3回以上、lv6 相手の勝率 0.47 以上。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import puyosim as ps  # noqa: E402
from solo_baseline import with_build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "runs" / "analysis"
HARASS = 4
MAINSUB = 17                       # turns[] の [本線段数, 本線色ぷよ, 副砲の点, 副砲を評価中]
I_QSUB_W = 45
I_H_MIN, I_H_MAXC, I_H_KEEP, I_H2, I_H_REACH = 46, 47, 48, 49, 50
I_SUB_CH, I_SUB_PY, I_SUB_FILL = 51, 52, 53

# §10.4 の固定値（学習しない）：H1(12個・3段・80%・200個)・H2・本線条件 7連鎖/30個
FIXED = {I_H_MIN: 12, I_H_MAXC: 3, I_H_KEEP: 80, I_H_REACH: 200, I_H2: 1, I_SUB_CH: 7, I_SUB_PY: 30}


def configs(base: dict) -> dict[str, ps.Policy]:
    lv6 = ps.Policy.lv6(base)
    g = {**FIXED, I_QSUB_W: 60, I_SUB_FILL: 40}   # 学習の初期値
    return {
        "lv6": lv6,
        "fixed": with_build(lv6, FIXED),                       # 固定値だけ（副砲の重みは lv6 のまま）
        "G": with_build(lv6, g),
        "G fill0": with_build(lv6, {**g, I_SUB_FILL: 0}),
        "G fill50": with_build(lv6, {**g, I_SUB_FILL: 50}),
        "G sub150": with_build(lv6, {**g, I_QSUB_W: 150}),
        "G h2=2": with_build(lv6, {**g, I_H2: 2}),
        "G h2=3": with_build(lv6, {**g, I_H2: 3}),
    }


def solo_report(name: str, pol: ps.Policy, n: int) -> str:
    path = OUT / f"subcheck_solo_{name.replace(' ', '_')}.jsonl"
    ps.trace_solo(pol.packed(), np.arange(970000, 970000 + n, dtype=np.uint32), path, max_turns=80)
    have, first_turn, first_main = [], [], []
    for line in path.open():
        P = json.loads(line)["P"]
        rows = P["turns"]
        flags = [r[MAINSUB][3] == 1 and r[MAINSUB][2] > 0 for r in rows]
        have.append(np.mean(flags) if flags else 0.0)
        k = next((i for i, f in enumerate(flags) if f), None)
        if k is not None:
            first_turn.append(rows[k][1])
            first_main.append(rows[k][MAINSUB][0])
    s = f"副砲あり {np.mean(have):.0%} の手"
    if first_turn:
        s += (f"・初出 {len(first_turn) / n:.0%} の局で {np.median(first_turn):.0f} 手目"
              f"（本線 {np.mean(first_main):.1f} 段）")
    return s


def versus_report(name: str, pol: ps.Policy, opp: ps.Policy, n: int) -> tuple[str, float]:
    X, Y = pol.packed(), opp.packed()
    seeds = np.arange(960000, 960000 + n, dtype=np.uint32)
    path = OUT / f"subcheck_vs_{name.replace(' ', '_')}.jsonl"
    ps.trace_matches(np.concatenate([np.tile(X, (n, 1)), np.tile(Y, (n, 1))]),
                     np.concatenate([np.tile(Y, (n, 1)), np.tile(X, (n, 1))]),
                     np.concatenate([seeds, seeds]), path)
    wins, h_all, h_main, h_turns, h_games, h_wins, counter_used = [], 0, 0, [], 0, 0, []
    for line in path.open():
        g = json.loads(line)
        me = "A" if g["job"] < n else "B"
        P = g[me]
        win = 1.0 if g["winner"] == (0 if me == "A" else 1) else 0.5 if g["winner"] == -1 else 0.0
        wins.append(win)
        by_turn = {r[1]: r for r in P["turns"]}
        hs = [f for f in P["fires"] if f["reason"] == HARASS]
        if hs:
            h_games += 1
            h_wins += win
        for f in hs:
            h_all += 1
            h_turns.append(f["turn"])
            r = by_turn.get(f["turn"])
            if r is not None and r[MAINSUB][0] >= 7:
                h_main += 1
        counter_used += [f["pb"] - f["pa"] for f in P["fires"] if f["mode"] == 1]
    wr = float(np.mean(wins))
    half = 1.96 * float(np.std(np.array(wins).reshape(2, n).mean(axis=0), ddof=1)) / np.sqrt(n)
    s = (f"勝率 {wr:.3f}±{half:.3f}・催促 {h_all / (2 * n):.2f} 回/局（本線7連鎖以上 {h_main / (2 * n):.2f}）")
    if h_all:
        s += f"・{np.median(h_turns):.0f} 手目・撃った局の勝率 {h_wins / h_games:.3f}"
    if counter_used:
        s += f"・カウンター {len(counter_used) / (2 * n):.2f} 回/局で色ぷよ {np.mean(counter_used):.1f} 個"
    return s, wr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=300)
    ap.add_argument("--only", default=None)
    ap.add_argument("--skip-solo", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    base = ps.load_baseline()
    cfg = configs(base)
    lv6 = cfg["lv6"]
    names = args.only.split(",") if args.only else list(cfg)
    lines = [f"## 副砲・催促の本線条件の事前確認（{args.seeds} シード）", ""]
    for name in names:
        pol = cfg[name]
        solo = "" if args.skip_solo else solo_report(name, pol, args.seeds)
        vs, _ = versus_report(name, pol, lv6, args.seeds) if name != "lv6" else ("（基準）", 0.5)
        line = f"- **{name}**：ひとり用 {solo}／対 lv6 {vs}"
        print(line, flush=True)
        lines.append(line)
    (OUT / "subcheck.md").write_text("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
