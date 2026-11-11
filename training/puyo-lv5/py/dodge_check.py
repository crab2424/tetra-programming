"""テト CPU lv7 の相殺外し（D0）：決まりの4つの条件が試合で何回成り立つかを数える。手は今と同じ。

設計 source_assets/memory/cpu/tet/lv7-dodge-design.md。記録は lv7Search2 の out[160..175]（lv7_wasm.cpp record_d0。
outLen 176 のシミュだけで計算する）と、見積もり（方法 A）の a・m（out[98..113]）。対戦の記録は threat_check.py と同じ
tet_vs_trace（局ごとの JSON）。

  python3 py/dodge_check.py run --a lv6n_w256_t56 --b clys_full --seeds 50 --name d0_full
  python3 py/dodge_check.py analyze --name d0_full
"""
from __future__ import annotations

import argparse
import itertools

import numpy as np

import threat_check as tc
from phase0 import PRESETS

RUNS = tc.ROOT / "runs" / "dodge"
# 見積もりは方法 A だけ（幅 64・締め切り 4ms＝本番 5ms を native の速さで割った値）。REN 探索は使わない
THREAT_W = {64: 64, 65: 4}

TR_OUT = tc.TR_OUT
O_A, O_M = tc.O_A, tc.O_M
O_D0 = 64   # out[160] の位置（out[96..] の中で）

# 1手の時間（ms）。両者 3 PPS（lv7-threat-design.md §2.3）
MY_MS = OPP_MS = 330


def m_window(o: list[int], depth: int) -> int:
    """次の手で撃った火力が相手で ready になるまで（自分の1手＋1500ms）に相手が撃てる火力の最大＝方法 A の m[j]。
    j は 8 手まで、読めた手数より先は比例で伸ばす（lv7_wasm.cpp make_press と同じ）。"""
    j = (MY_MS + 1500) // OPP_MS
    d = max(1, min(depth, 8))
    m = o[O_M:O_M + 8]
    return m[j - 1] if j <= d else m[d - 1] * j // d


def rows_of(games: list[dict]) -> list[dict]:
    rows = []
    for gi, g in enumerate(games):
        for side, (me, op) in enumerate((("a", "b"), ("b", "a"))):
            mine = g[me]
            if not mine["threats"]:
                continue
            ml = mine["locks"]
            for tr in mine["threats"]:
                o = tr[TR_OUT:]
                if len(o) < O_D0 + 16:
                    continue
                d = o[O_D0:O_D0 + 16]
                if not d[0] & 1:
                    continue
                p = tr[1]
                nxt = ml[p:p + 4]
                end_dt = g["ms"] - tr[0]
                rows.append({
                    "game": gi, "t": tr[0], "my_h": tr[3], "my_inc": tr[4], "opp_h": tr[5], "opp_inc": tr[6],
                    "opp_ren": tr[7], "m5": m_window(o, o[1]), "a5": o[O_A + 4],
                    "flags": d[0], "A": d[1], "clear": d[2], "R": d[3], "v_best": d[4], "v_alt": d[5],
                    "surv": d[6], "alt_h": d[7], "alt_center": d[8], "next_atk": d[9], "next_atk0": d[10],
                    "best_h": d[11], "n_cand": d[12], "n_noclear": d[13], "kind": d[14], "d0_ms": d[15] / 100,
                    # 実際の展開（今の打ち方）
                    "act_lines": nxt[0][1] if nxt else -1,
                    "act_next_atk": sum(e[6] for e in nxt[1:3]),
                    "win": g["winner"] == side, "lose": g["winner"] == 1 - side, "end_dt": end_dt,
                })
    return rows


def cond(r: dict, safe_h: int, lethal: int, shot_slack: int = 0) -> tuple[bool, bool, bool]:
    """決まりの条件 1〜3（4＝ready ありで選んだ手が消去・火力 > 0 は rows_of で済み）。"""
    c1 = (r["flags"] & 2) > 0 and r["surv"] <= 20 and r["alt_h"] <= safe_h
    c2 = (r["flags"] & 2) > 0 and r["next_atk"] >= r["A"] - shot_slack
    c3 = r["opp_h"] + r["opp_inc"] + r["A"] - r["m5"] > lethal
    return c1, c2, c3


def pct(x, n):
    return f"{100 * x / n:.1f}%" if n else "-"


