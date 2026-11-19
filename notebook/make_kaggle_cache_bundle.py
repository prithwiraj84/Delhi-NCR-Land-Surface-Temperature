"""Package an Earth Engine cache made on your PC as a zip to upload as a Kaggle Dataset.

Usage:
    python notebook/make_kaggle_cache_bundle.py --src outputs/pilot_ee      # -> outputs/kaggle/ncr-lst-v2-ee-cache.zip
    python notebook/make_kaggle_cache_bundle.py --src DIR --out ZIP

Why: the Earth Engine part of a run (sections 03-05) can run on your PC (``run_local.py --mode gee --grid-res 1000
--no-fast-dev`` with ``LST_STOP_AFTER=06`` and the Kaggle run's ``LST_PROFILE``; run_local's defaults, a 2 km grid and
FAST_DEV, would make every stage key miss on Kaggle), with no Kaggle time limit and no GPU quota. Attached to the Kaggle launcher, its cache makes
sections 03-06 cache hits, so the Kaggle session only trains. This needs the same code bundle (the stage keys carry
the section code hashes) and the same profile; Earth Engine tiles and GDDP blocks are reused even when a section's
code changed, because their keys are the request expressions.

The zip holds ``cache/stages/``, ``cache/tiles/`` and ``cache/gddp/`` as plain files: members of the run's packed
``cache/packed/*.tar`` are written out as files (Kaggle unpacks uploaded archives, so nested tar files are not
shipped), and ``RUN_STOPPED.json`` / ``LAUNCHER_RUN.json`` sit next to ``cache/`` so the Kaggle run logs where the
cache came from. ``LST_CACHE_IMPORT=auto`` finds it under ``/kaggle/input``.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SUBDIRS = ("stages", "tiles", "gddp")
STATUS_FILES = ("RUN_STOPPED.json", "LAUNCHER_RUN.json", "RUN_FAILED.json")


def _safe_member(name: str) -> bool:
    p = PurePosixPath(name)
    return not p.is_absolute() and ".." not in p.parts and len(p.parts) >= 2 and p.parts[0] in SUBDIRS


_STAGE_RE = re.compile(r"^stages/(?P<name>.+)-(?P<key>[0-9a-f]{8,})\.(?P<ext>[A-Za-z0-9]+)$")

# Stage-key fields (from each entry's .json sidecar) that identify a generation of a stage: the run identity fields
# of CFG.key (00_setup.py), the code hashes (code, code01, codeNN, shared), version and the data fingerprint df.
# Per-item fields of multi-entry stages (07_job_*: one entry per CV job, ``ident``; 08_boot_*: one per bootstrap
# replicate, ``b``) are not among them, so all entries of the newest generation stay together.
_GENERATION_FIELDS = ("data_mode", "profile", "grid_res_m", "fine_factor", "lc_fine_res_m", "frames_obs", "seed",
                      "shared", "version", "df")


def _read_files(chosen: dict, rels) -> dict:
    """``{rel: bytes}`` of chosen files (loose, or members of packed tars - each tar opened once); unreadable files are
    left out."""
    out: dict = {}
    by_tar: dict = {}
    for rel in rels:
        src_ref = chosen[rel][2]
        if src_ref[0] == "loose":
            try:
                out[rel] = src_ref[1].read_bytes()
            except OSError:
                pass
        else:
            by_tar.setdefault(src_ref[1], {})[src_ref[2]] = rel
    for tar_path, names in by_tar.items():
        try:
            with tarfile.open(tar_path, "r:") as tf:
                for m in tf.getmembers():
                    rel = names.get(m.name)
                    if rel is None or rel in out or not m.isfile():
                        continue
                    data = tf.extractfile(m)
                    if data is not None:
                        with data:
                            out[rel] = data.read()
        except (OSError, tarfile.TarError):
            continue
    return out


def _generation(sidecar: bytes | None) -> str | None:
    """The generation signature of a stage entry from its sidecar bytes (None when missing or unreadable)."""
    if sidecar is None:
        return None
    try:
        key = json.loads(sidecar.decode("utf-8")).get("key")
    except (ValueError, UnicodeDecodeError, AttributeError):
        return None
    if not isinstance(key, dict):
        return None
    sig = {k: v for k, v in key.items() if k in _GENERATION_FIELDS or str(k).startswith("code")}
    return json.dumps(sig, sort_keys=True, default=str)


def _latest_stages(chosen: dict) -> tuple:
    """Keep, per stage name, only its newest generation: the newest ``.pkl`` and every other entry whose key has the
    same generation fields (``_GENERATION_FIELDS``, read from the ``.json`` sidecars), each with its sidecar. A cache
    reused across code changes holds older versions of a stage whose keys no current run asks for; multi-entry stages
    (07_job_*, 08_boot_*) keep all entries of the newest generation. An entry whose generation cannot be read (no or
    unreadable sidecar) is kept, and so is every entry of a stage whose newest entry has no readable sidecar."""
    entries: dict = {}                                           # stage name -> {key: mtime of its .pkl}
    for rel, (mtime, _size, _src) in chosen.items():
        m = _STAGE_RE.match(rel)
        if m and m.group("ext") == "pkl":
            entries.setdefault(m.group("name"), {})[m.group("key")] = mtime
    sidecars = {f"stages/{name}-{key}.json": (name, key) for name, keys in entries.items() for key in keys}
    sidecars = {rel: nk for rel, nk in sidecars.items() if rel in chosen}
    raw = _read_files(chosen, sidecars)
    gen = {nk: _generation(raw.get(rel)) for rel, nk in sidecars.items()}
    drop = set()
    for name, keys in entries.items():
        newest = max(sorted(keys), key=lambda k: keys[k])
        ref = gen.get((name, newest))
        if ref is None:
            continue
        drop.update((name, k) for k in keys if gen.get((name, k)) not in (None, ref))
    kept = {}
    for rel, val in chosen.items():
        m = _STAGE_RE.match(rel)
        if m and m.group("name") in entries and (m.group("key") not in entries[m.group("name")]
                                                 or (m.group("name"), m.group("key")) in drop):
            continue                                             # superseded generation, or a sidecar without .pkl
        kept[rel] = val
    return kept, len(chosen) - len(kept)


def build(src: Path, out: Path, latest_stages_only: bool = True) -> Path:
    cache = src / "cache"
    if not cache.is_dir():
        sys.exit(f"{cache} does not exist: run the Earth Engine part first (see the docstring)")
    out.parent.mkdir(parents=True, exist_ok=True)
    # Pass 1: the newest copy of every file, loose (cache/<sub>/...) or a member of cache/packed/*.tar.
    chosen: dict[str, tuple] = {}                                # rel -> (mtime, size, ("loose", path) | ("tar", tar, name))
    for sub in SUBDIRS:
        for path in sorted((cache / sub).rglob("*")) if (cache / sub).is_dir() else []:
            if path.is_file() and not path.name.endswith(".tmp"):
                st = path.stat()
                chosen[path.relative_to(cache).as_posix()] = (st.st_mtime, st.st_size, ("loose", path))
    tars = sorted((cache / "packed").glob("*.tar")) if (cache / "packed").is_dir() else []
    for tar_path in tars:
        with tarfile.open(tar_path, "r:") as tf:
            for m in tf.getmembers():
                if m.isfile() and not m.name.endswith(".tmp") and _safe_member(m.name):
                    if m.name not in chosen or m.mtime > chosen[m.name][0]:
                        chosen[m.name] = (m.mtime, m.size, ("tar", tar_path, m.name))
    if not chosen:
        sys.exit(f"{cache} holds no stage, tile or GDDP files")
    if latest_stages_only:
        chosen, dropped = _latest_stages(chosen)
        if dropped:
            print(f"left out {dropped} outdated stage file(s) (older versions of a stage, e.g. from earlier code)")
    # Pass 2: write each file once.
    tmp = out.with_suffix(".zip.tmp")
    by_tar: dict[Path, list] = {}
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for rel, (_mtime, _size, src_ref) in sorted(chosen.items()):
            if src_ref[0] == "loose":
                zf.write(src_ref[1], f"cache/{rel}")
            else:
                by_tar.setdefault(src_ref[1], []).append(src_ref[2])
        for tar_path, names in by_tar.items():
            wanted = set(names)
            with tarfile.open(tar_path, "r:") as tf:
                for m in tf.getmembers():
                    if m.name not in wanted or chosen[m.name][2][1] != tar_path:
                        continue
                    data = tf.extractfile(m)
                    if data is None:
                        continue
                    info = zipfile.ZipInfo(f"cache/{m.name}", date_time=_dt(m.mtime))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with data, zf.open(info, "w") as dst:
                        while chunk := data.read(1 << 20):
                            dst.write(chunk)
                    wanted.discard(m.name)
        for name in STATUS_FILES:
            if (src / name).is_file():
                zf.write(src / name, name)
    tmp.replace(out)
    n_packed = sum(len(v) for v in by_tar.values())
    size = sum(v[1] for v in chosen.values())
    counts = {sub: sum(1 for k in chosen if k.startswith(sub + "/")) for sub in SUBDIRS}
    print(f"Wrote {out} ({out.stat().st_size / 2**20:,.0f} MiB zipped, {size / 2**20:,.0f} MiB of cache): "
          f"{len(chosen)} files ({len(chosen) - n_packed} loose + {n_packed} from packed tars) {counts}\n"
          "Kaggle: + Create -> New Dataset -> this zip (title e.g. ncr-lst-v2-ee-cache) -> Create; in the launcher "
          "Input -> + Add Input -> Datasets -> Your Work -> it. Use the SAME code bundle and profile as the run that "
          "made it.")
    return out


def _dt(mtime: float) -> tuple:
    import time as _time
    t = _time.gmtime(max(mtime, 315532800))                     # zip dates start in 1980
    return (t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, required=True, help="output folder of the local run (holds cache/)")
    ap.add_argument("--out", type=Path, default=ROOT / "outputs" / "kaggle" / "ncr-lst-v2-ee-cache.zip")
    ap.add_argument("--all-stages", action="store_true", help="also ship older versions of each stage")
    args = ap.parse_args()
    build(args.src, args.out, latest_stages_only=not args.all_stages)
