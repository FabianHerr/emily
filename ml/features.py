"""Turns one wrist recording into the numbers the model sees (CJ-21).

The watch must compute exactly the same thing in C++ (CJ-22), so every step here is
simple on purpose: clamp each axis, find the impact, then summarise the second before it
and the three seconds after it in 9 numbers.
"""

from pathlib import Path

import numpy as np
import pandas as pd

# The watch samples at 50 Hz (watch/watch.ino SAMPLE_PERIOD_MS = 20).
SAMPLE_RATE_HZ = 50
# The model looks from 1 s before the impact to 3 s after it. The watch already waits
# longer than that after an impact before deciding, so this costs no extra delay.
BEFORE_SECONDS = 1.0
AFTER_SECONDS = 3.0
# WEDA-FALL stores acceleration in m/s^2; the watch works in g.
STANDARD_GRAVITY = 9.80665
# Our watch reads up to 8 g per axis (BMA423 at FS_8G). FallAllD was recorded at that same
# range. WEDA-FALL's Fitbit stops at 4 g, so its strongest falls look weaker than they were.
# THE WATCH MUST CLAMP EACH AXIS TO THIS BEFORE COMPUTING THE FEATURES (CJ-22).
AXIS_LIMIT_G = 8.0
# Rates found in the dataset's "50Hz" folder (see load_recording).
DATASET_RATES_HZ = (40, 50)


def load_recording(path: Path) -> np.ndarray:
    """Reads one *_accel.csv and returns x, y, z in g at an even 50 Hz. Shape: (samples, 3).

    Three things learned by measuring the files and reading the recording tool's code:
    - The time column is when each reading was DELIVERED, not measured (readings arrive
      in small groups every 100 ms). The rows themselves are evenly spaced, so the time
      column is only used to put rows in order and to find the file's real rate.
    - 24 files have groups of rows out of order (messages that arrived late): sort them.
    - The falls of persons 1-13 were really recorded at 40 Hz (39.9 rows per second, and
      identical to the dataset's own "40Hz" folder); everything else is 50 Hz. Those files
      are stretched onto a 50 Hz grid so 100 samples always means 2 seconds.
    """
    table = pd.read_csv(path).sort_values("accel_time_list", kind="stable")
    seconds = table["accel_time_list"].to_numpy(dtype=float)
    xyz = table[["accel_x_list", "accel_y_list", "accel_z_list"]].to_numpy(dtype=float)
    xyz = xyz / STANDARD_GRAVITY

    measured = len(seconds) / (seconds[-1] - seconds[0])
    rate = min(DATASET_RATES_HZ, key=lambda r: abs(r - measured))
    if rate == SAMPLE_RATE_HZ:
        return xyz
    # Row i was measured at i / rate seconds. Read the same curve every 1 / 50 s.
    old_times = np.arange(len(xyz)) / rate
    new_times = np.arange(0, old_times[-1], 1 / SAMPLE_RATE_HZ)
    return np.column_stack([np.interp(new_times, old_times, xyz[:, axis]) for axis in range(3)])


def magnitude(xyz: np.ndarray) -> np.ndarray:
    """Total force at each instant, whatever way the watch is turned."""
    return np.sqrt((xyz**2).sum(axis=1))


def find_impact(xyz: np.ndarray, search_from: int = 0, search_to: int | None = None) -> int:
    """Row of the strongest moment between rows search_from and search_to (default: all)."""
    search_from = max(0, min(search_from, len(xyz) - 1))
    search_to = len(xyz) if search_to is None else max(search_from + 1, min(search_to, len(xyz)))
    return search_from + int(np.argmax(magnitude(xyz[search_from:search_to])))


def _slice(xyz: np.ndarray, impact: int, from_seconds: float, to_seconds: float) -> np.ndarray:
    """Rows from from_seconds to to_seconds relative to the impact (negative = before).

    Cut short at the ends of a recording, always keeping at least 2 rows. On the watch
    the buffer is always full, so nothing is cut there.
    """
    start = max(0, min(impact + int(from_seconds * SAMPLE_RATE_HZ), len(xyz) - 1))
    end = max(start + 2, min(impact + int(to_seconds * SAMPLE_RATE_HZ), len(xyz)))
    return xyz[start:end]


def _angle_degrees(a: np.ndarray, b: np.ndarray) -> float:
    """Angle between two directions, 0 to 180."""
    lengths = np.linalg.norm(a) * np.linalg.norm(b)
    if lengths == 0:
        return 0.0
    return float(np.degrees(np.arccos(np.clip(np.dot(a, b) / lengths, -1.0, 1.0))))


# The model's inputs, in this exact order. The watch must build the same list (CJ-22).
FEATURE_NAMES = [
    # The impact: the 2 s around it (1 s before to 1 s after).
    "max_g",
    "min_g",
    "mean_g",
    "variance",
    "turn_degrees",
    # What happens next: 1 s to 3 s after the impact. A clap and a fall can hit equally
    # hard; after a fall the force settles and the wrist stays turned.
    "after_std",
    "after_off_1g",
    "after_max_g",
    "turn_3s_degrees",
]
# Directions are averaged over this many samples (half a second).
ORIENTATION_SAMPLES = SAMPLE_RATE_HZ // 2  # 25


def extract_features(xyz: np.ndarray, impact: int) -> list[float]:
    """The 9 numbers for one impact, in FEATURE_NAMES order.

    xyz is the recording in g at 50 Hz; impact is the row of the strongest moment.
    No gyroscope is needed: at rest the accelerometer only feels gravity, so the average
    x, y, z points "down" as seen by the watch, and the angle between two such averages
    is how far the wrist turned. Variance and standard deviation divide by N, not N - 1.
    """
    xyz = np.clip(xyz, -AXIS_LIMIT_G, AXIS_LIMIT_G)

    around = _slice(xyz, impact, -BEFORE_SECONDS, 1.0)
    force = magnitude(around)
    turn = _angle_degrees(
        around[:ORIENTATION_SAMPLES].mean(axis=0), around[-ORIENTATION_SAMPLES:].mean(axis=0)
    )

    after = _slice(xyz, impact, 1.0, AFTER_SECONDS)
    after_force = magnitude(after)
    before_direction = _slice(xyz, impact, -BEFORE_SECONDS, -0.5).mean(axis=0)
    # Direction over the last second of the window (2 s to 3 s after the impact).
    after_direction = after[-2 * ORIENTATION_SAMPLES :].mean(axis=0)

    return [
        float(force.max()),
        float(force.min()),
        float(force.mean()),
        float(force.var()),
        turn,
        float(after_force.std()),
        float(np.abs(after_force - 1.0).mean()),
        float(after_force.max()),
        _angle_degrees(before_direction, after_direction),
    ]