def cmd_run(args) -> None:
    tc.RUNS = RUNS
    tc.THREAT_W = THREAT_W
    tc.cmd_run(args)


def cmd_analyze(args) -> None:
    tc.RUNS = RUNS
    games = tc.load(args.name)
    w = [g["winner"] for g in games]
    pieces = sum(len(g["a"]["locks"]) for g in games)
    print(f"{args.name}: {len(games)} 局（A 勝 {w.count(0)}・B 勝 {w.count(1)}・引分 {w.count(-1)}）、A の設置 {pieces}")
    rows = rows_of(games)
    n_games = len(games)
    print(f"\n■ 条件 4（ready の予告があり、選んだ手が消去・火力 > 0）: {len(rows)} 件"
          f"（設置の {pct(len(rows), pieces)}・1局 {len(rows) / n_games:.1f} 件）")
    if not rows:
        return
    R = rows
    print(f"  選んだ手：火力の平均 {np.mean([r['A'] for r in R]):.2f}・消去 {np.mean([r['clear'] for r in R]):.2f}・"
          f"T-spin {pct(sum(r['kind'] & 1 > 0 for r in R), len(R))}・4-LINES {pct(sum(r['kind'] & 2 > 0 for r in R), len(R))}、"
          f"ready の平均 {np.mean([r['R'] for r in R]):.2f}、実際の手が消去 {pct(sum(r['act_lines'] > 0 for r in R), len(R))}")
    print(f"  消去しない候補あり {pct(sum(r['flags'] & 2 > 0 for r in R), len(R))}・visit 比（alt/選んだ手）の中央値 "
          f"{np.median([r['v_alt'] / max(r['v_best'], 1) for r in R]):.3f}・D0 の時間 平均 "
          f"{np.mean([r['d0_ms'] for r in R]):.3f}ms 最大 {max(r['d0_ms'] for r in R):.2f}ms")
    print(f"  自分の高さ {np.mean([r['my_h'] for r in R]):.1f}・alt で受けた後の最大の高さ {np.mean([r['alt_h'] for r in R]):.1f}、"
          f"相手の高さ {np.mean([r['opp_h'] for r in R]):.1f}・相手の予告 {np.mean([r['opp_inc'] for r in R]):.1f}・"
          f"m（次の手が着くまで）{np.mean([r['m5'] for r in R]):.1f}")

    print("\n■ 条件ごとの成り立ち（安全の線 16・致死の線 18 の例）")
    cs = [cond(r, 16, 18) for r in R]
    for k, label in enumerate(("1 受けても安全", "2 次に撃てる", "3 撃てば相手に効く")):
        print(f"  {label}: {pct(sum(c[k] for c in cs), len(R))}")
    print(f"  1∧2: {pct(sum(c[0] and c[1] for c in cs), len(R))}  全部: {pct(sum(all(c) for c in cs), len(R))}")

    print("\n■ 4つ全部が成り立つ件数（安全の線 × 致死の線。次に撃てる＝火力 ≥ A）")
    print("  安全\\致死 | " + " | ".join(f"{L:>16d}" for L in (14, 16, 18, 20)))
    for H in (12, 14, 16, 18):
        cells = []
        for L in (14, 16, 18, 20):
            hit = [r for r in R if all(cond(r, H, L))]
            g = len({r["game"] for r in hit})
            cells.append(f"{len(hit):4d} 件 {g:3d} 局 ({pct(len(hit), pieces)})")
        print(f"  {H:>9d} | " + " | ".join(cells))

    for H, L in ((16, 18), (16, 20), (14, 16), (18, 20)):
        hit = [r for r in R if all(cond(r, H, L))]
        print(f"\n■ 安全 {H}・致死 {L}：{len(hit)} 件（{len({r['game'] for r in hit})} 局）")
        if not hit:
            continue
        n = len(hit)
        print(f"  火力 A {np.mean([r['A'] for r in hit]):.1f}・ready {np.mean([r['R'] for r in hit]):.1f}・"
              f"自分の高さ {np.mean([r['my_h'] for r in hit]):.1f}→受けた後 {np.mean([r['alt_h'] for r in hit]):.1f}、"
              f"相手の高さ＋予告 {np.mean([r['opp_h'] + r['opp_inc'] for r in hit]):.1f}・m {np.mean([r['m5'] for r in hit]):.1f}・"
              f"越える量 {np.mean([r['opp_h'] + r['opp_inc'] + r['A'] - r['m5'] - L for r in hit]):.1f}")
        print(f"  visit 比の中央値 {np.median([r['v_alt'] / max(r['v_best'], 1) for r in hit]):.3f}・"
              f"選んだ手 T-spin {pct(sum(r['kind'] & 1 > 0 for r in hit), n)}・4-LINES {pct(sum(r['kind'] & 2 > 0 for r in hit), n)}")
        print(f"  今の打ち方での結果：その局に勝ち {pct(sum(r['win'] for r in hit), n)}・"
              f"3 秒以内に相手が倒れた {pct(sum(r['win'] and r['end_dt'] <= 3000 for r in hit), n)}・"
              f"6 秒以内 {pct(sum(r['win'] and r['end_dt'] <= 6000 for r in hit), n)}・"
              f"6 秒以内に自分が倒れた {pct(sum(r['lose'] and r['end_dt'] <= 6000 for r in hit), n)}")
        # 局ごとに最初の1件だけ（同じ局面が何手も続くので）
        first = {}
        for r in hit:
            first.setdefault(r["game"], r)
        f = list(first.values())
        print(f"  局ごとの最初の1件（{len(f)} 局）：その局に勝ち {pct(sum(r['win'] for r in f), len(f))}・"
              f"6 秒以内に相手が倒れた {pct(sum(r['win'] and r['end_dt'] <= 6000 for r in f), len(f))}・"
              f"6 秒以内に自分が倒れた {pct(sum(r['lose'] and r['end_dt'] <= 6000 for r in f), len(f))}")

    # 条件 3 の足りなさ：相手の高さ＋予告＋A − m の分布と、緩めた場合
    eff = np.array([r["opp_h"] + r["opp_inc"] + r["A"] - r["m5"] for r in R])
    raw = np.array([r["opp_h"] + r["opp_inc"] + r["A"] for r in R])
    print(f"\n■ 条件 3 の値：相手の高さ＋予告＋A − m は 平均 {eff.mean():.1f}・90% 点 {np.percentile(eff, 90):.1f}・"
          f"最大 {eff.max()}（m を引かない値は 平均 {raw.mean():.1f}・90% 点 {np.percentile(raw, 90):.1f}・最大 {raw.max()}）")
    print(f"  相手の予告が 0 の件 {pct(sum(r['opp_inc'] == 0 for r in R), len(R))}、相手の高さ ≥ 10 の件 "
          f"{pct(sum(r['opp_h'] >= 10 for r in R), len(R))}")
    print("  条件 1（安全 16）∧2 に、緩めた条件 3 を足した件数（局数）：")
    for L in (8, 10, 12, 14):
        a = [r for r in R if cond(r, 16, 99)[0] and cond(r, 16, 99)[1] and r["opp_h"] + r["opp_inc"] + r["A"] - r["m5"] > L]
        b = [r for r in R if cond(r, 16, 99)[0] and cond(r, 16, 99)[1] and r["opp_h"] + r["opp_inc"] + r["A"] > L]
        print(f"    線 {L:2d}: m を引く {len(a):3d} 件（{len({r['game'] for r in a})} 局・その局の勝ち "
              f"{pct(sum(r['win'] for r in a), len(a))}） ／ m を引かない {len(b):3d} 件（{len({r['game'] for r in b})} 局）")

    # 負けた局で、負ける前に条件が成り立っていたか
    print("\n■ 負けた局のうち、条件（安全 16・致死 18／20）が成り立った局")
    lost = {gi for gi, g in enumerate(games) if g["winner"] == 1}
    for L in (18, 20):
        hit = {r["game"] for r in R if all(cond(r, 16, L)) and r["lose"]}
        print(f"  致死 {L}: {len(hit)}/{len(lost)} 局")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--a", default="lv6n_w256_t56", choices=PRESETS)
    r.add_argument("--b", default="clys_full", choices=PRESETS)
    r.add_argument("--b-threat", action="store_true")
    r.add_argument("--wa")
    r.add_argument("--wb")
    r.add_argument("--seeds", type=int, default=50)
    r.add_argument("--seed-base", type=int, default=1)
    r.add_argument("--max-ms", type=float, default=300000)
    r.add_argument("--threads", type=int, default=0)
    r.add_argument("--name", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--name", required=True)
    args = ap.parse_args()
    {"run": cmd_run, "analyze": cmd_analyze}[args.cmd](args)


if __name__ == "__main__":
    main()
