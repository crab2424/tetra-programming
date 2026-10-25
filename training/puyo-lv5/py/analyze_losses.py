"""負け方・連鎖の中身の分析（sim_trace_matches の JSONL を読む）。

使い方:
  python3 py/analyze_losses.py --collect            # runs/analysis/ に lv6(best) vs lv5 / lv5 vs lv5 を記録
  python3 py/analyze_losses.py runs/analysis/lv6_vs_lv5.jsonl --a-label lv6 --b-label lv5 --split 300

  --split N: 先頭 N 局は A=a-label, 以降は A/B を入れ替えて記録した、という意味（collect の並び）。

見るもの（設計: source_assets/memory/cpu/puyo/lv5-improvement-notes.md）
  ・負けの分類（自滅／催促・潰し／撃ち合い負け／先打ちされ返せず …）
  ・発火点の生死（おじゃま着弾で起こせる連鎖がどれだけ減ったか・撃てる連鎖を持ったまま死んだか）
  ・連鎖の中身（途中段の同時消し・多連結、4個消しのみの段、余り・無駄ぷよ、時間あたり火力）
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

RATE = 70
BIG = 30          # 本線級＝おじゃま 30 個（5段）以上を生む連鎖
T, TURN, MODE, INC, QUEUE, FIRE, REASON, FC, FS, PC, PS, IGN, PUYOS, OJAMA, H = range(15)


# ─── 発火1回の特徴量 ───
def fire_feats(f: dict) -> dict:
    steps = f["steps"]
    erased = [sum(s) for s in steps]
    n = len(steps)
    mid = steps[:-1]
    multi = [len(s) > 1 or sum(s) > 4 for s in steps]           # 同時消し or 多連結（4個消し以外）
    gen = f["offset"] + f["sent"]
    dur = max(1.0, f["t1"] - f["t0"])
    return {
        "chains": n,
        "gen": gen,
        "erased": sum(erased),
        "pure4": sum(1 for s in steps if s == [4]),
        "midMulti": sum(1 for s in mid if len(s) > 1 or sum(s) > 4),
        "midExtra": sum(sum(s) - 4 for s in mid),                # 途中段で4個を超えて使ったぷよ
        "lastMulti": bool(multi[-1]),
        "lastExtra": erased[-1] - 4,
        "puyosBefore": f["pb"],
        "leftover": f["pa"],                                      # 連鎖後に残った色ぷよ（無駄ぷよ＋次の種）
        "ojamaErased": sum(f["ojErased"]),
        "durSec": dur / 1000.0,
        "genPerSec": gen / (dur / 1000.0),
        "mode": f["mode"],
        "reason": f["reason"],
    }


def size_class(chains: int) -> str:
    if chains <= 1:
        return "1"
    if chains <= 4:
        return "2-4"
    if chains <= 7:
        return "5-7"
    return "8+"


def last_turn_before(turns: list, t: float):
    best = None
    for x in turns:
        if x[T] <= t:
            best = x
        else:
            break
    return best


# ─── 1局の負け方 ───
def classify(game: dict, loser: str) -> dict:
    winner = "B" if loser == "A" else "A"
    L, W = game[loser], game[winner]
    tDeath = game["dur"]
    Lf = [dict(f, **fire_feats(f)) for f in L["fires"]]
    Wf = [dict(f, **fire_feats(f)) for f in W["fires"]]
    Lmain = [f for f in Lf if f["gen"] >= BIG]
    Wmain = [f for f in Wf if f["gen"] >= BIG]
    flags = []

    # 発火点の生死：着弾で「起こせる連鎖」が 3 段以上減った
    for d in L["drops"]:
        before, after = d[3], d[4]
        if before[0] >= 4 and after[0] <= before[0] - 3:
            flags.append("発火点埋まり")
            break
    lastL = L["turns"][-1] if L["turns"] else None
    if lastL and max(lastL[IGN][0], lastL[FC]) >= 4:
        flags.append("撃てる連鎖を持ったまま死亡")
    if lastL and lastL[MODE] == 1:
        flags.append("死亡時カウンター中")

    if L["recvTotal"] < 18:
        cat = "自滅（ほぼ受けずに窒息）"
        dec = None
    else:
        lastLmainT = Lmain[-1]["t0"] if Lmain else -1
        cand = [f for f in Wf if f["t0"] < tDeath and f["sent"] > 0]
        later = [f for f in cand if f["t0"] > lastLmainT] or cand
        dec = max(later, key=lambda f: f["sent"]) if later else None
        if dec is None:
            cat = "不明"
        elif dec["chains"] <= 4 and not Wmain:
            cat = "催促・潰しで負け（相手は本線を撃たず）"
        elif dec["gen"] < BIG:
            cat = "本線後の小連鎖で止め"
        elif Lmain and Lmain[0]["t0"] < dec["t0"]:
            cat = "先に本線を撃ち、より大きく返された"
        elif Lmain:
            cat = "先に撃たれ、返したが足りず"
        else:
            snap = last_turn_before(L["turns"], dec["t0"])
            if snap is None:
                cat = "先に撃たれ返せず（序盤）"
            else:
                canNow = max(snap[FS], snap[IGN][1]) / RATE
                if canNow >= dec["gen"] * 0.8:
                    cat = "先に撃たれ、返せる連鎖はあったが撃たず"
                elif snap[PS] >= dec["score"]:
                    cat = "先に撃たれ返せず（育成中＝潜在では上回っていた）"
                else:
                    cat = "先に撃たれ返せず（連鎖が小さい／遅い）"
    return {"cat": cat, "flags": flags, "decisive": dec, "Lmain": Lmain, "Wmain": Wmain,
            "Lf": Lf, "Wf": Wf, "tDeath": tDeath}


# ─── 撃ち合い：先に本線を撃った側は勝てるのか ───
def exchange_report(games: list) -> list[str]:
    rows = []
    for g in games:
        if g["winner"] < 0:
            continue
        mains = []
        for side in "AB":
            for f in g[side]["fires"]:
                if f["offset"] + f["sent"] >= BIG:
                    mains.append((f["t0"], side, f))
                    break
        if not mains:
            continue
        mains.sort(key=lambda x: x[0])
        t0, P, F = mains[0]
        Q = "B" if P == "A" else "A"
        snap = last_turn_before(g[Q]["turns"], t0)
        if snap is None:
            continue
        gen = F["offset"] + F["sent"]
        qIgn = snap[IGN][1] / RATE
        qPot = snap[PS] / RATE
        resp = [f for f in g[Q]["fires"] if f["t0"] >= t0 and f["offset"] + f["sent"] >= BIG]
        r = resp[0] if resp else None
        qTurns = sum(1 for x in g[Q]["turns"] if t0 <= x[T] <= (r["t0"] if r else F["t1"]))
        rows.append({
            "win": (g["winner"] == 0) == (P == "A"),
            "gen": gen, "chains": len(F["steps"]), "dur": (F["t1"] - F["t0"]) / 1000,
            "qIgnRatio": qIgn / max(1, gen), "qPotRatio": qPot / max(1, gen),
            "resp": r is not None,
            "respGen": (r["offset"] + r["sent"]) if r else 0,
            "respDelay": ((r["t0"] - F["t0"]) / 1000) if r else None,
            "respBeforeEnd": (r["t0"] <= F["t1"]) if r else False,
            "qTurns": qTurns,
            "qIgnChains": snap[IGN][0], "respChains": len(r["steps"]) if r else 0,
        })
    if not rows:
        return []
    L = ["", "### 撃ち合い：最初に本線級を撃った側（先打ち）の勝率"]
    n = len(rows)
    w = sum(r["win"] for r in rows)
    L.append(f"- 先打ち側の勝率: {pct(w, n)}（{n} 局）。先打ちの本線 平均 {np.mean([r['chains'] for r in rows]):.1f} 段・"
             f"連鎖アニメ {np.mean([r['dur'] for r in rows]):.1f} 秒")
    rr = [r for r in rows if r["resp"]]
    if rr:
        L.append(f"- 相手が本線級で返した: {pct(len(rr), n)}。返し始め＝先打ち発火から {np.median([r['respDelay'] for r in rr]):.1f} 秒後（中央値）、"
                 f"先打ちの連鎖アニメ中に返し始めた {pct(sum(r['respBeforeEnd'] for r in rr), len(rr))}。"
                 f"その間に相手が置いた手数 中央値 {np.median([r['qTurns'] for r in rr]):.0f} 手")
        L.append(f"- 返した側の連鎖: 先打ち時点で起こせた {np.mean([r['qIgnChains'] for r in rr]):.1f} 段 → 実際に返した {np.mean([r['respChains'] for r in rr]):.1f} 段"
                 f"（＝アニメ中に伸ばした）")
    L.append("")
    L.append("| 先打ち時点で相手が「起こせた」火力 ÷ 先打ちの火力 | 局数 | 先打ち側の勝率 |")
    L.append("|---|---|---|")
    for lo, hi, name in [(0, .25, "〜0.25"), (.25, .5, "0.25〜0.5"), (.5, .75, "0.5〜0.75"), (.75, 1.0, "0.75〜1.0"), (1.0, 99, "1.0〜")]:
        b = [r for r in rows if lo <= r["qIgnRatio"] < hi]
        if b:
            L.append(f"| {name} | {len(b)} | {pct(sum(r['win'] for r in b), len(b))} |")
    L.append("")
    L.append("| 先打ち時点の相手の潜在（到達連鎖）÷ 先打ちの火力 | 局数 | 先打ち側の勝率 |")
    L.append("|---|---|---|")
    for lo, hi, name in [(0, .5, "〜0.5"), (.5, .8, "0.5〜0.8"), (.8, 1.0, "0.8〜1.0"), (1.0, 1.3, "1.0〜1.3"), (1.3, 99, "1.3〜")]:
        b = [r for r in rows if lo <= r["qPotRatio"] < hi]
        if b:
            L.append(f"| {name} | {len(b)} | {pct(sum(r['win'] for r in b), len(b))} |")
    return L


# ─── 本線の質：同じ色ぷよ量で、途中段の同時消し・多連結は段数を減らしているか ───
def main_quality_report(fires_by: dict) -> list[str]:
    fs = [f for l in fires_by.values() for f in l if f["chains"] >= 6]
    if not fs:
        return []
    L = ["", "### 本線（6段以上）の質：発火時の色ぷよ量をそろえて比べる"]
    L.append("| 発火時の色ぷよ | 途中段の余剰ぷよ | 回数 | 平均段数 | 平均おじゃま | 残り色ぷよ |")
    L.append("|---|---|---|---|---|---|")
    for plo, phi in [(30, 45), (45, 55), (55, 65), (65, 80)]:
        for elo, ehi, en in [(0, 3, "0〜2"), (3, 7, "3〜6"), (7, 12, "7〜11"), (12, 99, "12〜")]:
            b = [f for f in fs if plo <= f["puyosBefore"] < phi and elo <= f["midExtra"] < ehi]
            if len(b) >= 5:
                L.append(f"| {plo}〜{phi - 1} | {en} | {len(b)} | {np.mean([f['chains'] for f in b]):.1f} | "
                         f"{np.mean([f['gen'] for f in b]):.0f} | {np.mean([f['leftover'] for f in b]):.1f} |")
    x = np.array([[f["puyosBefore"], f["midExtra"], f["leftover"], f["chains"]] for f in fs], dtype=float)
    A = np.c_[np.ones(len(x)), x[:, 0], x[:, 1], x[:, 2]]
    coef, *_ = np.linalg.lstsq(A, x[:, 3], rcond=None)
    L.append(f"- 回帰（段数 ≈ a + b×発火時の色ぷよ + c×途中段の余剰 + d×残り色ぷよ）: "
             f"b={coef[1]:+.3f}/個, c={coef[2]:+.3f}/個, d={coef[3]:+.3f}/個（n={len(x)}）")
    return L


# ─── 催促・潰しへの弱さ（ひとり用に指定手数でおじゃまを降らせる実験）───
def harass_report(paths: dict, base_path: Path) -> list[str]:
    """paths: {(手数, 個数): jsonl}。base_path: 降らせない基準（同じシード）。"""
    def first_main(g):
        for f in g["P"]["fires"]:
            if f["score"] >= BIG * RATE:
                return f
        return None
    base = {}
    for line in base_path.open():
        g = json.loads(line)
        base[g["seed"]] = g
    L = ["", "### 催促・潰しへの弱さ（lv5 ひとり用・指定手数を置いた直後におじゃまを降らせる・同じツモで比較）",
         "| 降らせた手数 | 個数 | 局数 | 起こせる連鎖（着弾前→後） | 起こせなくなった | 最初の本線の段数（基準→） | 2段以上縮んだ | 本線が出ないまま60手 | 窒息 |",
         "|---|---|---|---|---|---|---|---|---|"]
    b_died = np.mean([g["died"] for g in base.values()])
    b_main = [first_main(g) for g in base.values()]
    L.append(f"| なし | 0 | {len(base)} | - | - | {np.mean([len(f['steps']) for f in b_main if f]):.1f} | - | "
             f"{pct(sum(1 for f in b_main if f is None), len(b_main))} | {100 * b_died:.1f}% |")
    for (turn, amt), path in sorted(paths.items()):
        before, after, dmain, shr, nomain, died, n = [], [], [], 0, 0, 0, 0
        for line in path.open():
            g = json.loads(line)
            n += 1
            died += g["died"]
            d = g["P"]["drops"]
            if d:
                before.append(d[0][3][0])
                after.append(d[0][4][0])
            fm, bm = first_main(g), first_main(base[g["seed"]])
            if fm is None:
                nomain += 1
            if fm and bm:
                dmain.append((len(bm["steps"]), len(fm["steps"])))
                if len(fm["steps"]) <= len(bm["steps"]) - 2:
                    shr += 1
        dm = np.array(dmain) if dmain else np.zeros((0, 2))
        zero = sum(1 for b, a in zip(before, after) if b >= 2 and a == 0)
        L.append(f"| {turn} | {amt} | {n} | {np.mean(before):.1f}→{np.mean(after):.1f} | {pct(zero, len(before))} | "
                 f"{dm[:, 0].mean():.1f}→{dm[:, 1].mean():.1f} | {pct(shr, len(dm))} | {pct(nomain, n)} | {pct(died, n)} |")
    return L


def load(path: Path, a_label: str, b_label: str, split: int | None):
    games = []
    for line in path.open():
        g = json.loads(line)
        if split is not None and g["job"] >= split:
            g["labels"] = {"A": b_label, "B": a_label}
        else:
            g["labels"] = {"A": a_label, "B": b_label}
        games.append(g)
    return games


def pct(a, b):
    return f"{100.0 * a / b:.1f}%" if b else "-"


def report(games: list, title: str) -> dict:
    out = {"title": title, "n": len(games)}
    lines = [f"## {title}（{len(games)} 局）"]
    labels = sorted({l for g in games for l in g["labels"].values()})
    wins = Counter()
    draws = 0
    cats = defaultdict(Counter)
    flags = defaultdict(Counter)
    losses = Counter()
    fires_by = defaultdict(list)          # label -> 全発火
    dec_fires, lose_main, win_main = [], [], []
    drop_loss = defaultdict(list)         # label -> 着弾での起こせる段数の減少
    turn_ign = defaultdict(list)          # label -> (潜在段数, 起こせる段数)
    first_main = defaultdict(list)
    accidental = Counter()
    for g in games:
        for side in "AB":
            lab = g["labels"][side]
            for f in g[side]["fires"]:
                ff = fire_feats(f)
                fires_by[lab].append(ff)
                if ff["reason"] == 0 and ff["mode"] == 0:
                    accidental[(lab, size_class(ff["chains"]))] += 1
            other = g["B" if side == "A" else "A"]
            om = [f["t0"] for f in other["fires"] if f["offset"] + f["sent"] >= BIG]
            tOppMain = om[0] if om else 1e18
            for d in g[side]["drops"]:
                if d[0] < tOppMain:   # 相手の本線より前の着弾（＝まだ勝負が決まっていない局面）だけ
                    drop_loss[lab].append((d[2], d[3][0], d[4][0]))
            for x in g[side]["turns"]:
                turn_ign[lab].append((x[PC], x[IGN][0], x[FC]))
            m = [f for f in g[side]["fires"] if f["offset"] + f["sent"] >= BIG]
            if m:
                first_main[lab].append((m[0]["t0"] / 1000.0, len(m[0]["steps"])))
        if g["winner"] < 0:
            draws += 1
            continue
        loser = "B" if g["winner"] == 0 else "A"
        lab = g["labels"][loser]
        wins[g["labels"]["A" if loser == "B" else "B"]] += 1
        losses[lab] += 1
        c = classify(g, loser)
        cats[lab][c["cat"]] += 1
        for fl in c["flags"]:
            flags[lab][fl] += 1
        if c["decisive"] is not None:
            dec_fires.append(c["decisive"])
        lose_main += c["Lmain"]
        win_main += c["Wmain"]

    lines.append("")
    lines.append("| | " + " | ".join(labels) + " |")
    lines.append("|---|" + "---|" * len(labels))
    lines.append("| 勝ち | " + " | ".join(str(wins[l]) for l in labels) + " |")
    lines.append(f"| 引き分け | {draws} |")
    out["wins"] = dict(wins)
    out["draws"] = draws

    lines.append("\n### 負けの分類（負けた側ごと）")
    allcats = sorted({k for c in cats.values() for k in c}, key=lambda k: -sum(cats[l][k] for l in labels))
    lines.append("| 分類 | " + " | ".join(f"{l}（負け{losses[l]}）" for l in labels) + " |")
    lines.append("|---|" + "---|" * len(labels))
    for k in allcats:
        lines.append(f"| {k} | " + " | ".join(f"{cats[l][k]} ({pct(cats[l][k], losses[l])})" for l in labels) + " |")
    lines.append("\n**フラグ（負け局のうち該当した割合・重複あり）**")
    allflags = sorted({k for c in flags.values() for k in c})
    for k in allflags:
        lines.append(f"- {k}: " + " / ".join(f"{l} {flags[l][k]} ({pct(flags[l][k], losses[l])})" for l in labels))
    out["cats"] = {l: dict(cats[l]) for l in labels}
    out["flags"] = {l: dict(flags[l]) for l in labels}

    # 発火点の生死
    lines.append("\n### 発火点の生死（相手の本線より前のおじゃま着弾の前後で「1列に同色1〜3個足して起こせる最大連鎖」）")
    for l in labels:
        d = np.array(drop_loss[l]) if drop_loss[l] else np.zeros((0, 3))
        big = d[d[:, 1] >= 6] if len(d) else d
        if len(d):
            lines.append(f"- {l}: 着弾量の分布 中央値 {np.median(d[:, 0]):.0f} 個・最大 {d[:, 0].max():.0f} 個")
        if len(big):
            lost = big[:, 1] - big[:, 2]
            lines.append(f"- {l}: 着弾 {len(d)} 回。起こせる連鎖が6段以上あった着弾 {len(big)} 回のうち、"
                         f"3段以上減った {pct((lost >= 3).sum(), len(big))}・"
                         f"半分以下になった {pct((big[:, 2] <= big[:, 1] / 2).sum(), len(big))}・"
                         f"0段（撃てない）になった {pct((big[:, 2] == 0).sum(), len(big))}")
        ti = np.array(turn_ign[l])
        if len(ti):
            grow = ti[ti[:, 0] >= 8]
            if len(grow):
                lines.append(f"  - 潜在8段以上の局面で、今起こせる連鎖が潜在の半分未満: {pct((grow[:, 1] < grow[:, 0] / 2).sum(), len(grow))}"
                             f"（起こせる平均 {grow[:, 1].mean():.1f} 段 / 潜在平均 {grow[:, 0].mean():.1f} 段）")

    # 本線の発火時刻
    lines.append("\n### 最初の本線級（おじゃま30個以上）の発火")
    for l in labels:
        fm = np.array(first_main[l])
        if len(fm):
            lines.append(f"- {l}: 時刻 中央値 {np.median(fm[:, 0]):.1f}s（25%点 {np.percentile(fm[:, 0], 25):.1f}s）、"
                         f"段数 平均 {fm[:, 1].mean():.1f}（本線を撃った局 {len(fm)}）")

    # 連鎖の中身
    lines.append("\n### 連鎖の中身（全発火・段数クラス別）")
    lines.append("| 誰 | クラス | 回数 | 平均おじゃま | 秒あたり(中央値) | 途中段の同時消し/多連結(回) | 途中段の余剰ぷよ | 最終段が同時消し/多連結 | 4個消しのみの段率 | 発火時の色ぷよ | 連鎖後に残る色ぷよ |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for l in labels:
        by = defaultdict(list)
        for ff in fires_by[l]:
            by[size_class(ff["chains"])].append(ff)
        for k in ["1", "2-4", "5-7", "8+"]:
            fs = by.get(k, [])
            if not fs:
                continue
            m = lambda key: np.mean([f[key] for f in fs])
            p4 = sum(f["pure4"] for f in fs) / max(1, sum(f["chains"] for f in fs))
            lines.append(f"| {l} | {k} | {len(fs)} | {m('gen'):.1f} | {np.median([f['genPerSec'] for f in fs]):.1f} | {m('midMulti'):.2f} | "
                         f"{m('midExtra'):.1f} | {pct(sum(f['lastMulti'] for f in fs), len(fs))} | {100*p4:.0f}% | "
                         f"{m('puyosBefore'):.1f} | {m('leftover'):.1f} |")
    for l in labels:
        lines.append(f"- {l} の育成手での発火（発火判定を通っていない連鎖）: " +
                     ", ".join(f"{k}連鎖 {accidental[(l, k)]}" for k in ["1", "2-4", "5-7", "8+"]))

    # 撃ち合いの勝ち側／負け側の本線
    def summ(fs, name):
        if not fs:
            return f"- {name}: なし"
        return (f"- {name}: {len(fs)} 回・平均 {np.mean([f['chains'] for f in fs]):.1f} 段・"
                f"おじゃま {np.mean([f['gen'] for f in fs]):.1f}・途中段の同時消し {np.mean([f['midMulti'] for f in fs]):.2f} 回・"
                f"途中段の余剰 {np.mean([f['midExtra'] for f in fs]):.1f} 個・4個消し段率 "
                f"{100*sum(f['pure4'] for f in fs)/max(1,sum(f['chains'] for f in fs)):.0f}%・"
                f"発火時の色ぷよ {np.mean([f['puyosBefore'] for f in fs]):.1f}・残り {np.mean([f['leftover'] for f in fs]):.1f}・"
                f"段/色ぷよ {np.mean([f['chains']/max(1,f['puyosBefore']) for f in fs]):.3f}")
    lines.append("\n### 本線の質（勝った側 vs 負けた側の本線級）")
    lines.append(summ(win_main, "勝った側の本線"))
    lines.append(summ(lose_main, "負けた側の本線"))
    lines.append(summ([f for f in dec_fires if f is not None], "決め手になった連鎖"))
    dc = Counter(size_class(f["chains"]) for f in dec_fires)
    lines.append("- 決め手の段数クラス: " + ", ".join(f"{k}: {dc[k]}" for k in ["1", "2-4", "5-7", "8+"]))

    lines += exchange_report(games)
    lines += main_quality_report(fires_by)

    out["text"] = "\n".join(lines)
    return out


def collect():
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    import puyosim as ps
    root = Path(__file__).resolve().parent.parent
    outdir = root / "runs" / "analysis"
    outdir.mkdir(parents=True, exist_ok=True)
    lv5 = ps.Policy.baseline().packed()
    best = json.loads((root / "runs" / "build-001" / "best.json").read_text())["policy"]
    lv6 = ps.Policy(best["build"], best["fast"], best["counterTrigger"], best["counterMargin"]).packed()
    seeds = np.arange(910000, 910300, dtype=np.uint32)
    ps.trace_matches(np.concatenate([np.tile(lv6, (300, 1)), np.tile(lv5, (300, 1))]),
                     np.concatenate([np.tile(lv5, (300, 1)), np.tile(lv6, (300, 1))]),
                     np.concatenate([seeds, seeds]), outdir / "lv6_vs_lv5.jsonl")
    ps.trace_matches(lv5, lv5, np.arange(920000, 920300, dtype=np.uint32), outdir / "lv5_vs_lv5.jsonl")
    hs = np.arange(930000, 930200, dtype=np.uint32)
    for turn, amt in [(0, 0)] + [(t, a) for t in (10, 20) for a in (6, 12, 18, 30)]:
        ps.trace_solo(lv5, hs, outdir / f"harass_t{turn}_a{amt}.jsonl", max_turns=60,
                      harass_turn=turn, harass_amount=amt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?")
    ap.add_argument("--collect", action="store_true")
    ap.add_argument("--harass", action="store_true", help="runs/analysis/harass_t*_a*.jsonl を集計")
    ap.add_argument("--a-label", default="A")
    ap.add_argument("--b-label", default="B")
    ap.add_argument("--split", type=int, default=None)
    args = ap.parse_args()
    if args.collect:
        collect()
        return
    if args.harass:
        d = Path(__file__).resolve().parent.parent / "runs" / "analysis"
        paths = {}
        for p in d.glob("harass_t*_a*.jsonl"):
            t, a = p.stem.split("_")[1:]
            if int(a[1:]) > 0:
                paths[(int(t[1:]), int(a[1:]))] = p
        print("\n".join(harass_report(paths, d / "harass_t0_a0.jsonl")))
        return
    games = load(Path(args.path), args.a_label, args.b_label, args.split)
    print(report(games, Path(args.path).stem)["text"])


if __name__ == "__main__":
    main()
