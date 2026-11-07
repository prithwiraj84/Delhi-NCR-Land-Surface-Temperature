"""Execute the notebook sections as one script in a single shared namespace (local smoke test).

Mirrors what Kaggle does when running the notebook top-to-bottom, without needing Jupyter: the per-section code
hashes (``_CODE_SHA``, as build_notebook.py injects them) are put into the namespace first, and the section marker
``_lst_enter_section('NN')`` runs before every section 01-12. A clean stop (time budget, ``LST_STOP_AFTER``; an
``LSTStop`` raised by a cell) ends the run with exit code 0 after ``finalize_stop()``.

Examples:
    python notebook/run_local.py                                  # synthetic, FAST_DEV, 2 km grid
    python notebook/run_local.py --until 02                       # stop after section 02
    python notebook/run_local.py --grid-res 1000 --no-fast-dev    # full-size synthetic run
    python notebook/run_local.py --out outputs_demo               # choose output dir
    python notebook/run_local.py --sections /path/to/copy         # run another sections folder
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
from build_notebook import SECTIONS_DIR, parse_sections, section_code_hashes, section_paths  # noqa: E402


def _stopped_cleanly(ns: dict, after: str) -> int:
    """Finalize a clean stop (RUN_STOPPED.json, cache packing) and report it."""
    fin = ns.get("finalize_stop")
    if callable(fin):
        fin()
    print(f"\nSTOPPED CLEANLY after section {after}: {ns.get('LST_STOP_REASON')}", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", default="synthetic", choices=["synthetic", "gee", "auto"])
    ap.add_argument("--grid-res", type=int, default=2000, help="grid cell size in metres")
    ap.add_argument("--fine-res", type=int, default=None, help="fine land-cover resolution in metres")
    ap.add_argument("--no-fast-dev", action="store_true")
    ap.add_argument("--bootstrap", type=int, default=None)
    ap.add_argument("--out", default=str(HERE.parent / "outputs"))
    ap.add_argument("--until", default=None, help="last section prefix to run, e.g. 03")
    ap.add_argument("--sections", type=Path, default=SECTIONS_DIR, help="folder with the NN_*.py section files")
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

    all_paths = section_paths(args.sections)
    if not all_paths:
        print(f"No section files found in {args.sections}", file=sys.stderr)
        return 1
    # Snapshot every section's code cells now, so the code that runs is exactly the code that was hashed (a file
    # edited while a long run is in progress cannot leak into it under a stale hash).
    hashes = section_code_hashes(all_paths)          # all 13 sections, also with --until (as in the notebook)
    snapshot = {p: [src for kind, src in parse_sections([p]) if kind == "code"] for p in all_paths}
    if section_code_hashes(all_paths) != hashes:
        print("section files changed while the run started; rerun", file=sys.stderr)
        return 1
    paths = [p for p in all_paths if not args.until or p.name[:2] <= args.until]
    ns: dict = {"__name__": "__main__", "_CODE_SHA": dict(hashes), "_CURRENT_SECTION": "00"}
    print(f"code hashes: {hashes}", flush=True)
    t_all = time.time()
    last_done = None
    try:
        for path in paths:
            sid = path.name[:2]
            cells = snapshot[path]
            print(f"\n{'=' * 78}\n>>> {path.name}  ({len(cells)} code cells)\n{'=' * 78}", flush=True)
            if sid == "00":
                ns["_CURRENT_SECTION"] = "00"
            elif callable(ns.get("_lst_enter_section")):
                ns["_lst_enter_section"](sid)
                if ns.get("LST_STOPPED"):
                    return _stopped_cleanly(ns, last_done or sid)
            else:
                ns["_CURRENT_SECTION"] = sid
            t0 = time.time()
            for i, src in enumerate(cells):
                try:
                    exec(compile(src, f"{path.name}[cell {i}]", "exec"), ns)
                except SystemExit:
                    raise
                except BaseException as exc:
                    stop_cls = ns.get("LSTStop")          # defined by section 00
                    if isinstance(stop_cls, type) and isinstance(exc, stop_cls):
                        if callable(ns.get("request_stop")):
                            ns["request_stop"](str(exc) or "LSTStop")
                        return _stopped_cleanly(ns, sid)
                    traceback.print_exc()
                    print(f"\n!!! FAILED in {path.name} code cell {i}:\n{src[:1500]}", file=sys.stderr)
                    return 1
                if ns.get("LST_STOPPED"):
                    return _stopped_cleanly(ns, sid)
            print(f"<<< {path.name} done in {time.time() - t0:.1f}s", flush=True)
            last_done = sid
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
