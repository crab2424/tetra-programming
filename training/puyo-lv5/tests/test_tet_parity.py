"""テト CPU lv5：native（学習シミュ）と本番 wasm の探索結果の一致テスト。

シミュのひとり用で出てきた局面（おじゃま入りを含む）を、本番 wasm（node で実行）にも同じ入力で渡し、
outResult[43]（初手・6手の読み・評価値・操作列）が全件一致することを確かめる。
  python3 tests/test_tet_parity.py
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

W = [14, -40, -56, -128, 4, 3, -2, -54, 72, 36, 60, -234, -125, 500, 68, -3, 100, 20, -45, 120,
     496, 2560, -6000, -50, 20, 496, -200, -1000, -360, 30, -100, 72, -36]


def main() -> int:
    runs = [(s, 0, 0) for s in range(1, 6)] + [(s, 4, 2) for s in range(11, 16)] + [(s, 2, 3) for s in range(21, 26)]
    cases = np.concatenate([tetsim.trace_cases(s, 150, ge, gl) for s, ge, gl in runs])
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"weights": W, "cases": cases.tolist()}, f)
        tmp = f.name
    res = subprocess.run(["node", str(ROOT / "tests" / "tet_wasm_cases.mjs"), tmp],
                         check=True, capture_output=True, text=True)
    wasm = np.array(json.loads(res.stdout), dtype=np.int32)
    native = cases[:, 260:].copy()
    # 初手が無い（その場で死ぬ）とき、本番は p[0] を初期化せずに rot/x/y/spawnY（[4..7]）を書き出す＝未定義の値。
    # JS は id（[3]）が 0..6 でなければ使わないので比較から外す。
    dead = native[:, 3] < 0
    native[dead, 4:8] = 0
    wasm[dead, 4:8] = 0
    bad = np.where((wasm != native).any(axis=1))[0]
    print(f"cases={len(cases)}  mismatch={len(bad)}")
    for i in bad[:5]:
        diff = np.where(wasm[i] != native[i])[0]
        print(f"  case {i}: idx {diff.tolist()} native={native[i][diff].tolist()} wasm={wasm[i][diff].tolist()}")
    return 1 if len(bad) else 0


if __name__ == "__main__":
    sys.exit(main())
