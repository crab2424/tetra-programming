"""ctypes ラッパ：build/libpuyosim.{dylib,so} を呼ぶ。

対局・探索・並列化はすべて C++ 側（sim/api.cpp）で行う。Python はジョブを組んで結果を受け取るだけ。
"""
from __future__ import annotations

import ctypes
import json
import os
import platform
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
W_LEN = 51
EXT_LEN = 16                       # 試作中の対戦判断（sim.h ExtIndex）。0 埋め＝現行 lv5
PP_LEN = W_LEN * 2 + 2 + EXT_LEN
EXT = {"p1_enable": 0, "p1_alpha": 1, "p1_kill_ratio": 2, "p1_kill_min": 3,
       "p2_enable": 4, "p2_safety_ms": 5, "p2_min_incoming": 6, "p2_wait_fast": 7, "p2_turn_ms": 8,
       "p2_fire_if_pct": 9, "p2_no_spill": 10, "p1_use_threat": 11}


def _lib_path() -> Path:
    ext = "dylib" if platform.system() == "Darwin" else "so"
    return BUILD / f"libpuyosim.{ext}"


def build(force: bool = False) -> None:
    """共有ライブラリをビルドする（無ければ）。"""
    if force or not _lib_path().exists():
        subprocess.run(["bash", str(ROOT / "build.sh")], check=True)


_lib = None


def lib():
    global _lib
    if _lib is None:
        build()
        L = ctypes.CDLL(str(_lib_path()))
        i32p = np.ctypeslib.ndpointer(np.int32, flags="C_CONTIGUOUS")
        u32p = np.ctypeslib.ndpointer(np.uint32, flags="C_CONTIGUOUS")
        f64p = np.ctypeslib.ndpointer(np.float64, flags="C_CONTIGUOUS")
        i64p = np.ctypeslib.ndpointer(np.int64, flags="C_CONTIGUOUS")
        u8p = np.ctypeslib.ndpointer(np.uint8, flags="C_CONTIGUOUS")
        L.sim_abi_version.restype = ctypes.c_int
        L.sim_pp_len.restype = ctypes.c_int
        L.sim_run_matches.argtypes = [ctypes.c_int, i32p, i32p, u32p, ctypes.c_int, ctypes.c_int,
                                      ctypes.c_int, ctypes.c_double, ctypes.c_int, i32p, f64p]
        L.sim_run_solo.argtypes = [ctypes.c_int, i32p, u32p, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, i32p]
        L.sim_rng_values.argtypes = [ctypes.c_uint32, ctypes.c_int, f64p]
        L.sim_pair_sequence.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_int, i32p]
        L.sim_chain.argtypes = [u8p, i64p]
        L.sim_chain_time.argtypes = [u8p, f64p]
        L.sim_trace_solo.restype = ctypes.c_int
        L.sim_trace_solo.argtypes = [ctypes.c_int, i32p, u32p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_int, ctypes.c_char_p]
        L.sim_trace_matches.restype = ctypes.c_int
        L.sim_trace_matches.argtypes = [ctypes.c_int, i32p, i32p, u32p, ctypes.c_int, ctypes.c_int,
                                        ctypes.c_int, ctypes.c_double, ctypes.c_int, ctypes.c_char_p]
        assert L.sim_abi_version() == 2
        assert L.sim_pp_len() == PP_LEN
        _lib = L
    return _lib


# ── 基準値（本番 JS から取り出す）──
def load_baseline(refresh: bool = True) -> dict:
    """現行 lv5 の weightsArray（build/fast）とカウンター定数。本番 JS から毎回取り直す。"""
    path = BUILD / "baseline.json"
    if refresh or not path.exists():
        BUILD.mkdir(exist_ok=True)
        js = subprocess.run(["node", str(ROOT / "tools" / "export_weights.mjs")],
                            check=True, capture_output=True, text=True).stdout
        path.write_text(js)
    return json.loads(path.read_text())


