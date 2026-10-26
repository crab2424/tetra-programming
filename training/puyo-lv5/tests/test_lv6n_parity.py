"""テト CPU lv6 の新しい探索（public/cpu/tet/lv6/engine）：native（学習シミュ）と本番 wasm の一致テスト・wasm の速さ。

lv6 のひとり用で出てきた盤面（おじゃま入りを含む）に、7-bag に合う確定 NEXT（33本）を付けて両方で探索し、
出力（経過 ms の [14] を除く）が全件一致することを確かめる。締め切りは十分長くして（探索を最後まで回して）比べる。
あわせて締め切り 80ms で wasm の時間と読めた深さを出す。設計 source_assets/memory/cpu/tet/lv6-phase1-search-design.md
  python3 tests/test_lv6n_parity.py
"""
from __future__ import annotations

import ctypes
import json
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))
import tetsim  # noqa: E402

OUT_LEN = 96


def make_cases(n_queue=33):
    runs = [(s, 0, 0) for s in range(1, 4)] + [(s, 4, 2) for s in range(11, 14)] + [(s, 2, 3) for s in range(21, 24)]
    boards = np.concatenate([tetsim.trace_cases_lv(6, s, 60, ge, gl) for s, ge, gl in runs])
    rnd = random.Random(1)
    cases = []
    for row in boards:
        # 7-bag の列から current＋NEXT を取り、残りの bag を bagAfter にする
        seq = []
        while len(seq) < n_queue + rnd.randrange(7) + 1:
            b = list(range(7)); rnd.shuffle(b); seq += b
        start = rnd.randrange(7)
        q = seq[start:start + n_queue]
        used_in_last_bag = (start + n_queue) % 7
        last_bag = seq[(start + n_queue) // 7 * 7:(start + n_queue) // 7 * 7 + 7]
        rest = last_bag[used_in_last_bag:] if used_in_last_bag else []
        bag_after = 0
        for t in rest:
            bag_after |= 1 << t
        hold = int(row[251])
        cases.append({"board": [int(v) for v in row[:250]], "queue": q, "hold": hold if hold != q[0] else -1,
                      "bagAfter": bag_after, "b2b": int(row[262]), "ren": int(row[261]), "incoming": int(row[263])})
    return cases


def run_native(cases, weights, width, depth, think_ms):
    L = tetsim._lib_lv()
    u8p = np.ctypeslib.ndpointer(np.uint8, flags="C_CONTIGUOUS")
    i32p = np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")
    L.tet_lv6n_search.argtypes = [u8p, i32p] + [ctypes.c_int] * 6 + [i32p] + [ctypes.c_int] * 4 + [i32p, ctypes.c_int]
    w = np.asarray(weights, dtype=np.int32)
    res = []
    for c in cases:
        out = np.zeros(OUT_LEN, dtype=np.int32)
        L.tet_lv6n_search(np.asarray(c["board"], dtype=np.uint8), np.asarray(c["queue"], dtype=np.int32),
                          len(c["queue"]), c["hold"], c["bagAfter"], c["b2b"], c["ren"], c["incoming"], w, len(w),
                          width, depth, think_ms, out, OUT_LEN)
        res.append(out)
    return np.array(res)


def run_wasm(cases, weights, width, depth, think_ms):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"weights": weights, "width": width, "depth": depth, "thinkMs": think_ms, "outLen": OUT_LEN,
                   "cases": cases}, f)
        tmp = f.name
    r = subprocess.run(["node", str(ROOT / "tests" / "lv6n_wasm_cases.mjs"), tmp], check=True, capture_output=True,
                       text=True)
    return np.array(json.loads(r.stdout), dtype=np.int32)


def main() -> int:
    weights = tetsim.sim_default_weights(36)
    cases = make_cases()
    sub = cases[::3]   # 一致テストは締め切りなしで重いので 1/3
    big = 1_000_000
    nat = run_native(sub, weights, 500, 32, big)
    wa = run_wasm(sub, weights, 500, 32, big)
    nat[:, 14] = 0
    wa[:, 14] = 0
    bad = np.where((nat != wa).any(axis=1))[0]
    print(f"一致テスト（幅500・深さ32・締め切りなし）: cases={len(sub)}  mismatch={len(bad)}")
    for i in bad[:5]:
        d = np.where(nat[i] != wa[i])[0]
        print(f"  case {i}: idx {d.tolist()[:10]} native={nat[i][d][:10].tolist()} wasm={wa[i][d][:10].tolist()}")
    print(f"  （HOLD する手 {int((nat[:, 10] == 1).sum())}、T-spin と見た手 {int((nat[:, 16] > 0).sum())}、"
          f"incoming>0 {sum(c['incoming'] > 0 for c in sub)}）")
    t0 = time.time()
    wt = run_wasm(cases, weights, 500, 32, 80)
    nt = run_native(cases, weights, 500, 32, 80)
    for label, o in (("wasm", wt), ("native", nt)):
        print(f"締め切り 80ms {label}: cases={len(o)} 平均 {o[:, 14].mean():.1f}ms 最大 {o[:, 14].max()}ms  "
              f"読めた深さ 平均 {o[:, 13].mean():.1f} 32まで {100 * (o[:, 13] >= 32).mean():.0f}%  "
              f"ノード/手 {o[:, 12].mean():.0f}  ノード/ms {o[:, 12].sum() / max(o[:, 14].sum(), 1):.0f}")
    print(f"（{time.time() - t0:.0f}s）")
    return 1 if len(bad) else 0


if __name__ == "__main__":
    sys.exit(main())
