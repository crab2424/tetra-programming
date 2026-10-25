"""テト CPU lv4/lv5/lv6：native（学習シミュ）と本番 wasm の探索結果の一致テスト。

シミュのひとり用で出てきた局面（おじゃま入りを含む）を、本番 wasm（node で実行）にも同じ入力で渡し、
outResult[43]（初手・読み・評価値・操作列）が全件一致することを確かめる。
あわせて、シミュが持っている各レベルの既定の重みが本番 cpu{4,5,6}.js の this.weights と一致するかも見る。
  python3 tests/test_tet_parity.py            # lv4・lv5・lv6 すべて
  python3 tests/test_tet_parity.py 6          # 一部だけ
lv6 は PC 探索を移植していない（ビーム探索だけを比べる）。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))
import tetsim  # noqa: E402


def compare(native: np.ndarray, wasm: np.ndarray, label: str) -> int:
    native = native.copy()
    # 初手が無い（その場で死ぬ）とき、本番は p[0] を初期化せずに rot/x/y/spawnY（[4..7]）を書き出す＝未定義の値。
    # JS は id（[3]）が 0..6 でなければ使わないので比較から外す。
    dead = native[:, 3] < 0
    native[dead, 4:8] = 0
    wasm[dead, 4:8] = 0
    bad = np.where((wasm != native).any(axis=1))[0]
    print(f"{label}: cases={len(native)}  mismatch={len(bad)}")
    for i in bad[:5]:
        diff = np.where(wasm[i] != native[i])[0]
        print(f"  case {i}: idx {diff.tolist()} native={native[i][diff].tolist()} wasm={wasm[i][diff].tolist()}")
    return len(bad)


def run_wasm(level: int, weights: list[int], cases: np.ndarray) -> np.ndarray:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"level": level, "weights": weights, "cases": cases.tolist()}, f)
        tmp = f.name
    res = subprocess.run(["node", str(ROOT / "tests" / "tet_wasm_cases_lv.mjs"), tmp],
                         check=True, capture_output=True, text=True)
    return np.array(json.loads(res.stdout), dtype=np.int32)


def check_level(level: int) -> int:
    fails = 0
    prod = tetsim.prod_weights(level)
    simw = tetsim.sim_default_weights(level)
    if prod != simw:
        print(f"lv{level}: 既定の重みが本番 JS と違う\n  sim ={simw}\n  prod={prod}")
        fails += 1
    pieces = 100 if level == 6 else 150
    runs = [(s, 0, 0) for s in range(1, 6)] + [(s, 4, 2) for s in range(11, 16)] + [(s, 2, 3) for s in range(21, 26)]
    cases = np.concatenate([tetsim.trace_cases_lv(level, s, pieces, ge, gl) for s, ge, gl in runs])
    wasm = run_wasm(level, prod, cases)
    fails += compare(cases[:, 264:], wasm, f"lv{level}")
    if level == 6:
        print(f"  （incoming>0 の局面 {int((cases[:, 263] > 0).sum())} 件）")
    return fails


def main() -> int:
    levels = [int(a) for a in sys.argv[1:]] or [4, 5, 6]
    return 1 if sum(check_level(lv) for lv in levels) else 0


if __name__ == "__main__":
    sys.exit(main())
