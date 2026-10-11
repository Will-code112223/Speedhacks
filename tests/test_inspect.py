import numpy as np
import pytest

from factory_ai.cad.io import MeshPart, write_stl
from factory_ai.cad.parts import catalog
from factory_ai.inspect.deviation import Reference, find_regions
from factory_ai.inspect.model import FAIL, PASS, InspectionModel
from factory_ai.inspect.registration import icp
from factory_ai.synth.dataset import generate_scans
from factory_ai.synth.defects import LABELS, make_instance
from factory_ai.synth.scanner import ScannerConfig, simulate_scan

PART = catalog()["BRK-1042"]


@pytest.fixture(scope="module")
def reference():
    return Reference.build(PART, 60000)


def test_sample_lies_on_part_surface():
    s = PART.sample(5000, np.random.default_rng(0))
    assert np.allclose(np.linalg.norm(s.normals, axis=1), 1.0)
    assert np.all(np.abs(s.points[:, 0]) <= PART.length / 2 + 1e-9)
    assert np.all(np.abs(s.points[:, 2]) <= PART.thickness / 2 + 1e-9)


def test_icp_recovers_fixture_pose(reference):
    rng = np.random.default_rng(1)
    scan = simulate_scan(make_instance(PART, 30000, rng), ScannerConfig(), rng)
    reg = icp(scan.points, reference.points, reference.normals, reference.tree)
    # Applying the found transform should undo the true pose.
    truth = (scan.points - scan.translation) @ scan.rotation
    assert np.median(np.linalg.norm(reg.apply(scan.points) - truth, axis=1)) < 0.05


def test_good_part_has_no_regions(reference):
    rng = np.random.default_rng(2)
    scan = simulate_scan(make_instance(PART, 30000, rng), ScannerConfig(), rng)
    reg = icp(scan.points, reference.points, reference.normals, reference.tree)
    dev, _, _ = reference.signed_deviation(reg.apply(scan.points))
    assert find_regions(reg.apply(scan.points), dev, PART.tolerance_mm) == []


@pytest.mark.parametrize("kind", ["dent", "burr", "missing_hole", "warp"])
def test_injected_defect_is_labeled_and_out_of_tolerance(reference, kind):
    rng = np.random.default_rng(3)
    inst = make_instance(PART, 30000, rng, [kind])
    assert np.any(inst.labels == LABELS[kind])
    scan = simulate_scan(inst, ScannerConfig(), rng)
    reg = icp(scan.points, reference.points, reference.normals, reference.tree)
    dev, _, _ = reference.signed_deviation(reg.apply(scan.points))
    assert np.abs(dev).max() > PART.tolerance_mm


def test_model_end_to_end_small():
    rng = np.random.default_rng(4)
    model = InspectionModel(PART, reference_points=60000)
    report = model.fit(generate_scans(PART, 60, rng, n_points=30000))
    assert report.defect_detection_rate > 0.7
    good = simulate_scan(make_instance(PART, 30000, rng), ScannerConfig(), rng)
    bad = simulate_scan(make_instance(PART, 30000, rng, ["missing_hole"]), ScannerConfig(), rng)
    assert model.inspect(good.points).verdict == PASS
    res = model.inspect(bad.points)
    assert res.verdict == FAIL and "missing_hole" in res.defect_types


def test_stl_round_trip(tmp_path):
    # A 10 mm cube as 12 triangles.
    v = np.array([[x, y, z] for x in (0, 10) for y in (0, 10) for z in (0, 10)], float)
    faces = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
             (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    path = tmp_path / "cube.stl"
    write_stl(path, v[np.array(faces)])
    part = MeshPart.from_stl(path, tolerance_mm=0.1)
    s = part.sample(2000, np.random.default_rng(0))
    assert np.all(np.abs(s.points) <= 5 + 1e-4)
    assert part.part_number == "cube"
