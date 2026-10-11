import numpy as np

from factory_ai.maintain.vibration import HealthModel, SpindleSpec, simulate_vibration
from factory_ai.monitor.drift import DriftMonitor, operation_at, simulate_cycle
from factory_ai.spine import Spine
from factory_ai.timesaved import time_saved


def test_bearing_fault_triggers_alert():
    rng = np.random.default_rng(0)
    spec = SpindleSpec()
    model = HealthModel(spec).fit_baseline([simulate_vibration(spec, 0.0, rng) for _ in range(30)])
    healthy = [model.update(simulate_vibration(spec, 0.0, rng)) for _ in range(10)]
    assert not any(h["alert"] for h in healthy)
    faulty = [model.update(simulate_vibration(spec, 0.8, rng)) for _ in range(5)]
    assert faulty[-1]["alert"] and faulty[-1]["health"] < 50


def test_drift_and_skipped_operation():
    rng = np.random.default_rng(1)
    mon = DriftMonitor().fit_baseline([simulate_cycle(tool_wear=w, rng=rng) for w in rng.uniform(0.05, 0.15, 30)])
    normal = [mon.update(simulate_cycle(tool_wear=0.1, rng=rng)) for _ in range(10)]
    assert not any(r["drift_alert"] or r["cycle_alert"] for r in normal)

    skipped = mon.update(simulate_cycle(tool_wear=0.1, skip_ops=("drill 3",), rng=rng))
    assert skipped["cycle_alert"] and operation_at(skipped["worst_sample"]) == "drill 3"

    worn = [mon.update(simulate_cycle(tool_wear=0.7, rng=rng)) for _ in range(10)]
    assert worn[-1]["drift_alert"]


def test_spine_root_cause():
    sp = Spine()
    sp.add_part("A-1", "BRK", "M", 1, "t")
    sp.add_cycle("M", 1, "A-1", {"score": 1, "ewma": 1, "drift_alert": True, "cycle_alert": False}, "rough pocket")
    sp.add_inspection("A-1", "FAIL", ["burr"], 1.0, 0.6, ["burr"])
    rc = sp.root_cause("M")
    assert rc[0]["defect"] == "burr" and rc[0]["after_drift_alert"] == 1


def test_time_saved_counts_setup_and_review():
    t = time_saved(n_parts=100, n_flagged=10, n_part_numbers=1)
    assert t["manual_min"] == 100 * 6.0 + 90.0
    assert t["ai_min"] == 100 * 0.3 + 10 * 1.5 + 25.0
    assert 0 < t["saved_pct"] < 100