@dataclass
class Policy:
    """1プレイヤーの設定（PolicyParams と同じ並び）。"""
    build: list[int]
    fast: list[int]
    counter_trigger: int
    counter_margin: float
    ext: list[int] = field(default_factory=lambda: [0] * EXT_LEN)

    def packed(self) -> np.ndarray:
        assert len(self.build) == W_LEN and len(self.fast) == W_LEN and len(self.ext) == EXT_LEN
        return np.array(list(self.build) + list(self.fast)
                        + [int(self.counter_trigger), int(round(self.counter_margin * 1000))]
                        + [int(v) for v in self.ext], dtype=np.int32)

    def with_ext(self, **kw) -> "Policy":
        """ext（試作中の対戦判断）を名前で指定したコピー。例: pol.with_ext(p2_enable=1)"""
        ext = list(self.ext)
        for k, v in kw.items():
            ext[EXT[k]] = int(v)
        return Policy(list(self.build), list(self.fast), self.counter_trigger, self.counter_margin, ext)

    @classmethod
    def lv6(cls, base: dict | None = None) -> "Policy":
        """本番の puyo lv6（cpu6.js）。学習済み重み＋対戦判断（VS_DECISION）を ext に写す。"""
        b = (base or load_baseline())["lv6"]
        pol = cls(list(b["build"]), list(b["fast"]), int(b["counterTrigger"]), float(b["counterMargin"]))
        p2 = b.get("vsDecision", {}).get("p2")
        if p2:
            pol = pol.with_ext(p2_enable=1, p2_min_incoming=p2["minIncoming"], p2_fire_if_pct=p2["fireIfPct"],
                               p2_safety_ms=p2["safetyMs"], p2_turn_ms=p2["turnMs"])
        return pol

    @classmethod
    def baseline(cls, base: dict | None = None) -> "Policy":
        b = base or load_baseline()
        return cls(list(b["build"]), list(b["fast"]), int(b["counterTrigger"]), float(b["counterMargin"]))


@dataclass
class Settings:
    ojama_rate: int = 70
    color_count: int = 4
    margin_time_ms: int = 96000
    max_game_ms: float = 600000.0


MATCH_COLS = ["winner", "turnsA", "turnsB", "maxChainA", "maxChainB", "maxScoreA", "maxScoreB",
              "sentA", "sentB", "recvA", "recvB", "counterTurnsA"]


def run_matches(pa: np.ndarray, pb: np.ndarray, seeds, settings: Settings | None = None,
                threads: int = 0) -> dict[str, np.ndarray]:
    """pa/pb: (nJobs, PP_LEN) か (PP_LEN,)（全ジョブ共通）。winner: 0=A勝ち 1=B勝ち -1=引き分け。"""
    s = settings or Settings()
    seeds = np.ascontiguousarray(seeds, dtype=np.uint32)
    n = len(seeds)
    pa = np.ascontiguousarray(np.broadcast_to(pa, (n, pa.shape[-1])), dtype=np.int32)
    pb = np.ascontiguousarray(np.broadcast_to(pb, (n, pb.shape[-1])), dtype=np.int32)
    out = np.zeros(n * 12, dtype=np.int32)
    dur = np.zeros(n, dtype=np.float64)
    lib().sim_run_matches(n, pa, pb, seeds, s.ojama_rate, s.color_count, s.margin_time_ms,
                          s.max_game_ms, threads, out, dur)
    out = out.reshape(n, 12)
    res = {k: out[:, i] for i, k in enumerate(MATCH_COLS)}
    res["durationMs"] = dur
    return res


def trace_matches(pa: np.ndarray, pb: np.ndarray, seeds, out_path, settings: Settings | None = None,
                  threads: int = 0) -> int:
    """記録付きで対局し、1局1行の JSON を out_path に書く（分析用。analyze_losses.py が読む）。"""
    s = settings or Settings()
    seeds = np.ascontiguousarray(seeds, dtype=np.uint32)
    n = len(seeds)
    pa = np.ascontiguousarray(np.broadcast_to(pa, (n, pa.shape[-1])), dtype=np.int32)
    pb = np.ascontiguousarray(np.broadcast_to(pb, (n, pb.shape[-1])), dtype=np.int32)
    return lib().sim_trace_matches(n, pa, pb, seeds, s.ojama_rate, s.color_count, s.margin_time_ms,
                                   s.max_game_ms, threads, str(out_path).encode())


