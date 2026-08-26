#!/usr/bin/env python
"""Export the SMPL-X rest joint positions (J_regressor @ v_template, 55x3) to JSON.

The frontend computes the SMPL-X -> VRM retarget offsets AT LOAD, for whatever VRM is
loaded, and needs the SMPL-X side of the rest pose for that: the direction of each bone.
Only these 55 points ship (src/retarget/smplxRest.json) — the same kind of derived data
the old precomputed offsets file carried; the SMPL-X model itself is not distributed.

    python scripts/export_smplx_rest.py [path/to/SMPLX_NEUTRAL_2020.npz]
"""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[1]
NPZ = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "PantoMatrix/smplx_models/smplx/SMPLX_NEUTRAL_2020.npz"
OUT = HERE / "src/retarget/smplxRest.json"

m = np.load(NPZ, allow_pickle=True)
J = np.asarray(m["J_regressor"] @ m["v_template"])[:55]
OUT.write_text(json.dumps({"joints": [[round(float(v), 6) for v in row] for row in J]}))
print(f"wrote {J.shape[0]} joints -> {OUT}")
