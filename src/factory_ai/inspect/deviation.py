"""Deviation from CAD: how far each scanned point sits off the nominal surface."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree
from sklearn.cluster import DBSCAN


@dataclass
class Reference:
    """A dense, indexed sample of the CAD surface used as ground truth geometry."""

    part: object
    points: np.ndarray
    normals: np.ndarray
    tree: cKDTree
    spacing: float

    @classmethod
    def build(cls, part, n_points: int = 80000, seed: int = 0) -> "Reference":
        s = part.sample(n_points, np.random.default_rng(seed))
        tree = cKDTree(s.points)
        probe = s.points[np.random.default_rng(seed + 1).choice(len(s.points), 2000, replace=False)]
        spacing = float(np.median(tree.query(probe, k=2)[0][:, 1]))
        return cls(part, s.points, s.normals, tree, spacing)

    def signed_deviation(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Signed distance to the CAD surface (+ = extra material, - = missing material).

        Returns (deviation, nearest-reference index, off_surface mask). A point is
        "off surface" when it does not sit over any CAD face at all, e.g. material
        filling a hole that should have been drilled.
        """
        # Near edges the closest reference point can sit on the neighbouring face.
        # Among the k nearest candidates, keep the face the point actually lies on
        # (smallest point-to-plane distance) unless that candidate is much farther away.
        dk, ik = self.tree.query(pts, k=8)
        vk = pts[:, None, :] - self.points[ik]
        nk = np.einsum("ijk,ijk->ij", vk, self.normals[ik])
        cost = np.abs(nk) + np.where(dk > dk[:, :1] + 0.5, np.inf, 0.0)
        best = cost.argmin(axis=1)
        rows = np.arange(len(pts))
        d, idx, normal = dk[rows, best], ik[rows, best], nk[rows, best]
        tangential = np.sqrt(np.maximum(d**2 - normal**2, 0.0))
        # Random sampling leaves small gaps in the reference; only call a point
        # "off surface" when it is well beyond any such gap.
        off = tangential > max(5.0 * self.spacing, 4.0 * self.part.tolerance_mm)
        sign = np.where(normal >= 0, 1.0, -1.0)
        return np.where(off, sign * d, normal), idx, off


def find_regions(pts: np.ndarray, dev: np.ndarray, tolerance: float, eps_mm: float = 2.5, min_points: int = 5) -> list[np.ndarray]:
    """Cluster out-of-tolerance points into candidate defect regions."""
    bad = np.flatnonzero(np.abs(dev) > tolerance)
    if len(bad) < min_points:
        return []
    lab = DBSCAN(eps=eps_mm, min_samples=min_points).fit_predict(pts[bad])
    return [bad[lab == k] for k in sorted(set(lab) - {-1})]
