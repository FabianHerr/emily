"""Exports the trained forest to C for the watch (CJ-21 step 6), and checks it.

Run:  cd ml && .venv/bin/python export.py      (after train.py)
Writes ml/watch_model/: the model header, the two emlearn headers it needs, and a file
of test cases the watch code can be checked against.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

import emlearn
import joblib
import numpy as np

from dataset import build_table
from features import FEATURE_NAMES
from train import MODEL_FILE

OUT_DIR = Path(__file__).parent / "watch_model"
MODEL_NAME = "fall_model"
# emlearn headers the generated code includes.
EMLEARN_HEADERS = ["eml_trees.h", "eml_common.h"]
# Precision of the fall share stored in each leaf (emlearn allows 3 to 8 bits).
LEAF_BITS = 8
# The C model must agree with Python to within this on every recording. Leaves are
# rounded to 1/255, so a tiny difference is expected.
MAX_SCORE_DIFFERENCE = 0.01
# Rows written to test_cases.csv for checking the watch's own feature code (CJ-22).
TEST_CASES = 20


def main() -> None:
    saved = joblib.load(MODEL_FILE)
    forest, threshold = saved["forest"], saved["threshold"]

    OUT_DIR.mkdir(exist_ok=True)
    # "inline" writes the trees as plain if/else C code; "float" keeps the features as
    # decimals (the watch's ESP32-S3 has a hardware float unit), so nothing is rescaled.
    # leaf_bits=8: each leaf keeps its share of falls (soft voting), as scikit-learn does.
    # The default stores only fall / not-fall per tree, which moved the score by up to 0.17.
    c_model = emlearn.convert(forest, method="inline", dtype="float", leaf_bits=LEAF_BITS)
    header = OUT_DIR / f"{MODEL_NAME}.h"
    c_model.save(file=str(header), name=MODEL_NAME)
    for name in EMLEARN_HEADERS:
        shutil.copy(Path(emlearn.includedir) / name, OUT_DIR / name)

    table = build_table()
    x = table[FEATURE_NAMES].to_numpy()
    python_scores = forest.predict_proba(x)[:, 1]
    c_scores = run_c_model(x)
    worst = float(np.abs(python_scores - c_scores).max())
    same_answer = int(((python_scores > threshold) == (c_scores > threshold)).sum())
    print(f"C model against Python on {len(x)} recordings: largest score difference {worst:.6f}")
    print(f"Same fall / not-fall answer on {same_answer} of {len(x)}")
    if worst > MAX_SCORE_DIFFERENCE:
        raise SystemExit("The C model does not match Python: do not use it.")

    (OUT_DIR / "fall_threshold.h").write_text(
        "// Written by ml/export.py. A score above this is a fall.\n"
        f"#define FALL_SCORE_THRESHOLD {threshold:.4f}f\n"
        f"#define FALL_FEATURES {len(FEATURE_NAMES)}\n"
        f"// Feature order: {', '.join(FEATURE_NAMES)}\n"
    )
    cases = table.sample(TEST_CASES, random_state=0)
    out = cases[FEATURE_NAMES].copy()
    out["fall_score"] = forest.predict_proba(cases[FEATURE_NAMES].to_numpy())[:, 1]
    out.round(6).to_csv(OUT_DIR / "test_cases.csv", index=False)
    print(f"Wrote {OUT_DIR.name}/: {header.name} ({header.stat().st_size // 1024} KB), fall_threshold.h, test_cases.csv")


def run_c_model(x: np.ndarray) -> np.ndarray:
    """Compiles the exported header on this computer and scores every row with it."""
    program = f"""
#include <stdio.h>
#include "{MODEL_NAME}.h"
int main(void) {{
    float f[{x.shape[1]}], out[2];
    while (scanf("{' '.join(['%f'] * x.shape[1])}", {', '.join(f'&f[{i}]' for i in range(x.shape[1]))}) == {x.shape[1]}) {{
        {MODEL_NAME}_predict_proba(f, {x.shape[1]}, out, 2);
        printf("%.6f\\n", out[1]);
    }}
    return 0;
}}
"""
    with tempfile.TemporaryDirectory() as tmp:
        source, binary = Path(tmp) / "check.c", Path(tmp) / "check"
        source.write_text(program)
        subprocess.run(["cc", "-O1", f"-I{OUT_DIR}", str(source), "-o", str(binary), "-lm"], check=True)
        rows = "\n".join(" ".join(f"{v:.9g}" for v in row) for row in x)
        result = subprocess.run([str(binary)], input=rows, capture_output=True, text=True, check=True)
    return np.array([float(line) for line in result.stdout.split()])


if __name__ == "__main__":
    main()
