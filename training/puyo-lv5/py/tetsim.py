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
              "puyo_danger_turns", "puyo_danger_fires", "puyo_safe_checks", "puyo_safe_fires",
              "puyo_standby_checks", "puyo_standby_changes", "puyo_standby_ok", "puyo_standby_danger",
              "puyo_counter_waits", "puyo_counter_wait_ms", "puyo_counter_wait_arrived"]


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
         "ojamaSearch": "vt_ojama_search", "ojamaWorst": "vt_ojama_worst", "ojamaTurnMs": "vt_ojama_turn_ms",
         "ojamaWorstDepth": "vt_ojama_worst_depth", "ojamaWorstByReach": "vt_ojama_worst_by_reach",
         "counterTriggerQueueOnly": "vt_counter_queue_only",
         "waitMinGauge": "vt_wait_min_gauge", "waitMaxMs": "vt_wait_max_ms"}
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
    out = np.zeros(n * 33, dtype=np.float64)
    L.sim_run_vstet(n, pp.ravel(), sd, first, s.ojama_rate, s.color_count, s.margin_time_ms, s.max_game_ms,
                    threads, out)
    out = out.reshape(n, 33)
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
    out = np.zeros(nc * ns * 33, dtype=np.float64)
    L.sim_run_vstet(nc * ns, pp.ravel(), sd, first, s.ojama_rate, s.color_count, s.margin_time_ms, s.max_game_ms,
                    threads, out)
    return (out.reshape(nc, ns, 33)[:, :, 0] == 0).astype(np.int8)


# ── テト同士（lv4/lv5/lv6）──
#   設計: source_assets/memory/cpu/tet/lv5-terrain-design.md §4
TVT_SIDE_KEYS = ["pieces", "lines", "tspins", "ts_mini", "tetrises", "pcs", "b2bs", "max_ren", "tet_attack",
                 "tet_sent", "lines_received", "garbage_taken", "holds", "dead", "final_height", "route_miss",
                 "tss", "tsd", "tst", "pc_searches", "pc_found", "pc_aborted", "pc_moves", "pc_search_ms",
                 "think_ms", "wait_ms", "max_spike", "ren1", "ren2to5", "ren6plus", "ren_atk", "nodes",
                 "ts_pred", "ts_pred_miss", "ts_unpred"]
# レベル番号の追加分（sim/tet.h）：26＝lv6＋PC 探索、7＝参考AI clys
TET_LV6_BOOST = 16   # 強化版 lv6（凍結。sim/tet.h）。レベル 6 は本番（main の版）
TET_LV6_PC = 26
TET_CLYS = 7
CASE_LEN_LV = 307
_REPO = __import__("pathlib").Path(__file__).resolve().parents[3]
_CPU_JS = {4: "public/cpu/tet/lv4/cpu4.js", 5: "public/cpu/tet/lv5/cpu5.js", 6: "public/cpu/tet/lv6/cpu6.js"}


def prod_weights(level: int) -> list[int]:
    """本番 cpu{4,5,6}.js の this.weights を onMinoSpawned の weightsArray の順に並べて返す（手で写さない）。"""
    import re
    src = (_REPO / _CPU_JS[level]).read_text(encoding="utf-8")
    body = re.search(r"this\.weights\s*=\s*\{(.*?)\n\s*\};", src, re.S).group(1)
    body = re.sub(r"//[^\n]*", "", body)
    vals = {k: float(v) for k, v in re.findall(r"(\w+)\s*:\s*(-?[\d.]+)", body)}
    spawn = src[src.index("onMinoSpawned()"):]
    arr = re.search(r"weightsArray\s*=\s*new Int32Array\(\[(.*?)\]\)", spawn, re.S).group(1)
    arr = re.sub(r"//[^\n]*", "", arr)
    out = []
    for item in [a.strip() for a in arr.split(",") if a.strip()]:
        m = re.fullmatch(r"Math\.round\(this\.weights\.(\w+)\s*\*\s*100\)", item)
        out.append(int(round(vals[m.group(1)] * 100)) if m else int(vals[re.fullmatch(r"this\.weights\.(\w+)", item).group(1)]))
    return out


def _lib_lv():
    L = lib()
    if not hasattr(L, "_lv_ready"):
        i32p = np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")
        u32p = np.ctypeslib.ndpointer(np.uint32, flags="C_CONTIGUOUS")
        f64p = np.ctypeslib.ndpointer(np.float64, flags="C_CONTIGUOUS")
        vp = ctypes.c_void_p
        L.tet_solo_run_lv.argtypes = [ctypes.c_int, vp, ctypes.c_int, ctypes.c_int, u32p, ctypes.c_int,
                                      ctypes.c_double, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, f64p]
        L.tet_trace_cases_lv.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                         i32p, ctypes.c_int]
        L.tet_trace_cases_lv.restype = ctypes.c_int
        L.tet_case_len_lv.restype = ctypes.c_int
        L.tet_vs_len.restype = ctypes.c_int
        L.tet_vs_run.argtypes = [ctypes.c_int, vp, ctypes.c_int, ctypes.c_int, vp, ctypes.c_int, ctypes.c_int, u32p,
                                 ctypes.c_double, ctypes.c_int, ctypes.c_int, ctypes.c_double, ctypes.c_int, ctypes.c_int, f64p]
        L.tet_search_cases_lv.argtypes = [ctypes.c_int, vp, ctypes.c_int, ctypes.c_int, i32p, ctypes.c_int, i32p]
        L.tet_terrain_lv.argtypes = [ctypes.c_int, vp, ctypes.c_int, ctypes.c_int, u32p, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_int, f64p]
        L.tet_terrain_len.restype = ctypes.c_int
        assert L.tet_terrain_len() == len(TERRAIN_KEYS)
        assert L.tet_case_len_lv() == CASE_LEN_LV and L.tet_vs_len() == 2 + 2 * len(TVT_SIDE_KEYS)
        L._lv_ready = True
    return L


