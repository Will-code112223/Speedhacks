"""Procedural defect injection.

Defects are applied to a surface sample in the part's own frame, so every
synthetic scan arrives with an exact per-point label. That replaces the months
of waiting for real defects and hand-labeling them.

Defect types modelled for machined parts:

* ``dent``         handling damage on a face (material pushed in)
* ``burr``         raised material on a hole rim or edge, typical of a worn tool
* ``missing_hole`` a skipped drilling operation
* ``warp``         the plate bows after clamping stress is released
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..cad.parts import FACE_BOTTOM, FACE_SIDE, FACE_TOP, SurfaceSample

DEFECT_TYPES = ("dent", "burr", "missing_hole", "warp")
LABELS = {"good": 0, "dent": 1, "burr": 2, "missing_hole": 3, "warp": 4}
LABEL_NAMES = {v: k for k, v in LABELS.items()}


@dataclass
class Defect:
    kind: str
    center: tuple[float, float, float]
    size_mm: float  # radius of the affected area
    magnitude_mm: float  # depth / height / bow amplitude


@dataclass
class PartInstance:
    """One physical part: its surface, per-point labels and the defects it carries."""

    part_number: str
    points: np.ndarray
    normals: np.ndarray
    face: np.ndarray
    labels: np.ndarray
    defects: list[Defect] = field(default_factory=list)

    @property
    def is_good(self) -> bool:
        return not self.defects


def _bump(inst: PartInstance, center: np.ndarray, radius: float, height: float, label: int) -> None:
    """Displace points along their normals with a Gaussian profile (height < 0 = dent)."""
    d = np.linalg.norm(inst.points - center, axis=1)
    g = np.exp(-0.5 * (d / (radius / 2.0)) ** 2)
    inst.points = inst.points + (height * g)[:, None] * inst.normals
    hit = g > 0.2
    inst.labels[hit & (inst.labels == 0)] = label


def inject_dent(inst: PartInstance, part, rng: np.random.Generator) -> Defect:
    top = np.flatnonzero(inst.face == FACE_TOP)
    center = inst.points[rng.choice(top)]
    radius, depth = rng.uniform(3.0, 7.0), rng.uniform(0.5, 1.2)
    _bump(inst, center, radius, -depth, LABELS["dent"])
    return Defect("dent", tuple(center), radius, depth)


def inject_burr(inst: PartInstance, part, rng: np.random.Generator) -> Defect:
    radius, height = rng.uniform(1.5, 2.5), rng.uniform(0.4, 0.9)
    z_top = inst.points[:, 2].max()
    if part.holes:  # on the top rim of a drilled hole
        h = part.holes[rng.integers(len(part.holes))]
        th = rng.uniform(0, 2 * np.pi)
        center = np.array([h.x + h.r * np.cos(th), h.y + h.r * np.sin(th), z_top])
    else:  # on the top outer edge
        side = np.flatnonzero(inst.face == FACE_SIDE)
        p = inst.points[rng.choice(side)]
        center = np.array([p[0], p[1], z_top])
    _bump(inst, center, radius, height, LABELS["burr"])
    return Defect("burr", tuple(center), radius, height)


def inject_missing_hole(inst: PartInstance, part, rng: np.random.Generator) -> Defect:
    if not part.holes:
        raise ValueError(f"{part.part_number} has no holes to leave undrilled")
    i = int(rng.integers(len(part.holes)))
    h = part.holes[i]
    in_cyl = (inst.points[:, 0] - h.x) ** 2 + (inst.points[:, 1] - h.y) ** 2 < (h.r + 1e-6) ** 2
    wall = in_cyl & (inst.face != FACE_TOP) & (inst.face != FACE_BOTTOM)
    keep = ~wall
    # Fill the hole's footprint on both caps at the same density as the rest of the cap.
    cap_area = part.length * part.width - sum(np.pi * hh.r**2 for hh in part.holes)
    density = np.sum(inst.face == FACE_TOP) / cap_area
    n = rng.poisson(density * np.pi * h.r**2)
    rr, th = h.r * np.sqrt(rng.random(n)), rng.uniform(0, 2 * np.pi, n)
    z_top, z_bot = inst.points[:, 2].max(), inst.points[:, 2].min()
    add_pts, add_nrm, add_face = [], [], []
    for z, nz, f in ((z_top, 1.0, FACE_TOP), (z_bot, -1.0, FACE_BOTTOM)):
        add_pts.append(np.column_stack([h.x + rr * np.cos(th), h.y + rr * np.sin(th), np.full(n, z)]))
        add_nrm.append(np.tile([0, 0, nz], (n, 1)))
        add_face.append(np.full(n, f))
    inst.points = np.vstack([inst.points[keep], *add_pts])
    inst.normals = np.vstack([inst.normals[keep], *add_nrm])
    inst.face = np.concatenate([inst.face[keep], *add_face])
    inst.labels = np.concatenate([inst.labels[keep], np.full(2 * n, LABELS["missing_hole"])])
    return Defect("missing_hole", (h.x, h.y, z_top), h.r, h.r)


def inject_warp(inst: PartInstance, part, rng: np.random.Generator) -> Defect:
    amp = rng.uniform(0.6, 1.0)
    half = np.abs(inst.points[:, 0]).max()
    inst.points = inst.points.copy()
    inst.points[:, 2] += amp * (inst.points[:, 0] / half) ** 2
    inst.labels[inst.labels == 0] = LABELS["warp"]  # a whole-part defect
    return Defect("warp", (0.0, 0.0, 0.0), half, amp)


INJECTORS = {
    "dent": inject_dent,
    "burr": inject_burr,
    "missing_hole": inject_missing_hole,
    "warp": inject_warp,
}


def make_instance(part, n_points: int, rng: np.random.Generator, defects: list[str] | tuple = ()) -> PartInstance:
    """Sample a part and apply the listed defects (warp is applied last)."""
    s: SurfaceSample = part.sample(n_points, rng)
    inst = PartInstance(part.part_number, s.points.copy(), s.normals.copy(), s.face.copy(), np.zeros(len(s.points), int))
    for kind in sorted(defects, key=lambda k: k == "warp"):
        inst.defects.append(INJECTORS[kind](inst, part, rng))
    return inst
