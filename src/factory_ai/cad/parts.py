"""Procedural CAD parts.

A bespoke shop rarely has a dataset, but it always has CAD. Everything in the
pipeline starts from a part that can be *sampled*: we draw points and surface
normals from its true geometry, then use those samples as the reference for
scanning, defect injection and inspection.

``PlatePart`` is a parametric machined plate (a bracket, flange or mounting
plate) with through-holes. Real customer geometry comes in through
``factory_ai.cad.io.MeshPart`` (STL), which exposes the same interface.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Face ids used across the pipeline.
FACE_TOP, FACE_BOTTOM, FACE_SIDE, FACE_HOLE = 0, 1, 2, 3


@dataclass(frozen=True)
class Hole:
    x: float
    y: float
    r: float


@dataclass(frozen=True)
class SurfaceSample:
    """Points on a part surface with outward normals and the face each came from."""

    points: np.ndarray  # (n, 3) mm
    normals: np.ndarray  # (n, 3) unit, pointing out of the material
    face: np.ndarray  # (n,) face id
    hole: np.ndarray  # (n,) hole index for hole-wall points, else -1


@dataclass(frozen=True)
class PlatePart:
    """A rectangular plate centred on the origin, with vertical through-holes."""

    part_number: str
    length: float  # x extent, mm
    width: float  # y extent, mm
    thickness: float  # z extent, mm
    holes: tuple[Hole, ...] = field(default_factory=tuple)
    tolerance_mm: float = 0.25
    material: str = "6061 aluminum"

    @property
    def diagonal(self) -> float:
        return float(np.sqrt(self.length**2 + self.width**2 + self.thickness**2))

    def _in_hole(self, xy: np.ndarray) -> np.ndarray:
        inside = np.zeros(len(xy), dtype=bool)
        for h in self.holes:
            inside |= (xy[:, 0] - h.x) ** 2 + (xy[:, 1] - h.y) ** 2 < h.r**2
        return inside

    def _face_areas(self) -> dict[str, float]:
        L, W, T = self.length, self.width, self.thickness
        cap = L * W - sum(np.pi * h.r**2 for h in self.holes)
        areas = {"top": cap, "bottom": cap, "side_x": 2 * W * T, "side_y": 2 * L * T}
        for i, h in enumerate(self.holes):
            areas[f"hole{i}"] = 2 * np.pi * h.r * T
        return areas

    def sample(self, n: int, rng: np.random.Generator) -> SurfaceSample:
        """Area-weighted uniform sample of ``n`` points on the part surface."""
        L, W, T = self.length, self.width, self.thickness
        areas = self._face_areas()
        names = list(areas)
        weights = np.array([areas[k] for k in names])
        counts = rng.multinomial(n, weights / weights.sum())

        pts, nrm, face, hole = [], [], [], []

        def add(p, nv, f, h=-1):
            pts.append(p)
            nrm.append(np.broadcast_to(nv, p.shape) if np.ndim(nv) == 1 else nv)
            face.append(np.full(len(p), f))
            hole.append(np.full(len(p), h))

        for name, k in zip(names, counts):
            if k == 0:
                continue
            if name in ("top", "bottom"):
                xy = np.empty((0, 2))
                while len(xy) < k:  # rejection-sample the cap around the holes
                    cand = rng.uniform([-L / 2, -W / 2], [L / 2, W / 2], size=(2 * k, 2))
                    xy = np.vstack([xy, cand[~self._in_hole(cand)]])
                xy = xy[:k]
                z = T / 2 if name == "top" else -T / 2
                p = np.column_stack([xy, np.full(k, z)])
                add(p, np.array([0, 0, 1.0 if name == "top" else -1.0]), FACE_TOP if name == "top" else FACE_BOTTOM)
            elif name == "side_x":  # the two faces at x = +/- L/2
                s = rng.choice([-1.0, 1.0], size=k)
                p = np.column_stack([s * L / 2, rng.uniform(-W / 2, W / 2, k), rng.uniform(-T / 2, T / 2, k)])
                add(p, np.column_stack([s, np.zeros(k), np.zeros(k)]), FACE_SIDE)
            elif name == "side_y":
                s = rng.choice([-1.0, 1.0], size=k)
                p = np.column_stack([rng.uniform(-L / 2, L / 2, k), s * W / 2, rng.uniform(-T / 2, T / 2, k)])
                add(p, np.column_stack([np.zeros(k), s, np.zeros(k)]), FACE_SIDE)
            else:  # hole wall; the outward normal points toward the hole axis
                i = int(name[4:])
                h = self.holes[i]
                th = rng.uniform(0, 2 * np.pi, k)
                p = np.column_stack([h.x + h.r * np.cos(th), h.y + h.r * np.sin(th), rng.uniform(-T / 2, T / 2, k)])
                add(p, np.column_stack([-np.cos(th), -np.sin(th), np.zeros(k)]), FACE_HOLE, i)

        return SurfaceSample(
            points=np.vstack(pts),
            normals=np.vstack(nrm).astype(float),
            face=np.concatenate(face).astype(int),
            hole=np.concatenate(hole).astype(int),
        )


def catalog() -> dict[str, PlatePart]:
    """A small, high-mix catalog of part numbers like a job shop would run."""
    parts = [
        PlatePart(
            "BRK-1042",
            length=120,
            width=60,
            thickness=8,
            holes=(Hole(-45, -18, 4), Hole(-45, 18, 4), Hole(45, -18, 4), Hole(45, 18, 4)),
        ),
        PlatePart(
            "PLT-2201",
            length=160,
            width=100,
            thickness=10,
            holes=tuple(Hole(x, y, 5) for x in (-60, 0, 60) for y in (-35, 35)),
        ),
        PlatePart(
            "FLG-0310",
            length=80,
            width=80,
            thickness=6,
            holes=(Hole(0, 0, 14), Hole(-28, -28, 3), Hole(-28, 28, 3), Hole(28, -28, 3), Hole(28, 28, 3)),
            tolerance_mm=0.2,
        ),
    ]
    return {p.part_number: p for p in parts}
