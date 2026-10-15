"""JS エンジンとの一致テスト（設計書 §3.5）。

    python3 tests/test_parity.py

本番 JS の関数を Node で直接動かした正解（tests/gen_js_cases.mjs）と、C++ シミュを照合する。
  1. 乱数 xorshift32（versus.js createSeededRandom）
  2. ツモ列（色シャッフル → 初期 NEXT → 取り出し）
  3. 連鎖スコア・段数（おじゃま巻き込み・隠し段・全消し以外の得点）
さらにシミュ固有の健全性：
  4. 決定性（同条件で2回回して完全一致）
  5. 先後入れ替えで同ポリシー同士の勝率が 0.5 になる（play_both_sides の偏り打ち消し）
     ※ 同ポリシー同士でも、同時刻イベントは先手から処理されるので単局では先後で偏る（参考表示）
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))
import puyosim as ps  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    ps.build(force=True)
    cases_path = ps.BUILD / "js_cases.json"
    with open(cases_path, "w") as f:
        subprocess.run(["node", str(ROOT / "tests" / "gen_js_cases.mjs")], check=True, stdout=f)
    cases = json.loads(cases_path.read_text())
    L = ps.lib()
    fails = 0

    # 1. 乱数
    for c in cases["rng"]:
        out = np.zeros(len(c["values"]), dtype=np.float64)
        L.sim_rng_values(c["seed"], len(out), out)
        if not np.array_equal(out, np.array(c["values"])):
            print(f"✗ rng seed={c['seed']}")
            fails += 1
    print(f"rng: {len(cases['rng'])} seeds")

    # 2. ツモ列
    for c in cases["pairs"]:
        n = len(c["seq"]) // 2
        out = np.zeros(n * 2, dtype=np.int32)
        L.sim_pair_sequence(c["seed"], c["colorCount"], n, out)
        if out.tolist() != c["seq"]:
            print(f"✗ pairs seed={c['seed']} colors={c['colorCount']}")
            fails += 1
    print(f"pairs: {len(cases['pairs'])} sequences")

    # 3. 連鎖
    bad = 0
    for c in cases["chains"]:
        out = np.zeros(2, dtype=np.int64)
        L.sim_chain(np.array(c["board"], dtype=np.uint8), out)
        if out[0] != c["score"] or out[1] != c["chains"]:
            bad += 1
            if bad <= 3:
                print(f"✗ chain js=({c['score']},{c['chains']}) sim=({out[0]},{out[1]})")
    fails += bad
    print(f"chains: {len(cases['chains'])} boards, mismatch={bad}")

    # 3b. 連鎖の残り時間（後打ちの締切判定。本番 JS と sim の chainRemainingMs）
    bad = 0
    for c in cases["chains"]:
        out = np.zeros(1, dtype=np.float64)
        L.sim_chain_time(np.array(c["board"], dtype=np.uint8), out)
        if abs(out[0] - c["chainMs"]) > 1e-6:
            bad += 1
            if bad <= 3:
                print(f"✗ chainMs js={c['chainMs']} sim={out[0]}")
    fails += bad
    print(f"chain time: {len(cases['chains'])} boards, mismatch={bad}")

    # 4. 決定性 / 5. 先後入れ替え
    base = ps.Policy.baseline().packed()
    seeds = np.arange(1, 9, dtype=np.uint32) * 1000003 % 1000000 + 1
    r1 = ps.run_matches(base, base, seeds)
    r2 = ps.run_matches(base, base, seeds)
    if not all(np.array_equal(r1[k], r2[k]) for k in r1):
        print("✗ determinism")
        fails += 1
    both = ps.play_both_sides(base, base, seeds)
    if abs(float(both["winRate"][0]) - 0.5) > 1e-9:
        print(f"✗ side-swap: winRate={both['winRate'][0]}")
        fails += 1
    print(f"determinism/side-swap: {len(seeds)} seeds, 先手勝率(単局)={ps.win_rate(r1):.2f}, "
          f"mean duration={r1['durationMs'].mean()/1000:.1f}s, turns={r1['turnsA'].mean():.1f}")

    print("✅ all passed" if fails == 0 else f"❌ {fails} failures")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
