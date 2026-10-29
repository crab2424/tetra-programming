"""lv6 学習の Phase 0（診断）。設計 source_assets/memory/cpu/tet/lv6-learning-design.md §3。

候補（A 席）を基準の clys（B 席）と対戦させ、A の打ち方（TSD・4-LINES・PC・BtB・火力/ライン・受けた段）と
探索量（ノード数・思考時間）を集計する。思考時間は実測を待ちに入れる（tetsim.set_model_think）。
  python3 py/phase0.py vs --a lv6 --b clys_full --seeds 50 --name a_lv6_vs_full
  python3 py/phase0.py solo --a clys_full --games 40
プリセット（PRESETS）は「レベル＋席ごとの探索設定」。lv6 の思考時間は native の2倍を実機並みとする（clys_vs6 §6.4）。
結果は runs/phase0/<name>.summary.json（と .jsonl）。
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

import tetsim
from tvt_baseline import wilson

ROOT = Path(__file__).resolve().parent.parent
QLEN = 40   # 確定 NEXT の内部保持数（clys の深さ 32 ＋余裕）
FREE = 1e-6  # 思考時間を待ちに入れない（倍率がほぼ 0）

# name: (level, side 設定, lv6 の思考時間の倍率)
PRESETS = {
    # clys：原作どおり（NEXT 8 本＋ランダムなツモ 3 本で深さ 32）
    "clys_old": (7, dict(clys_next=8, clys_branch=3, clys_width=500, clys_depth=32, clys_think=100), 1.0),
    # clys：確定 NEXT を深さぶん全部（ランダムなツモは使われない）
    "clys_full": (7, dict(queue_len=QLEN, clys_next=32, clys_width=500, clys_depth=32, clys_think=100), 1.0),
    # Phase 0 (b)：探索を減らした clys（確定 NEXT）
    "clys_w128": (7, dict(queue_len=QLEN, clys_next=32, clys_width=128, clys_depth=32, clys_think=100), 1.0),
    "clys_w32": (7, dict(queue_len=QLEN, clys_next=32, clys_width=32, clys_depth=32, clys_think=100), 1.0),
    "clys_t30": (7, dict(queue_len=QLEN, clys_next=32, clys_width=500, clys_depth=32, clys_think=30), 1.0),
    # lv6 と同じ読み（NEXT 8・深さ 9＝可視キューのみ）で幅 32 の clys ＝「clys の評価 × lv6 並みの探索」
    "clys_lv6like": (7, dict(queue_len=QLEN, clys_next=8, clys_width=32, clys_depth=9, clys_think=100), 1.0),
    "clys_w500_d9": (7, dict(queue_len=QLEN, clys_next=8, clys_width=500, clys_depth=9, clys_think=100), 1.0),
    # Phase 1（lv6-phase1-search-design.md）：lv6 の新しい探索（レベル36）。幅・深さ・締め切りは clys_* の欄を使う。
    #   wasm は native とほぼ同じ速さ（clys 取り込み版の実測）なので思考時間は ×1
    "lv6n": (36, dict(queue_len=QLEN, clys_width=500, clys_depth=32, clys_think=80), 1.0),
    "lv6n_t100": (36, dict(queue_len=QLEN, clys_width=500, clys_depth=32, clys_think=100), 1.0),
    "lv6n_w256": (36, dict(queue_len=QLEN, clys_width=256, clys_depth=32, clys_think=80), 1.0),
    "lv6n_w128": (36, dict(queue_len=QLEN, clys_width=128, clys_depth=32, clys_think=80), 1.0),
    "lv6n_t50": (36, dict(queue_len=QLEN, clys_width=500, clys_depth=32, clys_think=50), 1.0),
    # 本番相当：wasm は native の約 1/1.42 の速さ（tests/test_lv6n_parity.py の実測）なので、wasm の締め切り 80ms ≒ native 56ms
    "lv6n_t56": (36, dict(queue_len=QLEN, clys_width=500, clys_depth=32, clys_think=56), 1.0),
    "lv6n_w256_t56": (36, dict(queue_len=QLEN, clys_width=256, clys_depth=32, clys_think=56), 1.0),
    # lv6（2026-10-27 から本番＝main の版・PC 探索なし）。思考時間は native ×2（実機並み）
    "lv6": (6, dict(), 2.0),
    # 強化版 lv6（2026-10-26 時点を凍結。レベル 16）。Phase 0・P1 の「旧 lv6」はこれ。幅・深さの指定はこちらだけ
    "lv6b": (16, dict(), 2.0),
    "lv6_w32_d12": (16, dict(queue_len=QLEN, lv6_width=32, lv6_depth=12, lv6_next=13), 2.0),
    # Phase 0 (c)：探索を増やした lv6（確定 NEXT）。予算を超えるので思考時間を待ちに入れない（FREE）＝打ち方だけを見る
    "lv6_free": (16, dict(), FREE),
    "lv6_w64": (16, dict(queue_len=QLEN, lv6_width=64, lv6_depth=8, lv6_next=9), FREE),
    "lv6_d12": (16, dict(queue_len=QLEN, lv6_width=16, lv6_depth=12, lv6_next=13), FREE),
    "lv6_w64_d12": (16, dict(queue_len=QLEN, lv6_width=64, lv6_depth=12, lv6_next=13), FREE),
    "lv6_w32_d16": (16, dict(queue_len=QLEN, lv6_width=32, lv6_depth=16, lv6_next=17), FREE),
}

# P2（lv6-phase1-search-design.md §7）：幅 × 締め切りの格子 lv6n_w{幅}_t{締め切り}（既にある名前はそのまま）
for _w in (128, 256, 384, 500):
    for _t in (56, 80):
        PRESETS.setdefault(f"lv6n_w{_w}_t{_t}", (36, dict(queue_len=QLEN, clys_width=_w, clys_depth=32, clys_think=_t), 1.0))

KEYS = tetsim.TVT_SIDE_KEYS


def side_summary(res: list[dict], s: str) -> dict:
    minutes = np.array([r["ms"] for r in res]).sum() / 60000.0
    tot = {k: float(np.sum([r[f"{s}_{k}"] for r in res])) for k in KEYS}
    p = max(tot["pieces"], 1)
    return {
        "per100": {k: round(100 * tot[k] / p, 2) for k in ("tsd", "tss", "tst", "ts_mini", "tetrises", "pcs", "b2bs",
                                                          "holds", "ren1", "ren2to5", "ren6plus")},
        "apm": tot["tet_attack"] / minutes, "sent_pm": tot["tet_sent"] / minutes, "pps": tot["pieces"] / (minutes * 60),
        "attack_per_line": tot["tet_attack"] / max(tot["lines"], 1), "attack_per_piece": tot["tet_attack"] / p,
        "lines_per100": 100 * tot["lines"] / p, "ren_atk_share": tot["ren_atk"] / max(tot["tet_attack"], 1),
        "garbage_taken_per_game": tot["garbage_taken"] / len(res),
        "think_ms_per_piece": tot["think_ms"] / p, "wait_ms_per_piece": tot["wait_ms"] / p,
        "nodes_per_piece": tot["nodes"] / p, "nodes_per_ms": tot["nodes"] / max(tot["think_ms"], 1e-9),
        "max_spike": tot["max_spike"] / len(res), "route_miss": tot["route_miss"] / len(res),
        "ts_pred": tot["ts_pred"], "ts_pred_miss": tot["ts_pred_miss"], "ts_unpred": tot["ts_unpred"],
    }


def summarize(res: list[dict]) -> dict:
    n = len(res)
    w = np.array([r["winner"] for r in res])
    score = (w == 0) + 0.5 * (w == -1)
    lo, hi = wilson(score.sum(), n)
    return {"games": n, "a_win": float(score.mean()), "ci95": [lo, hi], "draws": int((w == -1).sum()),
            "mean_sec": float(np.mean([r["ms"] for r in res]) / 1000), "a": side_summary(res, "a"),
            "b": side_summary(res, "b")}


def apply_side(side: int, cfg: dict) -> None:
    tetsim.set_side(side, reset=True, **cfg)


def cmd_vs(args) -> None:
    la, ca, sa = PRESETS[args.a]
    lb, cb, sb = PRESETS[args.b]
    tetsim.set_model_think(True, 1.0)
    tetsim.set_side(0, reset=True)
    apply_side(1, ca)
    apply_side(2, cb)
    if la == lb and sa != sb:
        raise SystemExit("同じレベルで思考時間の倍率が違う組は未対応")
    tetsim.set_think_scale(la, sa, 1.0)
    tetsim.set_think_scale(lb, sb, 1.0)
    seeds = list(range(args.seed_base, args.seed_base + args.seeds))
    t0 = time.time()
    w_a = None
    if args.wa:
        w_a = tetsim.sim_default_weights(la)
        for kv in args.wa.split(","):
            k, v = kv.split("=")
            w_a[int(k)] = int(v)
    res = tetsim.vs_run(la, lb, seeds, w_a=w_a, max_ms=args.max_ms, shared_tumo=True, jitter_ms=10.0,
                        threads=args.threads)
    d = ROOT / "runs" / "phase0"
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"{args.name}.jsonl", "w") as f:
        for r in res:
            f.write(json.dumps({k: (float(v) if isinstance(v, (np.floating, float)) else v) for k, v in r.items()}) + "\n")
    s = summarize(res)
    s["args"] = vars(args) | {"cfg_a": ca, "cfg_b": cb}
    s["wall_sec"] = time.time() - t0
    (d / f"{args.name}.summary.json").write_text(json.dumps(s, indent=1, ensure_ascii=False))
    print(json.dumps(s, indent=1, ensure_ascii=False))


def cmd_solo(args) -> None:
    lv, cfg, sc = PRESETS[args.a]
    tetsim.set_model_think(False)
    tetsim.set_side(0, reset=True, **cfg)
    seeds = list(range(1001, 1001 + args.games))
    out = {}
    for label, ge, gl in (("clean", 0, 0), ("g8x2", 8, 2)):
        t0 = time.time()
        out[label] = tetsim.terrain_lv(lv, seeds, max_pieces=args.pieces, garbage_every=ge, garbage_lines=gl,
                                       threads=args.threads)
        out[label]["wall_sec"] = time.time() - t0
    tetsim.set_side(0, reset=True)
    d = ROOT / "runs" / "phase0"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"solo_{args.a}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(json.dumps(out, indent=1, ensure_ascii=False))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("vs")
    v.add_argument("--a", required=True, choices=PRESETS)
    v.add_argument("--b", default="clys_full", choices=PRESETS)
    v.add_argument("--seeds", type=int, default=50)
    v.add_argument("--seed-base", type=int, default=1)
    v.add_argument("--threads", type=int, default=12)
    v.add_argument("--max-ms", type=float, default=300000.0)
    v.add_argument("--wa", default="", help="A の重みの差し替え（添字=値,...。レベル36 は engine/ai/eval.h の並び）")
    v.add_argument("--name", required=True)
    s = sub.add_parser("solo")
    s.add_argument("--a", required=True, choices=PRESETS)
    s.add_argument("--games", type=int, default=40)
    s.add_argument("--pieces", type=int, default=300)
    s.add_argument("--threads", type=int, default=12)
    args = ap.parse_args()
    cmd_vs(args) if args.cmd == "vs" else cmd_solo(args)


if __name__ == "__main__":
    main()
