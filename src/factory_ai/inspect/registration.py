"""Scan-to-CAD registration (trimmed point-to-plane ICP).

The part sits in the fixture with a small unknown pose error. ICP finds the
rigid transform that best lays the scan onto the CAD reference. Trimming the
worst correspondences each iteration keeps real defects from dragging the fit.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree


@dataclass
class Registration:
    rotation: np.ndarray
    translation: np.ndarray
    rmse: float
    iterations: int

    def apply(self, pts: np.ndarray) -> np.ndarray:
        return pts @ self.rotation.T + self.translation


def kabsch(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Least-squares rigid transform (R, t) with R @ src + t ~= dst."""
    cs, cd = src.mean(axis=0), dst.mean(axis=0)
    U, _, Vt = np.linalg.svd((src - cs).T @ (dst - cd))
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    return R, cd - R @ cs


def _rotvec_to_matrix(w: np.ndarray) -> np.ndarray:
    a = np.linalg.norm(w)
    if a < 1e-12:
        return np.eye(3)
    k = w / a
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K


def icp(
    src: np.ndarray,
    ref_points: np.ndarray,
    ref_normals: np.ndarray,
    ref_tree: cKDTree,
    max_iter: int = 40,
    trim_factor: float = 3.0,
    min_trim_mm: float = 0.3,
    tol: float = 1e-7,
) -> Registration:
    R, t = np.eye(3), ref_points.mean(axis=0) - src.mean(axis=0)
    # Coarse start: the scan misses the part bottom, so only centre x and y.
    t[2] = 0.0
    prev = np.inf
    for it in range(1, max_iter + 1):
        moved = src @ R.T + t
        d, idx = ref_tree.query(moved)
        keep = d < max(trim_factor * np.median(d), min_trim_mm) if it > 2 else np.ones(len(d), bool)
        p, q, n = moved[keep], ref_points[idx[keep]], ref_normals[idx[keep]]
        if it <= 3:  # point-to-point for robustness while far away
            dR, dt = kabsch(p, q)
        else:  # point-to-plane for fast convergence on flat faces
            A = np.hstack([np.cross(p, n), n])
            b = np.einsum("ij,ij->i", q - p, n)
            x, *_ = np.linalg.lstsq(A, b, rcond=None)
            dR, dt = _rotvec_to_matrix(x[:3]), x[3:]
        R, t = dR @ R, dR @ t + dt
        err = float(np.sqrt(np.mean(np.einsum("ij,ij->i", q - p, n) ** 2)))
        if abs(prev - err) < tol:
            break
        prev = err
    return Registration(R, t, err, it)
