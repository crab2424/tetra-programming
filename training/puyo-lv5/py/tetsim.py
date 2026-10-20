"""ctypes ラッパ：異種戦シミュのテト側（sim/tet_*.cpp）。共有ライブラリは puyosim と同じ。

設計: source_assets/memory/cpu/puyo/lv6-vstet-design.md §7
"""
from __future__ import annotations

import ctypes

import numpy as np

import puyosim

SOLO_KEYS = ["pieces", "ms", "lines", "tspins", "ts_mini", "tetrises", "pcs", "b2bs", "max_ren",
             "gauge_sent", "ojama_sent", "tet_attack", "teleports", "route_instant", "route_path", "route_full",
             "no_move", "holds", "dead", "garbage_taken", "ojama_pre_margin", "ms_pre_margin", "pieces_pre_margin",
             "final_height"]
CASE_LEN = 303

_ready = False


def lib():
    global _ready
    L = puyosim.lib()
    if not _ready:
        i32p = np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")
        u32p = np.ctypeslib.ndpointer(np.uint32, flags="C_CONTIGUOUS")
        f64p = np.ctypeslib.ndpointer(np.float64, flags="C_CONTIGUOUS")
        L.tet_out_len.restype = ctypes.c_int
        L.tet_solo_run.argtypes = [ctypes.c_int, u32p, ctypes.c_int, ctypes.c_double, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, f64p]
        L.tet_trace_cases.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_int, ctypes.c_int, i32p, ctypes.c_int]
        L.tet_trace_cases.restype = ctypes.c_int
        assert L.tet_out_len() == len(SOLO_KEYS)
        _ready = True
    return L


def solo_run(seeds, max_pieces=100000, max_ms=1e18, margin_ms=96000, garbage_every=0, garbage_lines=0,
             threads=0) -> list[dict]:
    """テト CPU lv5 のひとり用。1局ごとの集計（SOLO_KEYS）を返す。"""
    seeds = np.asarray(seeds, dtype=np.uint32)
    out = np.zeros(len(seeds) * len(SOLO_KEYS), dtype=np.float64)
    lib().tet_solo_run(len(seeds), seeds, max_pieces, float(max_ms), margin_ms, garbage_every, garbage_lines,
                       threads, out)
    out = out.reshape(len(seeds), len(SOLO_KEYS))
    return [dict(zip(SOLO_KEYS, row)) for row in out]


def trace_cases(seed, max_pieces=200, garbage_every=0, garbage_lines=0) -> np.ndarray:
    """探索の入出力（1行 303 int：盤面250・cur・hold・next×5・canHold・ren・b2b・出力43）。"""
    buf = np.zeros(max_pieces * 3 * CASE_LEN, dtype=np.int32)
    n = lib().tet_trace_cases(seed, max_pieces, garbage_every, garbage_lines, buf, max_pieces * 3)
    return buf[: n * CASE_LEN].reshape(n, CASE_LEN)