def trace_solo(p: np.ndarray, seeds, out_path, max_turns: int = 60, harass_turn: int = 0,
               harass_amount: int = 0, color_count: int = 4, threads: int = 0) -> int:
    """記録付きひとり用。harass_turn 手目に harass_amount 個のおじゃまを降らせる（分析用）。"""
    seeds = np.ascontiguousarray(seeds, dtype=np.uint32)
    n = len(seeds)
    p = np.ascontiguousarray(np.broadcast_to(p, (n, p.shape[-1])), dtype=np.int32)
    return lib().sim_trace_solo(n, p, seeds, max_turns, harass_turn, harass_amount, color_count, threads,
                                str(out_path).encode())


SOLO_COLS = ["turns", "maxChain", "maxChainScore", "firstBigTurn", "died"]


def run_solo(p: np.ndarray, seeds, max_turns: int = 60, target_chain: int = 10,
             color_count: int = 4, threads: int = 0) -> dict[str, np.ndarray]:
    seeds = np.ascontiguousarray(seeds, dtype=np.uint32)
    n = len(seeds)
    p = np.ascontiguousarray(np.broadcast_to(p, (n, p.shape[-1])), dtype=np.int32)
    out = np.zeros(n * 6, dtype=np.int32)
    lib().sim_run_solo(n, p, seeds, max_turns, target_chain, color_count, threads, out)
    out = out.reshape(n, 6)
    return {k: out[:, i] for i, k in enumerate(SOLO_COLS)}


def win_rate(res: dict[str, np.ndarray]) -> float:
    """A 視点の勝率（引き分け=0.5）。"""
    w = res["winner"]
    return float(np.mean(np.where(w == 0, 1.0, np.where(w == 1, 0.0, 0.5))))


def play_both_sides(cand: np.ndarray, opp: np.ndarray, seeds, settings: Settings | None = None,
                    threads: int = 0) -> dict[str, np.ndarray]:
    """各シードを先後入れ替えて2局ずつ打ち、cand 視点に揃えて返す。

    同時刻のイベントは先手（A）側から処理されるため、同じポリシー同士でも先後で勝敗が偏る。
    先後を入れ替えた2局を1組にしてこの偏りを打ち消す。score: 1=cand勝ち 0=負け 0.5=引き分け。
    cand/opp は (PP_LEN,) か (nCand, PP_LEN)。後者は全候補×全シードを1バッチで回す。
    """
    seeds = np.asarray(seeds, dtype=np.uint32)
    cand = np.atleast_2d(cand)
    opp = np.atleast_2d(opp)
    nc, ns = cand.shape[0], len(seeds)
    if opp.shape[0] == 1:
        opp = np.repeat(opp, nc, axis=0)
    ci = np.repeat(np.arange(nc), ns)
    sd = np.tile(seeds, nc)
    pa = np.concatenate([cand[ci], opp[ci]])
    pb = np.concatenate([opp[ci], cand[ci]])
    r = run_matches(pa, pb, np.concatenate([sd, sd]), settings, threads)
    w = r["winner"]
    m = nc * ns
    first = np.where(w[:m] == 0, 1.0, np.where(w[:m] == 1, 0.0, 0.5))    # cand が先手
    second = np.where(w[m:] == 1, 1.0, np.where(w[m:] == 0, 0.0, 0.5))   # cand が後手
    score = np.concatenate([first, second]).reshape(2, nc, ns)
    return {
        "score": score,                          # [先後, 候補, シード]
        "winRate": score.mean(axis=(0, 2)),      # 候補ごとの勝率
        "durationMs": r["durationMs"].reshape(2, nc, ns),
        "raw": r,
    }


def threads_default() -> int:
    return os.cpu_count() or 8
