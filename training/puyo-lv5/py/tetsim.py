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


# ── 異種戦（ぷよ 対 テト CPU lv5）──
VSTET_KEYS = ["winner", "ms", "puyo_turns", "puyo_max_chain", "puyo_max_score", "puyo_lines_sent",
              "puyo_ojama_received", "puyo_counter_turns", "free_offsets", "offset_by_score",
              "tet_pieces", "tet_lines", "tet_tspins", "tet_tetrises", "tet_b2bs", "tet_ojama_sent", "tet_gauge",
              "tet_lines_received", "tet_garbage_taken", "tet_final_height", "puyo_tears", "puyo_tear_units",
              "puyo_danger_turns", "puyo_danger_fires"]


def vstet_policy(name: str = "lv6", base: dict | None = None) -> puyosim.Policy:
    """相手がテトのときのぷよの設定（build=vsTet・fast=fastVsTet・カウンター 6個/×1.3）。本番 JS から取る。"""
    b = base or puyosim.load_baseline()
    v = (b["lv6"] if name == "lv6" else b)["vsTet"]
    pol = puyosim.Policy(list(v["build"]), list(v["fast"]), int(v["counterTrigger"]), float(v["counterMargin"]))
    d = b["lv6"].get("vsTetDecision", {}) if name == "lv6" else {}
    m = {"keepReach": "vt_keep_reach", "decayStartS": "vt_decay_start_s", "decayStepS": "vt_decay_step_s",
         "decayMin": "vt_decay_min", "counterPct": "vt_counter_pct", "queueOnly": "vt_queue_only",
         "killPct": "vt_kill_pct", "killHoldPct": "vt_kill_hold_pct", "killFire": "vt_kill_fire", "strict": "vt_strict",
         "terrainMax": "vt_terrain_max", "terrainQueue": "vt_terrain_queue",
         "terrainMinChains": "vt_terrain_min_chains", "terrainGainPct": "vt_terrain_gain_pct",
         "ojamaSearch": "vt_ojama_search", "ojamaWorst": "vt_ojama_worst", "ojamaTurnMs": "vt_ojama_turn_ms"}
    kw = {m[k]: int(v) for k, v in d.items() if k in m and v}
    return pol.with_ext(**kw) if kw else pol


def run_vstet(pol, seeds, settings: puyosim.Settings | None = None, both_orders: bool = True,
              threads: int = 0) -> list[dict]:
    """ぷよ（pol：Policy か packed 配列）対 テト lv5。both_orders なら同時刻の処理順を入れ替えた2局ずつ。"""
    L = lib()
    if not hasattr(L, "_vstet_ready"):
        i32p = np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")
        u32p = np.ctypeslib.ndpointer(np.uint32, flags="C_CONTIGUOUS")
        f64p = np.ctypeslib.ndpointer(np.float64, flags="C_CONTIGUOUS")
        L.sim_run_vstet.argtypes = [ctypes.c_int, i32p, u32p, i32p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_double, ctypes.c_int, f64p]
        L._vstet_ready = True
    s = settings or puyosim.Settings()
    packed = pol.packed() if hasattr(pol, "packed") else np.asarray(pol, dtype=np.int32)
    seeds = np.asarray(seeds, dtype=np.uint32)
    orders = [1, 0] if both_orders else [1]
    sd = np.repeat(seeds, len(orders))
    first = np.tile(np.array(orders, dtype=np.int32), len(seeds))
    n = len(sd)
    pp = np.ascontiguousarray(np.tile(packed, (n, 1)).astype(np.int32))
    out = np.zeros(n * 24, dtype=np.float64)
    L.sim_run_vstet(n, pp.ravel(), sd, first, s.ojama_rate, s.color_count, s.margin_time_ms, s.max_game_ms,
                    threads, out)
    out = out.reshape(n, 24)
    return [dict(zip(VSTET_KEYS, row), seed=int(sd[i]), puyo_first=int(first[i])) for i, row in enumerate(out)]


def trace_vstet(pol, seeds, out_path, settings: puyosim.Settings | None = None, threads: int = 0) -> int:
    """記録付きの異種戦（ぷよ側の PlayerTrace を JSONL へ。1局1行）。同時刻はぷよを先に処理する。"""
    L = lib()
    if not hasattr(L, "_trace_vstet_ready"):
        i32p = np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")
        u32p = np.ctypeslib.ndpointer(np.uint32, flags="C_CONTIGUOUS")
        L.sim_trace_vstet.restype = ctypes.c_int
        L.sim_trace_vstet.argtypes = [ctypes.c_int, i32p, u32p, i32p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                      ctypes.c_double, ctypes.c_int, ctypes.c_char_p]
        L._trace_vstet_ready = True
    s = settings or puyosim.Settings()
    packed = pol.packed() if hasattr(pol, "packed") else np.asarray(pol, dtype=np.int32)
    seeds = np.asarray(seeds, dtype=np.uint32)
    n = len(seeds)
    pp = np.ascontiguousarray(np.tile(packed, (n, 1)).astype(np.int32))
    first = np.ones(n, dtype=np.int32)
    return L.sim_trace_vstet(n, pp.ravel(), seeds, first, s.ojama_rate, s.color_count, s.margin_time_ms,
                             s.max_game_ms, threads, str(out_path).encode())


def run_vstet_batch(packed_cands, seeds, settings: puyosim.Settings | None = None, threads: int = 0) -> np.ndarray:
    """候補 (nCand, PP_LEN) × シードを1バッチで打つ（同時刻はぷよ先）。返り値: 勝ち(1)/負け・引分(0) の (nCand, nSeeds)。"""
    L = lib()
    run_vstet(packed_cands[0], seeds[:1], settings, both_orders=False)   # argtypes の設定
    s = settings or puyosim.Settings()
    cands = np.asarray(packed_cands, dtype=np.int32)
    seeds = np.asarray(seeds, dtype=np.uint32)
    nc, ns = len(cands), len(seeds)
    pp = np.ascontiguousarray(np.repeat(cands, ns, axis=0))
    sd = np.tile(seeds, nc)
    first = np.ones(nc * ns, dtype=np.int32)
    out = np.zeros(nc * ns * 24, dtype=np.float64)
    L.sim_run_vstet(nc * ns, pp.ravel(), sd, first, s.ojama_rate, s.color_count, s.margin_time_ms, s.max_game_ms,
                    threads, out)
    return (out.reshape(nc, ns, 24)[:, :, 0] == 0).astype(np.int8)
