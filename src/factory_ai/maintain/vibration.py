"""The Maintain module: spindle health from vibration.

A bearing with an outer-race fault produces a train of impacts at the
"ball pass frequency, outer race" (BPFO). Each impact rings the housing at its
resonance, so the classic detector is: band-pass around the resonance, take
the envelope, and look for energy at BPFO.

Each machine learns its own healthy baseline from its first windows of data,
so no run-to-failure history is needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.signal import butter, hilbert, sosfiltfilt
from scipy.stats import kurtosis


@dataclass(frozen=True)
class SpindleSpec:
    rpm: float = 12000.0
    bpfo_order: float = 3.58  # BPFO as a multiple of shaft speed, from the bearing datasheet
    resonance_hz: float = 3500.0
    fs: float = 25600.0  # accelerometer sample rate
    window_s: float = 0.25

    @property
    def shaft_hz(self) -> float:
        return self.rpm / 60.0

    @property
    def bpfo_hz(self) -> float:
        return self.bpfo_order * self.shaft_hz


def simulate_vibration(spec: SpindleSpec, fault_severity: float, rng: np.random.Generator) -> np.ndarray:
    """One accelerometer window. ``fault_severity`` 0 = healthy, 1 = failing bearing."""
    n = int(spec.fs * spec.window_s)
    t = np.arange(n) / spec.fs
    x = 0.3 * np.sin(2 * np.pi * spec.shaft_hz * t + rng.uniform(0, 2 * np.pi))
    x += 0.1 * np.sin(2 * np.pi * 2 * spec.shaft_hz * t + rng.uniform(0, 2 * np.pi))
    x += rng.normal(scale=0.2, size=n)
    if fault_severity > 0:
        period = 1.0 / spec.bpfo_hz
        ring = np.exp(-np.arange(int(0.004 * spec.fs)) / (0.0006 * spec.fs))
        ring = ring * np.sin(2 * np.pi * spec.resonance_hz * np.arange(len(ring)) / spec.fs)
        impulses = np.zeros(n)
        start = rng.uniform(0, period)
        for k in np.arange(start, spec.window_s, period):
            j = int((k + rng.normal(scale=0.01 * period)) * spec.fs)  # slight slip
            if 0 <= j < n:
                impulses[j] = 1.0
        x += 1.5 * fault_severity * np.convolve(impulses, ring)[:n]
    return x


def vibration_features(x: np.ndarray, spec: SpindleSpec) -> np.ndarray:
    """RMS, kurtosis, crest factor and envelope amplitude at BPFO."""
    sos = butter(4, [spec.resonance_hz - 800, spec.resonance_hz + 800], btype="band", fs=spec.fs, output="sos")
    env = np.abs(hilbert(sosfiltfilt(sos, x)))
    env -= env.mean()
    spec_env = np.abs(np.fft.rfft(env * np.hanning(len(env)))) / len(env)
    freqs = np.fft.rfftfreq(len(env), 1 / spec.fs)
    band = np.abs(freqs - spec.bpfo_hz) < 6.0
    return np.array([np.sqrt(np.mean(x**2)), kurtosis(x), np.max(np.abs(x)) / np.sqrt(np.mean(x**2)), spec_env[band].max()])


FEATURE_NAMES = ("rms", "kurtosis", "crest_factor", "envelope_bpfo")


@dataclass
class HealthModel:
    """Per-machine baseline. Health 100 = matches baseline; alert after sustained deviation."""

    spec: SpindleSpec = field(default_factory=SpindleSpec)
    z_alert: float = 6.0
    sustain: int = 3
    mean: np.ndarray | None = None
    std: np.ndarray | None = None
    _streak: int = 0

    def fit_baseline(self, windows: list[np.ndarray]) -> "HealthModel":
        f = np.array([vibration_features(w, self.spec) for w in windows])
        self.mean, self.std = f.mean(axis=0), f.std(axis=0) + 1e-9
        return self

    def update(self, window: np.ndarray) -> dict:
        f = vibration_features(window, self.spec)
        z = (f - self.mean) / self.std
        z_max = float(np.max(z))
        self._streak = self._streak + 1 if z_max > self.z_alert else 0
        health = float(np.clip(100 - 6 * max(0.0, z_max - 3), 0, 100))
        return {
            "health": health,
            "z": z_max,
            "driver": FEATURE_NAMES[int(np.argmax(z))],
            "alert": self._streak >= self.sustain,
        }
