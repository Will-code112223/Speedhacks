"""The Monitor module: is this machine cutting the way it did yesterday?

Every run of a CNC program has a spindle-load signature. The module learns the
normal signature for each part number from the first cycles, then scores every
new cycle against it. An EWMA control chart turns noisy per-cycle scores into a
drift alert (tool wear, a changed feed rate, a skipped operation).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# A CNC program as (operation, samples, nominal spindle load fraction).
BRK_1042_PROGRAM = (
    ("rapid", 10, 0.05),
    ("face mill", 40, 0.35),
    ("rough pocket", 70, 0.60),
    ("rapid", 5, 0.05),
    ("drill 1", 15, 0.45),
    ("rapid", 5, 0.05),
    ("drill 2", 15, 0.45),
    ("rapid", 5, 0.05),
    ("drill 3", 15, 0.45),
    ("rapid", 5, 0.05),
    ("drill 4", 15, 0.45),
    ("finish contour", 40, 0.30),
)


def simulate_cycle(
    program=BRK_1042_PROGRAM,
    tool_wear: float = 0.0,
    skip_ops: tuple[str, ...] = (),
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """Spindle load trace for one cycle. Wear raises cutting load and adds chatter."""
    rng = rng or np.random.default_rng()
    trace = []
    for op, n, load in program:
        if op in skip_ops:
            seg = np.full(n, 0.05)  # spindle runs but nothing is cut
        else:
            cutting = load > 0.1
            seg = np.full(n, load * (1 + 0.35 * tool_wear if cutting else 1.0))
            if cutting and tool_wear > 0.6:
                seg += 0.08 * (tool_wear - 0.6) * np.sin(np.arange(n) * 2.1)
        trace.append(seg)
    x = np.concatenate(trace)
    return x + rng.normal(scale=0.015, size=len(x))


@dataclass
class DriftMonitor:
    lam: float = 0.2  # EWMA smoothing
    k_sigma: float = 5.0
    single_cycle_limit: float = 10.0  # z below which a stretch of samples counts as a skipped operation
    mean: np.ndarray | None = None
    std: np.ndarray | None = None
    ewma: float = 1.0
    ucl: float = np.inf
    history: list = field(default_factory=list)

    def fit_baseline(self, cycles: list[np.ndarray]) -> "DriftMonitor":
        X = np.array(cycles)
        self.mean, self.std = X.mean(axis=0), np.maximum(X.std(axis=0), 0.01)
        scores = np.array([self._score(c) for c in cycles])
        self.ewma = float(scores.mean())
        # Steady-state EWMA standard deviation.
        sd = scores.std() * np.sqrt(self.lam / (2 - self.lam))
        self.ucl = float(scores.mean() + self.k_sigma * sd)
        return self

    def _score(self, cycle: np.ndarray) -> float:
        return float(np.mean(((cycle - self.mean) / self.std) ** 2))

    def update(self, cycle: np.ndarray) -> dict:
        s = self._score(cycle)
        z = (cycle - self.mean) / self.std
        window = np.convolve(z, np.ones(10) / 10, "same")
        # An operation that cut nothing: load far *below* normal over a stretch of samples.
        missing_op = bool(window.min() < -self.single_cycle_limit)
        if not missing_op:  # a one-off event is its own alert, not gradual drift
            self.ewma = self.lam * s + (1 - self.lam) * self.ewma
        worst = np.argmin(window) if missing_op else np.argmax(np.abs(window))
        out = {
            "score": s,
            "ewma": self.ewma,
            "drift_alert": self.ewma > self.ucl,
            "cycle_alert": missing_op,
            "worst_sample": int(worst),
        }
        self.history.append(out)
        return out


def operation_at(sample: int, program=BRK_1042_PROGRAM) -> str:
    i = 0
    for op, n, _ in program:
        if sample < i + n:
            return op
        i += n
    return program[-1][0]
