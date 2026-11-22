"""Builds the training table from the two public wrist datasets: one row per recording (CJ-21).

WEDA-FALL: Fitbit on the wrist, 50 Hz (most falls 40 Hz), clips at 4 g per axis.
FallAllD:  data logger on the wrist, 238 Hz, reads up to 8 g like our watch.
"""

import re
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import resample_poly

from features import (
    FEATURE_NAMES,
    SAMPLE_RATE_HZ,
    extract_features,
    find_impact,
    load_recording,
)

DATA_DIR = Path(__file__).parent / "data"
# git clone https://github.com/joaojtmarques/WEDA-FALL.git ml/data/WEDA-FALL
WEDA_DIR = DATA_DIR / "WEDA-FALL" / "dataset"
# Where each WEDA fall happens inside its recording, in seconds (marked by hand by the authors).
WEDA_FALL_TIMES_FILE = WEDA_DIR / "fall_timestamps.csv"
# "Main data file" from IEEE DataPort (free login), unzipped: ml/data/FallAllD/FallAllD/*.dat
FALLALLD_DIR = DATA_DIR / "FallAllD" / "FallAllD"

# People pressed start and stop on the watch: the arm movement right after and before
# that is not part of the activity. Normal activities ignore this much at each end.
EDGE_SECONDS = 2
# The watch only checks a moment when a sample goes above this (watch/watch.ino
# TRIGGER_G). Gentler recordings never reach the model, so they are left out: keeping
# them would count easy "not a fall" answers the model is never asked for.
TRIGGER_G = 2.0

# FallAllD file names: S<subject>_D<device>_A<activity>_T<trial>_A.dat (the last A = accelerometer).
FALLALLD_WRIST_DEVICE = 2  # 1 = neck, 2 = wrist, 3 = waist (from the dataset's own script)
FALLALLD_FIRST_FALL_ID = 101  # activities 101-135 are falls, 1-44 are normal activities
# Raw sensor counts to g: LSM9DS1 at +-8 g is 0.244 mg per count (at rest the files read ~1 g).
FALLALLD_G_PER_COUNT = 0.000244
# 238 Hz -> 50 Hz: 238 * 25 / 119 = 50. resample_poly low-pass filters before dropping samples.
FALLALLD_RESAMPLE_UP, FALLALLD_RESAMPLE_DOWN = 25, 119
# Every FallAllD file is 20 s with the event in the middle: look for a fall's impact there.
FALLALLD_FALL_SEARCH_SECONDS = (8, 12)


def normal_activity_impact(xyz: np.ndarray) -> int:
    """Strongest moment of a normal activity, ignoring the start/stop arm movements."""
    edge = EDGE_SECONDS * SAMPLE_RATE_HZ
    # Too short to trim both ends: use the whole recording.
    if len(xyz) <= 2 * edge + SAMPLE_RATE_HZ:
        return find_impact(xyz)
    return find_impact(xyz, edge, len(xyz) - edge)


def weda_rows() -> list[list]:
    times = pd.read_csv(WEDA_FALL_TIMES_FILE, encoding="utf-8-sig")
    fall_times = {row.filename: (row.start_time, row.end_time) for row in times.itertuples()}
    rows = []
    # Folder = activity code (F01..F08 falls, D01..D11 normal); file = U<person>_R<trial>_accel.csv.
    for path in sorted((WEDA_DIR / "50Hz").glob("*/U*_R*_accel.csv")):
        # "..._vertical_accel.csv" is a different, derived signal: skip it.
        if path.name.endswith("_vertical_accel.csv"):
            continue
        activity = path.parent.name
        is_fall = activity.startswith("F")
        xyz = load_recording(path)
        if is_fall:
            # Look for the impact only where the authors marked the fall, so the window
            # cannot land on the arm movement after pressing start.
            start, end = fall_times[f"{activity}/{path.name.removesuffix('_accel.csv')}"]
            impact = find_impact(xyz, int(start * SAMPLE_RATE_HZ), int(end * SAMPLE_RATE_HZ))
        else:
            impact = normal_activity_impact(xyz)
        person = int(re.match(r"U(\d+)_", path.name).group(1))
        rows.append(
            ["weda", activity, f"weda-{person:02d}", int(is_fall), *extract_features(xyz, impact)]
        )
    return rows


def fallalld_rows() -> list[list]:
    rows = []
    for path in sorted(FALLALLD_DIR.glob(f"S*_D{FALLALLD_WRIST_DEVICE}_A*_T*_A.dat")):
        subject, activity = re.match(r"S(\d+)_D\d_A(\d+)_", path.name).groups()
        is_fall = int(activity) >= FALLALLD_FIRST_FALL_ID
        counts = np.genfromtxt(path, delimiter=",")
        xyz = resample_poly(
            counts * FALLALLD_G_PER_COUNT, FALLALLD_RESAMPLE_UP, FALLALLD_RESAMPLE_DOWN, axis=0
        )
        if is_fall:
            # Includes the "rec." falls (the person gets up afterwards): measured on the
            # files, they have the same impact as the others.
            start, end = FALLALLD_FALL_SEARCH_SECONDS
            impact = find_impact(xyz, start * SAMPLE_RATE_HZ, end * SAMPLE_RATE_HZ)
        else:
            impact = normal_activity_impact(xyz)
        rows.append(
            [
                "fallalld",
                f"A{activity}",
                f"fallalld-{subject}",
                int(is_fall),
                *extract_features(xyz, impact),
            ]
        )
    return rows


def build_table() -> pd.DataFrame:
    """Columns: source, activity, person, is_fall (1/0) and the 9 features."""
    columns = ["source", "activity", "person", "is_fall", *FEATURE_NAMES]
    table = pd.DataFrame(weda_rows() + fallalld_rows(), columns=columns)
    return table[table.max_g > TRIGGER_G].reset_index(drop=True)


if __name__ == "__main__":
    table = build_table()
    print(table.groupby(["source", "is_fall"]).agg(recordings=("person", "size"), people=("person", "nunique")))
    print("\nTypical values (median):")
    print(table.groupby(["source", "is_fall"])[FEATURE_NAMES].median().round(2).to_string())
