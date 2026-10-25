"""学習相手のプール（opponents/*.json）の読み込みと、シードの割り当て。

    {"members": [{"name", "base": "lv5|lv6|lv6h|lv6g", "set": {名前: 値}, "weight",
                  "perturb": {"sigma", "count"}}]}

  ・set は params.NAMED（SPACE＋FIXED_NAMED）の名前で base を上書きする（fast・ext は base のまま）
  ・perturb を持つメンバーは、base の重みに正規化座標で σ の雑音を足した count 体に展開する（weight は等分）
  ・シードは重みの比率で相手に割り当てる。全候補で同じ割り当て（共通乱数）
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

import params as P
import puyosim as ps


@dataclass
class Opponent:
    name: str
    weight: float
    packed: np.ndarray


def _apply_set(pol: ps.Policy, items: dict) -> ps.Policy:
    by_name = P.NAMED
    for k, v in items.items():
        p = by_name[k]
        if p.index == -1:
            pol.counter_trigger = int(v)
        elif p.index == -2:
            pol.counter_margin = float(v)
        else:
            pol.build[p.index] = int(v)
    return pol


def build_pool(spec: dict, base_json: dict, named_policy, rng: np.random.Generator) -> list[Opponent]:
    """プール定義 → 相手の一覧。perturb の雑音は rng から引く（同じ rng なら同じ相手）。"""
    out: list[Opponent] = []
    for m in spec["members"]:
        base = _apply_set(named_policy(m["base"], base_json), m.get("set", {}))
        w = float(m.get("weight", 1.0))
        pt = m.get("perturb")
        if not pt:
            out.append(Opponent(m["name"], w, base.packed()))
            continue
        n = int(pt.get("count", 1))
        x0 = P.encode(base)
        for i in range(n):
            x = np.clip(x0 + rng.normal(0.0, float(pt["sigma"]), size=x0.shape), 0.0, 1.0)
            out.append(Opponent(f"{m['name']}{i + 1}", w / n, P.decode(x, base).packed()))
    return out


def load_pool_spec(path: str | Path) -> dict:
    return json.loads(Path(path).read_text())


def assign_seeds(weights: np.ndarray, n_seeds: int) -> np.ndarray:
    """シード列の各位置を相手の添字に割り当てる（最大剰余法。重みが0でない相手は最低1シード）。"""
    w = np.asarray(weights, dtype=float)
    w = w / w.sum()
    raw = w * n_seeds
    cnt = np.floor(raw).astype(int)
    cnt = np.where((w > 0) & (cnt == 0), 1, cnt)
    while cnt.sum() < n_seeds:
        cnt[np.argmax(raw - cnt)] += 1
    while cnt.sum() > n_seeds:
        cnt[np.argmax(np.where(cnt > 1, cnt - raw, -np.inf))] -= 1
    return np.repeat(np.arange(len(w)), cnt)


def evaluate_pool(cands: np.ndarray, opps: list[Opponent], seeds: np.ndarray, settings: ps.Settings,
                  threads: int) -> tuple[np.ndarray, np.ndarray]:
    """候補 (nCand, PP_LEN) の重み付き勝率 (nCand,) と、相手ごとの勝率 (nCand, nOpp)。"""
    ow = np.array([o.weight for o in opps])
    oi = assign_seeds(ow, len(seeds))
    score = ps.play_vs_pool(cands, np.stack([o.packed for o in opps]), oi, seeds, settings, threads)
    per_opp = np.stack([score[:, oi == k].mean(axis=1) if (oi == k).any() else np.full(len(score), np.nan)
                        for k in range(len(opps))], axis=1)
    # 割り当てた実際のシード数で重み付け（丸めたぶん）
    return score.mean(axis=1), per_opp


def robust_score(per_opp: np.ndarray, mean_wr: float, lam: float) -> float:
    """選抜用：平均勝率 − λ×(最悪の相手に対する負け越し)。相手が1体なら平均のまま。"""
    if per_opp.shape[-1] <= 1 or lam <= 0:
        return mean_wr
    return float(mean_wr - lam * max(0.0, 0.5 - np.nanmin(per_opp)))
