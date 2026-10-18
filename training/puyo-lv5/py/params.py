"""最適化するパラメータ空間（設計書 §5.1）。

CMA-ES は [0,1]^n の正規化座標で動かし、decode で実際の重み（整数）に戻す。
  ・固定するもの: qChainWeight（スケール基準）/ expMaxDepth / expBeamWidth / p1Weight / 未参照の重み
  ・fast（カウンター）は学習中は現行値で固定（D2）＝ Policy.fast は baseline のまま
  ・ext（対戦判断。lv6 の後打ち p2 など）は学習しない＝ decode の base（初期値）のまま
  ★ SPACE を変えると次元が変わる＝それ以前の run は --resume できない（train.py が検出して止める）
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from puyosim import Policy


@dataclass(frozen=True)
class Param:
    name: str          # cpu5_weights.js の名前（JS 定数は COUNTER_*）
    index: int         # weightsArray の添字（-1=カウンター発動量 / -2=カウンター倍率）
    lo: float
    hi: float
    integer: bool = True


SPACE: list[Param] = [
    # ── 評価（evalWeights）──
    Param("heightPenalty",       2,   -60,    0),
    Param("heightDiffPenalty",   3,   -60,    0),
    Param("shapeWeight",        10,   -60,    0),
    Param("wellWeight",         11,   -60,    0),
    Param("bumpWeight",         12, -1500,    0),
    Param("qYWeight",           14,     0,  400),
    Param("qKeyWeight",         15,  -300,    0),
    Param("qChiWeight",         16,     0,  150),
    Param("link2Weight",        17,     0,   60),
    Param("link3Weight",        18,     0,  120),
    Param("formWeight",         21,     0,  300),
    Param("qLink2Weight",       25,     0,   60),
    Param("qLink3Weight",       26,     0,  120),
    Param("sideWeight",         27,   -50,   50),
    Param("tearWeight",         28,  -200,    0),
    Param("wasteWeight",        31,   -30,    0),
    Param("link3FacL",          38,     0,  200),
    Param("link3FacH",          39,     0,  200),
    Param("link3FacV",          40,     0,  200),
    Param("qExcessWeight",      43,  -400,    0),   # 提案3 E1：潜在連鎖の途中段の余剰（2026-10-16 追加）
    Param("qJunkWeight",        44,  -200,    0),   # 提案3 E2a：ゴミ×埋まり具合（2026-10-16 追加）
    Param("qSubWeight",         45,     0,  400),   # 提案3 E2b：副砲のおじゃま量（§10.4 で 0〜400 に拡大）
    Param("subMinFill",         53,     0,   60),   # G2：副砲を評価する盤面の色ぷよ数の下限（2026-10-18 追加）
    # ── 制御（controlWeights）──
    Param("emergencyHeight",         8,     8,     12),
    Param("expChainWeight",         19,     0,  10000),
    Param("pruneChainScore",        29,     0,  20000),
    Param("fireChainCount",         32,     6,     15),
    Param("fireScoreThreshold",     34, 10000, 200000),
    Param("growthFireForbidChains", 35,     0,      4),
    Param("emergencyFireMinRatio",  36,     0,    100),
    Param("emergencyHardCol2",      37,     8,     12),
    # ── VERSUS カウンター（cpu5_worker_io.js の定数）──
    Param("COUNTER_TRIGGER_OJAMA_VSPUYO", -1,   1,   20),
    Param("COUNTER_MARGIN_VSPUYO",        -2, 0.6,  2.0, integer=False),
]
DIM = len(SPACE)
SPACE_FULL = list(SPACE)

# 学習次元を絞った探索空間（§13.7。これまでの学習でほとんど動かなかった重みを外し、外した重みは初期値のまま固定）。
#   名前は SPACE の名前。train.py --space で選ぶ（args.json に残るので --resume・validate も同じ空間になる）。
SPACES: dict[str, list[str]] = {
    # v3（2026-10-19）：33次元 → 15次元。build-001〜lv6-g-001 の5回の学習で値がほぼ動かなかった、または端に張り付いた
    #   重み（高さ・形・side・tear・waste・link2・emergency 系・fireChainCount・growthFireForbid・カウンター発動量・
    #   link3FacH・qY・form・subMinFill など）を外して初期値（lv6s）に固定する。§13 の P・T も固定（A/B で値を決めた）。
    "v3": ["bumpWeight", "qChiWeight", "qKeyWeight", "link3Weight", "qLink2Weight", "qLink3Weight",
           "link3FacL", "link3FacV", "qExcessWeight", "qJunkWeight", "qSubWeight",
           "expChainWeight", "pruneChainScore", "fireScoreThreshold", "COUNTER_MARGIN_VSPUYO"],
}


def use_space(name: str) -> None:
    """探索空間を切り替える（encode/decode/describe と DIM がこれに従う）。"full"＝SPACE 全部。"""
    global SPACE, DIM
    if name in ("", "full", None):
        SPACE = list(SPACE_FULL)
    else:
        by = {p.name: p for p in SPACE_FULL + FIXED_NAMED}
        SPACE = [by[n] for n in SPACES[name]]
    DIM = len(SPACE)

# 学習しない（固定する）が、名前で初期値・相手を書き換えたいもの（--init-set・相手プールの set）。
#   催促・対応 H1/H2 と本線条件 G1 は §10.4 で固定値にした（lv6-harass-design.md）。
FIXED_NAMED: list[Param] = [
    Param("harassMinOjama",         46,     0,     30),   # 0＝催促しない
    Param("harassMaxChains",        47,     1,      5),
    Param("harassKeepPct",          48,     0,    100),
    Param("counterKeepReach",       49,     0,      3),   # H2 0..3
    Param("harassMinReach",         50,     0,    900),   # 撃った後に残す本線（個）
    Param("subMinMainChains",       51,     0,     19),   # G1：副砲・催促の本線段数の下限
    Param("subMinMainPuyos",        52,     0,     72),   # G1：副砲の本線色ぷよ数の下限
    Param("qKeepWeight",            54,   -20,     20),   # 提案5 K 発火点の保全（§13.4。効かず既定0で固定）
    Param("qKeepDepth",             55,     0,      8),
    Param("counterTerrainMax",      58,     0,     29),   # T 地形優先の対応：この受け量以下は fast に入らない（§13.5）
    Param("p1Alpha",                61,     0,    300),   # P 相手を見て撃つ：目標発火の相手比（%。§13.6）
]
NAMED = {p.name: p for p in SPACE_FULL + FIXED_NAMED}


def check_indices(baseline: dict) -> None:
    """名前と添字の対応が本番 JS とずれていないか（weightsArray の並びが変わったら落とす）。"""
    named = baseline["buildNamed"]
    for p in SPACE_FULL + FIXED_NAMED:
        if p.index >= 0 and p.name in named and p.index not in (46, 49, 50, 61):   # 46/49/50/61 は思考ごとの入力（export が保存値で上書き）。57/59/60 も思考ごと（名前なし）
            assert named[p.name] == baseline["build"][p.index], f"{p.name} の添字 {p.index} が本番とずれている"


def get_value(policy: Policy, p: Param) -> float:
    if p.index == -1:
        return policy.counter_trigger
    if p.index == -2:
        return policy.counter_margin
    return policy.build[p.index]


def encode(policy: Policy) -> np.ndarray:
    x = np.empty(DIM)
    for i, p in enumerate(SPACE):
        x[i] = (get_value(policy, p) - p.lo) / (p.hi - p.lo)
    return x


def decode(x: np.ndarray, base: Policy) -> Policy:
    """正規化座標 → Policy（範囲外は端に丸める）。"""
    x = np.clip(np.asarray(x, dtype=float), 0.0, 1.0)
    pol = Policy(list(base.build), list(base.fast), base.counter_trigger, base.counter_margin, list(base.ext))
    for i, p in enumerate(SPACE):
        v = p.lo + x[i] * (p.hi - p.lo)
        if p.integer:
            v = int(round(v))
        if p.index == -1:
            pol.counter_trigger = int(v)
        elif p.index == -2:
            pol.counter_margin = round(float(v), 3)
        else:
            pol.build[p.index] = int(v)
    return pol


def describe(policy: Policy, base: Policy | None = None) -> dict:
    """名前付きの値（base を渡すと変化したものだけ）。"""
    out = {}
    for p in SPACE:
        v = get_value(policy, p)
        if base is None or v != get_value(base, p):
            out[p.name] = v if base is None else {"from": get_value(base, p), "to": v}
    return out
