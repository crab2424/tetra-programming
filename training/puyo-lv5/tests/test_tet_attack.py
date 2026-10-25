"""異種戦のぷよ→テト火力（ojama.js _resolveTetAttack）：シミュと本番 JS の一致テスト。

段ごとのライン・持ち越し・全消し・点での相殺（ただの相殺を含む）を、ランダムな状態 5000 件で照合する。
  python3 tests/test_tet_attack.py
"""
from __future__ import annotations

import ctypes
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))
import puyosim  # noqa: E402

CHAIN_BONUS = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512]


def make_cases(n: int, seed: int = 1) -> list[list[float]]:
    rng = np.random.default_rng(seed)
    cases = []
    for _ in range(n):
        rate = int(rng.choice([70, 70, 70, 52, 34, 120, 1]))
        chain = int(rng.integers(1, 15))
        cells = int(rng.choice([4, 4, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16]))
        add = 10 * cells * max(1, CHAIN_BONUS[chain - 1] + int(rng.choice([0, 0, 0, 3, 6])))
        if rng.random() < 0.1:
            add = 0
        carry = float(rng.integers(0, 6000)) if rng.random() < 0.7 else 0.0
        zen = int(rng.random() < 0.1)
        nq = int(rng.integers(0, 4)) if rng.random() < 0.6 else 0
        c = [rate, chain, carry, zen, add, cells, nq]
        for _ in range(nq):
            c += [int(rng.integers(1, 60)), int(rng.random() < 0.5)]
        cases.append(c)
    return cases


def main() -> int:
    L = puyosim.lib()
    f64p = np.ctypeslib.ndpointer(np.float64, flags="C_CONTIGUOUS")
    L.sim_tet_resolve_case.argtypes = [f64p, f64p]
    cases = make_cases(5000)
    sim = []
    for c in cases:
        out = np.zeros(6)
        L.sim_tet_resolve_case(np.array(c, dtype=np.float64), out)
        sim.append(out)
    sim = np.array(sim)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(cases, f)
        tmp = f.name
    res = subprocess.run(["node", str(ROOT / "tests" / "tet_attack_cases.mjs"), tmp],
                         check=True, capture_output=True, text=True)
    js = np.array(json.loads(res.stdout), dtype=np.float64)
    bad = np.where(np.abs(js - sim).max(axis=1) > 1e-6)[0]
    lines = sim[:, 0]
    print(f"cases={len(cases)}  mismatch={len(bad)}  （ラインが出た {int((lines > 0).sum())} 件・最大 {int(lines.max())}）")
    for i in bad[:5]:
        print(f"  case {cases[i]}\n    sim={sim[i].tolist()}\n    js ={js[i].tolist()}")
    return 1 if len(bad) else 0


if __name__ == "__main__":
    sys.exit(main())
