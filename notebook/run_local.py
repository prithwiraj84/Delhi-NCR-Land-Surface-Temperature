"""Execute the notebook sections as one script in a single shared namespace (local smoke test).

Mirrors what Kaggle does when running the notebook top-to-bottom, without needing Jupyter.

Examples:
    python notebook/run_local.py                                  # synthetic, FAST_DEV, 2 km grid
    python notebook/run_local.py --until 02                       # stop after section 02
    python notebook/run_local.py --grid-res 1000 --no-fast-dev    # full-size synthetic run
    python notebook/run_local.py --out outputs_demo               # choose output dir
"""
from __future__ import annotations

import argparse
import gc
import os
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_notebook import SECTIONS_DIR, parse_sections  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", default="synthetic", choices=["synthetic", "gee", "auto"])
    ap.add_argument("--grid-res", type=int, default=2000, help="grid cell size in metres")
    ap.add_argument("--fine-res", type=int, default=None, help="fine land-cover resolution in metres")
    ap.add_argument("--no-fast-dev", action="store_true")
    ap.add_argument("--bootstrap", type=int, default=None)
    ap.add_argument("--out", default=str(HERE.parent / "outputs"))
    ap.add_argument("--until", default=None, help="last section prefix to run, e.g. 03")
    args = ap.parse_args()

    os.environ.setdefault("MPLBACKEND", "Agg")
    os.environ["LST_RUN_MODE"] = args.mode
    os.environ["LST_GRID_RES_M"] = str(args.grid_res)
    os.environ["LST_FAST_DEV"] = "0" if args.no_fast_dev else "1"
    os.environ["LST_OUTPUT_DIR"] = str(Path(args.out).resolve())
    if args.fine_res:
        os.environ["LST_FINE_RES_M"] = str(args.fine_res)
    if args.bootstrap is not None:
        os.environ["LST_N_BOOTSTRAP"] = str(args.bootstrap)

    paths = sorted(SECTIONS_DIR.glob("[0-9][0-9]_*.py"))
    if args.until:
        paths = [p for p in paths if p.name[:2] <= args.until]
    ns: dict = {"__name__": "__main__"}
    t_all = time.time()
    try:
        for path in paths:
            cells = [src for kind, src in parse_sections([path]) if kind == "code"]
            print(f"\n{'=' * 78}\n>>> {path.name}  ({len(cells)} code cells)\n{'=' * 78}", flush=True)
            t0 = time.time()
            for i, src in enumerate(cells):
                try:
                    exec(compile(src, f"{path.name}[cell {i}]", "exec"), ns)
                except SystemExit:
                    raise
                except BaseException:
                    traceback.print_exc()
                    print(f"\n!!! FAILED in {path.name} code cell {i}:\n{src[:1500]}", file=sys.stderr)
                    return 1
            print(f"<<< {path.name} done in {time.time() - t0:.1f}s", flush=True)
        print(f"\nALL SECTIONS OK in {time.time() - t_all:.1f}s", flush=True)
        return 0
    finally:
        # Release boosters / CUDA handles while their runtimes are still loaded. Left in the namespace until
        # interpreter teardown, XGBoost CUDA objects are finalised after the libraries they depend on and the
        # process exits with a spurious non-zero status (127 on Windows) even though every section succeeded.
        ns.clear()
        gc.collect()


if __name__ == "__main__":
    sys.exit(main())
