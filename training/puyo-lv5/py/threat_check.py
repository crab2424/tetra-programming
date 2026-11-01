"""テト CPU lv7 の相手の火力の見積もり（T1）：見積もりの当たり方と負け方を、シミュの対戦の記録で確かめる。

設計 source_assets/memory/cpu/tet/lv7-threat-design.md §7.2。見積もりは lv7Search2 の out[96..147]
（a・m＝方法 A の手ごとの火力の累計、REN 探索＝方法 B）。T0 では見積もりは手の選び方に使わないので、
A の打ち方は見積もりの時間ぶん探索が短くなる以外は今と同じ。

  python3 py/threat_check.py run --a lv6n_w256_t56 --b clys_full --seeds 50 --name t1_full
  python3 py/threat_check.py analyze --name t1_full
"""
from __future__ import annotations

import argparse
import ctypes
import glob
import json
import shutil
import time
from pathlib import Path

import numpy as np

import tetsim
from phase0 import PRESETS, apply_side

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs" / "threat"

# 相手の見積もりの重み（eval.h [64..72]）。native は本番 wasm の約 1.42 倍速いので、締め切りは本番の 5ms・15ms を割った値
THREAT_W = {64: 64, 65: 4, 66: 32, 67: 16, 68: 12, 72: 11}

# out[96..147] の中の位置
O_FLAGS, O_DEPTH, O_A, O_M, O_MS = 0, 1, 2, 10, 18
O_VIS_LEN, O_VIS_ATK, O_RUNS, O_LEN_MEAN10, O_LEN_MAX, O_ATK_MEAN10, O_ATK_MAX, O_R = 20, 21, 22, 23, 24, 25, 26, 32
TR_OUT = 8   # threats の行で out が始まる位置


def weights_with(level: int, extra: dict[int, int]) -> list[int]:
    w = tetsim.sim_default_weights(level)
    w += [0] * max(max(extra) + 1 - len(w), 0)
    for k, v in extra.items():
        w[k] = v
    return w


def parse_kv(s: str | None) -> dict[int, int]:
    if not s:
        return {}
    return {int(k): int(v) for k, v in (kv.split("=") for kv in s.split(","))}


def cmd_run(args) -> None:
    la, ca, sa = PRESETS[args.a]
    lb, cb, sb = PRESETS[args.b]
    tetsim.set_model_think(True, 1.0)
    tetsim.set_side(0, reset=True)
    apply_side(1, ca)
    apply_side(2, cb)
    tetsim.set_think_scale(la, sa, 1.0)
    tetsim.set_think_scale(lb, sb, 1.0)
    wa = weights_with(la, THREAT_W | parse_kv(args.wa)) if la == 36 else None
    wb = weights_with(lb, THREAT_W | parse_kv(args.wb)) if (lb == 36 and args.b_threat) else None
    out = RUNS / args.name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    L = tetsim._lib_lv()
    vp = ctypes.c_void_p
    u32p = np.ctypeslib.ndpointer(np.uint32, flags="C_CONTIGUOUS")
    L.tet_vs_trace.argtypes = [ctypes.c_int, vp, ctypes.c_int, ctypes.c_int, vp, ctypes.c_int, ctypes.c_int, u32p,
                               ctypes.c_double, ctypes.c_int, ctypes.c_int, ctypes.c_double, ctypes.c_int, ctypes.c_int,
                               ctypes.c_char_p]
    pa, na, _ka = tetsim._wptr(wa)
    pb, nb, _kb = tetsim._wptr(wb)
    seeds = np.arange(args.seed_base, args.seed_base + args.seeds, dtype=np.uint32)
    t0 = time.time()
    L.tet_vs_trace(la, pa, na, lb, pb, nb, len(seeds), seeds, float(args.max_ms), 96000, 70, 10.0, 1, args.threads,
                   str(out / "g").encode())
    (out / "args.json").write_text(json.dumps(vars(args) | {"threat_w": THREAT_W}, ensure_ascii=False))
    print(f"{len(seeds) * 2} 局 {time.time() - t0:.0f}s → {out}")


def load(name: str) -> list[dict]:
    games = []
    for f in sorted(glob.glob(str(RUNS / name / "g_*.json"))):
        games.append(json.loads(Path(f).read_text()))
    return games


def side_pairs(g: dict):
    """見積もりの記録がある側と、その相手。"""
    for me, op in (("a", "b"), ("b", "a")):
        if g[me]["threats"]:
            yield me, op


def cum_attack(locks: list, p: int, n: int) -> list[int] | None:
    """相手の設置 p から n 手ぶんの火力の累計（局が先に終わったら None）。"""
    if p + n > len(locks):
        return None
    c, s = [], 0
    for k in range(n):
        s += locks[p + k][6]
        c.append(s)
    return c


def ren_run(locks: list, p: int) -> tuple[int, int, bool]:
    """相手の設置 p から消去が続いた手数・その火力。局の終わりで切れたら第3値が False。"""
    n = atk = 0
    while p + n < len(locks) and locks[p + n][1] > 0:
        atk += locks[p + n][6]
        n += 1
    return n, atk, p + n < len(locks)


