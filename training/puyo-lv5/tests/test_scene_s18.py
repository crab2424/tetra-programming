"""局面テスト（lv6-vstet-design.md §18.1）：3連鎖で返すべき局面で、本番 lv6 と §18 F・G の手を比べる。

  python3 tests/test_scene_s18.py
見えていない手（3手目以降）を 30 通りの乱数にして、撃つ（3列目に縦）か、撃たずに置くかを数える。
"""
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))
import puyosim  # noqa: E402
import tetsim   # noqa: E402

NATIVE = ROOT / "../../public/cpu/puyo/lv5/native"
EXE = ROOT / "build/scene_s18"

# 名前 → build（vsTet）に足す値（添字: 値）。[77] ojamaWorst は本番 lv6 と同じ 1。
CASES = {
    "base":        {},
    "g100":        {94: 100},
    "g100f50":     {94: 100, 91: 50},
    "f50":         {91: 50},
    "w2r":         {92: 2, 93: 1},
    "g100w2r":     {94: 100, 92: 2, 93: 1},
    # §18.11 G の条件の絞り込み（案1 本線そのものは本線が埋まるときだけ・案2 高さの下限・案3 7個以上）
    "g100k50l50":  {94: 100, 97: 50, 98: 50},
    "g100k50l30":  {94: 100, 97: 50, 98: 30},
    "g100h6":      {94: 100, 99: 6},
    "g100h7":      {94: 100, 99: 7},
    "g100k50l50h6m7": {94: 100, 97: 50, 98: 50, 99: 6, 95: 7},
}


def build():
    srcs = ["tests/scene_s18.cpp"] + [str(NATIVE / s) for s in
                                      ("core/bitboard.cpp", "core/chain.cpp", "eval/shape.cpp", "eval/form.cpp",
                                       "eval/eval.cpp", "build/build.cpp")]
    subprocess.run(["clang++", "-std=c++17", "-O2", f"-I{NATIVE}", f"-DW_ARRAY_LEN_S18={puyosim.W_LEN}",
                    *srcs, "-o", str(EXE)], cwd=ROOT, check=True)


def main():
    build()
    pol = tetsim.vstet_policy("lv6")
    base = list(pol.build)
    base[77] = 1
    for name, sets in CASES.items():
        wa = list(base)
        for k, v in sets.items():
            wa[k] = v
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write(" ".join(str(int(v)) for v in wa))
            path = f.name
        moves = Counter()
        for seed in range(1, 31):
            col, rot, chains, reason, flags = map(int, subprocess.run(
                [str(EXE), path, str(seed)], capture_output=True, text=True, check=True).stdout.split())
            kind = f"撃つ({chains}連鎖・理由{reason})" if chains > 0 else f"置く(列{col + 1}・回転{rot})"
            moves[kind] += 1
        print(f"{name:10s}", ", ".join(f"{k} {n}" for k, n in moves.most_common()))


if __name__ == "__main__":
    main()