def sim_default_weights(level: int) -> list[int]:
    """シミュ（sim/tet_player.cpp）が持っている既定の重み。"""
    L = _lib_lv()
    buf = np.zeros(96, dtype=np.int32)   # sim/tet.h TET_W_MAX
    L.tet_default_weights.argtypes = [ctypes.c_int, np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")]
    n = L.tet_default_weights(level, buf)
    return buf[:n].tolist()


def _wptr(w):
    if w is None:
        return None, 0, None
    a = np.ascontiguousarray(np.asarray(w, dtype=np.int32))
    return a.ctypes.data_as(ctypes.c_void_p), len(a), a   # a は呼び出し中に解放されないよう返して持たせる


def solo_run_lv(level, seeds, weights=None, max_pieces=100000, max_ms=1e18, margin_ms=96000, garbage_every=0,
                garbage_lines=0, threads=0) -> list[dict]:
    """レベル指定のひとり用（weights=None なら本番の重み）。1局ごとの集計（SOLO_KEYS）。"""
    L = _lib_lv()
    seeds = np.asarray(seeds, dtype=np.uint32)
    out = np.zeros(len(seeds) * len(SOLO_KEYS), dtype=np.float64)
    wp, wn, _keep = _wptr(weights)
    L.tet_solo_run_lv(level, wp, wn, len(seeds), seeds, max_pieces, float(max_ms), margin_ms, garbage_every,
                      garbage_lines, threads, out)
    out = out.reshape(len(seeds), len(SOLO_KEYS))
    return [dict(zip(SOLO_KEYS, row)) for row in out]


def trace_cases_lv(level, seed, max_pieces=200, garbage_every=0, garbage_lines=0) -> np.ndarray:
    """探索の入出力（1行 307 int：盤面250・cur・hold・next×8・canHold・ren・b2b・incoming・出力43）。"""
    L = _lib_lv()
    buf = np.zeros(max_pieces * 3 * CASE_LEN_LV, dtype=np.int32)
    n = L.tet_trace_cases_lv(level, seed, max_pieces, garbage_every, garbage_lines, buf, max_pieces * 3)
    return buf[: n * CASE_LEN_LV].reshape(n, CASE_LEN_LV)


def set_model_think(on: bool = True, scale: float = 1.0) -> None:
    """探索に実際にかかった時間（×scale）を操作開始の待ちに入れる（既定オフ＝探索 0ms）。"""
    L = _lib_lv()
    L.tet_set_model_think.argtypes = [ctypes.c_int, ctypes.c_double]
    L.tet_set_model_think(1 if on else 0, float(scale))


def set_think_scale(level: int, scale: float = 1.0, pc_scale: float = 1.0) -> None:
    """レベル（26=lv6+PC など、vs_run に渡す番号）ごとの思考時間の倍率。pc_scale は PC 探索だけ（上限で頭打ち）。"""
    L = _lib_lv()
    L.tet_set_think_scale.argtypes = [ctypes.c_int, ctypes.c_double, ctypes.c_double]
    L.tet_set_think_scale(int(level), float(scale), float(pc_scale))


def set_clys(think_ms: int = 0, width: int = 0, branch: int = 0) -> None:
    """clys の思考時間・ビーム幅・branch（0 は変えない。既定 100ms・500・3）。"""
    L = _lib_lv()
    L.tet_set_clys.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    L.tet_set_clys(int(think_ms), int(width), int(branch))


def set_side(side: int, reset: bool = True, queue_len=-1, clys_think=-1, clys_width=-1, clys_branch=-1,
             clys_next=-1, clys_depth=-1, lv6_width=-1, lv6_depth=-1, lv6_next=-1) -> None:
    """席ごとの探索設定（lv6-learning-design.md Phase 0）。side 0=全員の既定 1=A 2=B。-1 は変えない。
    queue_len＝確定 NEXT の内部保持数（本番 11）、clys_next＝clys が探索に使う NEXT 本数、clys_depth＝clys の深さ上限、
    lv6_width/depth/next＝lv6 のビーム幅・深さ・NEXT 本数（本番 16・8・8）。"""
    L = _lib_lv()
    L.tet_set_side.argtypes = [ctypes.c_int] * 11
    L.tet_set_side(side, 1 if reset else 0, queue_len, clys_think, clys_width, clys_branch, clys_next, clys_depth,
                   lv6_width, lv6_depth, lv6_next)


def set_level_timing(level, action_ms=None, harddrop_ms=None) -> None:
    """レベルの操作時間（actionDelay / harddropDelay）を差し替える。None で本番の値。"""
    L = _lib_lv()
    L.tet_set_level_timing.argtypes = [ctypes.c_int, ctypes.c_double, ctypes.c_double]
    L.tet_set_level_timing(level, float(action_ms or 0), float(harddrop_ms or 0))


def search_cases_lv(level, cases, weights=None, threads=0) -> np.ndarray:
    """trace_cases_lv の局面（307 int 形式）で探索だけを回し、出力（N×43）を返す。新旧 lv5 の突き合わせ用。"""
    L = _lib_lv()
    cases = np.ascontiguousarray(cases, dtype=np.int32)
    out = np.zeros(len(cases) * 43, dtype=np.int32)
    wp, wn, _k = _wptr(weights)
    L.tet_search_cases_lv(level, wp, wn, len(cases), cases, threads, out)
    return out.reshape(len(cases), 43)


TERRAIN_KEYS = ["placements", "holes", "holes3", "bump", "created", "tspins", "tetrises", "lines", "tet_attack",
                "dead", "max_height", "ms", "step3", "ts_mini"]


def terrain_lv(level, seeds, weights=None, max_pieces=250, garbage_every=0, garbage_lines=0, threads=0) -> dict:
    """ひとり用で地形を測る（設計 lv5-terrain-design.md §1.3）。全局の合計から率を出して返す。
    holes＝平均の穴（T-slot の4マスは除く）、holes3＝穴3つ以上の局面率、bump＝平均の凸凹、
    created/tspins/tetrises＝/100手、apm 相当として attack/100手。"""
    L = _lib_lv()
    seeds = np.asarray(seeds, dtype=np.uint32)
    K = len(TERRAIN_KEYS)
    out = np.zeros(len(seeds) * K, dtype=np.float64)
    wp, wn, _k = _wptr(weights)
    L.tet_terrain_lv(level, wp, wn, len(seeds), seeds, max_pieces, garbage_every, garbage_lines, threads, out)
    t = dict(zip(TERRAIN_KEYS, out.reshape(len(seeds), K).sum(axis=0)))
    n = max(t["placements"], 1)
    return {"n": int(t["placements"]), "holes": t["holes"] / n, "holes3": t["holes3"] / n, "bump": t["bump"] / n,
            "step3": t["step3"] / n, "created": 100 * t["created"] / n, "tspins": 100 * t["tspins"] / n,
            "ts_mini": 100 * t["ts_mini"] / n, "tetrises": 100 * t["tetrises"] / n, "lines": 100 * t["lines"] / n,
            "attack": 100 * t["tet_attack"] / n, "max_height": t["max_height"] / n, "dead": int(t["dead"]),
            "pps": t["placements"] / max(t["ms"], 1) * 1000}


def vs_run(lv_a, lv_b, seeds, w_a=None, w_b=None, max_ms=300000.0, margin_ms=96000, hole_rate=70,
           jitter_ms=10.0, shared_tumo=True, threads=0) -> list[dict]:
    """テト同士の対戦。1シードにつき席（ツモ・送る穴・揺らぎの乱数と同時刻の先後）を入れ替えて2局。
    jitter_ms：操作開始の揺らぎ（本番のタイマーの揺れの代わり。0 だと同じ重み同士は鏡写しで全局引き分け）。
    shared_tumo：True＝本番 VERSUS と同じ両者共通のツモ。False＝B は別のツモ（似た打ち方同士の相殺し合いを崩す）。
    返り値の各局: winner(0=A 1=B -1=引き分け)・ms・a_<集計>・b_<集計>・seed・a_first（1=A が席0）。
    同じ重み同士は席を入れ替えた2局が鏡写しになるので、勝率はちょうど 0.5 になる（意味のある比較は違う重み同士）。"""
    L = _lib_lv()
    seeds = np.asarray(seeds, dtype=np.uint32)
    n = len(seeds) * 2
    W = 2 + 2 * len(TVT_SIDE_KEYS)
    out = np.zeros(n * W, dtype=np.float64)
    pa, na, _ka = _wptr(w_a)
    pb, nb, _kb = _wptr(w_b)
    L.tet_vs_run(lv_a, pa, na, lv_b, pb, nb, len(seeds), seeds, float(max_ms), margin_ms, hole_rate, float(jitter_ms),
                 1 if shared_tumo else 0, threads, out)
    out = out.reshape(n, W)
    res = []
    for j, row in enumerate(out):
        d = {"winner": int(row[0]), "ms": row[1], "seed": int(seeds[j // 2]), "a_first": int(j % 2 == 0)}
        for side, off in (("a", 2), ("b", 2 + len(TVT_SIDE_KEYS))):
            d.update({f"{side}_{k}": row[off + i] for i, k in enumerate(TVT_SIDE_KEYS)})
        res.append(d)
    return res
