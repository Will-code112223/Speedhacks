"""Time-saved accounting, with every assumption explicit.

Judges (and buyers) should be able to change any number here and see the
result move. Setup, review and corrections are counted, not just the happy path.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class TimeAssumptions:
    # Today's manual workflow (estimates for a 4-hole machined bracket; adjust per shop).
    manual_inspect_min_per_part: float = 6.0  # visual check + calipers/pin gauges on 4 holes, flatness on a surface plate
    manual_setup_min_per_part_number: float = 90.0  # writing the inspection plan / checklist for a new part number

    # With the platform.
    scan_handling_min_per_part: float = 0.3  # operator places the part on the fixture; scan runs in seconds
    review_min_per_flagged_part: float = 1.5  # inspector checks the heat map for a REVIEW or FAIL part
    ai_setup_min_per_part_number: float = 25.0  # upload CAD, set tolerance, scan 20 good parts to calibrate

    def as_dict(self) -> dict:
        return asdict(self)


def time_saved(n_parts: int, n_flagged: int, n_part_numbers: int, a: TimeAssumptions = TimeAssumptions()) -> dict:
    manual = n_parts * a.manual_inspect_min_per_part + n_part_numbers * a.manual_setup_min_per_part_number
    ai = (
        n_parts * a.scan_handling_min_per_part
        + n_flagged * a.review_min_per_flagged_part
        + n_part_numbers * a.ai_setup_min_per_part_number
    )
    return {
        "manual_min": manual,
        "ai_min": ai,
        "saved_min": manual - ai,
        "saved_pct": 100 * (manual - ai) / manual if manual else 0.0,
        "assumptions": a.as_dict(),
    }
