"""Load customer CAD exported as STL and sample it like a PlatePart.

STEP is what customers actually send. Tessellating STEP needs OpenCascade
(``pythonocc-core``/``cadquery``), which is heavy, so the demo accepts STL and
the roadmap adds a STEP -> STL step in the CAD-ingest service.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .parts import FACE_SIDE, FACE_TOP, SurfaceSample


def load_stl(path: str | Path) -> np.ndarray:
    """Return triangles as an (n, 3, 3) array. Handles binary and ASCII STL."""
    data = Path(path).read_bytes()
    if len(data) >= 84:
        n = struct.unpack("<I", data[80:84])[0]
        if 84 + 50 * n == len(data):  # binary
            rec = np.frombuffer(data[84:], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
            return rec["v"].astype(float)
    verts = [
        [float(t) for t in line.split()[1:4]]
        for line in data.decode("utf-8", errors="ignore").splitlines()
        if line.strip().startswith("vertex")
    ]
    if not verts or len(verts) % 3:
        raise ValueError(f"{path}: not a valid STL file")
    return np.asarray(verts).reshape(-1, 3, 3)


def write_stl(path: str | Path, triangles: np.ndarray) -> None:
    """Write triangles to a binary STL (used by tests and for exporting parts)."""
    tri = np.asarray(triangles, dtype="<f4")
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-12
    with open(path, "wb") as f:
        f.write(b"factory_ai".ljust(80, b"\0"))
        f.write(struct.pack("<I", len(tri)))
        for n_, t in zip(nrm.astype("<f4"), tri):
            f.write(n_.tobytes() + t.tobytes() + b"\0\0")


@dataclass(frozen=True)
class MeshPart:
    """A part defined by a triangle mesh, e.g. an STL exported from CAD."""

    part_number: str
    triangles: np.ndarray
    tolerance_mm: float = 0.25

    @classmethod
    def from_stl(cls, path: str | Path, part_number: str | None = None, tolerance_mm: float = 0.25) -> "MeshPart":
        tri = load_stl(path)
        tri = tri - tri.reshape(-1, 3).mean(axis=0)  # centre on the origin like PlatePart
        return cls(part_number or Path(path).stem, tri, tolerance_mm)

    @property
    def holes(self) -> tuple:
        return ()

    @property
    def diagonal(self) -> float:
        v = self.triangles.reshape(-1, 3)
        return float(np.linalg.norm(v.max(axis=0) - v.min(axis=0)))

    def sample(self, n: int, rng: np.random.Generator) -> SurfaceSample:
        a, b, c = self.triangles[:, 0], self.triangles[:, 1], self.triangles[:, 2]
        cross = np.cross(b - a, c - a)
        area = 0.5 * np.linalg.norm(cross, axis=1)
        idx = rng.choice(len(area), size=n, p=area / area.sum())
        u, v = rng.random(n), rng.random(n)
        flip = u + v > 1
        u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
        pts = a[idx] + u[:, None] * (b - a)[idx] + v[:, None] * (c - a)[idx]
        nrm = cross[idx] / (np.linalg.norm(cross[idx], axis=1, keepdims=True) + 1e-12)
        face = np.where(nrm[:, 2] > 0.7, FACE_TOP, FACE_SIDE)
        return SurfaceSample(pts, nrm, face, np.full(n, -1))
