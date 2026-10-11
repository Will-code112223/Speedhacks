"""Generate a labeled synthetic training set from CAD alone."""

from __future__ import annotations

import numpy as np

from .defects import DEFECT_TYPES, make_instance
from .scanner import Scan, ScannerConfig, simulate_scan


def generate_scans(
    part,
    n_scans: int,
    rng: np.random.Generator,
    scanner: ScannerConfig = ScannerConfig(),
    good_fraction: float = 0.4,
    n_points: int = 40000,
    randomize: bool = True,
) -> list[Scan]:
    """Synthetic scans of ``part``: a mix of good parts and parts with 1-2 defects."""
    kinds = [k for k in DEFECT_TYPES if part.holes or k != "missing_hole"]
    scans = []
    for i in range(n_scans):
        if rng.random() < good_fraction:
            defects: list[str] = []
        else:
            k = 2 if rng.random() < 0.15 else 1
            defects = list(rng.choice(kinds, size=k, replace=False))
        inst = make_instance(part, n_points, rng, defects)
        cfg = scanner.randomized(rng) if randomize else scanner
        scans.append(simulate_scan(inst, cfg, rng))
    return scans