def pct(x, n):
    return f"{100 * x / n:.0f}%" if n else "-"


def analyze(games: list[dict]) -> dict:
    rows = []          # 見積もり 1 件ごと
    deaths = []        # スパイク死の分析
    ms = []
    for g in games:
        for me, op in side_pairs(g):
            mine, opp = g[me], g[op]
            ol = opp["locks"]
            for tr in mine["threats"]:
                o = tr[TR_OUT:]
                p = tr[2]
                c = cum_attack(ol, p, 20)
                if c is None:
                    continue
                ms.append(o[O_MS] / 10)
                rn, ratk, done = ren_run(ol, p)
                rows.append({
                    "a": o[O_A:O_A + 8], "m": o[O_M:O_M + 8], "r": o[O_R:O_R + 20], "c": c, "flags": o[O_FLAGS],
                    "depth": o[O_DEPTH], "vis_len": o[O_VIS_LEN], "runs": o[O_RUNS], "len_mean": o[O_LEN_MEAN10] / 10,
                    "len_max": o[O_LEN_MAX], "atk_mean": o[O_ATK_MEAN10] / 10, "atk_max": o[O_ATK_MAX],
                    "ren_len": rn, "ren_atk": ratk, "ren_done": done, "opp_ren": tr[7], "opp_inc": tr[6],
                })
            # 負け：死ぬ前 9 手（約 3 秒）に上がった段数と、その一撃を撃たれる前に見えていたか
            if mine["dead"] and not opp["dead"]:
                ml = mine["locks"]
                t_death = ml[-1][0] if ml else 0
                landed = sum(e[7] for e in ml[-9:])
                d = {"landed9": landed, "pieces": len(ml), "pred": None}
                # 最後の 3 秒に上がり得たのは、死ぬ 6.0〜1.5 秒前に相手が撃った分（1500ms で ready、次の設置で着弾）
                win = [k for k, e in enumerate(ol) if t_death - 6000 <= e[0] <= t_death - 1500]
                fire = [k for k in win if ol[k][6] > 0]
                if fire:
                    p0, p1 = fire[0], win[-1]
                    s = sum(ol[k][6] for k in range(p0, p1 + 1))
                    n = p1 - p0 + 1
                    # 相手が撃ち始める設置 p0 より前（p0 を置く前）の、いちばん新しい見積もり
                    cand = [tr for tr in mine["threats"] if tr[2] <= p0 and tr[0] <= ol[p0][0]]
                    if cand:
                        tr = cand[-1]
                        o = tr[TR_OUT:]
                        k = p0 - tr[2] + n   # 見積もりの時点から数えた手数
                        d["pred"] = {"actual": s, "n": n, "k": k,
                                     "a": o[O_A + min(k, 8) - 1], "m": o[O_M + min(k, 8) - 1],
                                     "r": o[O_R + min(k, 20) - 1],
                                     "lead": len(ml) - tr[1], "my_inc": tr[4], "my_h": tr[3], "opp_inc": tr[6],
                                     "opp_ren": tr[7]}
                deaths.append(d)
    return {"rows": rows, "deaths": deaths, "ms": ms}


