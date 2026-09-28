"""Assemble notebook/sections/*.py (jupytext "percent" format) into delhi_ncr_lst_pipeline.ipynb.

Usage:
    python notebook/build_notebook.py            # writes ../delhi_ncr_lst_pipeline.ipynb
    python notebook/build_notebook.py --check    # also compiles every code cell (syntax check)

Only the standard library + nbformat are needed.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

HERE = Path(__file__).resolve().parent
SECTIONS_DIR = HERE / "sections"
DEFAULT_OUT = HERE.parent / "delhi_ncr_lst_pipeline.ipynb"

CELL_MARKER = re.compile(r"^# %%(?P<rest>.*)$")


def parse_sections(paths: list[Path]) -> list[tuple[str, str]]:
    """Return a list of (cell_type, source) tuples from percent-format files."""
    cells: list[tuple[str, str]] = []
    for path in paths:
        kind, buf = None, []

        def flush() -> None:
            if kind is None:
                return
            text = "\n".join(buf).strip("\n")
            if not text.strip():
                return
            if kind == "markdown":
                lines = []
                for line in text.splitlines():
                    if line.startswith("# "):
                        lines.append(line[2:])
                    elif line.strip() == "#":
                        lines.append("")
                    else:
                        lines.append(line)
                text = "\n".join(lines)
            cells.append((kind, text))

        for line in path.read_text(encoding="utf-8").splitlines():
            m = CELL_MARKER.match(line)
            if m:
                flush()
                kind = "markdown" if "[markdown]" in m.group("rest") else "code"
                buf = []
            else:
                if kind is None:  # preamble before the first marker is treated as code
                    kind = "code"
                buf.append(line)
        flush()
    return cells


def build(out_path: Path, check: bool) -> None:
    paths = sorted(SECTIONS_DIR.glob("[0-9][0-9]_*.py"))
    if not paths:
        sys.exit(f"No section files found in {SECTIONS_DIR}")
    cells = parse_sections(paths)
    if check:
        for i, (kind, src) in enumerate(cells):
            if kind == "code":
                try:
                    compile(src, f"<cell {i}>", "exec")
                except SyntaxError as exc:  # pragma: no cover - reporting path
                    sys.exit(f"Syntax error in code cell {i}: {exc}\n---\n{src[:400]}")
    nb = new_notebook()
    nb.cells = [new_markdown_cell(s) if k == "markdown" else new_code_cell(s) for k, s in cells]
    nb.metadata = {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.10"},
        "kaggle": {
            "accelerator": "nvidiaTeslaT4",
            "isGpuEnabled": True,
            "isInternetEnabled": True,
            "language": "python",
            "sourceType": "notebook",
        },
    }
    nbformat.validate(nb)
    out_path.write_text(nbformat.writes(nb), encoding="utf-8")
    n_code = sum(1 for k, _ in cells if k == "code")
    print(f"Wrote {out_path} ({len(cells)} cells: {n_code} code, {len(cells) - n_code} markdown) from {len(paths)} sections")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true", help="compile every code cell")
    args = ap.parse_args()
    build(args.out, args.check)
