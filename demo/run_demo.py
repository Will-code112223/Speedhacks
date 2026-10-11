"""End-to-end demo: one machine, one shift, three modules, one report.

    python demo/run_demo.py            # full run, about 2 minutes on a laptop
    python demo/run_demo.py --quick    # smaller run for CI

Story:
  1. A job shop gets a new part number, BRK-1042. All we have is its CAD.
  2. The platform generates synthetic scans with injected defects and trains
     the inspection models. No real defects, no hand labels.
  3. The shop scans 20 known-good parts to calibrate to its real scanner.
  4. Machine M-07 runs a shift. The tool wears, a drilling op is skipped once,
     and a spindle bearing starts to fail. Every part is scanned; every cycle's
     spindle load and vibration are monitored.
  5. The report shows verdicts, root causes and inspector time saved.

Everything physical here is SIMULATED (see README, "What is real vs simulated").
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from factory_ai.cad.parts import catalog  # noqa: E402
from factory_ai.inspect.model import FAIL, PASS, REVIEW, InspectionModel  # noqa: E402
from factory_ai.maintain.vibration import HealthModel, SpindleSpec, simulate_vibration  # noqa: E402
from factory_ai.monitor.drift import DriftMonitor, operation_at, simulate_cycle  # noqa: E402
from factory_ai.spine import Spine  # noqa: E402
from factory_ai.synth.dataset import generate_scans  # noqa: E402
from factory_ai.synth.defects import make_instance  # noqa: E402
from factory_ai.synth.scanner import ScannerConfig, simulate_scan  # noqa: E402
from factory_ai.timesaved import TimeAssumptions, time_saved  # noqa: E402

MACHINE = "M-07"
PART = "BRK-1042"
# The shop's real scanner differs from the nominal model used for training.
SHOP_SCANNER = ScannerConfig(noise_mm=0.045, dropout=0.05, tilt_deg=30.0)
N_POINTS = 40000
COLORS = {PASS: "#2e9d5b", REVIEW: "#e0a020", FAIL: "#d64545"}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fig_to_b64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=140, bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


def save_fig(fig, out: Path, name: str) -> str:
    fig.savefig(out / name, dpi=140, bbox_inches="tight")
    return fig_to_b64(fig)


# ---------------------------------------------------------------------------
def simulate_shift(model, part, n_cycles, rng, spine, start_ts):
    spec = SpindleSpec()
    monitor = DriftMonitor().fit_baseline([simulate_cycle(rng=rng, tool_wear=w) for w in rng.uniform(0.05, 0.15, 30)])
    health = HealthModel(spec).fit_baseline([simulate_vibration(spec, 0.0, rng) for _ in range(30)])

    skip_cycle = int(0.35 * n_cycles)
    bearing_start = int(0.6 * n_cycles)
    rows = []
    for c in range(1, n_cycles + 1):
        wear = 0.1 + 0.9 * (c / n_cycles) ** 2.2
        severity = 0.0 if c < bearing_start else (c - bearing_start) / (n_cycles - bearing_start)
        skip = ("drill 3",) if c == skip_cycle else ()

        # What actually happened to this part (ground truth, hidden from the models).
        defects = []
        if skip:
            defects.append("missing_hole")
        if rng.random() < 0.02 + 0.7 * max(0.0, wear - 0.5) / 0.5:
            defects.append("burr")
        if rng.random() < 0.03:
            defects.append("dent")
        if rng.random() < 0.015:
            defects.append("warp")

        serial = f"{PART}-{c:04d}"
        ts = start_ts + timedelta(minutes=4 * c)
        spine.add_part(serial, PART, MACHINE, c, ts.isoformat())

        cyc = monitor.update(simulate_cycle(tool_wear=wear, skip_ops=skip, rng=rng))
        spine.add_cycle(MACHINE, c, serial, cyc, operation_at(cyc["worst_sample"]))

        h = health.update(simulate_vibration(spec, severity, rng))
        spine.add_health(MACHINE, c, h)

        t0 = time.perf_counter()
        scan = simulate_scan(make_instance(part, N_POINTS, rng, defects), SHOP_SCANNER, rng)
        res = model.inspect(scan.points)
        dt = time.perf_counter() - t0
        max_dev = float(np.max(np.abs(res.analysis.deviation)))
        spine.add_inspection(serial, res.verdict, res.defect_types, res.anomaly_score, max_dev, sorted(set(defects)))
        rows.append(
            {
                "cycle": c,
                "wear": wear,
                "bearing": severity,
                "verdict": res.verdict,
                "found": res.defect_types,
                "truth": sorted(set(defects)),
                "drift_ewma": cyc["ewma"],
                "drift_alert": cyc["drift_alert"],
                "cycle_alert": cyc["cycle_alert"],
                "health": h["health"],
                "health_alert": h["alert"],
                "inspect_s": dt,
            }
        )
    spine.commit()
    return rows, monitor, skip_cycle, bearing_start


# ---------------------------------------------------------------------------
def plot_examples(model, part, rng, out):
    kinds = [[], ["dent"], ["burr"], ["missing_hole"], ["warp"]]
    titles = ["Good part", "Dent", "Burr on hole rim", "Missing hole", "Warp"]
    fig, axes = plt.subplots(1, 5, figsize=(20, 3.6))
    tol = part.tolerance_mm
    for ax, k, title in zip(axes, kinds, titles):
        scan = simulate_scan(make_instance(part, N_POINTS, rng, k), SHOP_SCANNER, rng)
        res = model.inspect(scan.points)
        p, d = res.analysis.aligned, res.analysis.deviation
        order = np.argsort(np.abs(d))
        sc = ax.scatter(p[order, 0], p[order, 1], c=d[order], s=1.5, cmap="RdBu_r", vmin=-4 * tol, vmax=4 * tol)
        found = {}
        for r in res.regions:
            if r.kind == "none":
                continue
            if r.kind != "warp":  # warp is whole-part; circling every region adds noise
                ax.add_patch(plt.Circle(r.center[:2], 7, fill=False, color="k", lw=1.2))
            found[r.kind] = max(found.get(r.kind, 0), r.confidence)
        caption = ", ".join(f"{k.replace('_', ' ')} ({v:.0%})" for k, v in found.items()) or "no regions out of tolerance"
        ax.text(0.5, -0.08, caption, transform=ax.transAxes, ha="center", va="top", fontsize=9, color="#333")
        ax.set_title(f"{title}  →  {res.verdict}", color=COLORS[res.verdict], fontsize=11, fontweight="bold")
        ax.set_aspect("equal")
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
    cb = fig.colorbar(sc, ax=axes, fraction=0.012, pad=0.01)
    cb.set_label("deviation from CAD (mm)\nred = extra material, blue = missing")
    return save_fig(fig, out, "examples.png")


def plot_timeline(rows, monitor, skip_cycle, out):
    c = np.array([r["cycle"] for r in rows])
    fig, ax = plt.subplots(3, 1, figsize=(12, 8), sharex=True, gridspec_kw={"height_ratios": [1.1, 1, 0.8]})

    ax[0].plot(c, [r["drift_ewma"] for r in rows], color="#3366cc", lw=1.8, label="spindle-load drift (EWMA)")
    ax[0].axhline(monitor.ucl, color="#d64545", ls="--", lw=1, label="alert limit")
    ax[0].set_yscale("log")
    ax[0].set_ylabel("Monitor\ndrift score")
    first = next((r["cycle"] for r in rows if r["drift_alert"]), None)
    if first:
        ax[0].axvline(first, color="#d64545", lw=1, alpha=0.5)
        ax[0].annotate(
            f"drift alert, cycle {first}\n(tool wearing)", (first, monitor.ucl), xytext=(-12, 40),
            textcoords="offset points", ha="right", fontsize=9, arrowprops={"arrowstyle": "-", "color": "#999"},
        )
    for r in rows:
        if r["cycle_alert"]:
            ax[0].scatter([r["cycle"]], [r["drift_ewma"]], marker="v", s=60, color="#d64545", zorder=3)
            ax[0].annotate(
                f"cycle {r['cycle']}: a drilling op cut nothing", (r["cycle"], r["drift_ewma"]), xytext=(10, 45),
                textcoords="offset points", fontsize=9, arrowprops={"arrowstyle": "-", "color": "#999"},
            )
    ax[0].legend(loc="upper left", fontsize=8, frameon=False)

    ax[1].plot(c, [r["health"] for r in rows], color="#7a4fbf", lw=1.8)
    ax[1].set_ylim(-5, 105)
    ax[1].set_ylabel("Maintain\nspindle health")
    h_first = next((r["cycle"] for r in rows if r["health_alert"]), None)
    if h_first:
        ax[1].axvline(h_first, color="#7a4fbf", lw=1, alpha=0.5)
        ax[1].annotate(f"bearing alert, cycle {h_first}", (h_first, 50), xytext=(6, 0), textcoords="offset points", fontsize=9)

    for v, y in ((PASS, 0), (REVIEW, 1), (FAIL, 2)):
        xs = [r["cycle"] for r in rows if r["verdict"] == v]
        ax[2].scatter(xs, [y] * len(xs), color=COLORS[v], s=18, label=v)
    missed = [r["cycle"] for r in rows if r["truth"] and r["verdict"] == PASS]
    if missed:
        ax[2].scatter(missed, [0] * len(missed), facecolors="none", edgecolors="k", s=90, lw=1.2)
        ax[2].annotate("missed defect", (missed[0], 0), xytext=(8, 14), textcoords="offset points", fontsize=9)
    ax[2].set_yticks([0, 1, 2], [PASS, REVIEW, FAIL])
    ax[2].set_ylim(-0.6, 2.6)
    ax[2].set_ylabel("Inspect\nverdict")
    ax[2].set_xlabel(f"cycle on {MACHINE} (one part per cycle)")
    for a in ax:
        for s in ("top", "right"):
            a.spines[s].set_visible(False)
    fig.suptitle(f"One shift on {MACHINE}: three modules, one timeline", x=0.01, ha="left", fontsize=13, fontweight="bold")
    fig.tight_layout()
    return save_fig(fig, out, "timeline.png")


def plot_time(ts, out):
    fig, ax = plt.subplots(figsize=(7, 2.4))
    vals = [ts["manual_min"] / 60, ts["ai_min"] / 60]
    ax.barh(["With the platform", "Manual inspection today"][::-1], vals, color=["#9aa3ad", "#2e9d5b"])
    for i, v in enumerate(vals):
        ax.text(v, i, f"  {v:.1f} h", va="center", fontsize=10)
    ax.set_xlabel("inspector hours for this shift (setup + inspection + review)")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    return save_fig(fig, out, "time_saved.png")


# ---------------------------------------------------------------------------
def part_level_scores(rows):
    tp = sum(1 for r in rows if r["truth"] and r["verdict"] != PASS)
    fn = sum(1 for r in rows if r["truth"] and r["verdict"] == PASS)
    fr = sum(1 for r in rows if not r["truth"] and r["verdict"] == FAIL)
    rv = sum(1 for r in rows if not r["truth"] and r["verdict"] == REVIEW)
    good = sum(1 for r in rows if not r["truth"])
    return {"defective": tp + fn, "caught": tp, "missed": fn, "good": good, "good_failed": fr, "good_reviewed": rv}


def write_report(out, ctx):
    t = ctx["time"]
    s = ctx["scores"]
    tr = ctx["train"]
    cm_rows = "".join(
        f"<tr><th>{c}</th>" + "".join(f"<td>{v}</td>" for v in row) + "</tr>" for c, row in zip(tr.classes, tr.confusion)
    )
    rc_rows = "".join(
        f"<tr><td>{r['defect']}</td><td>{r['count']}</td><td>{r['after_drift_alert']}</td><td>{r['same_cycle_alert']}"
        f"{' (' + ', '.join(r['ops']) + ')' if r['ops'] else ''}</td></tr>"
        for r in sorted(ctx["root_cause"], key=lambda r: -r["count"])
    )
    a = t["assumptions"]
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Factory AI demo report</title>
<style>
:root{{--ink:#1d2329;--quiet:#5c6670;--line:#e3e6ea;--bg:#fbfbfa;--good:#2e9d5b;--warn:#e0a020;--bad:#d64545}}
body{{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:var(--ink);background:var(--bg);margin:0}}
main{{max-width:1180px;margin:0 auto;padding:32px 20px 64px}}
h1{{font-size:28px;margin:0 0 4px}} h2{{font-size:19px;margin:36px 0 8px}} .sub{{color:var(--quiet);margin:0 0 24px}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}}
.kpi{{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}}
.kpi b{{display:block;font-size:28px;line-height:1.2}} .kpi span{{color:var(--quiet);font-size:13px}}
img{{width:100%;background:#fff;border:1px solid var(--line);border-radius:10px}}
table{{border-collapse:collapse;background:#fff;font-size:14px}} td,th{{border:1px solid var(--line);padding:6px 10px;text-align:right}}
th{{text-align:left;font-weight:600}} .note{{color:var(--quiet);font-size:13px}}
.flow{{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 0}} .flow div{{background:#fff;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:14px}}
.flow i{{color:var(--quiet);font-style:normal}}
.honest{{background:#fff8e6;border:1px solid #f0dca8;border-radius:10px;padding:12px 16px}}
</style></head><body><main>
<h1>CAD in, inspected parts out</h1>
<p class="sub">{PART} on machine {MACHINE} · {ctx['n_cycles']} parts · generated {ctx['generated']}</p>
<div class="kpis">
 <div class="kpi"><b>{t['saved_min']/60:.1f} h</b><span>inspector time saved this shift ({t['saved_pct']:.0f}%)</span></div>
 <div class="kpi"><b>{s['caught']}/{s['defective']}</b><span>defective parts caught (FAIL or REVIEW)</span></div>
 <div class="kpi"><b>{s['good_failed']}</b><span>good parts wrongly failed · {s['good_reviewed']} sent to review</span></div>
 <div class="kpi"><b>{ctx['setup_min']:.0f} min</b><span>CAD to trained model, zero hand labels</span></div>
 <div class="kpi"><b>{ctx['inspect_s']:.2f} s</b><span>median inspection time per part (CPU)</span></div>
</div>

<h2>1. The pipeline that ran</h2>
<div class="flow"><div>STEP/STL CAD</div><i>→</i><div>{tr.n_scans} synthetic scans, {tr.n_regions} labeled defect regions</div><i>→</i><div>defect classifier + good-parts anomaly model</div><i>→</i><div>calibrated on {ctx['calib']['n_parts']} real good parts</div><i>→</i><div>{ctx['n_cycles']} parts inspected</div></div>

<h2>2. What the inspector sees</h2>
<p class="note">Each scan is registered to CAD, and every point is coloured by how far it sits off the nominal surface. Regions outside the {ctx['tol']} mm tolerance are classified.</p>
<img src="data:image/png;base64,{ctx['img_examples']}" alt="Deviation maps for five example parts">

<h2>3. One shift, three modules</h2>
<img src="data:image/png;base64,{ctx['img_timeline']}" alt="Shift timeline">
<h3>Root cause from the data spine</h3>
<table><tr><th>Defect found</th><th>Parts</th><th>After the drift alert</th><th>Same cycle flagged by Monitor</th></tr>{rc_rows}</table>
<p class="note">Monitor's first drift alert came at cycle {ctx['drift_at']}. Changing the tool then would have prevented {ctx['burrs_after']} of the {ctx['burrs_total']} burred parts. Maintain's first bearing alert came at cycle {ctx['health_at']}.</p>

<h2>4. Time saved</h2>
<img src="data:image/png;base64,{ctx['img_time']}" alt="Time saved" style="max-width:720px">
<p class="note">Manual today: {a['manual_inspect_min_per_part']} min per part plus {a['manual_setup_min_per_part_number']} min to write the inspection plan. With the platform: {a['scan_handling_min_per_part']} min to place each part, {a['review_min_per_flagged_part']} min of inspector review per flagged part, and {a['ai_setup_min_per_part_number']} min of setup. All are estimates; change them in <code>src/factory_ai/timesaved.py</code>.</p>

<h2>5. Model quality on held-out synthetic scans</h2>
<p class="note">Region accuracy {tr.region_accuracy:.0%} · defective parts flagged {tr.defect_detection_rate:.0%} · good parts failed {tr.false_reject_rate:.0%} · good parts sent to review {tr.review_rate_good:.0%}. Rows are the true class, columns the prediction.</p>
<table><tr><th></th>{''.join(f'<th>{c}</th>' for c in tr.classes)}</tr>{cm_rows}</table>

<h2>What is real and what is simulated</h2>
<div class="honest">Real: registration, deviation measurement, defect classification, anomaly scoring, drift detection, vibration analysis, the data spine, and the time-saved arithmetic. Simulated: the parts, the 3D scanner, the defects, the spindle-load traces and the accelerometer. No real shop data has been tested yet; the next step is scanning real parts.</div>
</main></body></html>"""
    (out / "report.html").write_text(html)


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="smaller run for CI")
    ap.add_argument("--out", default="out")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    n_train, n_cycles, n_calib = (80, 40, 10) if args.quick else (240, 120, 20)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(args.seed)
    part = catalog()[PART]

    log(f"1/5  New part number {PART}: {part.length}x{part.width}x{part.thickness} mm, {len(part.holes)} holes, ±{part.tolerance_mm} mm")
    t0 = time.perf_counter()
    model = InspectionModel(part)
    scans = generate_scans(part, n_train, rng, n_points=N_POINTS)
    log(f"2/5  Generated {len(scans)} synthetic scans from CAD; training…")
    report = model.fit(scans)
    log(
        f"     held-out synthetic: region accuracy {report.region_accuracy:.0%}, "
        f"defective flagged {report.defect_detection_rate:.0%}, good failed {report.false_reject_rate:.0%}"
    )

    good_real = [simulate_scan(make_instance(part, N_POINTS, rng), SHOP_SCANNER, rng).points for _ in range(n_calib)]
    calib = model.calibrate(good_real)
    setup_s = time.perf_counter() - t0
    log(f"3/5  Calibrated on {calib['n_parts']} good parts from the shop scanner ({setup_s:.0f} s total setup)")

    spine = Spine(out / "spine.sqlite")
    log(f"4/5  Running a {n_cycles}-part shift on {MACHINE}…")
    rows, monitor, skip_cycle, bearing_start = simulate_shift(model, part, n_cycles, rng, spine, datetime(2026, 10, 12, 6, 0))

    scores = part_level_scores(rows)
    flagged = sum(r["verdict"] != PASS for r in rows)
    ts = time_saved(n_cycles, flagged, 1, TimeAssumptions())
    drift_at = spine.first_alert("cycles", "drift_alert", MACHINE)
    health_at = spine.first_alert("machine_health", "alert", MACHINE)
    burrs = [r for r in rows if "burr" in r["truth"]]
    burrs_after = sum(1 for r in burrs if drift_at and r["cycle"] >= drift_at)

    log("5/5  Writing report")
    ctx = {
        "n_cycles": n_cycles,
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "time": ts,
        "scores": scores,
        "train": report,
        "calib": calib,
        "setup_min": setup_s / 60,
        "inspect_s": float(np.median([r["inspect_s"] for r in rows])),
        "tol": part.tolerance_mm,
        "root_cause": spine.root_cause(MACHINE),
        "drift_at": drift_at,
        "health_at": health_at,
        "burrs_after": burrs_after,
        "burrs_total": len(burrs),
        "img_examples": plot_examples(model, part, rng, out),
        "img_timeline": plot_timeline(rows, monitor, skip_cycle, out),
        "img_time": plot_time(ts, out),
    }
    write_report(out, ctx)
    summary = {
        "parts": n_cycles,
        "verdicts": {v: sum(r["verdict"] == v for r in rows) for v in (PASS, REVIEW, FAIL)},
        "part_level": scores,
        "time_saved_hours": round(ts["saved_min"] / 60, 2),
        "time_saved_pct": round(ts["saved_pct"], 1),
        "drift_alert_cycle": drift_at,
        "bearing_alert_cycle": health_at,
        "skipped_drill_cycle": skip_cycle,
        "skipped_drill_verdict": rows[skip_cycle - 1]["verdict"],
        "burrs_after_drift_alert": f"{burrs_after}/{len(burrs)}",
        "synthetic_holdout": {
            "region_accuracy": round(report.region_accuracy, 3),
            "defect_detection_rate": round(report.defect_detection_rate, 3),
            "false_reject_rate": round(report.false_reject_rate, 3),
        },
        "calibration": calib,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=float))
    print(json.dumps(summary, indent=2, default=float))
    log(f"Done. Open {out / 'report.html'}")


if __name__ == "__main__":
    main()
