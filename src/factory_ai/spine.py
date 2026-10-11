"""The data spine: every result keyed by part, machine and cycle.

Linking the three modules is what turns separate alerts into a root cause:
"these burrs started after Monitor saw rising spindle load on M-07".
SQLite here; the production version is a time-series store in the cloud.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS parts (
    serial TEXT PRIMARY KEY, part_number TEXT, machine_id TEXT, cycle INTEGER, ts TEXT
);
CREATE TABLE IF NOT EXISTS inspections (
    serial TEXT PRIMARY KEY REFERENCES parts(serial), verdict TEXT, defects TEXT,
    anomaly_score REAL, max_dev_mm REAL, true_defects TEXT
);
CREATE TABLE IF NOT EXISTS cycles (
    machine_id TEXT, cycle INTEGER, serial TEXT, score REAL, ewma REAL,
    drift_alert INTEGER, cycle_alert INTEGER, worst_op TEXT, PRIMARY KEY (machine_id, cycle)
);
CREATE TABLE IF NOT EXISTS machine_health (
    machine_id TEXT, cycle INTEGER, health REAL, z REAL, driver TEXT, alert INTEGER,
    PRIMARY KEY (machine_id, cycle)
);
"""


class Spine:
    def __init__(self, path: str | Path = ":memory:"):
        if path != ":memory:" and Path(path).exists():
            Path(path).unlink()
        self.db = sqlite3.connect(str(path))
        self.db.executescript(SCHEMA)

    def add_part(self, serial, part_number, machine_id, cycle, ts):
        self.db.execute("INSERT INTO parts VALUES (?,?,?,?,?)", (serial, part_number, machine_id, cycle, ts))

    def add_inspection(self, serial, verdict, defects, anomaly_score, max_dev_mm, true_defects):
        self.db.execute(
            "INSERT INTO inspections VALUES (?,?,?,?,?,?)",
            (serial, verdict, json.dumps(defects), anomaly_score, max_dev_mm, json.dumps(true_defects)),
        )

    def add_cycle(self, machine_id, cycle, serial, r: dict, worst_op: str):
        self.db.execute(
            "INSERT INTO cycles VALUES (?,?,?,?,?,?,?,?)",
            (machine_id, cycle, serial, r["score"], r["ewma"], int(r["drift_alert"]), int(r["cycle_alert"]), worst_op),
        )

    def add_health(self, machine_id, cycle, r: dict):
        self.db.execute(
            "INSERT INTO machine_health VALUES (?,?,?,?,?,?)",
            (machine_id, cycle, r["health"], r["z"], r["driver"], int(r["alert"])),
        )

    def commit(self):
        self.db.commit()

    def first_alert(self, table: str, column: str, machine_id: str) -> int | None:
        row = self.db.execute(
            f"SELECT MIN(cycle) FROM {table} WHERE machine_id=? AND {column}=1", (machine_id,)
        ).fetchone()
        return row[0]

    def root_cause(self, machine_id: str) -> list[dict]:
        """For each defect type found on a machine, which signal preceded it."""
        drift_at = self.first_alert("cycles", "drift_alert", machine_id)
        rows = self.db.execute(
            """SELECT p.cycle, i.defects, c.cycle_alert, c.worst_op
               FROM inspections i JOIN parts p USING (serial)
               JOIN cycles c ON c.machine_id = p.machine_id AND c.cycle = p.cycle
               WHERE p.machine_id = ? AND i.verdict != 'PASS'""",
            (machine_id,),
        ).fetchall()
        out: dict[str, dict] = {}
        for cycle, defects, cycle_alert, worst_op in rows:
            for d in json.loads(defects) or ["unclassified"]:
                e = out.setdefault(d, {"defect": d, "count": 0, "after_drift_alert": 0, "same_cycle_alert": 0, "ops": set()})
                e["count"] += 1
                e["after_drift_alert"] += drift_at is not None and cycle >= drift_at
                if cycle_alert:
                    e["same_cycle_alert"] += 1
                    e["ops"].add(worst_op)
        return [dict(v, ops=sorted(v["ops"])) for v in out.values()]
