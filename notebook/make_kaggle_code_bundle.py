"""Package the pipeline code as a zip to upload as a Kaggle Dataset (for kaggle_launcher.ipynb).

Usage:
    python notebook/make_kaggle_code_bundle.py                 # -> outputs/kaggle/ncr-lst-v2-code.zip
    python notebook/make_kaggle_code_bundle.py --out DIR
    python notebook/make_kaggle_code_bundle.py --verify        # is the existing zip still the current code?

The zip holds one folder ``lst_code/`` with ``sections/00..12_*.py``, ``build_notebook.py``, ``kaggle_runner.py``,
``run_local.py``, ``validate_bundle.py`` and ``BUNDLE_INFO.json``: the bundle id (``YYYYMMDD-HHMMSS-<sha6>``, UTC
build time + a checksum of the files), creation time, git commit, per-section code hashes and the sha1 of every
file. The launcher refuses a bundle whose files do not match these checksums, and with ``EXPECTED_BUNDLE`` set, any
other bundle id. The script also rebuilds ``kaggle_launcher.ipynb`` (repository root, ``EXPECTED_BUNDLE = ""``) and
writes a copy next to the zip with ``EXPECTED_BUNDLE`` set to the new id. Upload the zip on Kaggle as a new dataset
(or as a New Version of it after a code change) and attach it to the launcher notebook.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import build_launcher  # noqa: E402
from build_notebook import section_code_hashes, section_paths  # noqa: E402

TOP = "lst_code"
FILES = ["build_notebook.py", "kaggle_runner.py", "run_local.py", "validate_bundle.py"]
N_SECTIONS = 13
ZIP_NAME = "ncr-lst-v2-code.zip"


def _sha1(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def _git(*args: str) -> str | None:
    try:
        return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True,
                              timeout=30).stdout.strip()
    except Exception:  # noqa: BLE001 - not a git checkout / git missing
        return None


def _entries() -> list[tuple[Path, str]]:
    """(source file, path inside the zip) of every bundled file, after checking that the tree is complete."""
    sections = section_paths(HERE / "sections")
    ids = [p.name[:2] for p in sections]
    if ids != [f"{i:02d}" for i in range(N_SECTIONS)]:
        sys.exit(f"expected sections 00..12 in {HERE / 'sections'}, found {ids}")
    for name in FILES:
        if not (HERE / name).is_file():
            sys.exit(f"missing {HERE / name}")
    return [(p, f"{TOP}/sections/{p.name}") for p in sections] + [(HERE / n, f"{TOP}/{n}") for n in FILES]


def build(out_dir: Path) -> Path:
    entries = _entries()
    sections = [src for src, arc in entries if "/sections/" in arc]
    for p in sections:                                     # every section must compile before it is shipped
        compile(p.read_text(encoding="utf-8"), str(p), "exec")
    hashes = section_code_hashes(sections)
    files = {arc[len(TOP) + 1:]: _sha1(src) for src, arc in entries}
    created = datetime.now(timezone.utc)
    files_sha = hashlib.sha1(json.dumps(files, sort_keys=True).encode("utf-8")).hexdigest()
    bundle_id = f"{created:%Y%m%d-%H%M%S}-{files_sha[:6]}"
    dirty = _git("status", "--porcelain", "--", "notebook")
    info = {
        "name": "ncr-lst-v2-code",
        "bundle_id": bundle_id,
        "created_utc": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "git_commit": _git("rev-parse", "--short=12", "HEAD"),
        "git_dirty": bool(dirty) if dirty is not None else None,
        "code_hashes": hashes,
        "files": files,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    # The launcher first (repository copy + the stamped copy next to the zip), the zip last.
    build_launcher.build(build_launcher.DEFAULT_OUT, check=True)
    launcher_copy = out_dir / build_launcher.DEFAULT_OUT.name
    build_launcher.build(launcher_copy, check=True, expected_bundle=bundle_id)
    zip_path = out_dir / ZIP_NAME
    tmp = zip_path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for src, arc in entries:
            zf.write(src, arc)
        zf.writestr(f"{TOP}/BUNDLE_INFO.json", json.dumps(info, indent=1, sort_keys=True))
    tmp.replace(zip_path)
    if verify(zip_path, quiet=True) != 0:                  # a file changed while the zip was written
        sys.exit(f"{zip_path}: the code changed while the bundle was built; run again")
    print(f"\nWrote {zip_path} ({zip_path.stat().st_size / 1024:.0f} KB): {len(entries)} files + BUNDLE_INFO.json\n"
          f"  BUNDLE ID  {bundle_id}\n"
          f"  commit {info['git_commit']}{' + uncommitted changes' if info['git_dirty'] else ''}; "
          f"kaggle_runner.py sha1 {files['kaggle_runner.py'][:12]}\n"
          f"  code hashes {hashes}\n"
          f"  launcher for Kaggle: {launcher_copy} (EXPECTED_BUNDLE = \"{bundle_id}\")\n"
          "Kaggle: first time -> + Create -> New Dataset -> this zip (title ncr-lst-v2-code), then import the launcher "
          "above (File -> Import Notebook) and attach the dataset (Input -> + Add Input -> Datasets -> Your Work).\n"
          "        later      -> dataset page -> New Version -> this zip; in the launcher update the dataset to the "
          f"new version and set EXPECTED_BUNDLE = \"{bundle_id}\".")
    return zip_path


def verify(zip_path: Path, quiet: bool = False) -> int:
    """0 when ``zip_path`` holds exactly the current files of the tree, else 1 (stale or unreadable)."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            info = json.loads(zf.read(f"{TOP}/BUNDLE_INFO.json").decode("utf-8"))
            in_zip = {n[len(TOP) + 1:]: hashlib.sha1(zf.read(n)).hexdigest() for n in zf.namelist()
                      if n.startswith(f"{TOP}/") and not n.endswith("/") and not n.endswith("BUNDLE_INFO.json")}
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        print(f"{zip_path}: unreadable ({type(exc).__name__}: {exc})")
        return 1
    tree = {arc[len(TOP) + 1:]: _sha1(src) for src, arc in _entries()}
    stale = sorted(k for k in set(tree) | set(info.get("files", {}))
                   if tree.get(k) != info.get("files", {}).get(k) or in_zip.get(k) != tree.get(k))
    if stale:
        print(f"{zip_path} (bundle {info.get('bundle_id')}) is STALE - these files differ from the tree: "
              f"{', '.join(stale)}\nRebuild: python notebook/make_kaggle_code_bundle.py")
        return 1
    if not quiet:
        print(f"{zip_path}: bundle {info.get('bundle_id')} matches the current code ({len(tree)} files)")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / "outputs" / "kaggle")
    ap.add_argument("--verify", action="store_true", help="check an existing zip against the code instead of building")
    args = ap.parse_args()
    if args.verify:
        sys.exit(verify(args.out / ZIP_NAME))
    build(args.out)
