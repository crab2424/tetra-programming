"""異種戦（ぷよ 対 テト lv5）の負け方の記録（sim_trace_vstet の JSONL を読む）。

    python3 py/vstet_losses.py --collect                 # runs/analysis/vstet_lv6.jsonl に 600 局を記録して集計
    python3 py/vstet_losses.py runs/analysis/vstet_lv6.jsonl

見るもの（設計: source_assets/memory/cpu/puyo/lv6-vstet-design.md §10.1）
  ・被弾のたびに「1列に同色 1〜3 個足して起こせる最大連鎖」（bestIgnition）が残っているか、どれだけ減ったか
  ・どの局面で死んだか（撃てる連鎖を持ったまま／発火点が埋まって／撃つものがない）
  ・撃った連鎖（モード別：本線・カウンター）の段数と、ただの相殺
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

T, TURN, MODE, INC, QUEUE, FIRE, REASON, FC, FS, PC, PS, IGN, PUYOS, OJAMA, H = range(15)


def load(path):
    return [json.loads(l) for l in open(path)]


def pct(a, b):
    return f"{a / b:.0%}" if b else "-"


def report(rows) -> str:
    L = []
    for label, sel in (("テト勝ち（ぷよの負け）", 1), ("ぷよ勝ち", 0)):
        g = [r for r in rows if r["winner"] == sel]
        if not g:
            continue
        L.append(f"## {label} {len(g)} 局")
        drops = [d for r in g for d in r["P"]["drops"]]
        n = len(drops)
        amt = np.array([d[2] for d in drops])
        b = np.array([d[3][0] for d in drops]); a = np.array([d[4][0] for d in drops])
        L.append(f"被弾 {n} 回（1局 {n / len(g):.1f} 回）・1回 平均 {amt.mean():.1f} 個（中央 {np.median(amt):.0f}）")
        L.append(f"  被弾の前に撃てる連鎖（同色1〜3個足し）: 平均 {b.mean():.2f} 段 → 後 {a.mean():.2f} 段")
        L.append(f"  減った {pct((a < b).sum(), n)}・変わらず {pct((a == b).sum(), n)}・増えた {pct((a > b).sum(), n)}")
        L.append(f"  前に3段以上あった被弾 {pct((b >= 3).sum(), n)} → そのうち後も3段以上 {pct(((b >= 3) & (a >= 3)).sum(), (b >= 3).sum())}")
        for lo, hi in ((1, 6), (6, 12), (12, 18), (18, 30), (30, 99)):
            m = (amt >= lo) & (amt < hi)
            if m.sum():
                L.append(f"    {lo:>2}〜{hi - 1:>2}個 {m.sum():4d} 回: {b[m].mean():.2f} → {a[m].mean():.2f} 段"
                         f"（減った {pct((a[m] < b[m]).sum(), m.sum())}）")
        # 最初の被弾
        first = [r["P"]["drops"][0] for r in g if r["P"]["drops"]]
        if first:
            L.append(f"  最初の被弾: 平均 {np.mean([d[0] for d in first]) / 1000:.1f} 秒・{np.mean([d[1] for d in first]):.1f} 手目・"
                     f"{np.mean([d[2] for d in first]):.1f} 個・その時の撃てる連鎖 {np.mean([d[3][0] for d in first]):.2f} 段")
        # 撃った連鎖
        fires = [f for r in g for f in r["P"]["fires"]]
        byMode = Counter(f["mode"] for f in fires)
        L.append(f"発火 {len(fires)} 回（1局 {len(fires) / len(g):.1f}）・モード {dict(byMode)}（0=本線 1=カウンター）")
        for m in sorted(byMode):
            fm = [f for f in fires if f["mode"] == m]
            ch = np.array([f["chains"] for f in fm])
            L.append(f"  mode{m}: 段数 平均 {ch.mean():.2f}・分布 {dict(sorted(Counter(ch.tolist()).items()))}・"
                     f"相殺 {np.mean([f['offset'] for f in fm]):.1f}・送 {np.mean([f['sent'] for f in fm]):.1f} ライン・"
                     f"発火時キュー {np.mean([f['queue'] for f in fm]):.1f}")
        # 思考の記録
        turns = [t for r in g for t in r["P"]["turns"]]
        mode = Counter(t[MODE] for t in turns)
        L.append(f"手 {len(turns)}（1局 {len(turns) / len(g):.1f}）・カウンター手 {pct(mode.get(1, 0), len(turns))}")
        inc = np.array([t[INC] for t in turns]); fc = np.array([t[FC] for t in turns])
        L.append(f"  受け量>0 の手 {pct((inc > 0).sum(), len(turns))}・その手で今撃てる最大 平均 {fc[inc > 0].mean():.2f} 段")
        # 決着時（最後の手）
        last = [r["P"]["turns"][-1] for r in g if r["P"]["turns"]]
        lc = np.array([t[IGN][0] for t in last]); lf = np.array([t[FC] for t in last])
        L.append(f"最後の手: 撃てる連鎖(発火点) {lc.mean():.2f} 段（0段 {pct((lc == 0).sum(), len(last))}・3段以上 {pct((lc >= 3).sum(), len(last))}）・"
                 f"現ペアで撃てる最大 {lf.mean():.2f}・おじゃま {np.mean([t[OJAMA] for t in last]):.1f}・色ぷよ {np.mean([t[PUYOS] for t in last]):.1f}・"
                 f"受け量 {np.mean([t[INC] for t in last]):.1f}")
        # 盤面の最大の撃てる連鎖（局の中で）
        peak = np.array([max([t[IGN][0] for t in r["P"]["turns"]] or [0]) for r in g])
        L.append(f"局中の撃てる連鎖の最大: 平均 {peak.mean():.2f}・分布 {dict(sorted(Counter(peak.tolist()).items()))}")
        mc = np.array([max([f["chains"] for f in r["P"]["fires"]] or [0]) for r in g])
        L.append(f"実際に撃った最大: 平均 {mc.mean():.2f}・本線級(≧6)を撃った局 {pct((mc >= 6).sum(), len(g))}")
        # 時系列（負け局）：経過秒ごとの撃てる連鎖・おじゃま
        if sel == 1:
            L.append("  経過秒 | 撃てる連鎖 | 盤面おじゃま | 色ぷよ | 受け量 | 生存局")
            for s0 in range(0, 60, 5):
                tt = [t for r in g for t in r["P"]["turns"] if s0 * 1000 <= t[T] < (s0 + 5) * 1000]
                alive = sum(1 for r in g if r["dur"] >= s0 * 1000)
                if tt:
                    L.append(f"  {s0:>3}-{s0 + 5:<3} | {np.mean([t[IGN][0] for t in tt]):.2f} | {np.mean([t[OJAMA] for t in tt]):5.1f} | "
                             f"{np.mean([t[PUYOS] for t in tt]):5.1f} | {np.mean([t[INC] for t in tt]):5.1f} | {alive}")
        # 死に方の分類
        if sel == 1:
            cls = Counter()
            for r in g:
                tl = r["P"]["turns"]
                fs = r["P"]["fires"]
                big = max([f["chains"] for f in fs] or [0])
                lastIgn = tl[-1][IGN][0] if tl else 0
                peakIgn = max([t[IGN][0] for t in tl] or [0])
                if big >= 5:
                    cls["本線(5+)を撃った後に負け"] += 1
                elif lastIgn >= 4:
                    cls["4段以上を撃てる状態のまま死亡"] += 1
                elif peakIgn >= 4:
                    cls["4段以上を作ったが埋まって死亡"] += 1
                else:
                    cls["4段以上を一度も作れず"] += 1
            L.append("死に方: " + "・".join(f"{k} {v}（{pct(v, len(g))}）" for k, v in cls.most_common()))
        L.append("")
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default="runs/analysis/vstet_lv6.jsonl")
    ap.add_argument("--collect", action="store_true")
    ap.add_argument("--games", type=int, default=600)
    args = ap.parse_args()
    if args.collect:
        import tetsim
        tetsim.trace_vstet(tetsim.vstet_policy("lv6"), np.arange(1, args.games + 1), args.path)
    rows = load(args.path)
    w = sum(r["winner"] == 0 for r in rows)
    print(f"{len(rows)} 局・ぷよ勝ち {w}（{w / len(rows):.3f}）\n")
    print(report(rows))


if __name__ == "__main__":
    main()