def report(res: dict) -> None:
    rows, deaths, ms = res["rows"], res["deaths"], res["ms"]
    n = len(rows)
    print(f"見積もり {n} 件、時間 平均 {np.mean(ms):.1f}ms 最大 {np.max(ms):.1f}ms（native）")
    print("\n■ 方法 A（相手の小さいビーム）：相手が次の j 手で撃った火力の累計 c[j] と比べる")
    print("  j | 実際 c 平均 | a 平均 | a 誤差 | a 相関 | m 平均 | m 誤差 | m 相関 | r 平均 | max(a,r) 誤差")
    for j in (1, 2, 3, 4, 6):
        c = np.array([x["c"][j - 1] for x in rows])
        a = np.array([x["a"][j - 1] for x in rows])
        m = np.array([x["m"][j - 1] for x in rows])
        r = np.array([x["r"][j - 1] for x in rows])
        ar = np.maximum(a, r)
        cor = lambda u: np.corrcoef(u, c)[0, 1] if u.std() > 0 and c.std() > 0 else float("nan")
        print(f"  {j} | {c.mean():6.2f} | {a.mean():6.2f} | {np.abs(a - c).mean():6.2f} | {cor(a):5.2f} | "
              f"{m.mean():6.2f} | {np.abs(m - c).mean():6.2f} | {cor(m):5.2f} | {r.mean():6.2f} | {np.abs(ar - c).mean():6.2f}")
    print("\n■ 大きい攻め（相手が 6 手で 6 以上撃った）を当てたか（予測は 6 手目の値 ≥ 4）")
    big = [x for x in rows if x["c"][5] >= 6]
    for label, f in (("a", lambda x: x["a"][5]), ("m", lambda x: x["m"][5]), ("r", lambda x: x["r"][5]),
                     ("max(a,r)", lambda x: max(x["a"][5], x["r"][5]))):
        hit = sum(1 for x in big if f(x) >= 4)
        flagged = [x for x in rows if f(x) >= 4]
        prec = sum(1 for x in flagged if x["c"][5] >= 6)
        print(f"  {label:9s}: 当てた {hit}/{len(big)}（{pct(hit, len(big))}）・予測 {len(flagged)} 件のうち本当に 6 以上 "
              f"{prec}（{pct(prec, len(flagged))}）")
    print("\n■ 10 手・15 手・20 手の長い攻め（REN 探索の r と比べる）")
    for j in (10, 15, 20):
        c = np.array([x["c"][j - 1] for x in rows])
        r = np.array([x["r"][j - 1] for x in rows])
        a = np.array([x["a"][7] for x in rows])
        print(f"  j={j:2d}: 実際 平均 {c.mean():5.2f}・r 平均 {r.mean():5.2f}（誤差 {np.abs(r - c).mean():5.2f}）・"
              f"a[8] 平均 {a.mean():5.2f}")
    print("\n■ REN：相手がその時点から続けた消去の手数・火力（局の終わりで切れたものは除く）")
    rr = [x for x in rows if x["ren_done"]]
    for label, sel in (("全部", rr), ("並べ替えを回した", [x for x in rr if x["flags"] & 8]),
                       ("相手が REN 中（ren≥2）", [x for x in rr if x["opp_ren"] >= 2])):
        if not sel:
            continue
        L = np.array([x["ren_len"] for x in sel])
        A = np.array([x["ren_atk"] for x in sel])
        vl = np.array([x["vis_len"] for x in sel])
        lm = np.array([x["len_mean"] if x["runs"] else x["vis_len"] for x in sel])
        lx = np.array([x["len_max"] if x["runs"] else x["vis_len"] for x in sel])
        am = np.array([x["atk_mean"] if x["runs"] else 0 for x in sel])
        print(f"  {label}（{len(sel)} 件）：実際 平均 {L.mean():.2f} 手・{A.mean():.2f} 火力・6 手以上 {pct((L >= 6).sum(), len(L))} | "
              f"見える分 {vl.mean():.2f}・平均 {lm.mean():.2f}・最大 {lx.mean():.2f} 手 | 火力の平均 {am.mean():.2f}")
        long = L >= 6
        if long.any():
            print(f"     6 手以上続いた {long.sum()} 件：見える分で 3 以上 {pct((vl[long] >= 3).sum(), long.sum())}・"
                  f"並べ替えの最大 ≥ 6 {pct((lx[long] >= 6).sum(), long.sum())}")
    print("\n■ 負け方（死ぬ前 9 手≒3 秒に上がった段数）")
    nd = len(deaths)
    spike = [d for d in deaths if d["landed9"] >= 10]
    print(f"  負け {nd} 局：10 段以上 {len(spike)}（{pct(len(spike), nd)}）")
    pred = [d for d in spike if d["pred"]]
    if pred:
        P = [d["pred"] for d in pred]
        print(f"  スパイク死 {len(pred)} 局：最後の一撃（死ぬ 6.0〜1.5 秒前に相手が撃った分）平均 {np.mean([p['actual'] for p in P]):.1f}"
              f"（相手の {np.mean([p['n'] for p in P]):.1f} 手）。撃ち始める前の見積もりは死ぬ {np.mean([p['lead'] for p in P]):.1f} 手前、"
              f"そのとき 届いていた予告 {np.mean([p['my_inc'] for p in P]):.1f}・自分の高さ {np.mean([p['my_h'] for p in P]):.1f}・"
              f"相手の REN {np.mean([p['opp_ren'] for p in P]):.1f}")
        print(f"  （一撃が見える範囲を越える＝見積もりから {np.mean([p['k'] for p in P]):.1f} 手。a・m は 8 手まで、r は 20 手まで）")
        for key in ("a", "m", "r", "max(m,r)"):
            f = (lambda p: max(p["m"], p["r"])) if key == "max(m,r)" else (lambda p, key=key: p[key])
            k = sum(1 for p in P if f(p) >= 0.5 * p["actual"])
            print(f"    {key:8s} が実際の半分以上を予告: {k}/{len(P)}（{pct(k, len(P))}）・予告の平均 {np.mean([f(p) for p in P]):.1f}")


def cmd_analyze(args) -> None:
    games = load(args.name)
    w = [g["winner"] for g in games]
    print(f"{args.name}: {len(games)} 局（A 勝 {w.count(0)}・B 勝 {w.count(1)}・引分 {w.count(-1)}）")
    report(analyze(games))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--a", default="lv6n_w256_t56", choices=PRESETS)
    r.add_argument("--b", default="clys_full", choices=PRESETS)
    r.add_argument("--b-threat", action="store_true", help="B（lv7）にも見積もりを回させる")
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
