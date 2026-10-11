"""The Inspect module: register, measure, find regions, classify, decide.

Two models are trained per part number, both from synthetic data only:

* a **defect classifier** on candidate regions, using the exact labels that
  defect injection provides
* a **good-parts anomaly model** fit only on defect-free scans, which catches
  anything unusual the classifier was never shown

Verdicts: PASS, FAIL, or REVIEW (routed to a human inspector).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from sklearn.covariance import LedoitWolf
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import confusion_matrix

from ..synth.defects import LABEL_NAMES
from ..synth.scanner import Scan
from .deviation import Reference, find_regions
from .registration import Registration, icp

REGION_CLASSES = ("none", "dent", "burr", "missing_hole", "warp")
PASS, FAIL, REVIEW = "PASS", "FAIL", "REVIEW"


@dataclass
class Region:
    center: np.ndarray
    n_points: int
    max_dev_mm: float
    mean_dev_mm: float
    kind: str = "none"
    confidence: float = 0.0


@dataclass
class Analysis:
    aligned: np.ndarray
    deviation: np.ndarray
    off_surface: np.ndarray
    nn_normals: np.ndarray
    regions: list[np.ndarray]
    registration: Registration
    part_features: np.ndarray


@dataclass
class InspectionResult:
    verdict: str
    regions: list[Region]
    anomaly_score: float
    analysis: Analysis

    @property
    def defect_types(self) -> list[str]:
        return sorted({r.kind for r in self.regions if r.kind != "none"})


@dataclass
class TrainingReport:
    n_scans: int
    n_regions: int
    region_accuracy: float
    confusion: np.ndarray
    classes: tuple[str, ...]
    defect_detection_rate: float  # defective parts flagged FAIL or REVIEW
    false_reject_rate: float  # good parts marked FAIL
    review_rate_good: float  # good parts sent to REVIEW
    extra: dict = field(default_factory=dict)


class InspectionModel:
    def __init__(self, part, reference_points: int = 80000, seed: int = 0):
        self.part = part
        self.tol = part.tolerance_mm
        self.ref = Reference.build(part, reference_points, seed)
        self.classifier: RandomForestClassifier | None = None
        self.anomaly_mean = None
        self.anomaly_cov = None
        self.anomaly_threshold = np.inf
        self.fail_confidence = 0.6

    # ---- geometry ---------------------------------------------------------
    def analyze(self, scan_points: np.ndarray, icp_points: int = 3000) -> Analysis:
        # Register on a subsample (fast), then measure every point.
        step = max(1, len(scan_points) // icp_points)
        reg = icp(scan_points[::step], self.ref.points, self.ref.normals, self.ref.tree)
        aligned = reg.apply(scan_points)
        dev, idx, off = self.ref.signed_deviation(aligned)
        regions = find_regions(aligned, dev, self.tol)
        a = np.abs(dev) / self.tol
        feats = np.array(
            [
                np.percentile(a, 50),
                np.percentile(a, 90),
                np.percentile(a, 99),
                np.percentile(a, 99.9),
                np.mean(a > 0.5),
                np.mean(a > 1.0),
                len(regions),
                reg.rmse / self.tol,
            ]
        )
        return Analysis(aligned, dev, off, self.ref.normals[idx], regions, reg, feats)

    def region_features(self, an: Analysis, idx: np.ndarray) -> np.ndarray:
        p, d = an.aligned[idx], an.deviation[idx]
        extent = float(np.linalg.norm(p.max(axis=0) - p.min(axis=0)))
        return np.array(
            [
                np.log1p(len(idx)),
                d.mean() / self.tol,
                np.abs(d).max() / self.tol,
                d.std() / self.tol,
                extent / self.part.diagonal,
                extent / 10.0,
                np.mean(d > 0),
                np.mean(np.abs(an.nn_normals[idx, 2]) < 0.5),
                np.mean(an.off_surface[idx]),
            ]
        )

    @staticmethod
    def region_label(labels: np.ndarray) -> str:
        nz = labels[labels > 0]
        if len(nz) < 0.3 * len(labels):
            return "none"
        return LABEL_NAMES[int(np.bincount(nz).argmax())]

    # ---- training ---------------------------------------------------------
    def _collect(self, scans: list[Scan], analyses: list[Analysis]):
        X, y, good_feats = [], [], []
        for s, an in zip(scans, analyses):
            for idx in an.regions:
                X.append(self.region_features(an, idx))
                y.append(self.region_label(s.labels[idx]))
            if not s.defects:
                good_feats.append(an.part_features)
        return np.array(X), np.array(y), np.array(good_feats)

    def _fit_models(self, scans, analyses, seed):
        X, y, good = self._collect(scans, analyses)
        self.classifier = RandomForestClassifier(
            n_estimators=300, min_samples_leaf=2, random_state=seed, class_weight="balanced"
        ).fit(X, y)
        self._fit_anomaly(good)
        return len(X)

    def _fit_anomaly(self, good_feats: np.ndarray, quantile: float = 0.99, margin: float = 1.15) -> None:
        self._synthetic_good = good_feats
        self.anomaly_mean = good_feats.mean(axis=0)
        self.anomaly_cov = LedoitWolf().fit(good_feats).precision_
        scores = [self.anomaly_score(f) for f in good_feats]
        self.anomaly_threshold = float(np.quantile(scores, quantile) * margin)

    def anomaly_score(self, feats: np.ndarray) -> float:
        d = feats - self.anomaly_mean
        return float(np.sqrt(max(d @ self.anomaly_cov @ d, 0.0)))

    def fit(self, scans: list[Scan], holdout: float = 0.25, seed: int = 0) -> TrainingReport:
        """Train on synthetic scans; report metrics on a held-out synthetic split, then refit on all."""
        rng = np.random.default_rng(seed)
        analyses = [self.analyze(s.points) for s in scans]  # the expensive step, done once
        order = rng.permutation(len(scans))
        n_test = int(len(scans) * holdout)
        test, train = order[:n_test], order[n_test:]
        self._fit_models([scans[i] for i in train], [analyses[i] for i in train], seed)

        # Evaluate on the held-out scans.
        yt, yp, detected, n_bad, false_rej, review_good, n_good = [], [], 0, 0, 0, 0, 0
        misses = []
        for i in test:
            s = scans[i]
            res = self.decide(analyses[i])
            for idx in res.analysis.regions:
                yt.append(self.region_label(s.labels[idx]))
            yp.extend(r.kind for r in res.regions)
            if s.defects:
                n_bad += 1
                detected += res.verdict != PASS
                if res.verdict == PASS:
                    misses.append([(d.kind, round(d.magnitude_mm, 2), round(d.size_mm, 1)) for d in s.defects])
            else:
                n_good += 1
                false_rej += res.verdict == FAIL
                review_good += res.verdict == REVIEW
        classes = tuple(c for c in REGION_CLASSES if c in set(yt) | set(yp))
        cm = confusion_matrix(yt, yp, labels=list(classes)) if yt else np.zeros((0, 0), int)
        n_regions = self._fit_models(scans, analyses, seed)  # final model uses every synthetic scan
        report = TrainingReport(
            n_scans=len(scans),
            n_regions=n_regions,
            region_accuracy=float(np.mean(np.array(yt) == np.array(yp))) if yt else float("nan"),
            confusion=cm,
            classes=classes,
            defect_detection_rate=detected / max(n_bad, 1),
            false_reject_rate=false_rej / max(n_good, 1),
            review_rate_good=review_good / max(n_good, 1),
            extra={"n_test_scans": n_test, "n_test_good": n_good, "n_test_defective": n_bad, "missed": misses},
        )
        return report

    def calibrate(self, real_good_scans: list[np.ndarray], margin: float = 1.4) -> dict:
        """Adapt to the shop's real scanner using a handful of known-good parts.

        Synthetic data never matches the real sensor exactly. Scanning 20-50 good
        parts re-centres the anomaly model on the real sensor. The spread is
        estimated from the real parts pooled with the synthetic ones, because 20
        parts alone are too few to estimate an 8-feature covariance.
        """
        before = self.anomaly_threshold
        feats = np.array([self.analyze(p).part_features for p in real_good_scans])
        scores_before = np.array([self.anomaly_score(f) for f in feats])
        real_mean = feats.mean(axis=0)
        pooled = np.vstack([feats - real_mean, self._synthetic_good - self._synthetic_good.mean(axis=0)])
        self.anomaly_mean = real_mean
        self.anomaly_cov = LedoitWolf(assume_centered=True).fit(pooled).precision_
        scores = np.array([self.anomaly_score(f) for f in feats])
        self.anomaly_threshold = float(max(scores.max(), np.quantile(scores, 0.99)) * margin)
        return {
            "n_parts": len(feats),
            "threshold_before": before,
            "threshold_after": self.anomaly_threshold,
            "review_rate_before": float(np.mean(scores_before > before)),
        }

    # ---- inference --------------------------------------------------------
    def inspect(self, scan_points: np.ndarray) -> InspectionResult:
        return self.decide(self.analyze(scan_points))

    def decide(self, an: Analysis) -> InspectionResult:
        regions = []
        for idx in an.regions:
            r = Region(
                center=an.aligned[idx].mean(axis=0),
                n_points=len(idx),
                max_dev_mm=float(an.deviation[idx][np.argmax(np.abs(an.deviation[idx]))]),
                mean_dev_mm=float(an.deviation[idx].mean()),
            )
            if self.classifier is not None:
                prob = self.classifier.predict_proba(self.region_features(an, idx)[None])[0]
                k = int(prob.argmax())
                r.kind, r.confidence = str(self.classifier.classes_[k]), float(prob[k])
            regions.append(r)

        score = self.anomaly_score(an.part_features) if self.anomaly_mean is not None else 0.0
        defects = [r for r in regions if r.kind != "none"]
        if any(r.confidence >= self.fail_confidence for r in defects):
            verdict = FAIL
        elif defects or score > self.anomaly_threshold:
            verdict = REVIEW
        else:
            verdict = PASS
        return InspectionResult(verdict, regions, score, an)
