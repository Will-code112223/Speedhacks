"""Simulated 3D scanner station.

Models what a structured-light scanner over a fixture actually returns:

* only surfaces facing one of the scanner views (the bottom sits on the fixture)
* the part is placed with a small, unknown pose error
* depth noise and dropped points

Domain randomization means training with a *range* of these settings so a
model built on synthetic scans still works on the shop's real scanner.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .defects import PartInstance


def _views(tilt_deg: float) -> np.ndarray:
    s, c = np.sin(np.radians(tilt_deg)), np.cos(np.radians(tilt_deg))
    return np.array([[0, 0, -1], [s, 0, -c], [-s, 0, -c], [0, s, -c], [0, -s, -c]], dtype=float)


@dataclass(frozen=True)
class ScannerConfig:
    noise_mm: float = 0.03
    dropout: float = 0.02
    tilt_deg: float = 35.0
    min_incidence_cos: float = 0.15
    pose_jitter_deg: float = 3.0
    pose_jitter_mm: float = 2.0

    def randomized(self, rng: np.random.Generator) -> "ScannerConfig":
        """Domain randomization: perturb the sensor model for each training scan."""
        return ScannerConfig(
            noise_mm=self.noise_mm * rng.uniform(0.6, 1.8),
            dropout=min(0.3, self.dropout * rng.uniform(0.5, 3.0)),
            tilt_deg=self.tilt_deg + rng.uniform(-8, 8),
            min_incidence_cos=self.min_incidence_cos,
            pose_jitter_deg=self.pose_jitter_deg,
            pose_jitter_mm=self.pose_jitter_mm,
        )


@dataclass
class Scan:
    points: np.ndarray  # scanner frame
    labels: np.ndarray  # ground truth, per point (synthetic data only)
    rotation: np.ndarray  # true part -> scanner pose (unknown to the inspector)
    translation: np.ndarray
    part_number: str
    defects: list


def _random_rotation(max_deg: float, rng: np.random.Generator) -> np.ndarray:
    axis = rng.normal(size=3)
    axis /= np.linalg.norm(axis)
    a = np.radians(rng.uniform(-max_deg, max_deg))
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K


def simulate_scan(inst: PartInstance, cfg: ScannerConfig, rng: np.random.Generator) -> Scan:
    views = _views(cfg.tilt_deg)
    visible = (inst.normals @ (-views.T) > cfg.min_incidence_cos).any(axis=1)
    visible &= rng.random(len(visible)) > cfg.dropout
    pts, lab = inst.points[visible], inst.labels[visible]

    R = _random_rotation(cfg.pose_jitter_deg, rng)
    t = rng.uniform(-cfg.pose_jitter_mm, cfg.pose_jitter_mm, 3)
    pts = pts @ R.T + t + rng.normal(scale=cfg.noise_mm, size=pts.shape)
    return Scan(pts, lab, R, t, inst.part_number, list(inst.defects))
