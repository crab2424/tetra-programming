"""最小構成の CMA-ES（(μ/μ_w, λ)、rank-1 + rank-μ 更新）。numpy のみで動く。

Hansen, "The CMA Evolution Strategy: A Tutorial" (2016) の標準パラメータに従う。
最小化問題として扱う（呼び出し側は fitness = -勝率 を渡す）。状態は to_dict/from_dict で JSON 保存できる。
"""
from __future__ import annotations

import numpy as np


class CMAES:
    def __init__(self, x0, sigma0: float, popsize: int | None = None, seed: int = 0):
        self.n = n = len(x0)
        self.lam = popsize or 4 + int(3 * np.log(n))
        self.mu = self.lam // 2
        w = np.log(self.mu + 0.5) - np.log(np.arange(1, self.mu + 1))
        self.weights = w / w.sum()
        self.mueff = 1.0 / np.sum(self.weights ** 2)
        self.cc = (4 + self.mueff / n) / (n + 4 + 2 * self.mueff / n)
        self.cs = (self.mueff + 2) / (n + self.mueff + 5)
        self.c1 = 2 / ((n + 1.3) ** 2 + self.mueff)
        self.cmu = min(1 - self.c1, 2 * (self.mueff - 2 + 1 / self.mueff) / ((n + 2) ** 2 + self.mueff))
        self.damps = 1 + 2 * max(0.0, np.sqrt((self.mueff - 1) / (n + 1)) - 1) + self.cs
        self.chiN = np.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n))

        self.mean = np.array(x0, dtype=float)
        self.sigma = float(sigma0)
        self.pc = np.zeros(n)
        self.ps = np.zeros(n)
        self.C = np.eye(n)
        self.gen = 0
        self.rng = np.random.default_rng(seed)
        self._eig()

    def _eig(self):
        self.C = np.triu(self.C) + np.triu(self.C, 1).T
        d, self.B = np.linalg.eigh(self.C)
        self.D = np.sqrt(np.maximum(d, 1e-20))
        self.invsqrtC = self.B @ np.diag(1 / self.D) @ self.B.T

    def ask(self) -> np.ndarray:
        z = self.rng.standard_normal((self.lam, self.n))
        return self.mean + self.sigma * (z * self.D) @ self.B.T

    def tell(self, xs: np.ndarray, fit: np.ndarray) -> None:
        xs = np.asarray(xs)
        order = np.argsort(fit)
        sel = xs[order[: self.mu]]
        old = self.mean
        self.mean = self.weights @ sel
        y = (self.mean - old) / self.sigma
        self.ps = (1 - self.cs) * self.ps + np.sqrt(self.cs * (2 - self.cs) * self.mueff) * (self.invsqrtC @ y)
        self.gen += 1
        hsig = (np.linalg.norm(self.ps) / np.sqrt(1 - (1 - self.cs) ** (2 * self.gen)) / self.chiN
                < 1.4 + 2 / (self.n + 1))
        self.pc = (1 - self.cc) * self.pc + hsig * np.sqrt(self.cc * (2 - self.cc) * self.mueff) * y
        artmp = (sel - old) / self.sigma
        self.C = ((1 - self.c1 - self.cmu) * self.C
                  + self.c1 * (np.outer(self.pc, self.pc) + (1 - hsig) * self.cc * (2 - self.cc) * self.C)
                  + self.cmu * artmp.T @ np.diag(self.weights) @ artmp)
        self.sigma *= np.exp((self.cs / self.damps) * (np.linalg.norm(self.ps) / self.chiN - 1))
        self._eig()

    # ── 保存 / 再開 ──
    def to_dict(self) -> dict:
        return {"n": self.n, "lam": self.lam, "mean": self.mean.tolist(), "sigma": self.sigma,
                "pc": self.pc.tolist(), "ps": self.ps.tolist(), "C": self.C.tolist(), "gen": self.gen,
                "rng": self.rng.bit_generator.state}

    @classmethod
    def from_dict(cls, d: dict) -> "CMAES":
        es = cls(d["mean"], d["sigma"], d["lam"])
        es.pc = np.array(d["pc"])
        es.ps = np.array(d["ps"])
        es.C = np.array(d["C"])
        es.gen = d["gen"]
        es.rng.bit_generator.state = d["rng"]
        es._eig()
        return es
