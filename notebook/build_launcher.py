"""Build kaggle_launcher.ipynb (the small Kaggle notebook) from notebook/kaggle_launcher_src.py.

Usage:
    python notebook/build_launcher.py            # writes ../kaggle_launcher.ipynb
    python notebook/build_launcher.py --check    # also compiles every code cell

The launcher runs the 13 pipeline sections from an attached code dataset (see make_kaggle_code_bundle.py) because the
full pipeline notebook exceeds Kaggle's 1 MB notebook limit. make_kaggle_code_bundle.py also writes a copy next to
the zip with ``EXPECTED_BUNDLE`` set to the id of the bundle it built (``build(..., expected_bundle=id)``).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_notebook import parse_sections  # noqa: E402

SRC = HERE / "kaggle_launcher_src.py"
DEFAULT_OUT = HERE.parent / "kaggle_launcher.ipynb"
KAGGLE_LIMIT_BYTES = 1_000_000
EXPECTED_LINE = re.compile(r'^EXPECTED_BUNDLE = "[^"\n]*"', re.MULTILINE)


def build(out_path: Path, check: bool, expected_bundle: str = "") -> None:
    import nbformat
    from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

    cells = parse_sections([SRC])
    n_lines = sum(len(EXPECTED_LINE.findall(src)) for kind, src in cells if kind == "code")
    if n_lines != 1:
        sys.exit(f"{SRC} must contain exactly one 'EXPECTED_BUNDLE = \"...\"' line, found {n_lines}")
    if expected_bundle:
        cells = [(k, EXPECTED_LINE.sub(f'EXPECTED_BUNDLE = "{expected_bundle}"', s) if k == "code" else s)
                 for k, s in cells]
    if check:
        for i, (kind, src) in enumerate(cells):
            if kind == "code":
                try:
                    compile(src, f"<launcher cell {i}>", "exec")
                except SyntaxError as exc:
                    sys.exit(f"Syntax error in launcher code cell {i}: {exc}")
    nb = new_notebook()
    nb.cells = [new_markdown_cell(s) if k == "markdown" else new_code_cell(s) for k, s in cells]
    nb.metadata = {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.10"},
        "kaggle": {"accelerator": "nvidiaTeslaT4", "isGpuEnabled": True, "isInternetEnabled": True,
                   "language": "python", "sourceType": "notebook"},
    }
    nbformat.validate(nb)
    text = nbformat.writes(nb)
    out_path.write_text(text, encoding="utf-8")
    size = len(text.encode("utf-8"))
    if size >= KAGGLE_LIMIT_BYTES:
        sys.exit(f"{out_path} is {size} bytes - over Kaggle's 1 MB notebook limit")
    print(f"Wrote {out_path} ({len(cells)} cells, {size / 1024:.1f} KB; Kaggle limit 1 MB"
          f"{f'; EXPECTED_BUNDLE = {expected_bundle!r}' if expected_bundle else ''})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    build(args.out, args.check)
