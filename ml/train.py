"""Trains the fall model and measures it on people it never saw (CJ-21).

Run:  cd ml && .venv/bin/python train.py
Writes ml/model.joblib (the trained forest) and prints the results.
"""

from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier

from dataset import build_table
from features import FEATURE_NAMES

# Small on purpose so it fits and runs fast on the watch. Tested: 50 or 100 trees, or
# deeper trees, did not catch more falls.
TREES = 20
MAX_DEPTH = 8
# Of the strong normal movements, the share we accept being called a fall. A "false
# alarm" only makes Emily ask "Are you OK?", so we trade some of them for more falls
# caught. Chosen by Fabian: about 90% of falls caught for 15% false alarms.
FALSE_ALARM_RATE = 0.15
# The measurement is repeated with different random seeds and averaged.
SEEDS = 5
MODEL_FILE = Path(__file__).parent / "model.joblib"


def new_forest(seed: int) -> RandomForestClassifier:
    return RandomForestClassifier(n_estimators=TREES, max_depth=MAX_DEPTH, random_state=seed)


def unseen_person_scores(x: np.ndarray, y: np.ndarray, person: np.ndarray) -> np.ndarray:
    """For every recording, the fall score from forests that never saw that person.

    One person is left out at a time: train on everyone else, score the one left out.
    Splitting at random instead would put the same person in training and test, and the
    result would look better than it is.
    """
    scores = np.zeros(len(y))
    for seed in range(SEEDS):
        for name in np.unique(person):
            held_out = person == name
            forest = new_forest(seed).fit(x[~held_out], y[~held_out])
            scores[held_out] += forest.predict_proba(x[held_out])[:, 1]
    return scores / SEEDS


def threshold_for(scores: np.ndarray, y: np.ndarray, false_alarm_rate: float) -> float:
    """The score above which a recording is called a fall, set so that this share of the
    normal movements is above it."""
    normal = np.sort(scores[y == 0])[::-1]
    return float(normal[int(false_alarm_rate * len(normal))])


def main() -> None:
    table = build_table()
    x = table[FEATURE_NAMES].to_numpy()
    y = table["is_fall"].to_numpy()
    person = table["person"].to_numpy()

    scores = unseen_person_scores(x, y, person)
    threshold = threshold_for(scores, y, FALSE_ALARM_RATE)
    called_fall = scores > threshold

    print(f"{len(table)} recordings, {y.sum()} falls, {len(np.unique(person[y == 1]))} people with falls")
    print(f"Fall score threshold: {threshold:.2f}\n")
    print("On people the model never saw:")
    for label, rows in [
        ("all", np.ones(len(y), dtype=bool)),
        ("WEDA-FALL", (table["source"] == "weda").to_numpy()),
        ("FallAllD", (table["source"] == "fallalld").to_numpy()),
    ]:
        falls, normal = rows & (y == 1), rows & (y == 0)
        print(
            f"  {label:10s} falls caught {called_fall[falls].sum():3d} of {falls.sum():3d} "
            f"({called_fall[falls].mean():.0%})   "
            f"false alarms {called_fall[normal].sum():3d} of {normal.sum():4d} "
            f"({called_fall[normal].mean():.0%})"
        )

    # The model that goes to the watch is trained on everyone.
    forest = new_forest(seed=0).fit(x, y)
    joblib.dump({"forest": forest, "threshold": threshold, "features": FEATURE_NAMES}, MODEL_FILE)
    print(f"\nSaved {MODEL_FILE.name}: {TREES} trees, depth up to {MAX_DEPTH}")
    print("What the forest relies on most:")
    for name, weight in sorted(zip(FEATURE_NAMES, forest.feature_importances_), key=lambda p: -p[1]):
        print(f"  {name:16s} {weight:.2f}")


if __name__ == "__main__":
    main()
